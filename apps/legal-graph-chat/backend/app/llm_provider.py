from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal, Mapping, Protocol
from urllib.parse import urlparse

import httpx

SCHEMA_VERSION = "coreline-codex-proxy.v1"
LEGAL_ANSWER_ENDPOINT = "/v1/legal-answer"
ContextKind = Literal["graph_evidence", "precedent", "source"]
Uncertainty = Literal["low", "medium", "high"]


class LLMProviderError(RuntimeError):
    """Recoverable provider failure that should trigger deterministic fallback."""


class LLMProviderConfigurationError(LLMProviderError):
    """Provider is selected but required backend-only configuration is missing."""


@dataclass(frozen=True)
class LLMContextItem:
    id: str
    kind: ContextKind
    title: str
    quote: str
    source_path: str | None = None
    source_url: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def to_payload(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["metadata"] = {k: v for k, v in dict(self.metadata).items() if v is not None}
        return payload


@dataclass(frozen=True)
class LLMAnswerRequest:
    question: str
    instructions: str
    context_items: list[LLMContextItem]
    max_output_tokens: int = 1024
    schema_version: str = SCHEMA_VERSION

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "question": self.question,
            "instructions": self.instructions,
            "context_items": [item.to_payload() for item in self.context_items],
            "max_output_tokens": self.max_output_tokens,
        }


@dataclass(frozen=True)
class LLMAnswerCitation:
    source_id: str
    label: str
    quote: str
    rationale: str | None = None


@dataclass(frozen=True)
class LLMAnswerResult:
    answer: str
    citations: list[LLMAnswerCitation]
    uncertainty: Uncertainty
    refused: bool
    warnings: list[str] = field(default_factory=list)
    provider: str = "coreline-codex-proxy"
    model: str | None = None
    raw_usage: Mapping[str, Any] | None = None
    schema_version: str = SCHEMA_VERSION


class LLMAnswerProvider(Protocol):
    provider_name: str
    model: str | None

    def answer(self, request: LLMAnswerRequest) -> LLMAnswerResult:
        """Return a source-grounded answer or raise LLMProviderError."""


@dataclass
class CorelineCodexProxyProvider:
    base_url: str
    token: str | None = field(default=None, repr=False)
    timeout_ms: int = 10_000
    model: str | None = None
    client: httpx.Client | None = field(default=None, repr=False, compare=False)
    provider_name: str = field(default="coreline-codex-proxy", init=False)

    @classmethod
    def from_env(cls) -> "CorelineCodexProxyProvider":
        base_url = (
            os.environ.get("CORELINE_CODEX_PROXY_URL", "").strip()
            or os.environ.get("LEGAL_GRAPH_CODEX_PROXY_BASE_URL", "").strip()
        )
        if not base_url:
            raise LLMProviderConfigurationError("CORELINE_CODEX_PROXY_URL is not configured")
        token = _load_token_from_env()
        if not token:
            raise LLMProviderConfigurationError("CORELINE_CODEX_PROXY_TOKEN or CORELINE_CODEX_PROXY_TOKEN_FILE is not configured")
        timeout_ms = _env_int("LEGAL_GRAPH_LLM_TIMEOUT_MS", default=10_000, minimum=250, maximum=120_000)
        model = os.environ.get("LEGAL_GRAPH_LLM_MODEL", "").strip() or None
        return cls(base_url=base_url, token=token, timeout_ms=timeout_ms, model=model)

    def answer(self, request: LLMAnswerRequest) -> LLMAnswerResult:
        payload = request.to_payload()
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        endpoint = self._endpoint_url()
        timeout = httpx.Timeout(self.timeout_ms / 1000.0)
        try:
            if self.client is not None:
                response = self.client.post(endpoint, json=payload, headers=headers, timeout=timeout)
            else:
                with httpx.Client(timeout=timeout) as client:
                    response = client.post(endpoint, json=payload, headers=headers)
        except httpx.TimeoutException as exc:
            raise LLMProviderError("coreline proxy timeout") from exc
        except httpx.HTTPError as exc:
            raise LLMProviderError("coreline proxy unavailable") from exc

        if response.status_code >= 400:
            raise LLMProviderError(f"coreline proxy returned HTTP {response.status_code}")
        try:
            data = response.json()
        except ValueError as exc:
            raise LLMProviderError("coreline proxy returned invalid JSON") from exc
        return self._parse_response(data)

    def _endpoint_url(self) -> str:
        raw = self.base_url.strip()
        if not raw:
            raise LLMProviderConfigurationError("CORELINE_CODEX_PROXY_URL is not configured")
        parsed = urlparse(raw)
        if parsed.path.rstrip("/").endswith(LEGAL_ANSWER_ENDPOINT):
            return raw
        return raw.rstrip("/") + LEGAL_ANSWER_ENDPOINT

    def _parse_response(self, data: Any) -> LLMAnswerResult:
        if not isinstance(data, dict):
            raise LLMProviderError("coreline proxy response must be a JSON object")
        if data.get("schema_version") != SCHEMA_VERSION:
            raise LLMProviderError("coreline proxy schema_version mismatch")
        answer = _required_str(data, "answer", allow_empty=True, max_length=6000)
        uncertainty = _required_str(data, "uncertainty", allow_empty=False, max_length=20)
        if uncertainty not in {"low", "medium", "high"}:
            raise LLMProviderError("coreline proxy uncertainty value is invalid")
        refused = data.get("refused")
        if not isinstance(refused, bool):
            raise LLMProviderError("coreline proxy refused field must be boolean")
        warnings = _string_list(data.get("warnings", []), field_name="warnings")
        citations_raw = data.get("citations")
        if not isinstance(citations_raw, list):
            raise LLMProviderError("coreline proxy citations field must be an array")
        citations: list[LLMAnswerCitation] = []
        for item in citations_raw[:12]:
            if not isinstance(item, dict):
                raise LLMProviderError("coreline proxy citation must be an object")
            citations.append(
                LLMAnswerCitation(
                    source_id=_required_str(item, "source_id", allow_empty=False, max_length=120),
                    label=_required_str(item, "label", allow_empty=False, max_length=300),
                    quote=_required_str(item, "quote", allow_empty=False, max_length=1000),
                    rationale=_optional_str(item.get("rationale"), max_length=1000),
                )
            )
        raw_usage = data.get("raw_usage")
        if raw_usage is not None and not isinstance(raw_usage, dict):
            raw_usage = None
        return LLMAnswerResult(
            answer=answer,
            citations=citations,
            uncertainty=uncertainty,  # type: ignore[arg-type]
            refused=refused,
            warnings=warnings,
            provider=self.provider_name,
            model=self.model,
            raw_usage=raw_usage,
        )


def _load_token_from_env() -> str | None:
    token = (
        os.environ.get("CORELINE_CODEX_PROXY_TOKEN", "").strip()
        or os.environ.get("LEGAL_GRAPH_CODEX_PROXY_TOKEN", "").strip()
    )
    if token:
        return token
    token_file = (
        os.environ.get("CORELINE_CODEX_PROXY_TOKEN_FILE", "").strip()
        or os.environ.get("LEGAL_GRAPH_CODEX_PROXY_TOKEN_FILE", "").strip()
    )
    if not token_file:
        return None
    try:
        return Path(token_file).expanduser().read_text(encoding="utf-8").strip() or None
    except OSError as exc:
        raise LLMProviderConfigurationError("CORELINE_CODEX_PROXY_TOKEN_FILE could not be read") from exc


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(minimum, min(value, maximum))


def _required_str(data: Mapping[str, Any], field_name: str, *, allow_empty: bool, max_length: int) -> str:
    value = data.get(field_name)
    if not isinstance(value, str):
        raise LLMProviderError(f"coreline proxy {field_name} field must be a string")
    value = value.strip()
    if not allow_empty and not value:
        raise LLMProviderError(f"coreline proxy {field_name} field must be non-empty")
    return value[:max_length]


def _optional_str(value: Any, *, max_length: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise LLMProviderError("coreline proxy optional citation rationale must be a string or null")
    compact = value.strip()
    return compact[:max_length] if compact else None


def _string_list(value: Any, *, field_name: str) -> list[str]:
    if not isinstance(value, list):
        raise LLMProviderError(f"coreline proxy {field_name} field must be an array")
    return [str(item)[:300] for item in value if isinstance(item, str) and item.strip()]

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Sequence

from .llm_provider import LLMContextItem
from .models import Citation, EvidenceItem

MAX_SCHEMA_CONTEXT_ITEMS = 24
MAX_SCHEMA_QUOTE_CHARS = 4000
DEFAULT_MAX_CONTEXT_ITEMS = 8
DEFAULT_MAX_CONTEXT_CHARS = 8_000

LEGAL_ANSWER_INSTRUCTIONS = """당신은 Legal Graph Chat의 source-grounded 요약기입니다.
규칙:
- 제공된 context_items의 quote, rationale, metadata만 사용하세요. 외부 지식이나 추측을 추가하지 마세요.
- 법률 자문, 소송 결과 예측, 행동 권고를 하지 마세요.
- 답변은 한국어로 작성하고, 불확실하면 부족한 근거를 명시하세요.
- citations에는 반드시 요청 context_items[].id 중 하나만 source_id로 사용하세요.
- 원문 전문이 아닌 제한된 발췌만 제공되었음을 전제로 신중하게 요약하세요.
""".strip()


@dataclass(frozen=True)
class PackedAnswerContext:
    items: list[LLMContextItem]
    citations_by_context_id: dict[str, Citation]


def pack_answer_context(
    citations: Sequence[Citation],
    evidence: Sequence[EvidenceItem],
    *,
    max_items: int = DEFAULT_MAX_CONTEXT_ITEMS,
    max_chars: int = DEFAULT_MAX_CONTEXT_CHARS,
) -> PackedAnswerContext:
    """Convert graph citations/evidence into bounded proxy context items.

    The packer intentionally sends only existing bounded quote/rationale metadata,
    never full source document contents.
    """

    safe_max_items = max(1, min(int(max_items), MAX_SCHEMA_CONTEXT_ITEMS))
    safe_max_chars = max(500, int(max_chars))
    evidence_by_id = {item.id: item for item in evidence}
    items: list[LLMContextItem] = []
    citation_map: dict[str, Citation] = {}
    used_ids: set[str] = set()
    chars_used = 0

    for citation in citations[:safe_max_items]:
        context_id = _safe_context_id(citation.id, used_ids)
        evidence_item = evidence_by_id.get(citation.id)
        quote = _context_quote(citation, evidence_item)
        remaining = safe_max_chars - chars_used
        if remaining <= 0:
            break
        quote = _truncate(quote, min(MAX_SCHEMA_QUOTE_CHARS, remaining))
        if not quote:
            continue
        item = LLMContextItem(
            id=context_id,
            kind="graph_evidence",
            title=_truncate(_compact(citation.label) or context_id, 300),
            source_path=_truncate(citation.source_file, 500),
            source_url=_truncate(citation.source_url, 1000),
            quote=quote,
            metadata={
                "original_citation_id": citation.id,
                "node_id": citation.node_id,
                "target": citation.target,
                "relation": citation.relation,
                "rationale": _truncate(citation.rationale, 500),
                "confidence": evidence_item.confidence if evidence_item else None,
                "community": evidence_item.community if evidence_item else None,
                "degree": evidence_item.degree if evidence_item else None,
                "score": evidence_item.score if evidence_item else None,
            },
        )
        items.append(item)
        citation_map[context_id] = citation
        chars_used += len(item.quote)
        if len(items) >= safe_max_items:
            break

    return PackedAnswerContext(items=items, citations_by_context_id=citation_map)


def _context_quote(citation: Citation, evidence_item: EvidenceItem | None) -> str:
    parts: list[str] = []
    if citation.quote:
        parts.append(_compact(citation.quote))
    if citation.rationale:
        parts.append(f"rationale: {_compact(citation.rationale)}")
    if evidence_item and evidence_item.rationale and evidence_item.rationale != citation.rationale:
        parts.append(f"graph rationale: {_compact(evidence_item.rationale)}")
    if citation.relation:
        parts.append(f"relation: {_compact(citation.relation)}")
    if citation.source_file or citation.source_url:
        parts.append(f"source: {_compact(citation.source_file or citation.source_url or '')}")
    if not parts:
        parts.append(_compact(citation.label))
    return " | ".join(part for part in parts if part)


def _safe_context_id(raw: str, used_ids: set[str]) -> str:
    compact = re.sub(r"[^0-9A-Za-z가-힣._:-]+", "-", raw.strip())[:120] or "context"
    if compact not in used_ids:
        used_ids.add(compact)
        return compact
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:8]
    base = compact[:111]
    candidate = f"{base}-{digest}"
    index = 2
    while candidate in used_ids:
        suffix = f"-{digest}-{index}"
        candidate = f"{base[: 120 - len(suffix)]}{suffix}"
        index += 1
    used_ids.add(candidate)
    return candidate


def _compact(value: str | None) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _truncate(value: str | None, max_chars: int) -> str:
    compact = _compact(value)
    if len(compact) <= max_chars:
        return compact
    if max_chars <= 1:
        return compact[:max_chars]
    return compact[: max_chars - 1].rstrip() + "…"

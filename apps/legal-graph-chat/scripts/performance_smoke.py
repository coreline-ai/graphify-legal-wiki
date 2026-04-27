#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


APP_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = APP_ROOT / "backend"
REPO_ROOT = APP_ROOT.parents[1]


@dataclass
class SmokeResult:
    name: str
    method: str
    path: str
    status_code: int
    latency_ms: float
    payload_bytes: int
    node_count: int | None = None
    edge_count: int | None = None
    community_count: int | None = None
    warning_count: int | None = None
    skipped: bool = False
    skip_reason: str | None = None
    error: str | None = None


class LocalClient:
    def __init__(self) -> None:
        for path in (BACKEND_ROOT, REPO_ROOT):
            value = str(path)
            if value not in sys.path:
                sys.path.insert(0, value)
        from fastapi.testclient import TestClient
        from app.main import app

        self._client = TestClient(app)

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, bytes, Any]:
        response = self._client.request(method, path, json=body)
        return response.status_code, response.content, response.json()


class UrlClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, bytes, Any]:
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                content = response.read()
                return response.status, content, json.loads(content.decode("utf-8"))
        except urllib.error.HTTPError as exc:
            content = exc.read()
            try:
                payload = json.loads(content.decode("utf-8"))
            except json.JSONDecodeError:
                payload = {"message": content.decode("utf-8", errors="replace")}
            return exc.code, content, payload


def payload_size(content: bytes, payload: Any) -> int:
    if content:
        return len(content)
    return len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def counts(payload: Any) -> tuple[int | None, int | None, int | None, int | None]:
    if not isinstance(payload, dict):
        return None, None, None, None
    graph = payload.get("graph") if isinstance(payload.get("graph"), dict) else payload
    node_count = len(graph["nodes"]) if isinstance(graph.get("nodes"), list) else payload.get("nodes")
    edge_count = len(graph["edges"]) if isinstance(graph.get("edges"), list) else payload.get("edges")
    community_count = len(payload["communities"]) if isinstance(payload.get("communities"), list) else payload.get("communities")
    warnings = graph.get("warnings") if isinstance(graph, dict) else payload.get("warnings")
    warning_count = len(warnings) if isinstance(warnings, list) else None
    return as_int(node_count), as_int(edge_count), as_int(community_count), warning_count


def as_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def run_request(
    client: LocalClient | UrlClient,
    name: str,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    *,
    optional: bool = False,
) -> tuple[SmokeResult, Any]:
    start = time.perf_counter()
    try:
        status_code, content, payload = client.request(method, path, body)
        latency_ms = (time.perf_counter() - start) * 1000
        node_count, edge_count, community_count, warning_count = counts(payload)
        skipped = optional and status_code in {404, 405}
        skip_reason = "optional endpoint is not implemented by this backend yet" if skipped else None
        result = SmokeResult(
            name=name,
            method=method,
            path=path,
            status_code=status_code,
            latency_ms=latency_ms,
            payload_bytes=payload_size(content, payload),
            node_count=node_count,
            edge_count=edge_count,
            community_count=community_count,
            warning_count=warning_count,
            skipped=skipped,
            skip_reason=skip_reason,
            error=None if skipped or 200 <= status_code < 300 else json.dumps(payload, ensure_ascii=False)[:240],
        )
        return result, payload
    except Exception as exc:  # noqa: BLE001 - smoke script should report and continue to summary
        latency_ms = (time.perf_counter() - start) * 1000
        return (
            SmokeResult(
                name=name,
                method=method,
                path=path,
                status_code=0,
                latency_ms=latency_ms,
                payload_bytes=0,
                skipped=False,
                skip_reason=None,
                error=f"{type(exc).__name__}: {exc}",
            ),
            {},
        )


def first_focus_node(query_payload: dict[str, Any]) -> str | None:
    rank_reason = query_payload.get("rank_reason") if isinstance(query_payload, dict) else None
    seeds = rank_reason.get("seed_nodes") if isinstance(rank_reason, dict) else None
    if isinstance(seeds, list) and seeds:
        first = seeds[0]
        if isinstance(first, dict) and first.get("id"):
            return str(first["id"])
    graph = query_payload.get("graph") if isinstance(query_payload.get("graph"), dict) else {}
    nodes = graph.get("nodes") if isinstance(graph, dict) else None
    if isinstance(nodes, list) and nodes:
        first = nodes[0]
        if isinstance(first, dict) and first.get("id"):
            return str(first["id"])
    return None


def print_table(results: list[SmokeResult]) -> None:
    header = (
        "name",
        "status",
        "result",
        "latency_ms",
        "bytes",
        "nodes",
        "edges",
        "communities",
        "warnings",
    )
    rows = [
        (
            r.name,
            "SKIP" if r.skipped else str(r.status_code),
            "skip" if r.skipped else ("ok" if 200 <= r.status_code < 300 else "fail"),
            f"{r.latency_ms:.1f}",
            str(r.payload_bytes),
            "" if r.node_count is None else str(r.node_count),
            "" if r.edge_count is None else str(r.edge_count),
            "" if r.community_count is None else str(r.community_count),
            "" if r.warning_count is None else str(r.warning_count),
        )
        for r in results
    ]
    widths = [max(len(row[i]) for row in [header, *rows]) for i in range(len(header))]
    print(" | ".join(header[i].ljust(widths[i]) for i in range(len(header))))
    print("-+-".join("-" * width for width in widths))
    for row in rows:
        print(" | ".join(row[i].ljust(widths[i]) for i in range(len(row))))


def main() -> int:
    parser = argparse.ArgumentParser(description="Legal Graph Chat backend performance smoke against the real graph.")
    parser.add_argument("--base-url", help="Running backend base URL. If omitted, imports FastAPI app via TestClient.")
    parser.add_argument("--question", default="민법", help="Query text used for /query and /subgraph/3d.")
    parser.add_argument("--precedent-query", default=None, help="Query text used for /precedents/search. Defaults to --question.")
    parser.add_argument("--precedent-limit", type=int, default=5, help="Result limit used for /precedents/search.")
    parser.add_argument("--include-all", action="store_true", help="Also call /graph/full-3d?edge_mode=all&confirm_all_edges=true. Disabled by default because it can return 176k+ edges.")
    parser.add_argument("--strict-optional", action="store_true", help="Treat missing optional /answer and /precedents endpoints as failures instead of skips.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON instead of a table.")
    args = parser.parse_args()

    client: LocalClient | UrlClient = UrlClient(args.base_url) if args.base_url else LocalClient()
    results: list[SmokeResult] = []
    query_payload: dict[str, Any] = {}

    for name, method, path, body in [
        ("health", "GET", "/health", None),
        ("query", "POST", "/query", {"question": args.question, "max_nodes": 80, "max_edges": 240, "depth": 1}),
        ("subgraph_3d", "POST", "/subgraph/3d", {"question": args.question, "max_nodes": 120, "max_edges": 500}),
        ("communities_3d", "GET", "/communities/3d", None),
        ("full_3d_hidden", "GET", "/graph/full-3d?edge_mode=hidden", None),
    ]:
        result, payload = run_request(client, name, method, path, body)
        results.append(result)
        if name == "query":
            query_payload = payload

    focus_node_id = first_focus_node(query_payload if isinstance(query_payload, dict) else {})
    focus_path = "/graph/full-3d?edge_mode=focus"
    if focus_node_id:
        focus_path += "&" + urllib.parse.urlencode({"focus_node_id": focus_node_id})
    result, _ = run_request(client, "full_3d_focus", "GET", focus_path, None)
    results.append(result)

    if args.include_all:
        result, _ = run_request(client, "full_3d_all", "GET", "/graph/full-3d?edge_mode=all&confirm_all_edges=true", None)
        results.append(result)

    precedent_query = args.precedent_query or args.question
    optional_requests: list[tuple[str, str, str, dict[str, Any] | None]] = [
        ("answer", "POST", "/answer", {"question": args.question}),
        ("precedents_health", "GET", "/precedents/health", None),
        (
            "precedents_search",
            "GET",
            "/precedents/search?" + urllib.parse.urlencode({"q": precedent_query, "limit": args.precedent_limit}),
            None,
        ),
    ]
    for name, method, path, body in optional_requests:
        result, _ = run_request(client, name, method, path, body, optional=not args.strict_optional)
        results.append(result)

    if args.json:
        print(json.dumps([r.__dict__ for r in results], ensure_ascii=False, indent=2))
    else:
        print_table(results)
        failures = [r for r in results if not r.skipped and not (200 <= r.status_code < 300)]
        skipped = [r for r in results if r.skipped]
        if failures:
            print("\nFailures:")
            for failure in failures:
                print(f"- {failure.name}: {failure.error}")
        if skipped:
            print("\nSkipped optional endpoints:")
            for item in skipped:
                print(f"- {item.name}: {item.skip_reason} ({item.method} {item.path} returned {item.status_code})")
        if not args.include_all:
            print("\nSkipped full_3d_all by default. Use --include-all only when intentionally measuring the full 176k-edge payload.")

    return 0 if all(r.skipped or 200 <= r.status_code < 300 for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())

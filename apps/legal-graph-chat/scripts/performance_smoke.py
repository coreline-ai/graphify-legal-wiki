#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import struct
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
    process_time_ms: float | None = None
    decoded_header_bytes: int | None = None
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

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, bytes, Any, dict[str, str]]:
        response = self._client.request(method, path, json=body)
        headers = {str(key).lower(): str(value) for key, value in response.headers.items()}
        return response.status_code, response.content, decode_payload(response.content, headers), headers


class UrlClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, bytes, Any, dict[str, str]]:
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                content = response.read()
                response_headers = {str(key).lower(): str(value) for key, value in response.headers.items()}
                return response.status, content, decode_payload(content, response_headers), response_headers
        except urllib.error.HTTPError as exc:
            content = exc.read()
            response_headers = {str(key).lower(): str(value) for key, value in exc.headers.items()}
            try:
                payload = json.loads(content.decode("utf-8"))
            except json.JSONDecodeError:
                payload = {"message": content.decode("utf-8", errors="replace")}
            return exc.code, content, payload, response_headers


def decode_payload(content: bytes, headers: dict[str, str]) -> Any:
    content_type = headers.get("content-type", "")
    if "application/json" in content_type:
        return json.loads(content.decode("utf-8"))
    if len(content) >= 9 and content[:5] in {b"GF3D\x01", b"GF3E\x01", b"GF3N\x01"}:
        header_length = struct.unpack("<I", content[5:9])[0]
        header_end = 9 + header_length
        header = json.loads(content[9:header_end].decode("utf-8")) if header_end <= len(content) else {}
        return {
            "binary_magic": content[:5].decode("latin1"),
            "binary_header_bytes": header_length,
            "binary_header": header,
        }
    if not content:
        return {}
    return {"message": content[:240].decode("utf-8", errors="replace")}


def payload_size(content: bytes, payload: Any) -> int:
    if content:
        return len(content)
    return len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def counts(payload: Any) -> tuple[int | None, int | None, int | None, int | None]:
    if not isinstance(payload, dict):
        return None, None, None, None
    binary_header = payload.get("binary_header")
    if isinstance(binary_header, dict):
        node_count = first_present(binary_header.get("node_count"), binary_header.get("nodes_in_scope"))
        edge_count = first_present(binary_header.get("edge_count"), binary_header.get("returned_edges"), binary_header.get("total_edges"))
        warnings = binary_header.get("warnings")
        warning_count = len(warnings) if isinstance(warnings, list) else None
        return as_int(node_count), as_int(edge_count), None, warning_count
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


def first_present(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


def parse_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
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
        status_code, content, payload, headers = client.request(method, path, body)
        latency_ms = (time.perf_counter() - start) * 1000
        node_count, edge_count, community_count, warning_count = counts(payload)
        skipped = optional and status_code in {404, 405}
        skip_reason = "optional endpoint is not implemented by this backend yet" if skipped else None
        decoded_header_bytes = as_int(payload.get("binary_header_bytes")) if isinstance(payload, dict) else None
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
            process_time_ms=parse_float(headers.get("x-process-time-ms")),
            decoded_header_bytes=decoded_header_bytes,
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
        "process_ms",
        "bytes",
        "header_bytes",
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
            "" if r.process_time_ms is None else f"{r.process_time_ms:.1f}",
            str(r.payload_bytes),
            "" if r.decoded_header_bytes is None else str(r.decoded_header_bytes),
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
    parser.add_argument("--include-edge-tiles", action="store_true", help="Also measure first JSON/binary full-3d edge tile using confirm_all_edges=true.")
    parser.add_argument("--tile-size", type=int, default=25_000, help="Tile size used with --include-edge-tiles.")
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
        ("full_3d_binary_hidden", "GET", "/graph/full-3d/binary?edge_mode=hidden", None),
        ("full_3d_nodes_binary", "GET", "/graph/full-3d/nodes/binary", None),
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

    if args.include_edge_tiles:
        tile_query = urllib.parse.urlencode({"edge_mode": "all", "confirm_all_edges": "true", "tile": 0, "tile_size": args.tile_size})
        for name, path in [
            ("full_3d_edge_tile_json", f"/graph/full-3d/edge-tile?{tile_query}"),
            ("full_3d_edge_tile_binary", f"/graph/full-3d/edge-tile/binary?{tile_query}"),
        ]:
            result, _ = run_request(client, name, "GET", path, None)
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
        if not args.include_edge_tiles:
            print("\nSkipped edge tile measurements by default. Use --include-edge-tiles to measure JSON/binary tile payloads.")

    return 0 if all(r.skipped or 200 <= r.status_code < 300 for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1] / "backend"
REPO_ROOT = Path(__file__).resolve().parents[3]
for candidate in (BACKEND_ROOT, REPO_ROOT):
    value = str(candidate)
    if value not in sys.path:
        sys.path.insert(0, value)

from app.precedent_index import create_precedent_index  # noqa: E402

DEFAULT_QUERIES = [
    {"query": "민법 손해배상", "expect_path_contains": ""},
    {"query": "개인정보 보호", "expect_path_contains": ""},
]


def default_precedent_root() -> Path:
    raw = os.environ.get("LEGAL_GRAPH_PRECEDENT_ROOT", "").strip()
    if raw:
        path = Path(raw).expanduser()
        return path if path.is_absolute() else (REPO_ROOT / path).resolve()
    return REPO_ROOT / "data" / "precedent-kr"


def load_suite(path: Path | None) -> list[dict[str, Any]]:
    if path is None:
        return DEFAULT_QUERIES
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("suite JSON must be a list of query objects")
    return data


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Smoke-evaluate precedent retrieval.")
    parser.add_argument("--root", type=Path, default=default_precedent_root())
    parser.add_argument("--backend", choices=["filesystem", "postgres", "sqlite"], default=os.environ.get("LEGAL_GRAPH_INDEX_BACKEND", "filesystem"))
    parser.add_argument("--suite", type=Path, default=None, help="JSON list with query and optional expect_path_contains")
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    root = args.root.expanduser()
    if not root.is_absolute():
        root = (Path.cwd() / root).resolve()
    index = create_precedent_index(root, backend=args.backend)
    suite = load_suite(args.suite)
    rows: list[dict[str, Any]] = []
    passed = 0
    for item in suite:
        query = str(item.get("query") or "")
        expected = str(item.get("expect_path_contains") or "")
        response = index.search(query, limit=args.limit)
        top_paths = [result.path for result in response.results]
        ok = bool(top_paths) if not expected else any(expected in path for path in top_paths)
        passed += int(ok)
        rows.append({"query": query, "ok": ok, "expected": expected, "top_paths": top_paths, "warnings": response.warnings})
    payload = {"backend": getattr(index, "backend", args.backend), "passed": passed, "total": len(suite), "results": rows}
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(f"backend={payload['backend']} passed={passed}/{len(suite)}")
        for row in rows:
            mark = "PASS" if row["ok"] else "FAIL"
            print(f"[{mark}] {row['query']} -> {row['top_paths'][:3]} warnings={row['warnings']}")
    return 0 if passed == len(suite) else 1


if __name__ == "__main__":
    raise SystemExit(main())

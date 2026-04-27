#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

BACKEND_ROOT = Path(__file__).resolve().parents[1] / "backend"
REPO_ROOT = Path(__file__).resolve().parents[3]
for candidate in (BACKEND_ROOT, REPO_ROOT):
    value = str(candidate)
    if value not in sys.path:
        sys.path.insert(0, value)

from app.db import DatabaseUnavailable, connect_postgres, connect_sqlite, database_url_from_env, postgres_availability, sqlite_path_from_env  # noqa: E402
from app.precedent_index import chunk_text, iter_markdown_paths, parse_precedent_file  # noqa: E402

SQLITE_SCHEMA = """
CREATE TABLE IF NOT EXISTS precedent_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    category TEXT,
    court TEXT,
    case_number TEXT,
    case_name TEXT,
    court_name TEXT,
    court_level TEXT,
    case_type TEXT,
    decision_date TEXT,
    source_url TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    body TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    body_hash TEXT NOT NULL,
    search_text TEXT NOT NULL DEFAULT '',
    indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS precedent_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES precedent_documents(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    token_count INTEGER,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (document_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_precedent_documents_category ON precedent_documents (category);
CREATE INDEX IF NOT EXISTS idx_precedent_documents_court ON precedent_documents (court);
CREATE INDEX IF NOT EXISTS idx_precedent_documents_case_number ON precedent_documents (case_number);
CREATE INDEX IF NOT EXISTS idx_precedent_documents_court_name ON precedent_documents (court_name);
CREATE INDEX IF NOT EXISTS idx_precedent_documents_decision_date ON precedent_documents (decision_date);
CREATE INDEX IF NOT EXISTS idx_precedent_documents_body_hash ON precedent_documents (body_hash);
CREATE INDEX IF NOT EXISTS idx_precedent_documents_search_text ON precedent_documents (search_text);
CREATE INDEX IF NOT EXISTS idx_precedent_chunks_document_id ON precedent_chunks (document_id);
CREATE INDEX IF NOT EXISTS idx_precedent_chunks_path ON precedent_chunks (path);
"""


@dataclass
class IndexStats:
    backend: str
    scanned: int = 0
    inserted: int = 0
    updated: int = 0
    skipped: int = 0
    chunks_written: int = 0
    dry_run: bool = False
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "backend": self.backend,
            "scanned": self.scanned,
            "inserted": self.inserted,
            "updated": self.updated,
            "skipped": self.skipped,
            "chunks_written": self.chunks_written,
            "dry_run": self.dry_run,
            "warnings": self.warnings,
        }


def default_repo_root() -> Path:
    return REPO_ROOT


def default_precedent_root() -> Path:
    raw = os.environ.get("LEGAL_GRAPH_PRECEDENT_ROOT", "").strip()
    if raw:
        path = Path(raw).expanduser()
        return path if path.is_absolute() else (default_repo_root() / path).resolve()
    return default_repo_root() / "data" / "precedent-kr"


def postgres_schema_path() -> Path:
    return BACKEND_ROOT / "sql" / "001_precedent_index.sql"


def iter_documents(root: Path, limit: int | None = None):
    count = 0
    for path in iter_markdown_paths(root):
        yield parse_precedent_file(path, root)
        count += 1
        if limit is not None and count >= limit:
            break


def ensure_sqlite_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SQLITE_SCHEMA)
    conn.commit()


def _text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def _metadata_json(metadata: dict[str, str]) -> str:
    return json.dumps(metadata, ensure_ascii=False, sort_keys=True)


def index_sqlite(*, root: Path, database_path: Path, dry_run: bool = False, limit: int | None = None, chunk_chars: int = 1_400) -> IndexStats:
    stats = IndexStats(backend="sqlite", dry_run=dry_run)
    if dry_run:
        if database_path.exists():
            conn = connect_sqlite(database_path, readonly=True)
        else:
            conn = sqlite3.connect(":memory:")
            conn.row_factory = sqlite3.Row
            ensure_sqlite_schema(conn)
    else:
        conn = connect_sqlite(database_path, readonly=False)
        ensure_sqlite_schema(conn)
    try:
        for doc in iter_documents(root, limit=limit):
            stats.scanned += 1
            existing = conn.execute("SELECT id, body_hash FROM precedent_documents WHERE path = ?", (doc.path,)).fetchone()
            if existing and existing["body_hash"] == doc.body_hash:
                stats.skipped += 1
                continue
            if existing:
                stats.updated += 1
            else:
                stats.inserted += 1
            chunks = chunk_text(doc.body, max_chars=chunk_chars)
            stats.chunks_written += len(chunks)
            if dry_run:
                continue
            metadata_json = _metadata_json(doc.metadata)
            conn.execute(
                """
                INSERT INTO precedent_documents (
                    path, title, category, court, case_number, case_name, court_name, court_level,
                    case_type, decision_date, source_url, metadata, body, content, body_hash, search_text,
                    indexed_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT(path) DO UPDATE SET
                    title = excluded.title,
                    category = excluded.category,
                    court = excluded.court,
                    case_number = excluded.case_number,
                    case_name = excluded.case_name,
                    court_name = excluded.court_name,
                    court_level = excluded.court_level,
                    case_type = excluded.case_type,
                    decision_date = excluded.decision_date,
                    source_url = excluded.source_url,
                    metadata = excluded.metadata,
                    body = excluded.body,
                    content = excluded.content,
                    body_hash = excluded.body_hash,
                    search_text = excluded.search_text,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    doc.path,
                    doc.title,
                    doc.category,
                    doc.court,
                    doc.case_number,
                    doc.case_name,
                    doc.court_name,
                    doc.court_level,
                    doc.case_type,
                    doc.decision_date,
                    doc.source_url,
                    metadata_json,
                    doc.body,
                    doc.content,
                    doc.body_hash,
                    doc.search_text,
                ),
            )
            row = conn.execute("SELECT id FROM precedent_documents WHERE path = ?", (doc.path,)).fetchone()
            document_id = int(row["id"])
            conn.execute("DELETE FROM precedent_chunks WHERE document_id = ?", (document_id,))
            conn.executemany(
                """
                INSERT INTO precedent_chunks (document_id, path, ordinal, text, text_hash, token_count, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (document_id, doc.path, ordinal, chunk, _text_hash(chunk), len(chunk.split()), metadata_json)
                    for ordinal, chunk in enumerate(chunks)
                ],
            )
        if not dry_run:
            conn.commit()
    finally:
        conn.close()
    return stats


def apply_postgres_schema(database_url: str, schema_path: Path) -> None:
    sql = schema_path.read_text(encoding="utf-8")
    with connect_postgres(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(sql)


def index_postgres(
    *,
    root: Path,
    database_url: str,
    dry_run: bool = False,
    limit: int | None = None,
    chunk_chars: int = 1_400,
    apply_schema: bool = False,
    schema_path: Path | None = None,
) -> IndexStats:
    availability = postgres_availability(database_url)
    if not availability.ok:
        raise DatabaseUnavailable(availability.reason or "postgres unavailable")
    schema = schema_path or postgres_schema_path()
    if apply_schema and not dry_run:
        apply_postgres_schema(database_url, schema)
    stats = IndexStats(backend="postgres", dry_run=dry_run)
    with connect_postgres(database_url) as conn:
        for doc in iter_documents(root, limit=limit):
            stats.scanned += 1
            with conn.cursor() as cur:
                cur.execute("SELECT id, body_hash FROM precedent_documents WHERE path = %s", (doc.path,))
                existing = cur.fetchone()
                if existing and existing[1] == doc.body_hash:
                    stats.skipped += 1
                    continue
                if existing:
                    stats.updated += 1
                else:
                    stats.inserted += 1
                chunks = chunk_text(doc.body, max_chars=chunk_chars)
                stats.chunks_written += len(chunks)
                if dry_run:
                    continue
                metadata_json = _metadata_json(doc.metadata)
                cur.execute(
                    """
                    INSERT INTO precedent_documents (
                        path, title, category, court, case_number, case_name, court_name, court_level,
                        case_type, decision_date, source_url, metadata, body, content, body_hash, search_text,
                        indexed_at, updated_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, now(), now())
                    ON CONFLICT(path) DO UPDATE SET
                        title = excluded.title,
                        category = excluded.category,
                        court = excluded.court,
                        case_number = excluded.case_number,
                        case_name = excluded.case_name,
                        court_name = excluded.court_name,
                        court_level = excluded.court_level,
                        case_type = excluded.case_type,
                        decision_date = excluded.decision_date,
                        source_url = excluded.source_url,
                        metadata = excluded.metadata,
                        body = excluded.body,
                        content = excluded.content,
                        body_hash = excluded.body_hash,
                        search_text = excluded.search_text,
                        updated_at = now()
                    RETURNING id
                    """,
                    (
                        doc.path,
                        doc.title,
                        doc.category,
                        doc.court,
                        doc.case_number,
                        doc.case_name,
                        doc.court_name,
                        doc.court_level,
                        doc.case_type,
                        doc.decision_date,
                        doc.source_url,
                        metadata_json,
                        doc.body,
                        doc.content,
                        doc.body_hash,
                        doc.search_text,
                    ),
                )
                document_id = int(cur.fetchone()[0])
                cur.execute("DELETE FROM precedent_chunks WHERE document_id = %s", (document_id,))
                cur.executemany(
                    """
                    INSERT INTO precedent_chunks (document_id, path, ordinal, text, text_hash, token_count, metadata)
                    VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
                    """,
                    [
                        (document_id, doc.path, ordinal, chunk, _text_hash(chunk), len(chunk.split()), metadata_json)
                        for ordinal, chunk in enumerate(chunks)
                    ],
                )
    return stats


def scan_filesystem(*, root: Path, dry_run: bool = True, limit: int | None = None, chunk_chars: int = 1_400) -> IndexStats:
    stats = IndexStats(backend="filesystem", dry_run=dry_run, warnings=["filesystem backend is scan-only; no DB index is written"])
    for doc in iter_documents(root, limit=limit):
        stats.scanned += 1
        stats.skipped += 1
        stats.chunks_written += len(chunk_text(doc.body, max_chars=chunk_chars))
    return stats


def resolve_sqlite_path(value: str | None) -> Path:
    if value:
        path = Path(value).expanduser()
    else:
        env_path = sqlite_path_from_env()
        path = env_path if env_path is not None else BACKEND_ROOT / "precedents.sqlite"
    return path if path.is_absolute() else (Path.cwd() / path).resolve()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Index data/precedent-kr into PostgreSQL or SQLite.")
    parser.add_argument("--root", type=Path, default=default_precedent_root(), help="precedent corpus root; defaults to data/precedent-kr")
    parser.add_argument(
        "--backend",
        choices=["filesystem", "postgres", "sqlite"],
        default=os.environ.get("LEGAL_GRAPH_INDEX_BACKEND", "filesystem"),
        help="index backend to write; filesystem is scan-only",
    )
    parser.add_argument("--database-url", default=database_url_from_env(), help="PostgreSQL URL; defaults to LEGAL_GRAPH_DATABASE_URL")
    parser.add_argument("--sqlite-path", default=None, help="SQLite index path; defaults to LEGAL_GRAPH_SQLITE_PATH or backend/precedents.sqlite")
    parser.add_argument("--schema", type=Path, default=postgres_schema_path(), help="PostgreSQL schema SQL path")
    parser.add_argument("--apply-schema", action="store_true", help="apply PostgreSQL schema before indexing")
    parser.add_argument("--dry-run", action="store_true", help="parse and compare body_hash values without writing changes")
    parser.add_argument("--limit", type=int, default=None, help="limit documents for fixture smoke runs")
    parser.add_argument("--chunk-chars", type=int, default=1_400, help="target chunk size in characters")
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON stats")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    root = args.root.expanduser()
    if not root.is_absolute():
        root = (Path.cwd() / root).resolve()
    if not root.exists() or not root.is_dir():
        print(f"precedent root not found or not a directory: {root}", file=sys.stderr)
        return 2

    try:
        if args.backend == "sqlite":
            stats = index_sqlite(
                root=root,
                database_path=resolve_sqlite_path(args.sqlite_path),
                dry_run=args.dry_run,
                limit=args.limit,
                chunk_chars=args.chunk_chars,
            )
        elif args.backend == "postgres":
            if not args.database_url:
                raise DatabaseUnavailable("LEGAL_GRAPH_DATABASE_URL is not set")
            stats = index_postgres(
                root=root,
                database_url=args.database_url,
                dry_run=args.dry_run,
                limit=args.limit,
                chunk_chars=args.chunk_chars,
                apply_schema=args.apply_schema,
                schema_path=args.schema,
            )
        else:
            stats = scan_filesystem(root=root, dry_run=True, limit=args.limit, chunk_chars=args.chunk_chars)
    except (DatabaseUnavailable, sqlite3.Error) as exc:
        print(f"indexing failed: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(stats.as_dict(), ensure_ascii=False, indent=2))
    else:
        print(
            f"backend={stats.backend} scanned={stats.scanned} inserted={stats.inserted} "
            f"updated={stats.updated} skipped={stats.skipped} chunks={stats.chunks_written} dry_run={stats.dry_run}"
        )
        for warning in stats.warnings:
            print(f"warning: {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

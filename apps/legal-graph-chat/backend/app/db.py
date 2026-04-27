from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class DatabaseUnavailable(RuntimeError):
    """Raised when an optional index database cannot be used safely."""


@dataclass(frozen=True)
class DatabaseAvailability:
    backend: str
    ok: bool
    reason: str | None = None
    driver: str | None = None
    database_url_present: bool = False


def database_url_from_env() -> str | None:
    value = os.environ.get("LEGAL_GRAPH_DATABASE_URL", "").strip()
    if value:
        return value
    value_file = os.environ.get("LEGAL_GRAPH_DATABASE_URL_FILE", "").strip()
    if not value_file:
        return None
    try:
        return Path(value_file).expanduser().read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def sqlite_path_from_env() -> Path | None:
    value = (
        os.environ.get("LEGAL_GRAPH_SQLITE_PATH", "").strip()
        or os.environ.get("LEGAL_GRAPH_PRECEDENT_SQLITE_PATH", "").strip()
    )
    if not value:
        return None
    return Path(value).expanduser()


def postgres_availability(database_url: str | None = None) -> DatabaseAvailability:
    url = database_url or database_url_from_env()
    if not url:
        return DatabaseAvailability(
            backend="postgres",
            ok=False,
            reason="LEGAL_GRAPH_DATABASE_URL is not set",
            database_url_present=False,
        )
    try:
        import psycopg  # noqa: F401
    except ModuleNotFoundError:
        return DatabaseAvailability(
            backend="postgres",
            ok=False,
            reason="psycopg driver is not installed; install backend requirements or psycopg[binary]",
            database_url_present=True,
        )
    return DatabaseAvailability(backend="postgres", ok=True, driver="psycopg", database_url_present=True)


def connect_postgres(database_url: str | None = None, *, autocommit: bool = True) -> Any:
    url = database_url or database_url_from_env()
    availability = postgres_availability(url)
    if not availability.ok:
        raise DatabaseUnavailable(availability.reason or "postgres database is unavailable")
    import psycopg

    return psycopg.connect(url, autocommit=autocommit)


def connect_sqlite(database_path: str | Path, *, readonly: bool = False) -> sqlite3.Connection:
    path = Path(database_path).expanduser()
    if readonly:
        if not path.exists():
            raise DatabaseUnavailable(f"sqlite index does not exist: {path}")
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

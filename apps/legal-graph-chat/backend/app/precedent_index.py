from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Protocol

from .db import DatabaseUnavailable, connect_postgres, connect_sqlite, database_url_from_env, postgres_availability, sqlite_path_from_env
from .models import PrecedentHealthResponse, PrecedentSearchResponse, PrecedentSearchResult, SourceResponse

TOKEN_RE = re.compile(r"[0-9A-Za-z가-힣ㆍ·]+")
MARKDOWN_SUFFIXES = {".md", ".markdown"}
DEFAULT_CHUNK_CHARS = 1_400


class PrecedentIndex(Protocol):
    backend: str
    root: Path | None

    def health(self) -> PrecedentHealthResponse: ...

    def search(self, query: str, limit: int = 10, category: str | None = None, court: str | None = None) -> PrecedentSearchResponse: ...

    def source(self, source_path: str, max_chars: int = 40_000) -> SourceResponse: ...


def env_enabled(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def normalize_text(text: Any) -> str:
    return re.sub(r"\s+", "", str(text or "").lower()).replace("·", "ㆍ")


def tokenize(text: str) -> list[str]:
    terms = [normalize_text(m.group(0)) for m in TOKEN_RE.finditer(text)]
    return [term for term in terms if len(term) >= 2]


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---"):
        return {}, text
    match = re.search(r"^---\s*\n(.*?)\n---\s*\n?", text, flags=re.S)
    if not match:
        return {}, text
    metadata: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        metadata[key.strip()] = value.strip().strip("'\"")
    return metadata, text[match.end() :]


def first_heading(text: str) -> str | None:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            return stripped.lstrip("#").strip() or None
    return None


def compact_snippet(text: str, max_chars: int = 500) -> str | None:
    lines: list[str] = []
    total = 0
    for line in text.splitlines():
        stripped = re.sub(r"\s+", " ", line).strip()
        if not stripped or stripped.startswith("#"):
            continue
        lines.append(stripped)
        total += len(stripped)
        if total >= max_chars:
            break
    snippet = " ".join(lines).strip()
    return snippet[:max_chars] if snippet else None


def best_snippet(snippet: str | None, terms: list[str]) -> str | None:
    if not snippet:
        return None
    normalized_lines = [(line, normalize_text(line)) for line in re.split(r"(?<=[.!?。])\s+|\n+", snippet)]
    for line, normalized in normalized_lines:
        if any(term in normalized for term in terms):
            return line[:260]
    return snippet[:260]


def build_search_text(
    *,
    path: str,
    title: str,
    category: str | None,
    court: str | None,
    metadata: dict[str, str],
    snippet: str | None,
) -> str:
    return normalize_text(
        " ".join(
            [
                path,
                title,
                category or "",
                court or "",
                metadata.get("사건번호", ""),
                metadata.get("사건명", ""),
                metadata.get("법원명", ""),
                metadata.get("법원등급", ""),
                metadata.get("사건종류", ""),
                metadata.get("선고일자", ""),
                metadata.get("출처", ""),
                snippet or "",
            ]
        )
    )


def body_hash(body: str) -> str:
    return hashlib.sha256(body.encode("utf-8", errors="replace")).hexdigest()


def is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def validate_relative_markdown_path(source_path: str) -> Path:
    rel = Path(source_path)
    if rel.is_absolute() or ".." in rel.parts or any(part.startswith(".") for part in rel.parts):
        raise PermissionError("precedent path must be a relative markdown path inside data/precedent-kr")
    if rel.suffix.lower() not in MARKDOWN_SUFFIXES:
        raise PermissionError("precedent source viewer only serves markdown files")
    return rel


@dataclass(frozen=True)
class PrecedentDocument:
    path: str
    title: str
    category: str | None
    court: str | None
    metadata: dict[str, str]
    body: str
    content: str
    snippet: str | None
    search_text: str
    body_hash: str

    @property
    def case_number(self) -> str | None:
        return self.metadata.get("사건번호") or Path(self.path).stem

    @property
    def case_name(self) -> str | None:
        return self.metadata.get("사건명")

    @property
    def court_name(self) -> str | None:
        return self.metadata.get("법원명")

    @property
    def court_level(self) -> str | None:
        return self.metadata.get("법원등급")

    @property
    def case_type(self) -> str | None:
        return self.metadata.get("사건종류")

    @property
    def decision_date(self) -> str | None:
        return self.metadata.get("선고일자")

    @property
    def source_url(self) -> str | None:
        return self.metadata.get("출처")


def parse_precedent_content(content: str, rel_path: str) -> PrecedentDocument:
    rel = Path(rel_path)
    category = rel.parts[0] if rel.parts else None
    court = rel.parts[1] if len(rel.parts) > 1 else None
    metadata, body = parse_frontmatter(content)
    title = metadata.get("사건명") or first_heading(body) or rel.stem
    snippet = compact_snippet(body)
    search_text = build_search_text(path=rel.as_posix(), title=title, category=category, court=court, metadata=metadata, snippet=snippet)
    return PrecedentDocument(
        path=rel.as_posix(),
        title=title,
        category=category,
        court=court,
        metadata=metadata,
        body=body,
        content=content,
        snippet=snippet,
        search_text=search_text,
        body_hash=body_hash(body),
    )


def parse_precedent_file(path: Path, root: Path, *, max_chars: int | None = None) -> PrecedentDocument:
    rel = path.relative_to(root).as_posix()
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        content = fh.read(max_chars) if max_chars else fh.read()
    return parse_precedent_content(content, rel)


def iter_markdown_paths(root: Path) -> list[Path]:
    if not root.exists() or not root.is_dir():
        return []
    paths: list[Path] = []
    for path in root.rglob("*.md"):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        if len(rel.parts) < 3 or any(part.startswith(".") for part in rel.parts):
            continue
        paths.append(path)
    paths.sort(key=lambda item: item.relative_to(root).as_posix())
    return paths


def chunk_text(text: str, *, max_chars: int = DEFAULT_CHUNK_CHARS) -> list[str]:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n+", text) if p.strip()]
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        if len(paragraph) > max_chars:
            if current:
                chunks.append(current.strip())
                current = ""
            for i in range(0, len(paragraph), max_chars):
                chunks.append(paragraph[i : i + max_chars].strip())
            continue
        candidate = f"{current}\n\n{paragraph}".strip() if current else paragraph
        if len(candidate) > max_chars and current:
            chunks.append(current.strip())
            current = paragraph
        else:
            current = candidate
    if current:
        chunks.append(current.strip())
    return chunks or ([text[:max_chars].strip()] if text.strip() else [])


def _score_document(doc: PrecedentDocument, terms: list[str]) -> float:
    score = 0.0
    body_text = normalize_text(doc.body)
    searchable = doc.search_text if not body_text else f"{doc.search_text} {body_text}"
    title = normalize_text(doc.title)
    path = normalize_text(doc.path)
    metadata_values = normalize_text(" ".join(doc.metadata.values()))
    for term in terms:
        if term not in searchable:
            continue
        score += 1.0
        if term in title:
            score += 4.0
        if term in path:
            score += 2.0
        if term in metadata_values:
            score += 2.0
    if terms and all(term in searchable for term in terms):
        score += 2.0
    return round(score, 4)


def _result_from_document(doc: PrecedentDocument, score: float, terms: list[str]) -> PrecedentSearchResult:
    return PrecedentSearchResult(
        path=doc.path,
        title=doc.title,
        case_number=doc.metadata.get("사건번호"),
        case_name=doc.metadata.get("사건명"),
        court_name=doc.metadata.get("법원명"),
        court_level=doc.metadata.get("법원등급"),
        case_type=doc.metadata.get("사건종류"),
        decision_date=doc.metadata.get("선고일자"),
        category=doc.category,
        court=doc.court,
        source_url=doc.metadata.get("출처"),
        score=score,
        snippet=best_snippet(doc.snippet, terms),
    )


class FilesystemPrecedentIndex:
    backend = "filesystem"

    def __init__(self, root: Path, *, fallback_warnings: list[str] | None = None, backend_label: str = "filesystem") -> None:
        self.root = root
        self.backend = backend_label
        self._fallback_warnings = fallback_warnings or []
        self._index: list[PrecedentDocument] | None = None
        self._paths: list[Path] | None = None
        self._file_count: int | None = None

    def health(self) -> PrecedentHealthResponse:
        root = self.root
        warnings: list[str] = list(self._fallback_warnings)
        if not root.exists():
            return PrecedentHealthResponse(
                ok=False,
                status="missing",
                root_path=str(root),
                exists=False,
                file_count=0,
                category_count=0,
                categories=[],
                courts=[],
                warnings=warnings + ["precedent corpus root not found"],
                message=f"data/precedent-kr corpus is unavailable. backend={self.backend}",
            )
        if not root.is_dir():
            return PrecedentHealthResponse(
                ok=False,
                status="error",
                root_path=str(root),
                exists=True,
                file_count=0,
                category_count=0,
                categories=[],
                courts=[],
                warnings=warnings + ["precedent corpus root is not a directory"],
                message=f"data/precedent-kr must be a directory. backend={self.backend}",
            )

        categories: set[str] = set()
        courts: set[str] = set()
        paths = self._all_markdown_paths()
        file_count = len(paths)
        for path in paths:
            rel = path.relative_to(root)
            if rel.parts:
                categories.add(rel.parts[0])
            if len(rel.parts) > 1:
                courts.add(rel.parts[1])
        if file_count == 0:
            warnings.append("no markdown precedent files found")
        return PrecedentHealthResponse(
            ok=file_count > 0 and not any(w == "no markdown precedent files found" for w in warnings),
            status="ready" if file_count > 0 else "empty",
            root_path=str(root),
            exists=True,
            file_count=file_count,
            category_count=len(categories),
            categories=sorted(categories)[:100],
            courts=sorted(courts)[:100],
            warnings=warnings,
            message=f"precedent-kr corpus indexed from {root} (backend={self.backend})",
        )

    def search(self, query: str, limit: int = 10, category: str | None = None, court: str | None = None) -> PrecedentSearchResponse:
        terms = tokenize(query)
        safe_limit = max(1, min(limit, 50))
        warnings: list[str] = list(self._fallback_warnings)
        if not terms:
            warnings.append("empty_query")
            return PrecedentSearchResponse(query=query, results=[], limit=safe_limit, total_considered=0, warnings=list(dict.fromkeys(warnings)))

        records, limited = self._records_for_query(query, terms)
        if category:
            normalized_category = normalize_text(category)
            records = [record for record in records if normalize_text(record.category) == normalized_category]
        if court:
            normalized_court = normalize_text(court)
            records = [
                record
                for record in records
                if normalize_text(record.court) == normalized_court or normalize_text(record.metadata.get("법원명")) == normalized_court
            ]
        scored: list[tuple[float, PrecedentDocument]] = []
        for record in records:
            score = _score_document(record, terms)
            if score <= 0:
                continue
            scored.append((score, record))

        scored.sort(key=lambda item: (item[0], item[1].metadata.get("선고일자") or "", item[1].path), reverse=True)
        results = [_result_from_document(record, score, terms) for score, record in scored[:safe_limit]]
        if not results:
            warnings.append("no_match")
        if limited:
            warnings.append("candidate_limited")
        return PrecedentSearchResponse(query=query, results=results, limit=safe_limit, total_considered=len(records), warnings=list(dict.fromkeys(warnings)))

    def source(self, source_path: str, max_chars: int = 40_000) -> SourceResponse:
        if not env_enabled("LEGAL_GRAPH_PRECEDENT_SOURCE_VIEWER_ENABLED", default=True):
            raise PermissionError("precedent source viewer is disabled by backend configuration")
        target, rel = self._resolve_source(source_path)
        content = target.read_text(encoding="utf-8", errors="replace")
        truncated = len(content) > max_chars
        if truncated:
            content = content[:max_chars] + "\n... truncated by backend precedent source viewer limit ..."
        return SourceResponse(
            path=rel.as_posix(),
            content=content,
            language="markdown" if target.suffix.lower() in MARKDOWN_SUFFIXES else "text",
            truncated=truncated,
            start_line=1,
            end_line=content.count("\n") + 1,
        )

    def _ensure_index(self) -> list[PrecedentDocument]:
        if self._index is not None:
            return self._index
        if not self.root.exists() or not self.root.is_dir():
            self._index = []
            return self._index
        self._index = [parse_precedent_file(path, self.root, max_chars=6_000) for path in self._all_markdown_paths()]
        return self._index

    def _records_for_query(self, query: str, terms: list[str]) -> tuple[list[PrecedentDocument], bool]:
        paths = self._all_markdown_paths()
        if len(paths) <= 5_000:
            return self._ensure_index(), False

        candidates: dict[str, Path] = {}
        for path in self._path_candidates(terms, limit=250):
            candidates[path.relative_to(self.root).as_posix()] = path
        for path in self._ripgrep_candidates(query, terms, limit=1_000):
            candidates[path.relative_to(self.root).as_posix()] = path

        if not candidates:
            return [], False
        limited = len(candidates) >= 1_000
        records = [parse_precedent_file(path, self.root, max_chars=6_000) for path in candidates.values()]
        return records, limited

    def _all_markdown_paths(self) -> list[Path]:
        if self._paths is not None:
            return self._paths
        self._paths = iter_markdown_paths(self.root)
        self._file_count = len(self._paths)
        return self._paths

    def _path_candidates(self, terms: list[str], limit: int) -> list[Path]:
        matches: list[Path] = []
        for path in self._all_markdown_paths():
            rel = path.relative_to(self.root).as_posix()
            normalized = normalize_text(rel)
            if any(term in normalized for term in terms):
                matches.append(path)
                if len(matches) >= limit:
                    break
        return matches

    def _ripgrep_candidates(self, query: str, terms: list[str], limit: int) -> list[Path]:
        rg = shutil.which("rg")
        if not rg:
            return []
        search_terms = terms[:3] or [query]
        collected: dict[str, Path] = {}
        for term in search_terms:
            try:
                proc = subprocess.run(
                    [rg, "--files-with-matches", "--fixed-strings", "--ignore-case", "--glob", "*.md", term, str(self.root)],
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
            except (OSError, subprocess.SubprocessError):
                continue
            if proc.returncode not in {0, 1}:
                continue
            for line in proc.stdout.splitlines():
                try:
                    path = Path(line).resolve()
                    rel = path.relative_to(self.root.resolve())
                except ValueError:
                    continue
                if len(rel.parts) < 3 or any(part.startswith(".") for part in rel.parts) or path.suffix.lower() not in MARKDOWN_SUFFIXES:
                    continue
                collected[rel.as_posix()] = path
                if len(collected) >= limit:
                    return list(collected.values())
        return list(collected.values())

    def _resolve_source(self, source_path: str) -> tuple[Path, Path]:
        rel = validate_relative_markdown_path(source_path)
        target = (self.root / rel).resolve()
        root = self.root.resolve()
        if not is_relative_to(target, root):
            raise PermissionError("precedent path escapes data/precedent-kr")
        if not target.exists() or not target.is_file():
            raise FileNotFoundError(source_path)
        return target, rel


class SQLitePrecedentIndex:
    backend = "sqlite"

    def __init__(self, database_path: Path, *, root: Path | None = None) -> None:
        self.database_path = database_path
        self.root = root

    def health(self) -> PrecedentHealthResponse:
        warnings: list[str] = []
        if not self.database_path.exists():
            return PrecedentHealthResponse(
                ok=False,
                status="unavailable",
                root_path=str(self.database_path),
                exists=False,
                file_count=0,
                category_count=0,
                categories=[],
                courts=[],
                warnings=[f"sqlite index does not exist: {self.database_path}"],
                message="sqlite precedent index unavailable",
            )
        try:
            with connect_sqlite(self.database_path, readonly=True) as conn:
                file_count = int(conn.execute("SELECT COUNT(*) FROM precedent_documents").fetchone()[0])
                categories = [row[0] for row in conn.execute("SELECT DISTINCT category FROM precedent_documents WHERE category IS NOT NULL ORDER BY category LIMIT 100")]
                courts = [row[0] for row in conn.execute("SELECT DISTINCT court FROM precedent_documents WHERE court IS NOT NULL ORDER BY court LIMIT 100")]
        except (sqlite3.Error, DatabaseUnavailable) as exc:
            return PrecedentHealthResponse(
                ok=False,
                status="error",
                root_path=str(self.database_path),
                exists=True,
                file_count=0,
                category_count=0,
                categories=[],
                courts=[],
                warnings=[f"sqlite_error: {exc}"],
                message="sqlite precedent index cannot be read",
            )
        if file_count == 0:
            warnings.append("no indexed precedent documents found")
        return PrecedentHealthResponse(
            ok=file_count > 0,
            status="ready" if file_count > 0 else "empty",
            root_path=str(self.database_path),
            exists=True,
            file_count=file_count,
            category_count=len(categories),
            categories=categories,
            courts=courts,
            warnings=warnings,
            message=f"precedent index loaded from sqlite (backend=sqlite path={self.database_path})",
        )

    def search(self, query: str, limit: int = 10, category: str | None = None, court: str | None = None) -> PrecedentSearchResponse:
        terms = tokenize(query)
        safe_limit = max(1, min(limit, 50))
        warnings: list[str] = []
        if not terms:
            return PrecedentSearchResponse(query=query, results=[], limit=safe_limit, total_considered=0, warnings=["empty_query"])
        if not self.database_path.exists():
            return PrecedentSearchResponse(
                query=query,
                results=[],
                limit=safe_limit,
                total_considered=0,
                warnings=[f"sqlite_unavailable: {self.database_path}"],
            )

        where: list[str] = []
        params: list[Any] = []
        if category:
            where.append("category = ?")
            params.append(category)
        if court:
            where.append("(court = ? OR court_name = ?)")
            params.extend([court, court])
        term_clauses: list[str] = []
        for term in terms:
            term_clauses.append(
                "(search_text LIKE ? OR EXISTS ("
                "SELECT 1 FROM precedent_chunks c "
                "WHERE c.document_id = precedent_documents.id AND c.text LIKE ?"
                "))"
            )
            params.extend([f"%{term}%", f"%{term}%"])
        where.append("(" + " OR ".join(term_clauses) + ")")
        sql = f"""
            SELECT path, title, category, court, case_number, case_name, court_name, court_level,
                   case_type, decision_date, source_url, metadata, body, content, body_hash, search_text
            FROM precedent_documents
            WHERE {' AND '.join(where)}
            ORDER BY decision_date DESC, path ASC
            LIMIT 1000
        """
        try:
            with connect_sqlite(self.database_path, readonly=True) as conn:
                rows = list(conn.execute(sql, params))
        except (sqlite3.Error, DatabaseUnavailable) as exc:
            return PrecedentSearchResponse(query=query, results=[], limit=safe_limit, total_considered=0, warnings=[f"sqlite_error: {exc}"])

        docs = [_document_from_db_row(row) for row in rows]
        scored = [(score, doc) for doc in docs if (score := _score_document(doc, terms)) > 0]
        scored.sort(key=lambda item: (item[0], item[1].metadata.get("선고일자") or "", item[1].path), reverse=True)
        results = [_result_from_document(doc, score, terms) for score, doc in scored[:safe_limit]]
        if not results:
            warnings.append("no_match")
        if len(rows) >= 1000:
            warnings.append("candidate_limited")
        return PrecedentSearchResponse(query=query, results=results, limit=safe_limit, total_considered=len(rows), warnings=warnings)

    def source(self, source_path: str, max_chars: int = 40_000) -> SourceResponse:
        if not env_enabled("LEGAL_GRAPH_PRECEDENT_SOURCE_VIEWER_ENABLED", default=True):
            raise PermissionError("precedent source viewer is disabled by backend configuration")
        rel = validate_relative_markdown_path(source_path)
        if not self.database_path.exists():
            raise FileNotFoundError(source_path)
        with connect_sqlite(self.database_path, readonly=True) as conn:
            row = conn.execute("SELECT content FROM precedent_documents WHERE path = ?", (rel.as_posix(),)).fetchone()
        if row is None:
            raise FileNotFoundError(source_path)
        content = str(row[0] or "")
        truncated = len(content) > max_chars
        if truncated:
            content = content[:max_chars] + "\n... truncated by backend precedent source viewer limit ..."
        return SourceResponse(
            path=rel.as_posix(),
            content=content,
            language="markdown",
            truncated=truncated,
            start_line=1,
            end_line=content.count("\n") + 1,
        )


class PostgresPrecedentIndex:
    backend = "postgres"

    def __init__(self, database_url: str, *, root: Path | None = None, vector_enabled: bool | None = None) -> None:
        self.database_url = database_url
        self.root = root
        self.vector_enabled = env_enabled("LEGAL_GRAPH_PRECEDENT_VECTOR_ENABLED", default=False) if vector_enabled is None else vector_enabled
        self._capabilities: dict[str, bool] | None = None

    def health(self) -> PrecedentHealthResponse:
        try:
            with connect_postgres(self.database_url) as conn:
                caps = self._detect_capabilities(conn)
                with conn.cursor() as cur:
                    cur.execute("SELECT COUNT(*) FROM precedent_documents")
                    file_count = int(cur.fetchone()[0])
                    cur.execute("SELECT DISTINCT category FROM precedent_documents WHERE category IS NOT NULL ORDER BY category LIMIT 100")
                    categories = [row[0] for row in cur.fetchall()]
                    cur.execute("SELECT DISTINCT court FROM precedent_documents WHERE court IS NOT NULL ORDER BY court LIMIT 100")
                    courts = [row[0] for row in cur.fetchall()]
        except Exception as exc:  # noqa: BLE001 - API must report unavailable safely
            return PrecedentHealthResponse(
                ok=False,
                status="unavailable",
                root_path="postgres://LEGAL_GRAPH_DATABASE_URL",
                exists=False,
                file_count=0,
                category_count=0,
                categories=[],
                courts=[],
                warnings=[f"postgres_unavailable: {exc}"],
                message="postgres precedent index unavailable; filesystem fallback may be used by configuration",
            )
        warnings: list[str] = []
        if file_count == 0:
            warnings.append("no indexed precedent documents found")
        if caps.get("pgroonga"):
            warnings.append("search_capability=pgroonga")
        elif caps.get("pg_trgm"):
            warnings.append("search_capability=pg_trgm")
        else:
            warnings.append("search_capability=ilike")
        if not self.vector_enabled:
            warnings.append("vector_disabled")
        elif not caps.get("vector"):
            warnings.append("vector_extension_missing")
        return PrecedentHealthResponse(
            ok=file_count > 0,
            status="ready" if file_count > 0 else "empty",
            root_path="postgres://LEGAL_GRAPH_DATABASE_URL",
            exists=True,
            file_count=file_count,
            category_count=len(categories),
            categories=categories,
            courts=courts,
            warnings=warnings,
            message="precedent index loaded from PostgreSQL (backend=postgres)",
        )

    def search(self, query: str, limit: int = 10, category: str | None = None, court: str | None = None) -> PrecedentSearchResponse:
        terms = tokenize(query)
        safe_limit = max(1, min(limit, 50))
        if not terms:
            return PrecedentSearchResponse(query=query, results=[], limit=safe_limit, total_considered=0, warnings=["empty_query"])
        try:
            with connect_postgres(self.database_url) as conn:
                caps = self._detect_capabilities(conn)
                rows = self._search_rows(conn, query=query, terms=terms, category=category, court=court, capabilities=caps)
        except Exception as exc:  # noqa: BLE001 - return safe API warning instead of leaking stack traces
            return PrecedentSearchResponse(
                query=query,
                results=[],
                limit=safe_limit,
                total_considered=0,
                warnings=[f"postgres_unavailable: {exc}"],
            )
        docs = [_document_from_db_row(row) for row in rows]
        scored = [(score, doc) for doc in docs if (score := _score_document(doc, terms)) > 0]
        scored.sort(key=lambda item: (item[0], item[1].metadata.get("선고일자") or "", item[1].path), reverse=True)
        results = [_result_from_document(doc, score, terms) for score, doc in scored[:safe_limit]]
        warnings: list[str] = []
        if not results:
            warnings.append("no_match")
        if len(rows) >= 1000:
            warnings.append("candidate_limited")
        caps = self._capabilities or {}
        if caps.get("pgroonga"):
            warnings.append("search_capability=pgroonga")
        elif caps.get("pg_trgm"):
            warnings.append("search_capability=pg_trgm")
        else:
            warnings.append("search_capability=ilike")
        if not self.vector_enabled:
            warnings.append("vector_disabled")
        return PrecedentSearchResponse(query=query, results=results, limit=safe_limit, total_considered=len(rows), warnings=warnings)

    def source(self, source_path: str, max_chars: int = 40_000) -> SourceResponse:
        if not env_enabled("LEGAL_GRAPH_PRECEDENT_SOURCE_VIEWER_ENABLED", default=True):
            raise PermissionError("precedent source viewer is disabled by backend configuration")
        rel = validate_relative_markdown_path(source_path)
        try:
            with connect_postgres(self.database_url) as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT content FROM precedent_documents WHERE path = %s", (rel.as_posix(),))
                    row = cur.fetchone()
        except Exception as exc:  # noqa: BLE001
            raise FileNotFoundError(f"postgres precedent source unavailable: {exc}") from exc
        if row is None:
            raise FileNotFoundError(source_path)
        content = str(row[0] or "")
        truncated = len(content) > max_chars
        if truncated:
            content = content[:max_chars] + "\n... truncated by backend precedent source viewer limit ..."
        return SourceResponse(
            path=rel.as_posix(),
            content=content,
            language="markdown",
            truncated=truncated,
            start_line=1,
            end_line=content.count("\n") + 1,
        )

    def _detect_capabilities(self, conn: Any) -> dict[str, bool]:
        if self._capabilities is not None:
            return self._capabilities
        caps = {"pg_trgm": False, "pgroonga": False, "vector": False}
        with conn.cursor() as cur:
            cur.execute("SELECT extname FROM pg_extension WHERE extname = ANY(%s)", (["pg_trgm", "pgroonga", "vector"],))
            for (name,) in cur.fetchall():
                caps[str(name)] = True
        self._capabilities = caps
        return caps

    def _search_rows(
        self,
        conn: Any,
        *,
        query: str,
        terms: list[str],
        category: str | None,
        court: str | None,
        capabilities: dict[str, bool],
    ) -> list[Any]:
        where: list[str] = []
        params: list[Any] = []
        if category:
            where.append("category = %s")
            params.append(category)
        if court:
            where.append("(court = %s OR court_name = %s)")
            params.extend([court, court])
        if capabilities.get("pgroonga"):
            where.append(
                "(search_text &@~ %s OR EXISTS ("
                "SELECT 1 FROM precedent_chunks c "
                "WHERE c.document_id = precedent_documents.id AND c.text &@~ %s"
                "))"
            )
            params.extend([query, query])
            order_expr = "decision_date DESC NULLS LAST, path ASC"
        else:
            term_clauses: list[str] = []
            for term in terms:
                term_clauses.append(
                    "(search_text ILIKE %s OR EXISTS ("
                    "SELECT 1 FROM precedent_chunks c "
                    "WHERE c.document_id = precedent_documents.id AND c.text ILIKE %s"
                    "))"
                )
                params.extend([f"%{term}%", f"%{term}%"])
            where.append("(" + " OR ".join(term_clauses) + ")")
            if capabilities.get("pg_trgm"):
                order_expr = "GREATEST(" + ", ".join(["similarity(search_text, %s)" for _ in terms]) + ") DESC, decision_date DESC NULLS LAST, path ASC"
                params.extend(terms)
            else:
                order_expr = "decision_date DESC NULLS LAST, path ASC"
        sql = f"""
            SELECT path, title, category, court, case_number, case_name, court_name, court_level,
                   case_type, decision_date, source_url, metadata, body, content, body_hash, search_text
            FROM precedent_documents
            WHERE {' AND '.join(where)}
            ORDER BY {order_expr}
            LIMIT 1000
        """
        with conn.cursor() as cur:
            cur.execute(sql, tuple(params))
            return list(cur.fetchall())


class UnavailablePrecedentIndex:
    def __init__(self, backend: str, reason: str, *, root: Path | None = None) -> None:
        self.backend = backend
        self.reason = reason
        self.root = root

    def health(self) -> PrecedentHealthResponse:
        return PrecedentHealthResponse(
            ok=False,
            status="unavailable",
            root_path=str(self.root or ""),
            exists=False,
            file_count=0,
            category_count=0,
            categories=[],
            courts=[],
            warnings=[f"{self.backend}_unavailable: {self.reason}"],
            message=f"{self.backend} precedent index unavailable",
        )

    def search(self, query: str, limit: int = 10, category: str | None = None, court: str | None = None) -> PrecedentSearchResponse:
        return PrecedentSearchResponse(
            query=query,
            results=[],
            limit=max(1, min(limit, 50)),
            total_considered=0,
            warnings=[f"{self.backend}_unavailable: {self.reason}"],
        )

    def source(self, source_path: str, max_chars: int = 40_000) -> SourceResponse:
        validate_relative_markdown_path(source_path)
        raise FileNotFoundError(f"{self.backend} precedent index unavailable: {self.reason}")


def create_precedent_index(root: Path, *, backend: str | None = None) -> PrecedentIndex:
    requested = (backend or os.environ.get("LEGAL_GRAPH_INDEX_BACKEND", "filesystem")).strip().lower() or "filesystem"
    fallback_enabled = env_enabled("LEGAL_GRAPH_INDEX_FALLBACK_ENABLED", default=True)

    if requested == "filesystem":
        return FilesystemPrecedentIndex(root)

    if requested == "postgres":
        url = database_url_from_env()
        availability = postgres_availability(url)
        if not availability.ok:
            reason = availability.reason or "postgres unavailable"
            if fallback_enabled:
                return FilesystemPrecedentIndex(root, fallback_warnings=[f"postgres_unavailable: {reason}; using filesystem fallback"])
            return UnavailablePrecedentIndex("postgres", reason, root=root)
        return PostgresPrecedentIndex(url, root=root)

    if requested == "sqlite":
        sqlite_path = sqlite_path_from_env()
        if sqlite_path is None:
            reason = "LEGAL_GRAPH_SQLITE_PATH or LEGAL_GRAPH_PRECEDENT_SQLITE_PATH is not set"
            if fallback_enabled:
                return FilesystemPrecedentIndex(root, fallback_warnings=[f"sqlite_unavailable: {reason}; using filesystem fallback"])
            return UnavailablePrecedentIndex("sqlite", reason, root=root)
        if not sqlite_path.is_absolute():
            sqlite_path = Path.cwd() / sqlite_path
        if not sqlite_path.exists() and fallback_enabled:
            return FilesystemPrecedentIndex(root, fallback_warnings=[f"sqlite_unavailable: {sqlite_path} does not exist; using filesystem fallback"])
        return SQLitePrecedentIndex(sqlite_path, root=root)

    reason = f"unknown LEGAL_GRAPH_INDEX_BACKEND={requested!r}; expected filesystem|postgres|sqlite"
    if fallback_enabled:
        return FilesystemPrecedentIndex(root, fallback_warnings=[f"index_backend_unavailable: {reason}; using filesystem fallback"])
    return UnavailablePrecedentIndex(requested, reason, root=root)


def _metadata_from_db_value(value: Any) -> dict[str, str]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return {str(k): str(v) for k, v in value.items() if v is not None}
    try:
        loaded = json.loads(str(value))
    except json.JSONDecodeError:
        return {}
    if not isinstance(loaded, dict):
        return {}
    return {str(k): str(v) for k, v in loaded.items() if v is not None}


def _row_get(row: Any, key: str, index: int) -> Any:
    if isinstance(row, sqlite3.Row):
        return row[key]
    if isinstance(row, dict):
        return row.get(key)
    return row[index]


def _document_from_db_row(row: Any) -> PrecedentDocument:
    path = str(_row_get(row, "path", 0))
    title = str(_row_get(row, "title", 1) or Path(path).stem)
    category = _row_get(row, "category", 2)
    court = _row_get(row, "court", 3)
    metadata = _metadata_from_db_value(_row_get(row, "metadata", 11))
    body = str(_row_get(row, "body", 12) or "")
    content = str(_row_get(row, "content", 13) or body)
    search_text = str(_row_get(row, "search_text", 15) or "")
    metadata.setdefault("사건번호", str(_row_get(row, "case_number", 4) or ""))
    metadata.setdefault("사건명", str(_row_get(row, "case_name", 5) or ""))
    metadata.setdefault("법원명", str(_row_get(row, "court_name", 6) or ""))
    metadata.setdefault("법원등급", str(_row_get(row, "court_level", 7) or ""))
    metadata.setdefault("사건종류", str(_row_get(row, "case_type", 8) or ""))
    metadata.setdefault("선고일자", str(_row_get(row, "decision_date", 9) or ""))
    metadata.setdefault("출처", str(_row_get(row, "source_url", 10) or ""))
    metadata = {key: value for key, value in metadata.items() if value}
    snippet = compact_snippet(body)
    if not search_text:
        search_text = build_search_text(path=path, title=title, category=category, court=court, metadata=metadata, snippet=snippet)
    return PrecedentDocument(
        path=path,
        title=title,
        category=str(category) if category else None,
        court=str(court) if court else None,
        metadata=metadata,
        body=body,
        content=content,
        snippet=snippet,
        search_text=search_text,
        body_hash=str(_row_get(row, "body_hash", 14) or body_hash(body)),
    )

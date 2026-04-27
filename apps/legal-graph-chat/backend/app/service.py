from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
from collections import Counter, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import networkx as nx
from networkx.readwrite import json_graph

from .answer_context import LEGAL_ANSWER_INSTRUCTIONS, pack_answer_context
from .llm_provider import (
    CorelineCodexProxyProvider,
    LLMAnswerCitation,
    LLMAnswerProvider,
    LLMAnswerRequest,
    LLMProviderError,
)
from .precedent_index import create_precedent_index
from .models import (
    AnswerMode,
    AnswerRequest,
    AnswerResponse,
    Citation,
    CommunityDTO,
    CommunityPayloadDTO,
    EdgeMode,
    EvidenceItem,
    GraphEdgeDTO,
    GraphNodeDTO,
    GraphPayloadDTO,
    HealthResponse,
    LayoutMode,
    PathResponse,
    PrecedentHealthResponse,
    PrecedentSearchResponse,
    PrecedentSearchResult,
    QueryRequest,
    QueryResponse,
    RankReason,
    SourceResponse,
)

TOKEN_RE = re.compile(r"[0-9A-Za-z가-힣ㆍ·]+")
ANSWER_DISCLAIMER = "이 응답은 graph/source evidence 탐색 결과이며 법률 자문, 법적 판단 또는 행동 권고가 아닙니다. 반드시 원문과 전문가 검토로 확인하세요."


def env_enabled(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class GraphPaths:
    repo_root: Path
    data_root: Path
    out_dir: Path
    graph_path: Path
    summary_path: Path
    report_path: Path
    precedent_root: Path | None = None


def default_paths() -> GraphPaths:
    repo_root = Path(__file__).resolve().parents[4]
    raw_source_root = os.environ.get("LEGAL_GRAPH_SOURCE_ROOT", "").strip()
    if raw_source_root:
        data_root = Path(raw_source_root).expanduser()
        if not data_root.is_absolute():
            data_root = (repo_root / data_root).resolve()
    else:
        data_root = repo_root / "data" / "legalize-kr"
    out_dir = data_root / "graphify-out"
    raw_precedent_root = os.environ.get("LEGAL_GRAPH_PRECEDENT_ROOT", "").strip()
    if not raw_precedent_root:
        precedent_root = repo_root / "data" / "precedent-kr"
    else:
        precedent_root = Path(raw_precedent_root).expanduser()
        if not precedent_root.is_absolute():
            precedent_root = (repo_root / precedent_root).resolve()
    return GraphPaths(
        repo_root=repo_root,
        data_root=data_root,
        out_dir=out_dir,
        graph_path=out_dir / "graph.json",
        summary_path=out_dir / "run-summary.json",
        report_path=out_dir / "GRAPH_REPORT.md",
        precedent_root=precedent_root,
    )


class GraphLoadError(RuntimeError):
    pass


@dataclass(frozen=True)
class PrecedentRecord:
    path: str
    title: str
    category: str | None
    court: str | None
    metadata: dict[str, str]
    snippet: str | None
    search_text: str


class PrecedentSearchService:
    def __init__(self, root: Path) -> None:
        self.root = root
        self._index: list[PrecedentRecord] | None = None
        self._paths: list[Path] | None = None
        self._file_count: int | None = None

    def health(self) -> PrecedentHealthResponse:
        root = self.root
        warnings: list[str] = []
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
                warnings=["precedent corpus root not found"],
                message="data/precedent-kr corpus is unavailable.",
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
                warnings=["precedent corpus root is not a directory"],
                message="data/precedent-kr must be a directory.",
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
            ok=file_count > 0 and not warnings,
            status="ready" if file_count > 0 else "empty",
            root_path=str(root),
            exists=True,
            file_count=file_count,
            category_count=len(categories),
            categories=sorted(categories)[:100],
            courts=sorted(courts)[:100],
            warnings=warnings,
            message=f"precedent-kr corpus indexed from {root}",
        )

    def search(self, query: str, limit: int = 10, category: str | None = None, court: str | None = None) -> PrecedentSearchResponse:
        normalized_terms = self._tokenize(query)
        safe_limit = max(1, min(limit, 50))
        warnings: list[str] = []
        if not normalized_terms:
            return PrecedentSearchResponse(query=query, results=[], limit=safe_limit, total_considered=0, warnings=["empty_query"])

        records, limited = self._records_for_query(query, normalized_terms)
        if category:
            normalized_category = self._normalize(category)
            records = [record for record in records if self._normalize(record.category) == normalized_category]
        if court:
            normalized_court = self._normalize(court)
            records = [record for record in records if self._normalize(record.court) == normalized_court or self._normalize(record.metadata.get("법원명")) == normalized_court]
        scored: list[tuple[float, PrecedentRecord]] = []
        for record in records:
            score = self._score(record, normalized_terms)
            if score <= 0:
                continue
            scored.append((score, record))

        scored.sort(key=lambda item: (item[0], item[1].metadata.get("선고일자") or "", item[1].path), reverse=True)
        results = [self._result(record, score, normalized_terms) for score, record in scored[:safe_limit]]
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
            language="markdown" if target.suffix.lower() in {".md", ".markdown"} else "text",
            truncated=truncated,
            start_line=1,
            end_line=content.count("\n") + 1,
        )

    def _ensure_index(self) -> list[PrecedentRecord]:
        if self._index is not None:
            return self._index
        if not self.root.exists() or not self.root.is_dir():
            self._index = []
            return self._index

        records = [self._record_from_path(path) for path in self._all_markdown_paths()]
        self._index = records
        return self._index

    def _records_for_query(self, query: str, terms: list[str]) -> tuple[list[PrecedentRecord], bool]:
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
        records = [self._record_from_path(path) for path in candidates.values()]
        return records, limited

    def _record_from_path(self, path: Path) -> PrecedentRecord:
        rel = path.relative_to(self.root)
        rel_posix = rel.as_posix()
        category = rel.parts[0] if rel.parts else None
        court = rel.parts[1] if len(rel.parts) > 1 else None
        head = self._read_head(path)
        metadata, body = self._parse_frontmatter(head)
        title = metadata.get("사건명") or self._first_heading(body) or path.stem
        snippet = self._compact_snippet(body)
        searchable = " ".join(
            [
                rel_posix,
                title,
                category or "",
                court or "",
                metadata.get("사건번호", ""),
                metadata.get("사건명", ""),
                metadata.get("법원명", ""),
                metadata.get("법원등급", ""),
                metadata.get("사건종류", ""),
                metadata.get("선고일자", ""),
                snippet or "",
            ]
        )
        return PrecedentRecord(
            path=rel_posix,
            title=title,
            category=category,
            court=court,
            metadata=metadata,
            snippet=snippet,
            search_text=self._normalize(searchable),
        )

    def _iter_markdown_paths(self) -> Iterable[Path]:
        yield from self._all_markdown_paths()

    def _all_markdown_paths(self) -> list[Path]:
        if self._paths is not None:
            return self._paths
        if not self.root.exists() or not self.root.is_dir():
            self._paths = []
            self._file_count = 0
            return self._paths
        paths: list[Path] = []
        for path in self.root.rglob("*.md"):
            if not path.is_file():
                continue
            rel = path.relative_to(self.root)
            if len(rel.parts) < 3 or any(part.startswith(".") for part in rel.parts):
                continue
            paths.append(path)
        self._paths = paths
        self._file_count = len(paths)
        return self._paths

    def _path_candidates(self, terms: list[str], limit: int) -> list[Path]:
        matches: list[Path] = []
        for path in self._all_markdown_paths():
            rel = path.relative_to(self.root).as_posix()
            normalized = self._normalize(rel)
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
                if len(rel.parts) < 3 or any(part.startswith(".") for part in rel.parts) or path.suffix.lower() not in {".md", ".markdown"}:
                    continue
                collected[rel.as_posix()] = path
                if len(collected) >= limit:
                    return list(collected.values())
        return list(collected.values())

    def _resolve_source(self, source_path: str) -> tuple[Path, Path]:
        rel = Path(source_path)
        if rel.is_absolute() or ".." in rel.parts or any(part.startswith(".") for part in rel.parts):
            raise PermissionError("precedent path must be a relative markdown path inside data/precedent-kr")
        if rel.suffix.lower() not in {".md", ".markdown"}:
            raise PermissionError("precedent source viewer only serves markdown files")
        target = (self.root / rel).resolve()
        root = self.root.resolve()
        if not self._is_relative_to(target, root):
            raise PermissionError("precedent path escapes data/precedent-kr")
        if not target.exists() or not target.is_file():
            raise FileNotFoundError(source_path)
        return target, rel

    def _read_head(self, path: Path, max_chars: int = 6_000) -> str:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            return fh.read(max_chars)

    def _parse_frontmatter(self, text: str) -> tuple[dict[str, str], str]:
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

    def _first_heading(self, text: str) -> str | None:
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                return stripped.lstrip("#").strip() or None
        return None

    def _compact_snippet(self, text: str, max_chars: int = 500) -> str | None:
        lines = []
        for line in text.splitlines():
            stripped = re.sub(r"\s+", " ", line).strip()
            if not stripped or stripped.startswith("#"):
                continue
            lines.append(stripped)
            if sum(len(item) for item in lines) >= max_chars:
                break
        snippet = " ".join(lines).strip()
        if not snippet:
            return None
        return snippet[:max_chars]

    def _score(self, record: PrecedentRecord, terms: list[str]) -> float:
        score = 0.0
        searchable = record.search_text
        title = self._normalize(record.title)
        path = self._normalize(record.path)
        metadata_values = self._normalize(" ".join(record.metadata.values()))
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
        if all(term in searchable for term in terms):
            score += 2.0
        return round(score, 4)

    def _result(self, record: PrecedentRecord, score: float, terms: list[str]) -> PrecedentSearchResult:
        metadata = record.metadata
        return PrecedentSearchResult(
            path=record.path,
            title=record.title,
            case_number=metadata.get("사건번호"),
            case_name=metadata.get("사건명"),
            court_name=metadata.get("법원명"),
            court_level=metadata.get("법원등급"),
            case_type=metadata.get("사건종류"),
            decision_date=metadata.get("선고일자"),
            category=record.category,
            court=record.court,
            source_url=metadata.get("출처"),
            score=score,
            snippet=self._best_snippet(record.snippet, terms),
        )

    def _best_snippet(self, snippet: str | None, terms: list[str]) -> str | None:
        if not snippet:
            return None
        normalized_lines = [(line, self._normalize(line)) for line in re.split(r"(?<=[.!?。])\s+|\n+", snippet)]
        for line, normalized in normalized_lines:
            if any(term in normalized for term in terms):
                return line[:260]
        return snippet[:260]

    def _tokenize(self, text: str) -> list[str]:
        terms = [self._normalize(m.group(0)) for m in TOKEN_RE.finditer(text)]
        return [term for term in terms if len(term) >= 2]

    def _normalize(self, text: Any) -> str:
        return re.sub(r"\s+", "", str(text or "").lower()).replace("·", "ㆍ")

    def _is_relative_to(self, path: Path, root: Path) -> bool:
        try:
            path.relative_to(root)
            return True
        except ValueError:
            return False


class GraphQueryService:
    def __init__(self, paths: GraphPaths | None = None, llm_provider: LLMAnswerProvider | None = None) -> None:
        self.paths = paths or default_paths()
        self.precedents = create_precedent_index(self.paths.precedent_root or (self.paths.repo_root / "data" / "precedent-kr"))
        self._llm_provider = llm_provider
        self._graph: nx.Graph | None = None
        self._raw_summary: dict[str, Any] = {}
        self._graph_mtime: float | None = None
        self._graph_hash: str | None = None

    @property
    def graph(self) -> nx.Graph:
        self.ensure_loaded()
        assert self._graph is not None
        return self._graph

    def ensure_loaded(self) -> None:
        graph_path = self.paths.graph_path
        if not graph_path.exists():
            raise GraphLoadError(f"graph.json not found: {graph_path}")
        mtime = graph_path.stat().st_mtime
        if self._graph is not None and self._graph_mtime == mtime:
            return
        try:
            data = json.loads(graph_path.read_text(encoding="utf-8"))
            try:
                graph = json_graph.node_link_graph(data, edges="links")
            except TypeError:
                graph = json_graph.node_link_graph(data)
        except Exception as exc:  # noqa: BLE001 - convert to recoverable API error
            raise GraphLoadError(f"graph.json is malformed: {exc}") from exc
        self._graph = graph
        self._graph_mtime = mtime
        self._graph_hash = self._hash_file(graph_path)
        if self.paths.summary_path.exists():
            try:
                self._raw_summary = json.loads(self.paths.summary_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                self._raw_summary = {}

    def health(self) -> HealthResponse:
        warnings: list[str] = []
        try:
            self.ensure_loaded()
            graph = self.graph
            status = "ready"
            loaded = True
            ok = True
            message = "legalize-kr graph loaded"
        except GraphLoadError as exc:
            graph = None
            status = "error"
            loaded = False
            ok = False
            message = str(exc)
            warnings.append("Run graphify for data/legalize-kr or restore graphify-out/graph.json.")

        summary = self._raw_summary if loaded else self._read_summary_safe()
        nodes = graph.number_of_nodes() if graph else None
        edges = graph.number_of_edges() if graph else None
        communities = self._community_count(graph) if graph else None
        expected_nodes = self._int_or_none(summary.get("nodes"))
        expected_edges = self._int_or_none(summary.get("edges"))
        expected_communities = self._int_or_none(summary.get("communities"))
        if loaded:
            if expected_nodes is not None and nodes != expected_nodes:
                warnings.append(f"node count mismatch: graph={nodes}, run-summary={expected_nodes}")
            if expected_edges is not None and edges != expected_edges:
                warnings.append(f"edge count mismatch: graph={edges}, run-summary={expected_edges}")
            if expected_communities is not None and communities != expected_communities:
                warnings.append(f"community count mismatch: graph={communities}, run-summary={expected_communities}")

        return HealthResponse(
            ok=ok and not warnings,
            status=status,
            loaded=loaded,
            graph_path=str(self.paths.graph_path),
            graph_hash=self._graph_hash,
            graph_size_bytes=self.paths.graph_path.stat().st_size if self.paths.graph_path.exists() else None,
            generated_at=self._generated_at(),
            mode=summary.get("mode"),
            nodes=nodes,
            edges=edges,
            communities=communities,
            expected_nodes=expected_nodes,
            expected_edges=expected_edges,
            expected_communities=expected_communities,
            warnings=warnings,
            message=message,
        )

    def query(self, request: QueryRequest) -> QueryResponse:
        terms = self._tokenize(request.question)
        ranked = self._rank_nodes(terms, limit=8)
        if not ranked:
            empty_graph = GraphPayloadDTO(warnings=["matching node not found"])
            return QueryResponse(
                question=request.question,
                summary="일치하는 그래프 노드를 찾지 못했습니다. 법령명이나 source file명을 더 구체적으로 입력해 주세요.",
                evidence=[],
                graph=empty_graph,
                rank_reason=RankReason(matched_terms=terms, stop_hub_threshold=self._stop_hub_threshold(), max_degree=self._max_degree()),
                warnings=["no_match"],
            )
        seeds = [nid for _, nid, _ in ranked[:3]]
        graph_payload = self.subgraph_for_nodes(seeds, depth=request.depth, max_nodes=request.max_nodes, max_edges=request.max_edges, edge_mode="focus")
        evidence = self._evidence_from_payload(graph_payload, max_items=8)
        summary = self._summary_for_query(request.question, evidence, graph_payload)
        seed_dtos = [self._node_dto(nid, score=score, matched_terms=matched) for score, nid, matched in ranked[:3]]
        return QueryResponse(
            question=request.question,
            summary=summary,
            evidence=evidence,
            graph=graph_payload,
            rank_reason=RankReason(
                matched_terms=terms,
                seed_nodes=seed_dtos,
                hub_dampening_applied=True,
                stop_hub_threshold=self._stop_hub_threshold(),
                max_degree=self._max_degree(),
            ),
            warnings=graph_payload.warnings,
        )

    def answer(self, request: AnswerRequest) -> AnswerResponse:
        query_result = self.query(
            QueryRequest(
                question=request.question,
                max_nodes=request.max_nodes,
                max_edges=request.max_edges,
                depth=request.depth,
            )
        )
        warnings = list(query_result.warnings)
        source_evidence = [item for item in query_result.evidence if item.source_file or item.source_url][: request.max_citations]
        citations = [self._citation_from_evidence(item, request.question) for item in source_evidence]
        if not citations:
            warnings.append("no_source_evidence")
            answer = "표시 가능한 source evidence가 없어 답변을 생성하지 않았습니다. 질문을 더 구체화하거나 그래프 evidence/source 경로를 먼저 확인하세요."
            return AnswerResponse(
                question=request.question,
                mode="deterministic",
                answer=answer,
                summary=query_result.summary,
                citations=[],
                evidence=[],
                graph=query_result.graph,
                disclaimer=ANSWER_DISCLAIMER,
                llm_status="no_context" if request.mode == "llm" else "not_requested",
                validated_citations=[],
                warnings=list(dict.fromkeys(warnings)),
            )

        deterministic_answer = self._deterministic_answer_text(request.question, citations, query_result)
        if request.mode == "llm":
            return self._llm_answer_or_deterministic_fallback(
                request=request,
                query_result=query_result,
                source_evidence=source_evidence,
                citations=citations,
                deterministic_answer=deterministic_answer,
                warnings=warnings,
            )

        response_mode: AnswerMode = "extractive" if request.mode == "extractive" else "deterministic"
        return AnswerResponse(
            question=request.question,
            mode=response_mode,
            answer=deterministic_answer,
            summary=query_result.summary,
            citations=citations,
            evidence=source_evidence,
            graph=query_result.graph,
            disclaimer=ANSWER_DISCLAIMER,
            llm_status="not_requested",
            validated_citations=[citation.id for citation in citations],
            warnings=list(dict.fromkeys(warnings)),
        )

    def explain(self, label: str | None = None, node_id: str | None = None) -> dict[str, Any]:
        nid = self._resolve_node(label=label, node_id=node_id)
        payload = self.subgraph_for_nodes([nid], depth=1, max_nodes=40, max_edges=120, edge_mode="focus")
        node = self._node_dto(nid)
        evidence = self._evidence_from_payload(payload, max_items=8)
        summary = f"`{node.label}` 노드는 degree {node.degree or 0}의 그래프 노드입니다. 연결 관계와 source file을 기준으로 검증하세요."
        return {"id": nid, "label": node.label, "summary": summary, "evidence": evidence, "graph": payload, "node": node, "warnings": payload.warnings}

    def shortest_path(self, source: str, target: str, max_hops: int = 8) -> PathResponse:
        src = self._resolve_node(label=source)
        tgt = self._resolve_node(label=target)
        try:
            path_nodes = nx.shortest_path(self.graph, src, tgt)
        except nx.NetworkXNoPath:
            return PathResponse(source=source, target=target, found=False, message="No path found between the selected graph nodes.")
        hops = len(path_nodes) - 1
        if hops > max_hops:
            return PathResponse(source=source, target=target, found=False, hops=hops, message=f"Path exceeds max_hops={max_hops}.")
        edges = [self._edge_dto(path_nodes[i], path_nodes[i + 1], i) for i in range(len(path_nodes) - 1)]
        return PathResponse(source=source, target=target, found=True, hops=hops, nodes=[self._node_dto(n) for n in path_nodes], edges=edges)

    def subgraph_for_node(self, node_id: str, depth: int = 1, max_nodes: int = 100, max_edges: int = 300, edge_mode: EdgeMode = "focus") -> GraphPayloadDTO:
        nid = self._resolve_node(node_id=node_id)
        return self.subgraph_for_nodes([nid], depth=depth, max_nodes=max_nodes, max_edges=max_edges, edge_mode=edge_mode)

    def subgraph_for_query_or_node(self, question: str | None = None, node_id: str | None = None, max_nodes: int = 120, max_edges: int = 500) -> GraphPayloadDTO:
        if node_id:
            return self.subgraph_for_node(node_id, depth=1, max_nodes=max_nodes, max_edges=max_edges, edge_mode="focus")
        terms = self._tokenize(question or "")
        ranked = self._rank_nodes(terms, limit=3)
        seeds = [nid for _, nid, _ in ranked] or list(self.graph.nodes)[:1]
        return self.subgraph_for_nodes(seeds, depth=1, max_nodes=max_nodes, max_edges=max_edges, edge_mode="focus")

    def subgraph_for_nodes(self, seeds: list[str], depth: int, max_nodes: int, max_edges: int, edge_mode: EdgeMode = "focus") -> GraphPayloadDTO:
        graph = self.graph
        stop_threshold = self._stop_hub_threshold()
        visited: set[str] = set(seeds)
        frontier: deque[tuple[str, int]] = deque((seed, 0) for seed in seeds)
        warnings: list[str] = []
        while frontier and len(visited) < max_nodes:
            nid, level = frontier.popleft()
            if level >= depth:
                continue
            neighbors = list(graph.neighbors(nid))
            neighbors.sort(key=lambda n: (self._edge_weight(nid, n), -graph.degree(n)), reverse=True)
            cap = 24 if graph.degree(nid) >= stop_threshold else 60
            if graph.degree(nid) >= stop_threshold:
                warnings.append(f"hub dampening: {self._label(nid)} neighbors capped at {cap}")
            for neighbor in neighbors[:cap]:
                if len(visited) >= max_nodes:
                    break
                if neighbor not in visited:
                    visited.add(neighbor)
                    frontier.append((neighbor, level + 1))
        edge_pairs: list[tuple[str, str]] = []
        if edge_mode != "hidden":
            for u, v in graph.edges(visited):
                if u in visited and v in visited:
                    if edge_mode == "focus" and not (u in seeds or v in seeds):
                        continue
                    edge_pairs.append((u, v))
                    if len(edge_pairs) >= max_edges:
                        warnings.append(f"edge limit reached: showing {max_edges} edges")
                        break
        partial = len(visited) >= max_nodes or len(edge_pairs) >= max_edges
        if len(visited) >= max_nodes:
            warnings.append(f"node limit reached: showing {max_nodes} nodes")
        return GraphPayloadDTO(
            nodes=[self._node_dto(n) for n in sorted(visited, key=lambda n: graph.degree(n), reverse=True)],
            edges=[self._edge_dto(u, v, i) for i, (u, v) in enumerate(edge_pairs)],
            seed_node_ids=seeds,
            focus_node_id=seeds[0] if seeds else None,
            edge_mode=edge_mode,
            partial=partial,
            warnings=list(dict.fromkeys(warnings)),
        )

    def communities_3d(self) -> CommunityPayloadDTO:
        graph = self.graph
        members: dict[int, list[str]] = {}
        for nid, data in graph.nodes(data=True):
            cid = self._community(data)
            if cid is not None:
                members.setdefault(cid, []).append(nid)
        degree_top = {cid: sorted(nodes, key=lambda n: graph.degree(n), reverse=True)[:5] for cid, nodes in members.items()}
        community_labels = self._community_labels()
        communities = [
            CommunityDTO(
                id=f"community-{cid}",
                label=community_labels.get(cid) or f"Community {cid}",
                community=cid,
                member_count=len(nodes),
                edge_count=sum(1 for u, v in graph.edges(nodes) if u in nodes and v in nodes),
                god_nodes=[self._label(n) for n in degree_top.get(cid, [])],
                cohesion=None,
                size=math.sqrt(len(nodes)),
            )
            for cid, nodes in sorted(members.items())
        ]
        cross_counts: Counter[tuple[int, int]] = Counter()
        for u, v in graph.edges:
            cu = self._community(graph.nodes[u])
            cv = self._community(graph.nodes[v])
            if cu is None or cv is None or cu == cv:
                continue
            a, b = sorted((cu, cv))
            cross_counts[(a, b)] += 1
        edges = [
            GraphEdgeDTO(
                id=f"community-{a}-community-{b}",
                source=f"community-{a}",
                target=f"community-{b}",
                relation="cross_community_edges",
                confidence="EXTRACTED",
                weight=float(count),
            )
            for (a, b), count in cross_counts.most_common(80)
        ]
        return CommunityPayloadDTO(communities=communities, edges=edges)

    def cache_token(self) -> str:
        try:
            self.ensure_loaded()
        except GraphLoadError:
            return "graph-unavailable"
        return self._graph_hash or str(self._graph_mtime or "graph-loaded")

    def full_graph_3d(
        self,
        edge_mode: EdgeMode = "hidden",
        focus_node_id: str | None = None,
        confirm_all_edges: bool = False,
        node_limit: int | None = None,
        edge_limit: int | None = None,
        min_degree: int | None = None,
        community_id: str | None = None,
        static_layout: bool = False,
        static_layout_mode: LayoutMode = "spherical",
    ) -> GraphPayloadDTO:
        graph = self.graph
        focus = self._resolve_node(node_id=focus_node_id) if focus_node_id else None
        warnings = ["Full graph payload is experimental. Start with hidden or focus edges for browser safety."]
        partial = False

        node_subset_requested = node_limit is not None or min_degree is not None or community_id is not None
        if not node_subset_requested and edge_limit is None and not static_layout:
            nodes = [self._node_dto(n) for n in graph.nodes]
            edge_pairs: Iterable[tuple[str, str]]
            if edge_mode == "hidden":
                edge_pairs = []
            elif edge_mode == "focus":
                if focus:
                    edge_pairs = [(focus, n) for n in graph.neighbors(focus)]
                else:
                    edge_pairs = []
                    warnings.append("focus_node_id is required for focus edges; returning hidden-edge full graph")
            else:
                if confirm_all_edges:
                    edge_pairs = graph.edges
                    warnings.append("all edges requested; this can be slow for 176k edges")
                else:
                    edge_pairs = []
                    partial = True
                    warnings.append("edge_mode=all requires confirm_all_edges=true; returning hidden-edge full graph")
            edges = [self._edge_dto(u, v, i) for i, (u, v) in enumerate(edge_pairs)]
            return GraphPayloadDTO(nodes=nodes, edges=edges, focus_node_id=focus, seed_node_ids=[focus] if focus else [], edge_mode=edge_mode, partial=partial, warnings=warnings)

        selected_nodes = list(graph.nodes)
        if node_subset_requested:
            selected_nodes, node_reduced, node_warnings = self._bounded_full_graph_nodes(
                focus=focus,
                node_limit=node_limit,
                min_degree=min_degree,
                community_id=community_id,
            )
            partial = partial or node_reduced
            warnings.extend(node_warnings)
        selected_set = set(selected_nodes)

        edge_pairs: Iterable[tuple[str, str]]
        if edge_mode == "hidden":
            edge_pairs = []
        elif edge_mode == "focus":
            if focus:
                edge_pairs = ((focus, n) for n in graph.neighbors(focus) if n in selected_set)
            else:
                edge_pairs = []
                warnings.append("focus_node_id is required for focus edges; returning hidden-edge full graph")
        else:
            if confirm_all_edges:
                edge_pairs = ((u, v) for u, v in graph.edges(selected_set) if u in selected_set and v in selected_set)
                warnings.append("all edges requested; this can be slow for 176k edges")
            else:
                edge_pairs = []
                partial = True
                warnings.append("edge_mode=all requires confirm_all_edges=true; returning hidden-edge full graph")
        edge_pairs, edge_reduced, edge_layers = self._bounded_full_graph_edges(edge_pairs, edge_limit=edge_limit, focus=focus)
        if edge_reduced:
            partial = True
            warnings.append(f"edge limit reached: showing {edge_limit} edges")
        if edge_limit is not None and edge_mode == "all" and edge_pairs:
            warnings.append("edge LOD active: backbone/context/focus metadata included for layered rendering")

        positions = self._full_graph_layout_positions(selected_nodes, static_layout_mode) if static_layout else {}
        if static_layout:
            warnings.append(
                f"static_layout=true: deterministic backend x/y/z coordinates included using layout_mode={static_layout_mode}; "
                "frontend should use static renderer for large raw graphs"
            )
        nodes = [self._node_dto(n, position=positions.get(n)) for n in selected_nodes]
        edges = [
            self._edge_dto(u, v, i, metadata_extra={"lod_layer": edge_layers.get(self._edge_pair_key(u, v), "density" if edge_limit is None else "context")})
            for i, (u, v) in enumerate(edge_pairs)
        ]
        return GraphPayloadDTO(
            nodes=nodes,
            edges=edges,
            focus_node_id=focus,
            seed_node_ids=[focus] if focus else [],
            edge_mode=edge_mode,
            layout_mode=static_layout_mode if static_layout else None,
            partial=partial,
            warnings=list(dict.fromkeys(warnings)),
        )

    def _bounded_full_graph_nodes(
        self,
        *,
        focus: str | None,
        node_limit: int | None,
        min_degree: int | None,
        community_id: str | None,
    ) -> tuple[list[str], bool, list[str]]:
        graph = self.graph
        total_nodes = graph.number_of_nodes()
        candidates = list(graph.nodes)
        warnings: list[str] = []
        partial = False

        if min_degree is not None:
            before = len(candidates)
            candidates = [nid for nid in candidates if graph.degree(nid) >= min_degree]
            if len(candidates) < before:
                partial = True
                warnings.append(f"min_degree filter reduced nodes: showing {len(candidates)} of {before} nodes with degree >= {min_degree}")

        if community_id is not None:
            before = len(candidates)
            candidates = [nid for nid in candidates if self._node_matches_community(nid, community_id)]
            if len(candidates) < before:
                partial = True
                warnings.append(f"community_id filter reduced nodes: showing {len(candidates)} of {before} nodes in {community_id}")

        candidates = sorted(candidates, key=lambda nid: graph.degree(nid), reverse=True)
        selected = candidates
        if node_limit is not None and len(selected) > node_limit:
            selected = selected[:node_limit]
            partial = True
            warnings.append(f"node limit reached: showing {node_limit} of {len(candidates)} nodes")

        if focus and focus not in selected:
            if node_limit is not None and len(selected) >= node_limit:
                selected = [*selected[: max(node_limit - 1, 0)], focus]
            else:
                selected = [*selected, focus]
            partial = True
            warnings.append("focus node preserved outside requested node subset")

        if len(selected) < total_nodes and not partial:
            partial = True

        return selected, partial, warnings

    def _edge_pair_key(self, u: str, v: str) -> tuple[str, str]:
        a = str(u)
        b = str(v)
        return (a, b) if a <= b else (b, a)

    def _edge_lod_score(self, u: str, v: str) -> float:
        data = self.graph.get_edge_data(u, v) or {}
        if isinstance(data, dict) and 0 in data:  # MultiGraph style
            data = data[0]
        weight = self._float_or_none(data.get("weight")) or 1.0
        return float(self.graph.degree(u) + self.graph.degree(v)) + math.sqrt(max(weight, 0.1)) * 8.0

    def _node_community_value(self, nid: str) -> str:
        return str(self.graph.nodes[nid].get("community", "unknown"))

    def _edge_lod_layer(self, u: str, v: str, *, focus: str | None, edge_limit: int | None) -> str:
        if focus and (u == focus or v == focus):
            return "focus"
        if edge_limit is None:
            return "density"
        if self._node_community_value(u) != self._node_community_value(v):
            return "backbone"
        if self.graph.degree(u) + self.graph.degree(v) >= 260:
            return "backbone"
        return "context"

    def _bounded_full_graph_edges(
        self,
        edge_pairs: Iterable[tuple[str, str]],
        *,
        edge_limit: int | None,
        focus: str | None = None,
    ) -> tuple[list[tuple[str, str]], bool, dict[tuple[str, str], str]]:
        candidates = [(str(u), str(v)) for u, v in edge_pairs]
        if edge_limit is None:
            return candidates, False, {self._edge_pair_key(u, v): "density" for u, v in candidates}
        if edge_limit <= 0:
            return [], bool(candidates), {}
        if len(candidates) <= edge_limit:
            return (
                candidates,
                False,
                {self._edge_pair_key(u, v): self._edge_lod_layer(u, v, focus=focus, edge_limit=edge_limit) for u, v in candidates},
            )

        selected: list[tuple[str, str]] = []
        selected_keys: set[tuple[str, str]] = set()
        layers: dict[tuple[str, str], str] = {}
        backbone_quota = min(edge_limit, max(1, min(3_000, int(edge_limit * 0.22))))

        def add_edge(u: str, v: str, layer: str) -> bool:
            if len(selected) >= edge_limit:
                return False
            key = self._edge_pair_key(u, v)
            if key in selected_keys:
                return True
            selected.append((u, v))
            selected_keys.add(key)
            layers[key] = layer
            return True

        if focus:
            focus_edges = sorted(
                ((u, v) for u, v in candidates if u == focus or v == focus),
                key=lambda pair: self._edge_lod_score(pair[0], pair[1]),
                reverse=True,
            )
            for u, v in focus_edges:
                if not add_edge(u, v, "focus"):
                    return selected, True, layers

        community_representatives: dict[tuple[str, str], tuple[str, str, float]] = {}
        for u, v in candidates:
            cu = self._node_community_value(u)
            cv = self._node_community_value(v)
            if cu == cv:
                continue
            community_key = (cu, cv) if cu <= cv else (cv, cu)
            score = self._edge_lod_score(u, v)
            current = community_representatives.get(community_key)
            if current is None or score > current[2]:
                community_representatives[community_key] = (u, v, score)

        for u, v, _score in sorted(community_representatives.values(), key=lambda item: item[2], reverse=True):
            if len(selected) >= backbone_quota:
                break
            add_edge(u, v, "backbone")

        ranked_candidates = sorted(candidates, key=lambda pair: self._edge_lod_score(pair[0], pair[1]), reverse=True)
        for u, v in ranked_candidates:
            if len(selected) >= backbone_quota:
                break
            layer = self._edge_lod_layer(u, v, focus=focus, edge_limit=edge_limit)
            if layer == "context":
                continue
            add_edge(u, v, layer)

        # Fill the remaining budget in original edge order so the safe overview keeps a broad,
        # deterministic sample instead of becoming only a hub-to-hub hairball.
        for u, v in candidates:
            if len(selected) >= edge_limit:
                break
            add_edge(u, v, "context")

        return selected, True, layers

    def _node_matches_community(self, nid: str, community_id: str) -> bool:
        requested = str(community_id)
        if requested.startswith("community-"):
            requested = requested.removeprefix("community-")
        value = self.graph.nodes[nid].get("community")
        return str(value) == requested

    def _full_graph_layout_positions(self, nodes: list[str], layout_mode: LayoutMode) -> dict[str, tuple[float, float, float]]:
        if layout_mode == "clustered":
            return self._full_graph_static_positions(nodes)
        if layout_mode == "circular":
            return self._full_graph_circular_positions(nodes)
        if layout_mode == "spherical":
            return self._full_graph_spherical_positions(nodes)
        raise ValueError("static_layout_mode must be one of: clustered, circular, spherical")

    def _full_graph_static_positions(self, nodes: list[str]) -> dict[str, tuple[float, float, float]]:
        if not nodes:
            return {}

        graph = self.graph
        groups: dict[int, list[str]] = {}
        none_group = 999_999
        for nid in nodes:
            cid = self._community(graph.nodes[nid])
            groups.setdefault(cid if cid is not None else none_group, []).append(nid)

        community_ids = sorted(groups)
        community_count = max(len(community_ids), 1)
        golden_angle = math.pi * (3 - math.sqrt(5))
        center_radius = 560.0 if community_count > 1 else 0.0
        positions: dict[str, tuple[float, float, float]] = {}

        for community_index, cid in enumerate(community_ids):
            members = sorted(groups[cid], key=lambda nid: graph.degree(nid), reverse=True)
            community_angle = (community_index / community_count) * math.tau
            center_x = math.cos(community_angle) * center_radius
            center_z = math.sin(community_angle) * center_radius
            center_y = ((community_index % 5) - 2) * 72.0
            shell_scale = max(90.0, min(260.0, 10.5 * math.sqrt(len(members))))

            for local_index, nid in enumerate(members):
                degree = max(float(graph.degree(nid)), 1.0)
                if local_index == 0:
                    local_radius = 0.0
                else:
                    local_radius = min(shell_scale, 18.0 * math.sqrt(local_index))
                local_angle = local_index * golden_angle
                vertical_angle = local_index * golden_angle * 0.63
                hub_lift = min(140.0, math.sqrt(degree) * 10.0)
                x = center_x + math.cos(local_angle) * local_radius
                y = center_y + math.sin(vertical_angle) * local_radius * 0.42 + hub_lift
                z = center_z + math.sin(local_angle) * local_radius
                positions[nid] = (round(x, 3), round(y, 3), round(z, 3))

        return positions

    def _full_graph_circular_positions(self, nodes: list[str]) -> dict[str, tuple[float, float, float]]:
        if not nodes:
            return {}

        graph = self.graph
        groups: dict[int, list[str]] = {}
        none_group = 999_999
        for nid in nodes:
            cid = self._community(graph.nodes[nid])
            groups.setdefault(cid if cid is not None else none_group, []).append(nid)

        community_ids = sorted(groups)
        community_count = len(community_ids)
        total_nodes = max(len(nodes), 1)
        gap = min(math.radians(3.0), math.tau * 0.12 / max(community_count, 1))
        available_angle = max(math.tau - (gap * community_count), math.tau * 0.55)
        min_wedge = min(math.radians(8.0), available_angle / max(community_count, 1) * 0.45)
        reserved_angle = min_wedge * community_count
        proportional_angle = max(available_angle - reserved_angle, 0.0)
        inner_radius = 260.0
        outer_radius = 780.0
        radius_span = outer_radius - inner_radius
        positions: dict[str, tuple[float, float, float]] = {}
        cursor = -math.pi

        for community_index, cid in enumerate(community_ids):
            members = sorted(
                groups[cid],
                key=lambda nid: (-graph.degree(nid), self._normalize(self._label(nid)), str(nid)),
            )
            wedge = min_wedge + proportional_angle * (len(members) / total_nodes)
            wedge_start = cursor + (gap / 2.0)
            wedge_end = wedge_start + wedge
            cursor = wedge_end + (gap / 2.0)

            ring_count = max(1, min(18, math.ceil(math.sqrt(len(members)) / 2.0)))
            angle_slots = max(1, math.ceil(len(members) / ring_count))
            padding = min(wedge * 0.08, math.radians(2.5))
            usable_wedge = max(wedge - (padding * 2.0), wedge * 0.82)

            for local_index, nid in enumerate(members):
                ring_index = local_index % ring_count
                angle_index = local_index // ring_count
                if angle_slots == 1:
                    theta = (wedge_start + wedge_end) / 2.0
                else:
                    theta_fraction = (angle_index + 0.5) / angle_slots
                    theta = wedge_start + padding + (theta_fraction * usable_wedge)
                    slot_width = usable_wedge / angle_slots
                    phase = ((ring_index * 0.61803398875) % 1.0) - 0.5
                    theta += phase * min(slot_width * 0.42, math.radians(1.1))
                    theta = max(wedge_start + padding, min(wedge_end - padding, theta))

                radius = inner_radius + ((ring_index + 0.5) / ring_count) * radius_span
                degree = max(float(graph.degree(nid)), 1.0)
                degree_lift = min(72.0, math.log1p(degree) * 16.0)
                ring_wave = math.sin((ring_index + 1) * 1.73 + community_index * 0.41) * 30.0
                angular_wave = math.sin(theta * 2.0 + local_index * 0.17) * 22.0
                community_wave = ((community_index % 5) - 2) * 10.0
                y = max(-140.0, min(140.0, degree_lift + ring_wave + angular_wave + community_wave))
                x = math.cos(theta) * radius
                z = math.sin(theta) * radius
                positions[nid] = (round(x, 3), round(y, 3), round(z, 3))

        return positions


    def _full_graph_spherical_positions(self, nodes: list[str]) -> dict[str, tuple[float, float, float]]:
        """Deterministic 3D sphere layout for the original Full 3D hairball feel.

        This is intentionally not force-directed: the goal is a stable, browser-safe
        spherical shell where nodes read as a round 3D cloud and all-edge links read
        as chords through the sphere instead of a flat annulus or rectangular slab.
        Communities occupy broad latitude/longitude bands but every node gets true
        x/y/z depth.
        """
        if not nodes:
            return {}

        graph = self.graph
        groups: dict[int, list[str]] = {}
        none_group = 999_999
        for nid in nodes:
            cid = self._community(graph.nodes[nid])
            groups.setdefault(cid if cid is not None else none_group, []).append(nid)

        community_ids = sorted(groups)
        community_count = max(len(community_ids), 1)
        sphere_radius = 720.0
        inner_fraction = 0.72
        golden_angle = math.pi * (3 - math.sqrt(5))
        positions: dict[str, tuple[float, float, float]] = {}

        for community_index, cid in enumerate(community_ids):
            members = sorted(
                groups[cid],
                key=lambda nid: (-graph.degree(nid), self._normalize(self._label(nid)), str(nid)),
            )
            count = len(members)
            if count == 0:
                continue

            # Communities rotate around the sphere so colors remain legible, but
            # every community now spans the whole polar axis. The earlier latitude
            # banding created a donut/hollow 2D projection because no nodes reached
            # the poles, so the X/Z projection never filled the center.
            community_longitude = (community_index / community_count) * math.tau

            for local_index, nid in enumerate(members):
                # Fibonacci sphere coordinates over the full sphere. This preserves
                # a true circular 2D X/Z projection while keeping real 3D depth.
                fraction = (local_index + 0.5) / count
                y_unit = max(-0.995, min(0.995, 1.0 - (2.0 * fraction)))
                latitude_radius = math.sqrt(max(0.0, 1.0 - y_unit * y_unit))
                theta = community_longitude + local_index * golden_angle

                # Light radial layering prevents all nodes from sitting on exactly
                # one surface while preserving a round silhouette.
                shell_phase = ((local_index * 37 + community_index * 17) % 101) / 100.0
                radius = sphere_radius * (inner_fraction + (1.0 - inner_fraction) * shell_phase)
                degree = max(float(graph.degree(nid)), 1.0)
                hub_push = min(52.0, math.log1p(degree) * 11.0)
                radius = min(sphere_radius + 70.0, radius + hub_push)

                x = math.cos(theta) * latitude_radius * radius
                y = y_unit * radius
                z = math.sin(theta) * latitude_radius * radius
                positions[nid] = (round(x, 3), round(y, 3), round(z, 3))

        return positions

    def suggested_questions(self) -> list[str]:
        if not self.paths.report_path.exists():
            return [
                "개인정보 보호법 전자정부법 관계",
                "민법 계약 손해배상",
                "전자정부법 시행령이 여러 커뮤니티를 연결하는 이유",
            ]
        text = self.paths.report_path.read_text(encoding="utf-8", errors="replace")
        questions = re.findall(r"^- \*\*(.+?)\*\*", text, flags=re.M)
        return questions[:8]

    def precedent_health(self) -> PrecedentHealthResponse:
        return self.precedents.health()

    def search_precedents(self, query: str, limit: int = 10, category: str | None = None, court: str | None = None) -> PrecedentSearchResponse:
        return self.precedents.search(query=query, limit=limit, category=category, court=court)

    def precedent_source(self, source_path: str, max_chars: int = 40_000) -> SourceResponse:
        return self.precedents.source(source_path, max_chars=max_chars)

    def source(self, source_path: str, max_chars: int = 40_000) -> SourceResponse:
        if not env_enabled("LEGAL_GRAPH_SOURCE_VIEWER_ENABLED", default=True):
            raise PermissionError("source viewer is disabled by backend configuration")
        rel = Path(source_path)
        if rel.is_absolute() or ".." in rel.parts:
            raise PermissionError("source path must be relative and cannot contain '..'")
        candidates = [self.paths.data_root / rel, self.paths.out_dir / rel]
        target = next((p for p in candidates if p.exists() and p.is_file()), None)
        if target is None:
            raise FileNotFoundError(source_path)
        resolved = target.resolve()
        allowed_roots = [self.paths.data_root.resolve(), self.paths.out_dir.resolve()]
        if not any(self._is_relative_to(resolved, root) for root in allowed_roots):
            raise PermissionError("source path escapes allowed legalize-kr roots")
        content = resolved.read_text(encoding="utf-8", errors="replace")
        truncated = len(content) > max_chars
        if truncated:
            content = content[:max_chars] + "\n... truncated by backend source viewer limit ..."
        return SourceResponse(
            path=rel.as_posix(),
            content=content,
            language="markdown" if target.suffix.lower() in {".md", ".markdown"} else "text",
            truncated=truncated,
            start_line=1,
            end_line=content.count("\n") + 1,
        )

    def _read_summary_safe(self) -> dict[str, Any]:
        if not self.paths.summary_path.exists():
            return {}
        try:
            return json.loads(self.paths.summary_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}

    def _hash_file(self, path: Path) -> str:
        h = hashlib.sha256()
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()[:16]

    def _generated_at(self) -> str | None:
        if not self.paths.graph_path.exists():
            return None
        return str(int(self.paths.graph_path.stat().st_mtime))

    def _community_count(self, graph: nx.Graph | None) -> int | None:
        if graph is None:
            return None
        values = {self._community(data) for _, data in graph.nodes(data=True)}
        values.discard(None)
        return len(values)

    def _community(self, data: dict[str, Any]) -> int | None:
        value = data.get("community")
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    def _community_labels(self) -> dict[int, str]:
        labels_path = self.paths.out_dir / ".graphify_labels.json"
        if not labels_path.exists():
            return {}
        try:
            raw = json.loads(labels_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
        return {int(k): str(v) for k, v in raw.items() if str(k).lstrip("-").isdigit()}

    def _node_dto(
        self,
        nid: str,
        score: float | None = None,
        matched_terms: list[str] | None = None,
        position: tuple[float, float, float] | None = None,
    ) -> GraphNodeDTO:
        data = dict(self.graph.nodes[nid])
        degree = self.graph.degree(nid)
        metadata = {k: v for k, v in data.items() if k not in {"id", "label", "community", "source_file", "source_url", "file_type"}}
        if matched_terms:
            metadata["matched_terms"] = matched_terms
        return GraphNodeDTO(
            id=str(nid),
            label=str(data.get("label") or nid),
            community=data.get("community"),
            degree=degree,
            type=str(data.get("node_kind") or data.get("type") or data.get("file_type") or "node"),
            file_type=data.get("file_type"),
            source_file=data.get("source_file") or None,
            source_url=data.get("source_url") or None,
            score=score,
            size=math.sqrt(max(degree, 1)),
            x=position[0] if position else None,
            y=position[1] if position else None,
            z=position[2] if position else None,
            is_hub=degree >= self._stop_hub_threshold(),
            metadata=metadata,
        )

    def _edge_dto(self, u: str, v: str, index: int, metadata_extra: dict[str, Any] | None = None) -> GraphEdgeDTO:
        data = self.graph.get_edge_data(u, v) or {}
        if isinstance(data, dict) and 0 in data:  # MultiGraph style
            data = data[0]
        metadata = {k: val for k, val in data.items() if k not in {"relation", "confidence", "confidence_score", "weight", "source_file"}}
        if metadata_extra:
            metadata.update(metadata_extra)
        return GraphEdgeDTO(
            id=f"{u}->{v}-{index}",
            source=str(u),
            target=str(v),
            relation=data.get("relation") or "related",
            confidence=data.get("confidence") or "EXTRACTED",
            confidence_score=self._float_or_none(data.get("confidence_score")),
            weight=self._float_or_none(data.get("weight")) or 1.0,
            source_file=data.get("source_file") or None,
            metadata=metadata,
        )

    def _evidence_from_payload(self, payload: GraphPayloadDTO, max_items: int) -> list[EvidenceItem]:
        items: list[EvidenceItem] = []
        for node in payload.nodes:
            if not node.source_file:
                continue
            items.append(
                EvidenceItem(
                    id=f"evidence-{node.id}",
                    label=node.label,
                    relation="node-source",
                    confidence="EXTRACTED",
                    source_file=node.source_file,
                    source_url=node.source_url,
                    community=node.community,
                    degree=node.degree,
                    score=node.score,
                    rationale="graph node with source_file metadata",
                    node_id=node.id,
                )
            )
            if len(items) >= max_items:
                break
        if not items:
            for edge in payload.edges[:max_items]:
                items.append(
                    EvidenceItem(
                        id=f"evidence-{edge.id}",
                        label=edge.relation or "graph relation",
                        relation=edge.relation or "related",
                        confidence=edge.confidence or "EXTRACTED",
                        source_file=edge.source_file,
                        node_id=edge.source,
                        target=edge.target,
                        rationale="graph edge evidence",
                    )
                )
        return items

    def _summary_for_query(self, question: str, evidence: list[EvidenceItem], payload: GraphPayloadDTO) -> str:
        if not evidence:
            return "질문과 관련된 노드/엣지는 찾았지만 표시 가능한 source evidence가 부족합니다. 그래프 결과를 검증해 주세요."
        labels = ", ".join(item.label for item in evidence[:3])
        return f"'{question}' 질문에 대해 {len(payload.nodes)}개 노드와 {len(payload.edges)}개 엣지의 제한 subgraph를 찾았습니다. 주요 근거: {labels}."

    def _citation_from_evidence(self, item: EvidenceItem, question: str) -> Citation:
        quote = self._quote_from_source(item.source_file, question=question, label=item.label) if item.source_file else None
        return Citation(
            id=item.id,
            label=item.label,
            source_file=item.source_file,
            source_url=item.source_url,
            node_id=item.node_id,
            target=item.target,
            relation=item.relation,
            quote=quote,
            rationale=item.rationale,
        )

    def _deterministic_answer_text(self, question: str, citations: list[Citation], query_result: QueryResponse) -> str:
        citation_lines: list[str] = []
        for index, citation in enumerate(citations, start=1):
            source = citation.source_file or citation.source_url or "source unavailable"
            quote = f" — 원문 발췌: {citation.quote}" if citation.quote else ""
            citation_lines.append(f"[{index}] {citation.label}: {citation.relation or 'evidence'} ({source}){quote}")
        joined = "\n".join(citation_lines)
        return (
            f"'{question}' 질문에 대해 그래프가 반환한 source evidence만 사용해 요약합니다. "
            f"{len(query_result.graph.nodes)}개 노드와 {len(query_result.graph.edges)}개 엣지 범위에서 확인된 주요 근거는 다음과 같습니다.\n"
            f"{joined}\n"
            "위 항목의 원문 경로와 그래프 연결을 기준으로 추가 확인하세요."
        )

    def _llm_answer_or_deterministic_fallback(
        self,
        *,
        request: AnswerRequest,
        query_result: QueryResponse,
        source_evidence: list[EvidenceItem],
        citations: list[Citation],
        deterministic_answer: str,
        warnings: list[str],
    ) -> AnswerResponse:
        def fallback(status: str, extra_warnings: list[str], *, provider: str | None = None, model: str | None = None) -> AnswerResponse:
            return AnswerResponse(
                question=request.question,
                mode="deterministic",
                answer=deterministic_answer,
                summary=query_result.summary,
                citations=citations,
                evidence=source_evidence,
                graph=query_result.graph,
                disclaimer=ANSWER_DISCLAIMER,
                provider=provider,
                model=model,
                llm_status=status,
                validated_citations=[citation.id for citation in citations],
                warnings=list(dict.fromkeys([*warnings, *extra_warnings])),
            )

        if not self._llm_provider_enabled():
            return fallback("disabled", ["llm_disabled", "deterministic_fallback"])

        provider_name = self._llm_provider_name()
        if provider_name != "coreline-codex-proxy":
            safe_provider = provider_name or "unset"
            return fallback("unsupported_provider", [f"llm_unsupported_provider:{safe_provider}", "deterministic_fallback"], provider=safe_provider)

        packed_context = pack_answer_context(
            citations,
            source_evidence,
            max_items=self._llm_max_context_items(),
            max_chars=self._llm_max_context_chars(),
        )
        if not packed_context.items:
            return fallback("fallback_no_context", ["llm_no_context", "deterministic_fallback"], provider=provider_name)

        try:
            provider = self._get_llm_provider()
        except LLMProviderError:
            return fallback("fallback_provider_config", ["llm_provider_config_error", "deterministic_fallback"], provider=provider_name)

        try:
            llm_result = provider.answer(
                LLMAnswerRequest(
                    question=request.question,
                    instructions=LEGAL_ANSWER_INSTRUCTIONS,
                    context_items=packed_context.items,
                    max_output_tokens=self._llm_max_output_tokens(),
                )
            )
        except LLMProviderError:
            return fallback(
                "fallback_provider_error",
                ["llm_provider_error", "deterministic_fallback"],
                provider=getattr(provider, "provider_name", provider_name),
                model=getattr(provider, "model", None),
            )

        allowed_source_ids = set(packed_context.citations_by_context_id)
        invalid_source_ids = [citation.source_id for citation in llm_result.citations if citation.source_id not in allowed_source_ids]
        if invalid_source_ids:
            return fallback(
                "fallback_invalid_citation",
                ["llm_invalid_citation", "deterministic_fallback"],
                provider=llm_result.provider,
                model=llm_result.model,
            )
        if not llm_result.refused and not llm_result.citations:
            return fallback(
                "fallback_no_citations",
                ["llm_no_citations", "deterministic_fallback"],
                provider=llm_result.provider,
                model=llm_result.model,
            )

        llm_citations = [
            self._citation_from_llm_citation(citation, packed_context.citations_by_context_id)
            for citation in llm_result.citations[: request.max_citations]
        ]
        llm_warnings = list(llm_result.warnings)
        if llm_result.refused:
            llm_warnings.append("llm_refused")
        answer = llm_result.answer.strip()
        if not answer:
            answer = "제공된 graph/source evidence만으로는 답변을 생성할 수 없습니다."
        return AnswerResponse(
            question=request.question,
            mode="llm",
            answer=answer,
            summary=query_result.summary,
            citations=llm_citations,
            evidence=source_evidence,
            graph=query_result.graph,
            disclaimer=ANSWER_DISCLAIMER,
            provider=llm_result.provider,
            model=llm_result.model,
            llm_status="refused" if llm_result.refused else "success",
            validated_citations=[citation.id for citation in llm_citations],
            warnings=list(dict.fromkeys([*warnings, *llm_warnings])),
        )

    def _citation_from_llm_citation(self, llm_citation: LLMAnswerCitation, citations_by_context_id: dict[str, Citation]) -> Citation:
        original = citations_by_context_id[llm_citation.source_id]
        return Citation(
            id=llm_citation.source_id,
            label=llm_citation.label or original.label,
            source_file=original.source_file,
            source_url=original.source_url,
            node_id=original.node_id,
            target=original.target,
            relation=original.relation,
            quote=llm_citation.quote,
            rationale=llm_citation.rationale or original.rationale,
        )

    def _quote_from_source(self, source_file: str | None, question: str, label: str) -> str | None:
        if not source_file:
            return None
        try:
            source = self.source(source_file, max_chars=12_000)
        except (FileNotFoundError, PermissionError, OSError):
            return None
        terms = self._tokenize(f"{question} {label}")
        fallback: str | None = None
        for line in source.content.splitlines():
            compact = re.sub(r"\s+", " ", line).strip()
            if not compact or compact.startswith("#"):
                continue
            if fallback is None:
                fallback = compact
            normalized = self._normalize(compact)
            if any(term in normalized for term in terms):
                return compact[:260]
        return fallback[:260] if fallback else None

    def _llm_provider_enabled(self) -> bool:
        return (
            os.environ.get("LEGAL_GRAPH_LLM_ENABLED", os.environ.get("LEGAL_GRAPH_CHAT_LLM_ENABLED", ""))
            .strip()
            .lower()
            in {"1", "true", "yes", "on"}
        )

    def _llm_provider_name(self) -> str:
        return os.environ.get("LEGAL_GRAPH_LLM_PROVIDER", "").strip().lower()

    def _get_llm_provider(self) -> LLMAnswerProvider:
        if self._llm_provider is not None:
            return self._llm_provider
        return CorelineCodexProxyProvider.from_env()

    def _llm_max_context_items(self) -> int:
        return self._env_int("LEGAL_GRAPH_LLM_MAX_CONTEXT_ITEMS", default=8, minimum=1, maximum=24)

    def _llm_max_context_chars(self) -> int:
        return self._env_int("LEGAL_GRAPH_LLM_MAX_CONTEXT_CHARS", default=8_000, minimum=500, maximum=96_000)

    def _llm_max_output_tokens(self) -> int:
        return self._env_int("LEGAL_GRAPH_LLM_MAX_OUTPUT_TOKENS", default=1024, minimum=128, maximum=4096)

    def _env_int(self, name: str, default: int, minimum: int, maximum: int) -> int:
        raw = os.environ.get(name, "").strip()
        if not raw:
            return default
        try:
            value = int(raw)
        except ValueError:
            return default
        return max(minimum, min(value, maximum))

    def _rank_nodes(self, terms: list[str], limit: int) -> list[tuple[float, str, list[str]]]:
        if not terms:
            return []
        max_degree = max((self.graph.degree(n) for n in self.graph.nodes), default=1)
        scored: list[tuple[float, str, list[str]]] = []
        for nid, data in self.graph.nodes(data=True):
            label = self._normalize(data.get("label") or nid)
            source = self._normalize(data.get("source_file") or "")
            matched = [t for t in terms if t in label or t in source]
            if not matched:
                continue
            exact_bonus = 2.0 if any(t == label for t in matched) else 0.0
            source_bonus = sum(0.4 for t in terms if t in source)
            degree = self.graph.degree(nid)
            hub_penalty = math.log1p(degree) / math.log1p(max_degree) if max_degree else 0
            score = len(matched) * 2.0 + exact_bonus + source_bonus - hub_penalty * 1.2
            scored.append((round(score, 4), str(nid), matched))
        return sorted(scored, key=lambda item: (item[0], -self.graph.degree(item[1])), reverse=True)[:limit]

    def _resolve_node(self, label: str | None = None, node_id: str | None = None) -> str:
        if node_id and node_id in self.graph:
            return node_id
        if label and label in self.graph:
            return label
        terms = self._tokenize(label or node_id or "")
        ranked = self._rank_nodes(terms, limit=1)
        if ranked:
            return ranked[0][1]
        raise KeyError(label or node_id or "")

    def _tokenize(self, text: str) -> list[str]:
        terms = [self._normalize(m.group(0)) for m in TOKEN_RE.finditer(text)]
        return [t for t in terms if len(t) >= 2]

    def _normalize(self, text: Any) -> str:
        return re.sub(r"\s+", "", str(text or "").lower()).replace("·", "ㆍ")

    def _label(self, nid: str) -> str:
        return str(self.graph.nodes[nid].get("label") or nid)

    def _edge_weight(self, u: str, v: str) -> float:
        data = self.graph.get_edge_data(u, v) or {}
        if isinstance(data, dict) and 0 in data:
            data = data[0]
        try:
            return float(data.get("weight", 1.0))
        except (TypeError, ValueError):
            return 1.0

    def _stop_hub_threshold(self) -> int:
        summary = self._raw_summary or self._read_summary_safe()
        nodes = self._int_or_none(summary.get("nodes")) or self.graph.number_of_nodes()
        return max(80, int(math.sqrt(nodes) * 4))

    def _max_degree(self) -> int:
        return max((self.graph.degree(n) for n in self.graph.nodes), default=0)

    def _int_or_none(self, value: Any) -> int | None:
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    def _float_or_none(self, value: Any) -> float | None:
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def _is_relative_to(self, path: Path, root: Path) -> bool:
        try:
            path.relative_to(root)
            return True
        except ValueError:
            return False

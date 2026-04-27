from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

EdgeMode = Literal["hidden", "focus", "all"]
AnswerMode = Literal["deterministic", "extractive", "llm"]
LayoutMode = Literal["clustered", "circular", "spherical"]


class ApiError(BaseModel):
    code: str
    message: str
    detail: Any | None = None
    recover_action: str | None = None


class GraphNodeDTO(BaseModel):
    id: str
    label: str
    community: int | str | None = None
    degree: int | float | None = None
    type: str | None = None
    file_type: str | None = None
    source_file: str | None = None
    source_url: str | None = None
    score: float | None = None
    size: float | None = None
    x: float | None = None
    y: float | None = None
    z: float | None = None
    is_hub: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)


class GraphEdgeDTO(BaseModel):
    id: str | None = None
    source: str
    target: str
    relation: str | None = None
    confidence: str | None = None
    confidence_score: float | None = None
    weight: float | None = None
    source_file: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class GraphPayloadDTO(BaseModel):
    nodes: list[GraphNodeDTO] = Field(default_factory=list)
    edges: list[GraphEdgeDTO] = Field(default_factory=list)
    seed_node_ids: list[str] = Field(default_factory=list)
    focus_node_id: str | None = None
    edge_mode: EdgeMode | None = None
    layout_mode: LayoutMode | None = None
    label: str | None = None
    generated_at: str | None = None
    partial: bool = False
    warnings: list[str] = Field(default_factory=list)


class EvidenceItem(BaseModel):
    id: str
    label: str
    relation: str
    confidence: str = "EXTRACTED"
    source_file: str | None = None
    source_url: str | None = None
    community: int | str | None = None
    degree: int | float | None = None
    score: float | None = None
    rationale: str | None = None
    node_id: str | None = None
    target: str | None = None


class RankReason(BaseModel):
    matched_terms: list[str] = Field(default_factory=list)
    seed_nodes: list[GraphNodeDTO] = Field(default_factory=list)
    hub_dampening_applied: bool = False
    stop_hub_threshold: int
    max_degree: int


class QueryRequest(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    max_nodes: int = Field(default=80, ge=1, le=300)
    max_edges: int = Field(default=240, ge=0, le=1500)
    depth: int = Field(default=1, ge=1, le=3)


class QueryResponse(BaseModel):
    question: str
    summary: str
    evidence: list[EvidenceItem] = Field(default_factory=list)
    graph: GraphPayloadDTO
    rank_reason: RankReason
    warnings: list[str] = Field(default_factory=list)


class Citation(BaseModel):
    id: str
    label: str
    source_file: str | None = None
    source_url: str | None = None
    node_id: str | None = None
    target: str | None = None
    relation: str | None = None
    quote: str | None = None
    rationale: str | None = None


class AnswerRequest(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    mode: AnswerMode = "deterministic"
    max_nodes: int = Field(default=80, ge=1, le=300)
    max_edges: int = Field(default=240, ge=0, le=1500)
    depth: int = Field(default=1, ge=1, le=3)
    max_citations: int = Field(default=5, ge=1, le=10)


class AnswerResponse(BaseModel):
    question: str
    mode: AnswerMode
    answer: str
    summary: str
    citations: list[Citation] = Field(default_factory=list)
    evidence: list[EvidenceItem] = Field(default_factory=list)
    graph: GraphPayloadDTO
    disclaimer: str
    provider: str | None = None
    model: str | None = None
    llm_status: str | None = None
    validated_citations: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class ExplainResponse(BaseModel):
    id: str
    label: str
    summary: str
    evidence: list[EvidenceItem] = Field(default_factory=list)
    graph: GraphPayloadDTO
    node: GraphNodeDTO
    warnings: list[str] = Field(default_factory=list)


class PathResponse(BaseModel):
    source: str
    target: str
    found: bool
    hops: int | None = None
    nodes: list[GraphNodeDTO] = Field(default_factory=list)
    edges: list[GraphEdgeDTO] = Field(default_factory=list)
    message: str | None = None


class HealthResponse(BaseModel):
    ok: bool
    status: str
    loaded: bool
    graph_path: str
    graph_version: str | None = None
    graph_hash: str | None = None
    graph_size_bytes: int | None = None
    generated_at: str | None = None
    mode: str | None = None
    nodes: int | None = None
    edges: int | None = None
    communities: int | None = None
    expected_nodes: int | None = None
    expected_edges: int | None = None
    expected_communities: int | None = None
    warnings: list[str] = Field(default_factory=list)
    message: str | None = None


class CommunityDTO(BaseModel):
    id: str
    label: str
    community: int
    member_count: int
    edge_count: int
    god_nodes: list[str] = Field(default_factory=list)
    cohesion: float | None = None
    size: float | None = None


class CommunityPayloadDTO(BaseModel):
    communities: list[CommunityDTO] = Field(default_factory=list)
    edges: list[GraphEdgeDTO] = Field(default_factory=list)
    generated_at: str | None = None
    warnings: list[str] = Field(default_factory=list)


class SourceResponse(BaseModel):
    path: str
    content: str
    language: str = "markdown"
    truncated: bool = False
    start_line: int = 1
    end_line: int


class PrecedentHealthResponse(BaseModel):
    ok: bool
    status: str
    root_path: str
    exists: bool
    file_count: int
    category_count: int
    categories: list[str] = Field(default_factory=list)
    courts: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    message: str | None = None


class PrecedentSearchResult(BaseModel):
    path: str
    title: str
    case_number: str | None = None
    case_name: str | None = None
    court_name: str | None = None
    court_level: str | None = None
    case_type: str | None = None
    decision_date: str | None = None
    category: str | None = None
    court: str | None = None
    source_url: str | None = None
    score: float
    snippet: str | None = None


class PrecedentSearchResponse(BaseModel):
    query: str
    results: list[PrecedentSearchResult] = Field(default_factory=list)
    limit: int
    total_considered: int
    warnings: list[str] = Field(default_factory=list)

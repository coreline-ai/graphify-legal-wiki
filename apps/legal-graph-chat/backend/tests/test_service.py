from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.llm_provider import CorelineCodexProxyProvider
from app.models import (
    ApiError,
    AnswerRequest,
    AnswerResponse,
    Citation,
    EvidenceItem,
    GraphEdgeDTO,
    GraphNodeDTO,
    GraphPayloadDTO,
    HealthResponse,
    PrecedentHealthResponse,
    PrecedentSearchResponse,
    PrecedentSearchResult,
    QueryRequest,
    QueryResponse,
    RankReason,
    SourceResponse,
)
from app.service import GraphPaths, GraphQueryService, default_paths

FIXTURE = Path(__file__).parent / "fixtures" / "legal_graph_small.json"
CONTRACT = Path(__file__).resolve().parents[2] / "contract" / "api-contract.snapshot.json"


def fixture_service(tmp_path: Path) -> GraphQueryService:
    data_root = tmp_path / "data" / "legalize-kr"
    out_dir = data_root / "graphify-out"
    precedent_root = tmp_path / "data" / "precedent-kr"
    out_dir.mkdir(parents=True)
    graph_path = out_dir / "graph.json"
    graph_path.write_text(FIXTURE.read_text(encoding="utf-8"), encoding="utf-8")
    (out_dir / "run-summary.json").write_text(json.dumps({"mode": "test", "nodes": 4, "edges": 3, "communities": 2}), encoding="utf-8")
    source = data_root / "kr" / "개인정보보호법"
    source.mkdir(parents=True)
    (source / "법률.md").write_text("# 개인정보 보호법\n\n테스트 본문", encoding="utf-8")
    civil_source = data_root / "kr" / "민법"
    civil_source.mkdir(parents=True)
    (civil_source / "법률.md").write_text("# 민법\n\n계약과 손해배상 테스트 본문", encoding="utf-8")

    supreme = precedent_root / "민사" / "대법원"
    district = precedent_root / "형사" / "하급심"
    supreme.mkdir(parents=True)
    district.mkdir(parents=True)
    (supreme / "2020다12345.md").write_text(
        """---
판례일련번호: '1'
사건번호: 2020다12345
사건명: 손해배상
법원명: 대법원
법원등급: 대법원
사건종류: 민사
출처: https://example.test/precedent/1
선고일자: 2020-01-02
---

# 손해배상

## 판결요지

민법상 계약 책임과 손해배상 범위를 판단한 사례입니다.
""",
        encoding="utf-8",
    )
    (district / "2021고단9.md").write_text(
        """---
판례일련번호: '2'
사건번호: 2021고단9
사건명: 개인정보보호법위반
법원명: 서울중앙지방법원
법원등급: 하급심
사건종류: 형사
출처: https://example.test/precedent/2
선고일자: 2021-03-04
---

# 개인정보보호법위반

## 판례내용

개인정보 처리와 보호 조치에 관한 사례입니다.
""",
        encoding="utf-8",
    )
    return GraphQueryService(GraphPaths(tmp_path, data_root, out_dir, graph_path, out_dir / "run-summary.json", out_dir / "GRAPH_REPORT.md", precedent_root))


def test_default_paths_honors_source_root_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    source_root = tmp_path / "mounted-legalize-kr"
    monkeypatch.setenv("LEGAL_GRAPH_SOURCE_ROOT", str(source_root))

    paths = default_paths()

    assert paths.data_root == source_root
    assert paths.out_dir == source_root / "graphify-out"


@pytest.fixture
def fixture_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(main_module, "service", fixture_service(tmp_path))
    return TestClient(main_module.app)


def load_contract() -> dict:
    return json.loads(CONTRACT.read_text(encoding="utf-8"))


def assert_contract_keys(payload: dict, model_name: str) -> None:
    expected = set(load_contract()["models"][model_name]["required_fields"])
    assert set(payload) == expected


def test_contract_snapshot_matches_pydantic_model_fields():
    contract = load_contract()["models"]
    models = {
        "ApiError": ApiError,
        "AnswerRequest": AnswerRequest,
        "AnswerResponse": AnswerResponse,
        "Citation": Citation,
        "EvidenceItem": EvidenceItem,
        "GraphEdgeDTO": GraphEdgeDTO,
        "GraphNodeDTO": GraphNodeDTO,
        "GraphPayloadDTO": GraphPayloadDTO,
        "HealthResponse": HealthResponse,
        "PrecedentHealthResponse": PrecedentHealthResponse,
        "PrecedentSearchResponse": PrecedentSearchResponse,
        "PrecedentSearchResult": PrecedentSearchResult,
        "QueryResponse": QueryResponse,
        "RankReason": RankReason,
        "SourceResponse": SourceResponse,
    }
    for name, model in models.items():
        assert name in contract
        assert set(model.model_fields) == set(contract[name]["required_fields"])
        assert set(contract[name]["example"]) == set(contract[name]["required_fields"])


def test_fastapi_contract_shapes_use_fixture_graph(fixture_client: TestClient):
    health_response = fixture_client.get("/health")
    assert health_response.headers["etag"].startswith('W/"')
    assert "max-age" in health_response.headers["cache-control"]
    assert "x-process-time-ms" in health_response.headers
    health = health_response.json()
    assert_contract_keys(health, "HealthResponse")
    assert health["nodes"] == 4
    assert health["edges"] == 3
    assert health["communities"] == 2

    query = fixture_client.post("/query", json={"question": "민법", "max_nodes": 10, "max_edges": 10, "depth": 1}).json()
    assert_contract_keys(query, "QueryResponse")
    assert_contract_keys(query["graph"], "GraphPayloadDTO")
    assert_contract_keys(query["rank_reason"], "RankReason")
    assert query["evidence"]
    assert_contract_keys(query["evidence"][0], "EvidenceItem")
    assert query["graph"]["nodes"]
    assert_contract_keys(query["graph"]["nodes"][0], "GraphNodeDTO")
    assert query["graph"]["edges"]
    assert_contract_keys(query["graph"]["edges"][0], "GraphEdgeDTO")

    answer = fixture_client.post("/answer", json={"question": "민법", "mode": "llm", "max_nodes": 10, "max_edges": 10, "depth": 1}).json()
    assert_contract_keys(answer, "AnswerResponse")
    assert answer["mode"] == "deterministic"
    assert "llm_disabled" in answer["warnings"]
    assert answer["citations"]
    assert_contract_keys(answer["citations"][0], "Citation")

    subgraph = fixture_client.post("/subgraph/3d", json={"question": "민법", "max_nodes": 10, "max_edges": 10}).json()
    assert_contract_keys(subgraph, "GraphPayloadDTO")

    source = fixture_client.get("/source", params={"path": "kr/개인정보보호법/법률.md"}).json()
    assert_contract_keys(source, "SourceResponse")
    assert source["language"] == "markdown"

    error = fixture_client.get("/source", params={"path": "../secret.txt"}).json()
    assert_contract_keys(error, "ApiError")
    assert error["code"] == "SOURCE_FORBIDDEN"

    precedents_health = fixture_client.get("/precedents/health").json()
    assert_contract_keys(precedents_health, "PrecedentHealthResponse")
    assert precedents_health["file_count"] == 2

    precedents = fixture_client.get("/precedents/search", params={"q": "민법", "limit": 5}).json()
    assert_contract_keys(precedents, "PrecedentSearchResponse")
    assert precedents["results"]
    assert_contract_keys(precedents["results"][0], "PrecedentSearchResult")

    precedent_source = fixture_client.get("/precedents/source", params={"path": "민사/대법원/2020다12345.md"}).json()
    assert_contract_keys(precedent_source, "SourceResponse")
    assert "손해배상" in precedent_source["content"]


def test_health_loads_fixture(tmp_path: Path):
    service = fixture_service(tmp_path)
    health = service.health()
    assert health.loaded is True
    assert health.nodes == 4
    assert health.edges == 3
    assert health.communities == 2


def test_query_matches_two_character_law_name(tmp_path: Path):
    service = fixture_service(tmp_path)
    result = service.query(QueryRequest(question="민법", max_nodes=10, max_edges=10))
    assert result.evidence
    assert any(item.label == "민법" for item in result.evidence)


def test_query_no_match_returns_empty_graph_warning(tmp_path: Path):
    service = fixture_service(tmp_path)
    result = service.query(QueryRequest(question="없는법률", max_nodes=10, max_edges=10))
    assert result.evidence == []
    assert result.graph.nodes == []
    assert "no_match" in result.warnings


def test_answer_is_deterministic_and_source_grounded(tmp_path: Path):
    service = fixture_service(tmp_path)
    result = service.answer(AnswerRequest(question="민법 계약", mode="deterministic", max_nodes=10, max_edges=10))

    assert result.mode == "deterministic"
    assert result.citations
    assert result.citations[0].source_file
    assert "법률 자문" in result.disclaimer
    assert "계약과 손해배상" in (result.citations[0].quote or result.answer)


def test_answer_llm_mode_disabled_by_default(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("LEGAL_GRAPH_CHAT_LLM_ENABLED", raising=False)
    monkeypatch.delenv("LEGAL_GRAPH_LLM_ENABLED", raising=False)
    service = fixture_service(tmp_path)

    result = service.answer(AnswerRequest(question="민법", mode="llm", max_nodes=10, max_edges=10))

    assert result.mode == "deterministic"
    assert result.llm_status == "disabled"
    assert "llm_disabled" in result.warnings
    assert "deterministic_fallback" in result.warnings


def test_answer_llm_coreline_success_uses_validated_citations(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("LEGAL_GRAPH_CHAT_LLM_ENABLED", raising=False)
    monkeypatch.setenv("LEGAL_GRAPH_LLM_ENABLED", "true")
    monkeypatch.setenv("LEGAL_GRAPH_LLM_PROVIDER", "coreline-codex-proxy")
    captured_requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/legal-answer"
        assert request.headers["authorization"] == "Bearer test-token"
        payload = json.loads(request.content.decode("utf-8"))
        captured_requests.append(payload)
        source_id = payload["context_items"][0]["id"]
        return httpx.Response(
            200,
            json={
                "schema_version": "coreline-codex-proxy.v1",
                "answer": "LLM 요약: 제공된 근거는 민법상 계약 책임과 손해배상을 설명합니다.",
                "citations": [{"source_id": source_id, "label": "민법", "quote": "계약과 손해배상 테스트 본문", "rationale": "bounded quote"}],
                "uncertainty": "low",
                "refused": False,
                "warnings": [],
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    provider = CorelineCodexProxyProvider(base_url="https://coreline.test", token="test-token", model="test-model", client=client)
    service = fixture_service(tmp_path)
    service._llm_provider = provider

    result = service.answer(AnswerRequest(question="민법 계약", mode="llm", max_nodes=10, max_edges=10))

    assert result.mode == "llm"
    assert result.provider == "coreline-codex-proxy"
    assert result.model == "test-model"
    assert result.llm_status == "success"
    assert result.validated_citations == [result.citations[0].id]
    assert "LLM 요약" in result.answer
    assert captured_requests
    assert captured_requests[0]["context_items"]
    assert "# 민법" not in captured_requests[0]["context_items"][0]["quote"]


def test_coreline_provider_from_env_accepts_proxy_alias_secret_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    token_file = tmp_path / "coreline_token"
    token_file.write_text("test-token\n", encoding="utf-8")
    monkeypatch.delenv("CORELINE_CODEX_PROXY_URL", raising=False)
    monkeypatch.delenv("CORELINE_CODEX_PROXY_TOKEN", raising=False)
    monkeypatch.delenv("CORELINE_CODEX_PROXY_TOKEN_FILE", raising=False)
    monkeypatch.delenv("LEGAL_GRAPH_CODEX_PROXY_TOKEN", raising=False)
    monkeypatch.setenv("LEGAL_GRAPH_CODEX_PROXY_BASE_URL", "https://coreline.test")
    monkeypatch.setenv("LEGAL_GRAPH_CODEX_PROXY_TOKEN_FILE", str(token_file))

    provider = CorelineCodexProxyProvider.from_env()

    assert provider.base_url == "https://coreline.test"
    assert provider.token == "test-token"


def test_answer_llm_invalid_citation_falls_back(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("LEGAL_GRAPH_CHAT_LLM_ENABLED", raising=False)
    monkeypatch.setenv("LEGAL_GRAPH_LLM_ENABLED", "true")
    monkeypatch.setenv("LEGAL_GRAPH_LLM_PROVIDER", "coreline-codex-proxy")

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "schema_version": "coreline-codex-proxy.v1",
                "answer": "검증되지 않은 LLM 답변",
                "citations": [{"source_id": "not-in-context", "label": "외부", "quote": "외부 인용", "rationale": None}],
                "uncertainty": "medium",
                "refused": False,
                "warnings": [],
            },
        )

    service = fixture_service(tmp_path)
    service._llm_provider = CorelineCodexProxyProvider(base_url="https://coreline.test", token="test-token", client=httpx.Client(transport=httpx.MockTransport(handler)))

    result = service.answer(AnswerRequest(question="민법 계약", mode="llm", max_nodes=10, max_edges=10))

    assert result.mode == "deterministic"
    assert result.llm_status == "fallback_invalid_citation"
    assert "llm_invalid_citation" in result.warnings
    assert "deterministic_fallback" in result.warnings
    assert "검증되지 않은 LLM 답변" not in result.answer


def test_answer_llm_proxy_down_falls_back(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("LEGAL_GRAPH_CHAT_LLM_ENABLED", raising=False)
    monkeypatch.setenv("LEGAL_GRAPH_LLM_ENABLED", "true")
    monkeypatch.setenv("LEGAL_GRAPH_LLM_PROVIDER", "coreline-codex-proxy")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("proxy down", request=request)

    service = fixture_service(tmp_path)
    service._llm_provider = CorelineCodexProxyProvider(base_url="https://coreline.test", token="test-token", client=httpx.Client(transport=httpx.MockTransport(handler)))

    result = service.answer(AnswerRequest(question="민법 계약", mode="llm", max_nodes=10, max_edges=10))

    assert result.mode == "deterministic"
    assert result.llm_status == "fallback_provider_error"
    assert "llm_provider_error" in result.warnings
    assert "deterministic_fallback" in result.warnings


def test_answer_without_source_evidence_refuses_to_generate(tmp_path: Path):
    service = fixture_service(tmp_path)
    result = service.answer(AnswerRequest(question="없는법률", max_nodes=10, max_edges=10))

    assert result.citations == []
    assert "no_source_evidence" in result.warnings
    assert "답변을 생성하지 않았습니다" in result.answer


def test_source_rejects_traversal(tmp_path: Path):
    service = fixture_service(tmp_path)
    with pytest.raises(PermissionError):
        service.source("../secret.txt")


def test_source_rejects_absolute_path(tmp_path: Path):
    service = fixture_service(tmp_path)
    secret = tmp_path / "secret.txt"
    secret.write_text("outside allowed roots", encoding="utf-8")
    with pytest.raises(PermissionError):
        service.source(str(secret))


def test_source_rejects_missing_file(tmp_path: Path):
    service = fixture_service(tmp_path)
    with pytest.raises(FileNotFoundError):
        service.source("kr/개인정보보호법/없는파일.md")


def test_source_rejects_symlink_escape(tmp_path: Path):
    service = fixture_service(tmp_path)
    outside = tmp_path / "outside-secret.md"
    outside.write_text("outside allowed roots", encoding="utf-8")
    link = service.paths.data_root / "kr" / "escape.md"
    try:
        link.symlink_to(outside)
    except OSError as exc:
        pytest.skip(f"symlink creation unavailable: {exc}")

    with pytest.raises(PermissionError):
        service.source("kr/escape.md")


def test_source_allows_legalize_relative_path(tmp_path: Path):
    service = fixture_service(tmp_path)
    result = service.source("kr/개인정보보호법/법률.md")
    assert "개인정보" in result.content


def test_precedent_health_search_and_source_use_fixture_corpus(tmp_path: Path):
    service = fixture_service(tmp_path)

    health = service.precedent_health()
    search = service.search_precedents("민법", limit=5)
    source = service.precedent_source("민사/대법원/2020다12345.md")

    assert health.ok is True
    assert health.file_count == 2
    assert health.category_count == 2
    assert search.results
    assert search.results[0].path == "민사/대법원/2020다12345.md"
    assert search.limit == 5
    assert "민법상 계약 책임" in (search.results[0].snippet or "")
    assert "손해배상" in source.content


def test_precedent_search_applies_limit(tmp_path: Path):
    service = fixture_service(tmp_path)

    result = service.search_precedents("사례", limit=1)

    assert len(result.results) == 1
    assert result.limit == 1


def test_precedent_source_rejects_traversal_and_absolute_path(tmp_path: Path):
    service = fixture_service(tmp_path)

    with pytest.raises(PermissionError):
        service.precedent_source("../secret.md")
    with pytest.raises(PermissionError):
        service.precedent_source(str(tmp_path / "data" / "precedent-kr" / "민사" / "대법원" / "2020다12345.md"))


def test_precedent_source_rejects_symlink_escape(tmp_path: Path):
    service = fixture_service(tmp_path)
    outside = tmp_path / "outside-precedent.md"
    outside.write_text("outside allowed roots", encoding="utf-8")
    link = service.precedents.root / "민사" / "대법원" / "escape.md"
    try:
        link.symlink_to(outside)
    except OSError as exc:
        pytest.skip(f"symlink creation unavailable: {exc}")

    with pytest.raises(PermissionError):
        service.precedent_source("민사/대법원/escape.md")


def test_subgraph_limits_nodes(tmp_path: Path):
    service = fixture_service(tmp_path)
    graph = service.subgraph_for_node("law_privacy", depth=2, max_nodes=2, max_edges=2)
    assert len(graph.nodes) <= 2
    assert graph.partial is True


def test_full_graph_focus_without_focus_node_hides_edges(tmp_path: Path):
    service = fixture_service(tmp_path)
    graph = service.full_graph_3d(edge_mode="focus")
    assert len(graph.nodes) == 4
    assert graph.edges == []
    assert any("focus_node_id is required" in warning for warning in graph.warnings)


def test_full_graph_all_edges_requires_explicit_confirmation(tmp_path: Path):
    service = fixture_service(tmp_path)

    guarded = service.full_graph_3d(edge_mode="all")
    confirmed = service.full_graph_3d(edge_mode="all", confirm_all_edges=True)

    assert len(guarded.nodes) == 4
    assert guarded.edges == []
    assert guarded.partial is True
    assert any("confirm_all_edges=true" in warning for warning in guarded.warnings)
    assert len(confirmed.edges) == 3


def test_full_graph_node_limit_sorts_by_degree_and_marks_partial(tmp_path: Path):
    service = fixture_service(tmp_path)

    graph = service.full_graph_3d(node_limit=2)

    assert len(graph.nodes) == 2
    assert [node.degree for node in graph.nodes] == sorted([node.degree for node in graph.nodes], reverse=True)
    assert {node.id for node in graph.nodes} == {"law_privacy", "hub_purpose"}
    assert graph.partial is True
    assert any("node limit reached" in warning for warning in graph.warnings)


def test_full_graph_edge_limit_applies_to_focus_and_confirmed_all_edges(tmp_path: Path):
    service = fixture_service(tmp_path)

    focus = service.full_graph_3d(edge_mode="focus", focus_node_id="law_privacy", edge_limit=1)
    confirmed = service.full_graph_3d(edge_mode="all", confirm_all_edges=True, edge_limit=1)

    assert len(focus.edges) == 1
    assert focus.partial is True
    assert any("edge limit reached" in warning for warning in focus.warnings)
    assert len(confirmed.edges) == 1
    assert confirmed.partial is True
    assert any("edge limit reached" in warning for warning in confirmed.warnings)


def test_full_graph_focus_node_is_preserved_when_limit_would_exclude_it(tmp_path: Path):
    service = fixture_service(tmp_path)

    graph = service.full_graph_3d(edge_mode="focus", focus_node_id="law_civil", node_limit=1)

    assert [node.id for node in graph.nodes] == ["law_civil"]
    assert graph.focus_node_id == "law_civil"
    assert graph.partial is True
    assert any("focus node preserved" in warning for warning in graph.warnings)


def test_full_graph_all_edges_fastapi_confirmation_param(fixture_client: TestClient):
    guarded = fixture_client.get("/graph/full-3d", params={"edge_mode": "all"}).json()
    confirmed = fixture_client.get("/graph/full-3d", params={"edge_mode": "all", "confirm_all_edges": "true"}).json()

    assert guarded["edges"] == []
    assert guarded["partial"] is True
    assert len(confirmed["edges"]) == 3


def test_full_graph_static_layout_includes_deterministic_coordinates(tmp_path: Path):
    service = fixture_service(tmp_path)

    legacy = service.full_graph_3d(edge_mode="all", confirm_all_edges=True)
    static = service.full_graph_3d(edge_mode="all", confirm_all_edges=True, static_layout=True)
    static_again = service.full_graph_3d(edge_mode="all", confirm_all_edges=True, static_layout=True)

    assert legacy.nodes[0].x is None
    assert legacy.layout_mode is None
    assert len(static.nodes) == 4
    assert len(static.edges) == 3
    assert static.layout_mode == "spherical"
    assert all(node.x is not None and node.y is not None and node.z is not None for node in static.nodes)
    assert [(node.id, node.x, node.y, node.z) for node in static.nodes] == [(node.id, node.x, node.y, node.z) for node in static_again.nodes]
    assert any("static_layout=true" in warning for warning in static.warnings)
    assert any("layout_mode=spherical" in warning for warning in static.warnings)


def test_full_graph_circular_static_layout_is_deterministic(tmp_path: Path):
    service = fixture_service(tmp_path)

    circular = service.full_graph_3d(edge_mode="all", confirm_all_edges=True, static_layout=True, static_layout_mode="circular")
    circular_again = service.full_graph_3d(edge_mode="all", confirm_all_edges=True, static_layout=True, static_layout_mode="circular")
    clustered = service.full_graph_3d(edge_mode="all", confirm_all_edges=True, static_layout=True, static_layout_mode="clustered")

    assert circular.layout_mode == "circular"
    assert len(circular.nodes) == 4
    assert all(node.x is not None and node.y is not None and node.z is not None for node in circular.nodes)
    assert [(node.id, node.x, node.y, node.z) for node in circular.nodes] == [(node.id, node.x, node.y, node.z) for node in circular_again.nodes]
    assert [(node.id, node.x, node.y, node.z) for node in circular.nodes] != [(node.id, node.x, node.y, node.z) for node in clustered.nodes]
    assert any("layout_mode=circular" in warning for warning in circular.warnings)


def test_full_graph_circular_static_layout_uses_sane_annulus_bounds(tmp_path: Path):
    service = fixture_service(tmp_path)
    graph = service.graph
    graph.clear()
    for community, count in [(0, 30), (1, 20), (2, 10)]:
        for index in range(count):
            nid = f"c{community}_n{index:02d}"
            graph.add_node(nid, label=f"Community {community} node {index:02d}", community=community, file_type="document")
    for community, count in [(0, 30), (1, 20), (2, 10)]:
        for index in range(count - 1):
            graph.add_edge(f"c{community}_n{index:02d}", f"c{community}_n{index + 1:02d}", relation="related", confidence="EXTRACTED", weight=1.0)
    for index in range(10):
        graph.add_edge(f"c0_n{index:02d}", f"c1_n{index:02d}", relation="related", confidence="EXTRACTED", weight=1.0)
        graph.add_edge(f"c1_n{index:02d}", f"c2_n{index:02d}", relation="related", confidence="EXTRACTED", weight=1.0)

    payload = service.full_graph_3d(static_layout=True, static_layout_mode="circular")

    radii = [(node.x**2 + node.z**2) ** 0.5 for node in payload.nodes if node.x is not None and node.z is not None]
    xs = [node.x for node in payload.nodes if node.x is not None]
    ys = [node.y for node in payload.nodes if node.y is not None]
    zs = [node.z for node in payload.nodes if node.z is not None]
    assert min(radii) >= 250.0
    assert max(radii) <= 790.0
    assert max(abs(y) for y in ys) <= 140.0
    aspect_ratio = (max(xs) - min(xs)) / (max(zs) - min(zs))
    assert 0.65 <= aspect_ratio <= 1.55

    largest = [node for node in payload.nodes if node.community == 0]
    largest_radii = sorted((node.x**2 + node.z**2) ** 0.5 for node in largest if node.x is not None and node.z is not None)
    assert largest_radii[-1] - largest_radii[0] > 250.0



def test_full_graph_spherical_static_layout_is_deterministic_and_3d(tmp_path: Path):
    service = fixture_service(tmp_path)

    spherical = service.full_graph_3d(edge_mode="all", confirm_all_edges=True, static_layout=True, static_layout_mode="spherical")
    spherical_again = service.full_graph_3d(edge_mode="all", confirm_all_edges=True, static_layout=True, static_layout_mode="spherical")
    clustered = service.full_graph_3d(edge_mode="all", confirm_all_edges=True, static_layout=True, static_layout_mode="clustered")

    assert spherical.layout_mode == "spherical"
    assert len(spherical.nodes) == 4
    assert all(node.x is not None and node.y is not None and node.z is not None for node in spherical.nodes)
    assert [(node.id, node.x, node.y, node.z) for node in spherical.nodes] == [(node.id, node.x, node.y, node.z) for node in spherical_again.nodes]
    assert [(node.id, node.x, node.y, node.z) for node in spherical.nodes] != [(node.id, node.x, node.y, node.z) for node in clustered.nodes]
    assert any("layout_mode=spherical" in warning for warning in spherical.warnings)


def test_full_graph_spherical_static_layout_uses_round_3d_cloud(tmp_path: Path):
    service = fixture_service(tmp_path)
    graph = service.graph
    graph.clear()
    for community, count in [(0, 60), (1, 45), (2, 30), (3, 15)]:
        for index in range(count):
            nid = f"s{community}_n{index:02d}"
            graph.add_node(nid, label=f"Sphere community {community} node {index:02d}", community=community, file_type="document")
    for community, count in [(0, 60), (1, 45), (2, 30), (3, 15)]:
        for index in range(count - 1):
            graph.add_edge(f"s{community}_n{index:02d}", f"s{community}_n{index + 1:02d}", relation="related", confidence="EXTRACTED", weight=1.0)
    for index in range(15):
        graph.add_edge(f"s0_n{index:02d}", f"s1_n{index:02d}", relation="cross", confidence="EXTRACTED", weight=1.0)
        graph.add_edge(f"s1_n{index:02d}", f"s2_n{index:02d}", relation="cross", confidence="EXTRACTED", weight=1.0)

    payload = service.full_graph_3d(static_layout=True, static_layout_mode="spherical")

    xs = [node.x for node in payload.nodes if node.x is not None]
    ys = [node.y for node in payload.nodes if node.y is not None]
    zs = [node.z for node in payload.nodes if node.z is not None]
    radii = [(node.x**2 + node.y**2 + node.z**2) ** 0.5 for node in payload.nodes if node.x is not None and node.y is not None and node.z is not None]
    xz_radii = [(node.x**2 + node.z**2) ** 0.5 for node in payload.nodes if node.x is not None and node.z is not None]
    assert min(radii) >= 500.0
    assert max(radii) <= 805.0
    assert min(xz_radii) < 180.0
    assert max(xz_radii) > 650.0
    assert max(xs) - min(xs) > 900.0
    assert max(ys) - min(ys) > 700.0
    assert max(zs) - min(zs) > 900.0
    xy_aspect = (max(xs) - min(xs)) / (max(ys) - min(ys))
    xz_aspect = (max(xs) - min(xs)) / (max(zs) - min(zs))
    assert 0.7 <= xy_aspect <= 1.7
    assert 0.7 <= xz_aspect <= 1.7

def test_full_graph_static_layout_fastapi_param(fixture_client: TestClient):
    payload = fixture_client.get("/graph/full-3d", params={"edge_mode": "hidden", "node_limit": 2, "static_layout": "true"}).json()
    clustered = fixture_client.get(
        "/graph/full-3d",
        params={"edge_mode": "hidden", "node_limit": 2, "static_layout": "true", "static_layout_mode": "clustered"},
    ).json()
    circular = fixture_client.get(
        "/graph/full-3d",
        params={"edge_mode": "hidden", "node_limit": 2, "static_layout": "true", "static_layout_mode": "circular"},
    ).json()
    spherical = fixture_client.get(
        "/graph/full-3d",
        params={"edge_mode": "hidden", "node_limit": 2, "static_layout": "true", "static_layout_mode": "spherical"},
    ).json()
    invalid = fixture_client.get("/graph/full-3d", params={"static_layout": "true", "static_layout_mode": "spiral"})

    assert len(payload["nodes"]) == 2
    assert payload["layout_mode"] == "spherical"
    assert all(node["x"] is not None and node["y"] is not None and node["z"] is not None for node in payload["nodes"])
    assert any("static_layout=true" in warning for warning in payload["warnings"])
    assert clustered["layout_mode"] == "clustered"
    assert all(node["x"] is not None and node["y"] is not None and node["z"] is not None for node in clustered["nodes"])
    assert circular["layout_mode"] == "circular"
    assert all(node["x"] is not None and node["y"] is not None and node["z"] is not None for node in circular["nodes"])
    assert spherical["layout_mode"] == "spherical"
    assert all(node["x"] is not None and node["y"] is not None and node["z"] is not None for node in spherical["nodes"])
    assert invalid.status_code == 422


def test_full_graph_fastapi_bounded_params_and_validation(fixture_client: TestClient):
    response = fixture_client.get(
        "/graph/full-3d",
        params={"edge_mode": "all", "confirm_all_edges": "true", "node_limit": 2, "edge_limit": 1, "min_degree": 1, "community_id": "community-1"},
    )
    invalid = fixture_client.get("/graph/full-3d", params={"node_limit": 0})

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["nodes"]) <= 2
    assert all(node["community"] == 1 for node in payload["nodes"])
    assert len(payload["edges"]) <= 1
    assert payload["partial"] is True
    assert invalid.status_code == 422


def test_auth_required_blocks_sensitive_api_without_proxy_header(fixture_client: TestClient, monkeypatch: pytest.MonkeyPatch):
    main_module.rate_limiter.reset()
    monkeypatch.setenv("LEGAL_GRAPH_AUTH_REQUIRED", "true")
    monkeypatch.delenv("LEGAL_GRAPH_RATE_LIMIT_ENABLED", raising=False)

    blocked = fixture_client.post("/answer", json={"question": "민법", "max_nodes": 10, "max_edges": 10, "depth": 1})
    allowed = fixture_client.post(
        "/answer",
        headers={"X-Forwarded-User": "tester@example.test"},
        json={"question": "민법", "max_nodes": 10, "max_edges": 10, "depth": 1},
    )

    assert blocked.status_code == 401
    assert blocked.json()["code"] == "AUTH_REQUIRED"
    assert allowed.status_code == 200


def test_rate_limit_blocks_repeated_answer_requests(fixture_client: TestClient, monkeypatch: pytest.MonkeyPatch):
    main_module.rate_limiter.reset()
    monkeypatch.delenv("LEGAL_GRAPH_AUTH_REQUIRED", raising=False)
    monkeypatch.setenv("LEGAL_GRAPH_RATE_LIMIT_ENABLED", "true")
    monkeypatch.setenv("LEGAL_GRAPH_RATE_LIMIT_ANSWER_BURST", "1")
    monkeypatch.setenv("LEGAL_GRAPH_RATE_LIMIT_ANSWER_PER_MINUTE", "0")

    first = fixture_client.post("/answer", json={"question": "민법", "max_nodes": 10, "max_edges": 10, "depth": 1})
    second = fixture_client.post("/answer", json={"question": "민법", "max_nodes": 10, "max_edges": 10, "depth": 1})

    assert first.status_code == 200
    assert second.status_code == 429
    assert second.headers["retry-after"] == "60"
    assert second.json()["code"] == "RATE_LIMITED"


def test_health_reports_malformed_graph(tmp_path: Path):
    data_root = tmp_path / "data" / "legalize-kr"
    out_dir = data_root / "graphify-out"
    out_dir.mkdir(parents=True)
    graph_path = out_dir / "graph.json"
    graph_path.write_text("{not valid json", encoding="utf-8")
    service = GraphQueryService(GraphPaths(tmp_path, data_root, out_dir, graph_path, out_dir / "run-summary.json", out_dir / "GRAPH_REPORT.md"))

    health = service.health()

    assert health.ok is False
    assert health.loaded is False
    assert health.status == "error"
    assert "malformed" in (health.message or "")


def test_fastapi_health_uses_real_or_local_graph():
    client = TestClient(main_module.app)
    response = client.get("/health")
    assert response.status_code in {200, 503}
    payload = response.json()
    assert "status" in payload or "code" in payload

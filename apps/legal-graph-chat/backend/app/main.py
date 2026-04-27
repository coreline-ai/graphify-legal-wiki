from __future__ import annotations

import hashlib
import logging
import os
import time

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .models import AnswerRequest, ApiError, EdgeMode, LayoutMode, QueryRequest
from .rate_limit import InProcessTokenBucketRateLimiter
from .service import GraphLoadError, GraphQueryService

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("legal_graph_chat.api")

service = GraphQueryService()
rate_limiter = InProcessTokenBucketRateLimiter()
app = FastAPI(title="Graphify Legal Graph Chat API", version="0.1.0")


def allowed_origins() -> list[str]:
    configured = os.environ.get("LEGAL_GRAPH_ALLOWED_ORIGINS", "")
    if configured.strip():
        return [origin.strip() for origin in configured.split(",") if origin.strip()]
    return [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:5174",
        "http://localhost:5174",
    ]

app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Accept", "Authorization", "X-Forwarded-User"],
)


class Subgraph3DRequest(BaseModel):
    question: str | None = Field(default=None, max_length=500)
    node_id: str | None = None
    max_nodes: int = Field(default=120, ge=1, le=300)
    max_edges: int = Field(default=500, ge=0, le=1500)


def error_response(status: int, code: str, message: str, detail=None, recover_action: str | None = None) -> JSONResponse:
    return JSONResponse(status_code=status, content=ApiError(code=code, message=message, detail=detail, recover_action=recover_action).model_dump())


def set_cache_headers(response: Response, scope: str, max_age: int = 30, extra: str = "") -> None:
    raw = f"{scope}:{service.cache_token()}:{extra}"
    tag = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]
    response.headers["ETag"] = f'W/"{tag}"'
    response.headers["Cache-Control"] = f"private, max-age={max_age}"
    response.headers["Vary"] = "Accept-Encoding"


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(minimum, min(value, maximum))


def trusted_proxy_header_name() -> str:
    return os.environ.get("LEGAL_GRAPH_TRUSTED_PROXY_HEADER", "X-Forwarded-User").strip() or "X-Forwarded-User"


def is_sensitive_or_mutating(request: Request) -> bool:
    if request.method in {"OPTIONS", "HEAD"}:
        return False
    if request.method != "GET":
        return True
    return request.url.path in {"/source", "/precedents/source", "/graph/full-3d"}


def request_identity(request: Request) -> str:
    proxy_user = request.headers.get(trusted_proxy_header_name(), "").strip()
    if proxy_user:
        return proxy_user
    if request.client and request.client.host:
        return request.client.host
    return "anonymous"


@app.middleware("http")
async def auth_and_rate_limit(request: Request, call_next):
    if request.method != "OPTIONS" and env_bool("LEGAL_GRAPH_AUTH_REQUIRED", default=False) and is_sensitive_or_mutating(request):
        header = trusted_proxy_header_name()
        if not request.headers.get(header, "").strip():
            return error_response(
                401,
                "AUTH_REQUIRED",
                f"Missing trusted proxy identity header: {header}",
                recover_action="Authenticate through the trusted reverse proxy before using sensitive APIs.",
            )

    decision = rate_limiter.check(request.url.path, request_identity(request))
    if not decision.allowed:
        response = error_response(
            429,
            "RATE_LIMITED",
            "Too many requests for this endpoint.",
            detail={"route": decision.route_key, "retry_after_seconds": decision.retry_after_seconds},
            recover_action="Wait and retry, or configure a higher backend/proxy rate limit.",
        )
        response.headers["Retry-After"] = str(decision.retry_after_seconds)
        response.headers["X-RateLimit-Limit"] = str(decision.limit)
        response.headers["X-RateLimit-Remaining"] = str(decision.remaining)
        return response

    response = await call_next(request)
    if decision.route_key:
        response.headers["X-RateLimit-Limit"] = str(decision.limit)
        response.headers["X-RateLimit-Remaining"] = str(decision.remaining)
    return response


@app.middleware("http")
async def request_metrics(request: Request, call_next):
    start = time.perf_counter()
    response = await call_next(request)
    duration_ms = (time.perf_counter() - start) * 1000
    response.headers["X-Process-Time-Ms"] = f"{duration_ms:.1f}"
    if request.method != "OPTIONS":
        logger.info("%s %s -> %s %.1fms", request.method, request.url.path, response.status_code, duration_ms)
    return response


@app.exception_handler(GraphLoadError)
async def graph_load_error_handler(_: Request, exc: GraphLoadError) -> JSONResponse:
    return error_response(503, "GRAPH_UNAVAILABLE", str(exc), recover_action="Run graphify for data/legalize-kr and verify graphify-out/graph.json.")


@app.exception_handler(KeyError)
async def key_error_handler(_: Request, exc: KeyError) -> JSONResponse:
    return error_response(404, "NODE_NOT_FOUND", f"No matching node found: {exc.args[0] if exc.args else ''}", recover_action="Use a full law name or inspect suggested questions.")


@app.exception_handler(PermissionError)
async def permission_error_handler(_: Request, exc: PermissionError) -> JSONResponse:
    return error_response(403, "SOURCE_FORBIDDEN", str(exc), recover_action="Only relative files under configured source corpus roots can be opened.")


@app.exception_handler(FileNotFoundError)
async def not_found_handler(_: Request, exc: FileNotFoundError) -> JSONResponse:
    return error_response(404, "SOURCE_NOT_FOUND", str(exc), recover_action="Check the source_file path returned by evidence items or precedent search results.")


@app.get("/health")
def health(response: Response):
    set_cache_headers(response, "health", max_age=15)
    return service.health()


@app.post("/query")
def query_graph(request: QueryRequest, response: Response):
    set_cache_headers(response, "query", max_age=10, extra=f"{request.question}:{request.max_nodes}:{request.max_edges}:{request.depth}")
    return service.query(request)


@app.post("/answer")
def answer_graph(request: AnswerRequest, response: Response):
    set_cache_headers(
        response,
        "answer",
        max_age=10,
        extra=f"{request.question}:{request.mode}:{request.max_nodes}:{request.max_edges}:{request.depth}:{request.max_citations}",
    )
    return service.answer(request)


@app.get("/explain")
def explain(response: Response, label: str | None = Query(default=None, max_length=240), id: str | None = Query(default=None, max_length=240)):
    if not label and not id:
        raise HTTPException(status_code=422, detail="label or id is required")
    set_cache_headers(response, "explain", max_age=60, extra=id or label or "")
    return service.explain(label=label, node_id=id)


@app.get("/path")
def path(response: Response, source: str = Query(max_length=240), target: str = Query(max_length=240), max_hops: int = Query(default=8, ge=1, le=20)):
    set_cache_headers(response, "path", max_age=60, extra=f"{source}:{target}:{max_hops}")
    return service.shortest_path(source, target, max_hops=max_hops)


@app.get("/subgraph")
def subgraph(
    response: Response,
    node_id: str = Query(max_length=240),
    depth: int = Query(default=1, ge=1, le=3),
    max_nodes: int = Query(default=100, ge=1, le=300),
    max_edges: int = Query(default=300, ge=0, le=1500),
    edge_mode: EdgeMode = Query(default="focus"),
):
    set_cache_headers(response, "subgraph", max_age=30, extra=f"{node_id}:{depth}:{max_nodes}:{max_edges}:{edge_mode}")
    return service.subgraph_for_node(node_id=node_id, depth=depth, max_nodes=max_nodes, max_edges=max_edges, edge_mode=edge_mode)


@app.post("/subgraph/3d")
def subgraph_3d(request: Subgraph3DRequest, response: Response):
    set_cache_headers(response, "subgraph-3d", max_age=30, extra=f"{request.question}:{request.node_id}:{request.max_nodes}:{request.max_edges}")
    return service.subgraph_for_query_or_node(question=request.question, node_id=request.node_id, max_nodes=request.max_nodes, max_edges=request.max_edges)


@app.get("/communities/3d")
def communities_3d(response: Response):
    set_cache_headers(response, "communities-3d", max_age=300)
    return service.communities_3d()


@app.get("/graph/full-3d")
def full_graph_3d(
    response: Response,
    edge_mode: EdgeMode = Query(default="hidden"),
    focus_node_id: str | None = Query(default=None, max_length=240),
    confirm_all_edges: bool = Query(default=False),
    node_limit: int | None = Query(default=None, ge=1, le=10000),
    edge_limit: int | None = Query(default=None, ge=0, le=20000),
    min_degree: int | None = Query(default=None, ge=0),
    community_id: str | None = Query(default=None),
    static_layout: bool = Query(default=False),
    static_layout_mode: LayoutMode = Query(default="spherical"),
):
    set_cache_headers(
        response,
        "full-3d",
        max_age=120,
        extra=f"{edge_mode}:{focus_node_id or ''}:{confirm_all_edges}:{node_limit}:{edge_limit}:{min_degree}:{community_id or ''}:{static_layout}:{static_layout_mode}",
    )
    return service.full_graph_3d(
        edge_mode=edge_mode,
        focus_node_id=focus_node_id,
        confirm_all_edges=confirm_all_edges,
        node_limit=node_limit,
        edge_limit=edge_limit,
        min_degree=min_degree,
        community_id=community_id,
        static_layout=static_layout,
        static_layout_mode=static_layout_mode,
    )


@app.get("/suggested-questions")
def suggested_questions(response: Response):
    set_cache_headers(response, "suggested-questions", max_age=300)
    return {"questions": service.suggested_questions()}


@app.get("/precedents/health")
def precedent_health(response: Response):
    set_cache_headers(response, "precedents-health", max_age=60)
    return service.precedent_health()


@app.get("/precedents/search")
def precedent_search(
    response: Response,
    q: str = Query(min_length=1, max_length=240),
    category: str | None = Query(default=None, max_length=80),
    court: str | None = Query(default=None, max_length=80),
    limit: int = Query(default=10, ge=1, le=50),
):
    set_cache_headers(response, "precedents-search", max_age=60, extra=f"{q}:{category or ''}:{court or ''}:{limit}")
    return service.search_precedents(query=q, limit=limit, category=category, court=court)


@app.get("/precedents/source")
def precedent_source(response: Response, path: str = Query(max_length=500)):
    set_cache_headers(response, "precedents-source", max_age=300, extra=path)
    return service.precedent_source(path, max_chars=env_int("LEGAL_GRAPH_PRECEDENT_SOURCE_MAX_CHARS", 40_000, 1_000, 200_000))


@app.get("/source")
def source(response: Response, path: str = Query(max_length=500)):
    set_cache_headers(response, "source", max_age=300, extra=path)
    return service.source(path, max_chars=env_int("LEGAL_GRAPH_SOURCE_MAX_CHARS", 40_000, 1_000, 200_000))

# Legal Graph Chat Backend

Local-only FastAPI backend for exploring `data/legalize-kr/graphify-out/graph.json` through slim, source-backed DTOs.

## Run

```bash
cd apps/legal-graph-chat/backend
PYTHONPATH=$PWD:/Users/hwanchoi/projects/claude-code/graphify \
uv run --python /opt/homebrew/bin/python3.11 \
  --with fastapi --with 'uvicorn[standard]' --with networkx --with pydantic --with httpx \
  uvicorn app.main:app --host 127.0.0.1 --port 8765 --reload
```

## Test

```bash
cd apps/legal-graph-chat/backend
PYTHONPATH=$PWD:/Users/hwanchoi/projects/claude-code/graphify \
uv run --python /opt/homebrew/bin/python3.11 \
  --with fastapi --with networkx --with pydantic --with pytest --with httpx \
  pytest -q
```

## Contract summary

- `GET /health`
  - Optional query: `graph=legalize-kr|precedent-kr`.
- `GET /graphs`
  - Lists selectable graph catalog metadata without loading every graph into memory.
- `POST /query`
  - Optional query: `graph=legalize-kr|precedent-kr`.
- `POST /answer`
  - Source-grounded deterministic/extractive answer scaffold.
  - `mode=llm` never calls an external provider by default; without
    `LEGAL_GRAPH_CHAT_LLM_ENABLED=true` or `LEGAL_GRAPH_LLM_ENABLED=true`, the response returns
    `llm_disabled` and deterministic fallback warnings.
- `GET /explain?label=...` or `GET /explain?id=...`
- `GET /path?source=...&target=...`
- `GET /subgraph?node_id=...&depth=...`
- `POST /subgraph/3d`
- `GET /communities/3d`
- `GET /graph/full-3d?edge_mode=hidden|focus|all`
  - `edge_mode=all` requires `confirm_all_edges=true`.
  - `static_layout=true` returns deterministic `x/y/z` coordinates.
  - `static_layout_mode=clustered|circular|spherical` selects the static coordinate layout; default is `spherical` for a round 3D node-link graph.
  - Static layout coordinates are cached under `LEGAL_GRAPH_CACHE_DIR` or `.graphify/legal-graph-chat-cache`.
- `GET /graph/full-3d/edge-tile`
  - Progressive edge-only LOD page for large Full 3D graphs.
  - Key query params: `edge_mode`, `confirm_all_edges`, `tile`, `tile_size`, `lod_layer`, `node_limit`, `min_degree`, `community_id`.
- `GET /graph/full-3d/edge-tile/binary`
  - Binary version of the progressive edge tile endpoint.
  - Format: `GF3E\x01` magic, JSON header, uint32 source/target node indices, uint8 LOD layer codes.
  - Intended for frontend WebWorker decode against the currently loaded Full 3D node order.
- `GET /graph/full-3d/nodes/binary`
  - Compact node-only binary endpoint for Full 3D.
  - Format: `GF3N\x01` magic, compact JSON header, then arrays in order: float32 positions, float32 sizes, uint32 degrees, int32 communities, uint8 flags, uint32-length-prefixed UTF-8 node ids.
  - Header intentionally excludes label/source metadata to keep `precedent-kr` 124k node payload small; selected node metadata is resolved lazily by `/explain` and source endpoints.
- `GET /graph/full-3d/binary`
  - Experimental `application/octet-stream` payload with `GF3D\x01` magic, JSON header, float32 positions/sizes, and uint32 edge indices.
- `GET /suggested-questions`
- `GET /source?path=...`
  - Optional query: `graph=legalize-kr|precedent-kr`; resolves under the selected graph corpus and its `graphify-out`.
- `GET /precedents/health`
- `GET /precedents/search?q=...&limit=...`
- `GET /precedents/source?path=...`

## Safety rules

- Host locally on `127.0.0.1`.
- CORS allows only Vite dev origins.
- Browser must not fetch raw `graph.json`.
- `/source` only opens relative files under `data/legalize-kr` or `data/legalize-kr/graphify-out`.
- `/precedents/source` only opens relative markdown files under
  `data/precedent-kr`; absolute paths, `..`, hidden paths, symlink
  escapes, and non-markdown files are rejected.
- Full 3D defaults to `edge_mode=hidden`; `all` is opt-in.
- For `precedent-kr`, prefer `/graph/full-3d/edge-tile/binary` with JSON `/graph/full-3d/edge-tile` fallback over a single raw all-edge JSON response.
- For `precedent-kr` full-node rendering, prefer `/graph/full-3d/nodes/binary` over JSON `/graph/full-3d`; current smoke measured 124,263 nodes at ~5.7MB with a 637-byte header.
- Large JSON responses are gzip-compressed and include `ETag`,
  `Cache-Control`, and `X-Process-Time-Ms` headers.
- `/answer` responses describe graph traversal and source evidence, not
  legal advice, legal judgment, or action recommendations.

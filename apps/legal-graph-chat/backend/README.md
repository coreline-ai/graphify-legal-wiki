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
- `POST /query`
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
- `GET /suggested-questions`
- `GET /source?path=...`
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
- Large JSON responses are gzip-compressed and include `ETag`,
  `Cache-Control`, and `X-Process-Time-Ms` headers.
- `/answer` responses describe graph traversal and source evidence, not
  legal advice, legal judgment, or action recommendations.

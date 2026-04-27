# Legal Graph Chat

Local-first GUI/API workstream for exploring `data/legalize-kr/graphify-out/graph.json` without opening the raw 86MiB graph in the browser. The follow-up workstream adds source-grounded answers and read-only precedent corpus exploration for `data/precedent-kr/`.

## Architecture

```text
data/legalize-kr/graphify-out/graph.json
data/precedent-kr/graphify-out/graph.json
        │
        ▼
backend GraphQueryService + FastAPI
        │ slim DTOs only
        ▼
frontend React/Vite workspace
  Graph selector + Chat + Evidence + Subgraph + Community Overview + Full 3D opt-in

optional local corpus volume:
data/precedent-kr/ ──► /precedents/* read-only search/source preview
```

## Configuration scaffold

```bash
cd /Users/hwanchoi/projects/claude-code/graphify
cp apps/legal-graph-chat/.env.example apps/legal-graph-chat/.env
cp apps/legal-graph-chat/backend/.env.example apps/legal-graph-chat/backend/.env
```

Important defaults:

- `LEGAL_GRAPH_API_HOST=127.0.0.1`
- `LEGAL_GRAPH_API_PORT=8765`
- `LEGAL_GRAPH_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5174,http://localhost:5174`
- `LEGAL_GRAPH_SOURCE_VIEWER_ENABLED=true`
- `LEGAL_GRAPH_PRECEDENT_ROOT=../../data/precedent-kr` from app root, or `../../../data/precedent-kr` from backend root
- `LEGAL_GRAPH_LLM_ENABLED=false`

The current local run command still passes host/port to `uvicorn` directly. Treat the env files as the shared configuration contract for the backend/frontend/deployment workstreams, and do not commit real secrets in `.env`.

## Production deploy scaffold

Worker D production files live in [`deploy/`](deploy/):

- `compose.prod.yml` creates public nginx ingress plus private-network frontend, backend, Postgres, oauth2-proxy, and optional Coreline Codex proxy.
- `nginx.conf` routes `/` to the frontend and `/api/` to the backend, enforces oauth2-proxy `auth_request`, and rate-limits `/api/answer`, `/api/source`, `/api/precedents/source`, and `/api/graph/full-3d`.
- `.env.production.example` and `oauth2-proxy.cfg.example` are templates only; copy them locally and keep real secrets out of git.

Syntax check:

```bash
cd /Users/hwanchoi/projects/claude-code/graphify
docker compose -f apps/legal-graph-chat/deploy/compose.prod.yml config
# or: docker-compose -f apps/legal-graph-chat/deploy/compose.prod.yml config
```

See [`deploy/README.md`](deploy/README.md) and [`docs/deployment-security.md`](docs/deployment-security.md) for the private network, OAuth, Postgres/pgvector/PGroonga, Codex proxy token isolation, and rate-limit runbooks.

## Backend

```bash
cd apps/legal-graph-chat/backend
PYTHONPATH=$PWD:/Users/hwanchoi/projects/claude-code/graphify \
uv run --python /opt/homebrew/bin/python3.11 \
  --with fastapi --with 'uvicorn[standard]' --with networkx --with pydantic \
  uvicorn app.main:app --host 127.0.0.1 --port 8765 --reload
```

Tests:

```bash
cd apps/legal-graph-chat/backend
PYTHONPATH=$PWD:/Users/hwanchoi/projects/claude-code/graphify \
uv run --python /opt/homebrew/bin/python3.11 \
  --with fastapi --with networkx --with pydantic --with pytest --with httpx \
  pytest -q
```

## Frontend

```bash
cd apps/legal-graph-chat/frontend
npm install
VITE_API_BASE_URL=http://127.0.0.1:8765 npm run dev
```

If Vite falls back from `5173` to `5174`, the backend CORS allowlist permits both local dev origins.

Checks:

```bash
npm run build
npm run test
```

Browser smoke:

```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"
"$PWCLI" open http://127.0.0.1:5173
"$PWCLI" snapshot
```

## API contract

Current graph API:

- `GET /graphs`
  - Returns selectable graph catalog entries for `legalize-kr` and `precedent-kr` without forcing the large graph JSON to load.
- `GET /health`
- `POST /query`
- `GET /explain?label=...` or `GET /explain?id=...`
- `GET /path?source=...&target=...`
- `GET /subgraph?node_id=...`
- `POST /subgraph/3d`
- `GET /communities/3d`
- `GET /graph/full-3d?edge_mode=hidden|focus|all`
  - `edge_mode=all` requires `confirm_all_edges=true`; otherwise backend returns the node payload with hidden edges and a warning.
  - `static_layout=true` can use disk-cached deterministic coordinates for repeated large graph views.
- `GET /graph/full-3d/edge-tile?edge_mode=all&confirm_all_edges=true&tile=0&tile_size=25000`
  - Returns edge-only LOD tiles for progressive Full 3D expansion without one giant JSON payload.
- `GET /graph/full-3d/edge-tile/binary`
  - Returns the same progressive edge tile as a compact `graphify.edge-tile.binary.v1` stream for WebWorker decoding.
- `GET /graph/full-3d/nodes/binary`
  - Compact `GF3N\x01` node-only binary stream for Full 3D static rendering.
  - Carries typed positions/sizes/degrees/communities/flags plus a length-prefixed node id table; labels/source metadata are lazy-resolved via existing node/source APIs.
- `GET /graph/full-3d/binary`
  - Legacy experimental binary foundation for typed-array friendly node positions, node sizes, and edge indices.
- `GET /suggested-questions`
- `GET /source?path=...`

Graph endpoints accept `graph=legalize-kr|precedent-kr`; the frontend sends this automatically from the sidebar graph selector. `/source` resolves paths under the selected graph's corpus and `graphify-out` directory.

Answer and precedent follow-up API contract:

- `POST /answer`
  - Request: source question plus optional `mode`, graph limit, depth, and citation limit fields.
  - Response: deterministic/source-grounded answer, citations/evidence, warnings, and legal-advice disclaimer.
  - Default: LLM disabled unless `LEGAL_GRAPH_LLM_ENABLED=true` or `LEGAL_GRAPH_CHAT_LLM_ENABLED=true` and provider settings are configured.
- `GET /precedents/health`
  - Reports precedent corpus availability and bounded metadata counts.
- `GET /precedents/search?q=...&category=...&court=...&limit=...`
  - Returns bounded metadata/snippet results; it must not stream full raw corpus files.
- `GET /precedents/source?path=...`
  - Read-only source preview under `LEGAL_GRAPH_PRECEDENT_ROOT`; rejects absolute paths, `..`, and corpus-root escape.

`scripts/performance_smoke.py` includes `/answer` and `/precedents/*` checks. It still marks missing optional follow-up endpoints as skips by default so the script can be reused against older local branches. Use `--strict-optional` to make missing answer/precedent endpoints fail.

## Product and design rules

- Source/evidence-first. No answer should appear as unsupported legal advice.
- The left sidebar graph selector controls whether the workspace explores the `legalize-kr` 법령 graph or the `precedent-kr` 판례 graph.
- `precedent-kr` Full 3D loads full nodes through GF3N + persistent WebWorker state, then adds GF3E edge tiles as typed index buffers under memory cap/backpressure controls.
- Full 3D Graph is opt-in, lazy-loaded, and starts with `edge_mode=hidden`.
- `precedent-kr` Full 3D uses bounded sampled/static payloads by default; raw all-edge direct loading is intentionally not exposed in the GUI because the graph is much larger than the 법령 graph.
- Full 3D static coordinates support `static_layout_mode=clustered|circular|spherical`; the frontend requests `spherical` by default so the safe/raw overview reads as a round 3D node-link graph instead of a clustered slab.
- Full 3D all-edge mode needs a second explicit confirmation before requesting `176,128` edges.
- 3D graph panels use lazy WebGL rendering: bounded subgraphs can use `react-force-graph-3d`, while large Full 3D payloads use a static `BufferGeometry` renderer with DOM/SVG fallback and `3D / 2D / evidence` view switching.
- 3D search can focus the first matching node, and Community Overview selection opens member/edge counts, top God Nodes, wiki article access, and limited community 3D exploration.
- Browser must never fetch raw `graph.json` directly.
- Full 3D payload loading uses a WebWorker path when available so large JSON fetch/parse work does not block the main UI thread.
- `precedent-kr` edge expansion uses progressive binary edge tiles decoded in a WebWorker, with JSON tile fallback; do not auto-load all `761k+` edges in a single browser request.
- Static Full 3D uses position-only edge `BufferGeometry` layers and GPU color picking with CPU fallback for large node clouds.
- API responses include local request latency, cache headers/ETags, and gzip compression for large JSON responses.
- `docs/design/obsidian-inspired-tokens.css` is the design token source of truth.
- Obsidian is only an interaction/design reference; do not use Obsidian logo, icon, or trademark assets.

## Security notes

See [`docs/deployment-security.md`](docs/deployment-security.md) for deployment guidance.

Operational defaults:

- Keep the API local-first on `127.0.0.1`.
- Keep CORS origins explicit; do not use `*` with source viewers enabled.
- Mount `data/precedent-kr/` as a read-only corpus volume.
- Put any non-localhost deployment behind an auth proxy/private network gateway; the deploy scaffold publishes only nginx and keeps backend/Postgres internal.
- Treat `/source` and `/precedents/source` as read-only, path-whitelisted previewers.
- Keep `LEGAL_GRAPH_LLM_ENABLED=false` unless source-grounding, provider secrets, logging, and disclaimers have been reviewed.
- `LEGAL_GRAPH_PRECEDENT_ROOT` defaults to the repository `data/precedent-kr` directory when unset; set it explicitly for mounted corpus volumes.

## Verification target

`data/legalize-kr/graphify-out/run-summary.json` should report:

```text
9,001 nodes · 176,128 edges · 12 communities · deterministic_legal_reference
```

## QA / verification automation

Contract and backend tests:

```bash
cd apps/legal-graph-chat/backend
PYTHONPATH=$PWD:/Users/hwanchoi/projects/claude-code/graphify \
uv run --python /opt/homebrew/bin/python3.11 \
  --with fastapi --with networkx --with pydantic --with pytest --with httpx \
  pytest -q
```

Real-graph performance smoke:

```bash
cd /Users/hwanchoi/projects/claude-code/graphify
uv run --python /opt/homebrew/bin/python3.11 \
  --with fastapi --with networkx --with pydantic --with httpx \
  apps/legal-graph-chat/scripts/performance_smoke.py
```

The smoke script measures `/health`, `/query`, `/subgraph/3d`, `/communities/3d`, `/graph/full-3d?edge_mode=hidden`, focus-edge full graph latency, `/answer`, `/precedents/health`, and `/precedents/search` status, latency, counts, warnings, and payload bytes. It skips missing answer/precedent endpoints by default so the same script can be reused against older local branches. Use `--strict-optional` to make missing answer/precedent endpoints fail.

It skips all-edge full graph unless `--include-all` is passed intentionally, which calls `/graph/full-3d?edge_mode=all&confirm_all_edges=true`.

Manual user testing checklist:

- [`docs/user-testing-checklist.md`](docs/user-testing-checklist.md)

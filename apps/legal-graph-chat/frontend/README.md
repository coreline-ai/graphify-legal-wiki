# Legal Graph Chat Frontend

React/Vite/TypeScript MVP for exploring the local `legalize-kr` graph through the FastAPI slim DTO backend.

## Run

```bash
cd apps/legal-graph-chat/frontend
npm install
VITE_API_BASE_URL=http://127.0.0.1:8765 npm run dev
```

## Scripts

```bash
npm run build      # TypeScript + Vite production build
npm run test       # Vitest unit tests
npm run typecheck  # TypeScript only
```

## UX rules

- The browser never fetches raw `graph.json`.
- The sidebar graph selector switches the entire workspace between
  `legalize-kr` 법령 graph and `precedent-kr` 판례 graph by sending the
  selected `graph` query parameter to backend graph endpoints.
- Chat answers always show evidence/source context when available.
- 3D Subgraph, Community Overview, and Full 3D use lazy WebGL rendering with
  DOM/SVG fallback and `3D / 2D / evidence` view switching.
- Full 3D requests backend `static_layout_mode=spherical` by default, so the
  safe overview and raw all-edge view render as a round 3D node-link graph.
  The legacy clustered and flat circular static layouts remain backend modes for comparison.
- For `precedent-kr`, Full 3D remains bounded/sampled in the GUI because the
  graph is much larger than the 법령 graph.
- Graph search supports Enter or `Focus result` to select the first matching
  node and move the 3D camera focus.
- Community nodes show member/edge counts, top God Nodes, wiki article access,
  and a limited community 3D exploration action.
- Full 3D Graph is lazy-loaded only after a warning modal and defaults to `edge_mode=hidden`.
- Switching Full 3D to all-edge mode opens a second confirmation before the
  frontend sends `confirm_all_edges=true`.
- Query/subgraph/source/full-graph requests use AbortController cancellation so
  stale responses from fast repeated actions do not overwrite newer UI state.
- Obsidian is used only as an interaction/style reference; no Obsidian logo, icon, or brand assets are used.
- Copy must describe graph exploration, not legal advice.

## Backend contract

Default API base: `http://127.0.0.1:8765`.

- `GET /health`
- `POST /query`
- `GET /explain`
- `GET /subgraph`
- `POST /subgraph/3d`
- `GET /communities/3d`
- `GET /graph/full-3d`
- `GET /suggested-questions`
- `GET /source`

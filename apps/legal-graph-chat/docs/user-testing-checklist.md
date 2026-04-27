# Legal Graph Chat user testing checklist

Use this checklist for manual validation after backend and frontend workstreams are merged.

## Setup

- [ ] Backend is bound to `127.0.0.1:8765` or the documented local port.
- [ ] Frontend `VITE_API_BASE_URL` points to the backend.
- [ ] `data/legalize-kr/graphify-out/graph.json` is available locally.
- [ ] If testing precedent features, `data/precedent-kr/` is mounted read-only.
- [ ] LLM mode is disabled unless the test explicitly covers provider integration.

## Core graph flow

- [ ] `/health` reports the expected graph size and a ready/loaded state.
- [ ] A query such as `민법` returns a concise summary, evidence, and a limited graph.
- [ ] Evidence links open only through the backend source viewer.
- [ ] Full 3D graph opens first with hidden/focus edges, not all edges.
- [ ] All-edge mode requires explicit confirmation.

## Answer flow

- [ ] The answer action calls `/answer` only after a user question is present.
- [ ] The answer clearly says it is source-grounded exploration, not legal advice.
- [ ] Citations/evidence are visible next to the answer.
- [ ] Missing evidence produces a warning or limited answer instead of unsupported claims.
- [ ] LLM disabled state is visible and does not break the flow.

## Precedent flow

- [ ] `/precedents/health` communicates corpus availability clearly.
- [ ] Searching a term such as `민법` returns bounded result rows with snippets/metadata.
- [ ] Result rows show category/court/path metadata when available.
- [ ] Source preview rejects absolute paths and traversal attempts.
- [ ] Search results can be used to continue a graph question without copying raw corpus payloads into the browser.

## Security and privacy checks

- [ ] CORS only allows the local or deployed frontend origin.
- [ ] Source viewers are disabled or behind auth outside localhost.
- [ ] No `.env` secrets or private corpus files are committed.
- [ ] Browser network panel does not show direct fetches of raw `graph.json` or corpus files.
- [ ] Error messages guide recovery without exposing host filesystem internals.

## Production deploy checks

- [ ] `docker compose -f apps/legal-graph-chat/deploy/compose.prod.yml config` or `docker-compose ... config` passes.
- [ ] Only nginx publishes a host port; backend, Postgres, oauth2-proxy, and optional Coreline proxy remain private-network only.
- [ ] Unauthenticated `/` and `/api/health` requests redirect to oauth2-proxy, while `/nginx-healthz` stays usable for infrastructure health checks.
- [ ] `/api/answer`, `/api/source`, `/api/precedents/source`, and `/api/graph/full-3d` return `429` under intentional rate-limit pressure.
- [ ] `LEGAL_GRAPH_ALLOWED_ORIGINS`, `VITE_API_BASE_URL`, and OAuth redirect URL all match the exact deployed domain.
- [ ] Postgres secrets and optional LLM/Coreline tokens are loaded from untracked secret files or a secret manager.
- [ ] Codex auth files, if used, are mounted only into the Coreline proxy service and never into backend/frontend/nginx.
- [ ] pgvector/PGroonga extensions are enabled only through reviewed migrations; the app still starts when index backend is `memory`.

## Feedback capture

- [ ] User can flag confusing, unsupported, or legally risky wording.
- [ ] Feedback captures the query and UI state but not private source file contents.
- [ ] Test notes include browser, backend commit/branch, corpus availability, and exact date.

# Legal Graph Chat deployment and security notes

Legal Graph Chat is a local-first graph/corpus exploration app. Treat it as a source-backed research UI, not a public legal advice service.

## Default posture

- Bind the API to `127.0.0.1` for local development.
- Keep LLM generation disabled unless a separate provider integration has been reviewed.
- Serve slim DTOs from the backend; the browser must not fetch raw `graph.json` or large corpus files.
- Keep `data/legalize-kr/` and `data/precedent-kr/` outside app bundles and commits.

## Corpus volume

`data/precedent-kr/` can be large and should be mounted as a read-only volume:

```bash
LEGAL_GRAPH_PRECEDENT_ROOT=/mnt/legal-corpus/precedent-kr
```

Recommended volume rules:

- read-only mount for the application user;
- no symlink-following escape outside the configured root;
- size and timeout limits on search/source preview responses;
- operational backups handled outside this repository.

## Source viewers

Both `/source` and `/precedents/source` must remain read-only previewers.

Required guardrails:

- accept only relative paths returned by backend DTOs;
- reject absolute paths and `..` segments;
- resolve the final path and verify it is still under the configured root;
- truncate large files with a clear `truncated` marker;
- never render source content as trusted HTML in the frontend.

Disable viewers in shared environments unless an auth proxy is in front of the app:

```bash
LEGAL_GRAPH_SOURCE_VIEWER_ENABLED=false
LEGAL_GRAPH_PRECEDENT_SOURCE_VIEWER_ENABLED=false
```

## CORS

Keep `LEGAL_GRAPH_ALLOWED_ORIGINS` explicit and narrow:

```bash
LEGAL_GRAPH_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173
```

Do not use wildcard origins when any source viewer is enabled. If the frontend is deployed on a preview hostname, add only that exact origin.

## Auth proxy recommendation

This app does not currently provide user accounts or multi-tenant authorization. For anything beyond single-user localhost:

- put the API and frontend behind an auth proxy or private network gateway;
- require HTTPS at the proxy edge;
- block direct public access to the FastAPI port;
- add request size and rate limits;
- log source-viewer access without storing source file contents in logs.

The production scaffold in `apps/legal-graph-chat/deploy/` follows this shape:

- only nginx publishes a host port;
- frontend, backend, Postgres, oauth2-proxy, and optional Coreline Codex proxy are on a Docker `internal: true` network;
- backend and Postgres expose container ports only to the private network;
- nginx uses oauth2-proxy `auth_request` before serving `/` or `/api/`;
- nginx rate-limits `/api/answer`, `/api/source`, `/api/precedents/source`, and `/api/graph/full-3d` separately from the general API bucket.

Before production use, configure TLS at an upstream load balancer or replace the scaffolded HTTP listener with a TLS-enabled edge. Keep `LEGAL_GRAPH_ALLOWED_ORIGINS` aligned to the exact public origin.

## Secrets and private network isolation

Recommended secret boundaries:

- keep `.env.production`, `oauth2-proxy.cfg`, and `deploy/secrets/*` out of git;
- use file-backed or platform-managed secrets for Postgres passwords and internal bearer tokens;
- never put provider tokens, OAuth client secrets, or cookie secrets in tracked example files;
- do not log request bodies for `/answer`, `/source`, or `/precedents/source`.

The backend should treat all private services as private-network dependencies. Do not publish Postgres, oauth2-proxy, or the optional Codex proxy to the host or internet.

## Coreline Codex proxy token isolation

If LLM mode is enabled through `coreline-cli`/Codex:

- `coreline-cli` or the Coreline proxy owns Codex CLI auth and token refresh;
- Legal Graph Chat backend must not mount or read `~/.codex/auth.json`;
- the browser must never call the Coreline proxy directly;
- backend-to-proxy calls should use `CORELINE_CODEX_PROXY_URL` on the private network plus a shared bearer token from `CORELINE_CODEX_PROXY_TOKEN_FILE`;
- proxy responses must satisfy `contract/coreline-codex-proxy.schema.json`, especially citation IDs matching the provided context items;
- when proxy health reports upstream rate-limit pressure, the backend should fall back to deterministic/source-grounded answers instead of retry storms.

Mount any Codex auth directory only into the optional `coreline-codex-proxy` service, read-only where possible.

## Rate limits and payload limits

Recommended edge defaults are documented in `deploy/nginx.conf` and mirrored in env examples:

- general `/api/`: `120r/m`;
- `/api/answer`: `12r/m`;
- `/api/source`: `30r/m`;
- `/api/precedents/source`: `20r/m`;
- `/api/graph/full-3d`: `6r/m`.

Keep `client_max_body_size` small because API requests are bounded question/query payloads. Increase timeouts only for endpoints known to load large graph DTOs, and keep all-edge full graph requests behind explicit user confirmation.

## Postgres, pgvector, and PGroonga operations

The current app can run from local graph/corpus files, but the production scaffold includes an internal Postgres service for future indexing and audit metadata. Operational guidance:

- keep Postgres on the private Docker network; do not publish `5432`;
- store `POSTGRES_PASSWORD` and `LEGAL_GRAPH_DATABASE_URL` in secrets, not tracked env files;
- back up the Postgres volume independently from app containers;
- use `pgvector` only for bounded, source-derived embeddings; never store raw OAuth/Codex tokens in vector metadata;
- if Korean full-text search needs PGroonga, use a vetted image or custom build with the extension installed, then enable it through explicit migrations;
- run `CREATE EXTENSION` migrations idempotently and verify extension versions before switching `LEGAL_GRAPH_INDEX_BACKEND` from `filesystem` to `postgres`;
- avoid indexing full private corpus contents unless retention, access control, and deletion procedures are documented.

## Answer API safety

The `/answer` API must remain source-grounded:

- deterministic/extractive answer mode is the safe default;
- LLM calls stay disabled unless `LEGAL_GRAPH_LLM_ENABLED=true` and provider secrets are configured;
- responses should include citations/evidence and warnings when evidence is missing;
- avoid legal advice language such as outcome predictions or recommended legal actions.

## Precedent API safety

The `/precedents/health`, `/precedents/search`, and `/precedents/source` APIs should expose only metadata, snippets, and bounded previews.

Recommended defaults:

- cap result limits, snippet length, and source preview bytes;
- avoid returning full raw corpus payloads from search;
- include corpus availability in `/precedents/health` without leaking host filesystem details;
- make missing corpus paths a clear operational error, not a crash.

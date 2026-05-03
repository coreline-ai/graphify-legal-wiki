# Legal Graph Chat production deploy scaffold

This folder contains the production-oriented Docker Compose scaffold for Legal Graph Chat. It is intentionally conservative: only nginx is public, all app/data services are on a private Docker network, and source/corpus paths are read-only mounts.

## Files

| File | Purpose |
| --- | --- |
| `compose.prod.yml` | nginx ingress, frontend, backend, internal Postgres, oauth2-proxy, optional Coreline Codex proxy profile |
| `nginx.conf` | public ingress, `/api/` reverse proxy, oauth2 `auth_request`, endpoint rate limits, gzip/timeouts/cache headers |
| `Dockerfile.backend` | FastAPI backend image scaffold |
| `Dockerfile.frontend` / `frontend.nginx.conf` | Vite build and internal static nginx server |
| `.env.production.example` | non-secret production variable template |
| `oauth2-proxy.cfg.example` | auth proxy config template; copy before use |
| `secrets/README.md` | local secret-file placeholders; real values stay ignored |

## Quick config check

```bash
cd /Users/hwanchoi/projects/claude-code/graphify

# Syntax check with safe defaults. This does not require real secrets.
docker compose -f apps/legal-graph-chat/deploy/compose.prod.yml config
# If Docker Compose is installed as the legacy binary:
docker-compose -f apps/legal-graph-chat/deploy/compose.prod.yml config
```

For a production-like run, create local untracked config files first:

```bash
cd apps/legal-graph-chat/deploy
cp .env.production.example .env.production
cp oauth2-proxy.cfg.example oauth2-proxy.cfg
mkdir -p secrets
printf '%s\n' 'replace-with-strong-postgres-password' > secrets/postgres_password
printf '%s\n' 'postgresql://legal_graph:replace-with-password@postgres:5432/legal_graph' > secrets/legal_graph_database_url
printf '%s\n' 'replace-with-shared-internal-token' > secrets/coreline_codex_proxy_token

docker compose --env-file .env.production -f compose.prod.yml config
```

## Network model

- Public network: `nginx` only, bound by `LEGAL_GRAPH_INGRESS_BIND`/`LEGAL_GRAPH_INGRESS_PORT`.
- Private internal network: `frontend`, `backend`, `postgres`, `oauth2-proxy`, and optional `coreline-codex-proxy`.
- Backend and Postgres have no host-published ports.
- `data/legalize-kr` and `data/precedent-kr` are mounted read-only into the backend.

## Required operator values

Fill these before starting a real deployment:

- Public domain: `PUBLIC_BASE_URL`, `VITE_API_BASE_URL`, `LEGAL_GRAPH_ALLOWED_ORIGINS`, `OAUTH2_PROXY_REDIRECT_URL`.
- OAuth/OIDC: `OAUTH2_PROXY_CLIENT_ID`, `OAUTH2_PROXY_CLIENT_SECRET`, `OAUTH2_PROXY_COOKIE_SECRET`, issuer URL, allowed email domains/groups.
- Corpus paths: `LEGAL_GRAPH_LEGALIZE_CORPUS_ROOT`, `LEGAL_GRAPH_PRECEDENT_CORPUS_ROOT`.
- Secret files: `POSTGRES_PASSWORD_HOST_FILE`, `LEGAL_GRAPH_DATABASE_URL_HOST_FILE`, and optional Coreline proxy token file.
- Image tags: replace placeholder `CORELINE_CODEX_PROXY_IMAGE` before enabling the `codex-proxy` profile.

## Start

```bash
cd apps/legal-graph-chat/deploy
docker compose --env-file .env.production -f compose.prod.yml up -d --build
```

Enable the optional Codex proxy only after the image and isolated auth directory are configured:

```bash
docker compose --env-file .env.production -f compose.prod.yml --profile codex-proxy up -d --build
```

## Rate limits

`nginx.conf` currently enforces per-client limits:

| Endpoint | Zone | Default |
| --- | --- | --- |
| `/api/answer` | `api_answer` | `12r/m`, burst 4 |
| `/api/source` | `api_source` | `30r/m`, burst 10 |
| `/api/precedents/source` | `api_precedent_source` | `20r/m`, burst 8 |
| `/api/graph/full-3d` | `api_full_3d` | `6r/m`, burst 2 |
| other `/api/` | `api_general` | `120r/m`, burst 40 |

The `.env.production.example` mirrors these values for runbooks. If changing rates, update both the env example and `nginx.conf` together.

## Security notes

- Do not expose backend, Postgres, or Coreline proxy ports to the host.
- Do not mount `~/.codex/auth.json` into the backend or frontend. If the optional proxy is used, mount Codex auth only into the proxy container.
- Keep `/api/metrics` internal. The backend `/metrics` endpoint follows auth by default; set `LEGAL_GRAPH_METRICS_PUBLIC=true` only for a trusted private scrape network.
- Keep LLM mode disabled until provider secrets, source-grounding, rate limits, logs, and legal disclaimers are reviewed.
- Keep source viewers authenticated, path-whitelisted, truncated, and backed by read-only corpus mounts.
- Prefer an external TLS terminator/load balancer in front of this Compose stack; this nginx scaffold listens plain HTTP inside that boundary.

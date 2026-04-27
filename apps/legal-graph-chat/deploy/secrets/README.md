# Local secret files

This directory is ignored except for this README. For local production-like tests,
create files with the names referenced by `compose.prod.yml`, for example:

- `postgres_password`
- `legal_graph_database_url`
- `coreline_codex_proxy_token`

Do not commit real secret values. Prefer a platform secret manager in production.

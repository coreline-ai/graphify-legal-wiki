# Coreline Codex proxy contract

This contract is the Phase 0 boundary between `graphify/apps/legal-graph-chat`
and `../../coreline-cli`.

## Boundary

- `coreline-cli` owns Codex CLI auth and token refresh.
- Legal Graph Chat backend never reads `~/.codex/auth.json`.
- The browser never talks to the coreline proxy directly.
- The coreline proxy is loopback/internal-network only and protected by a shared
  internal bearer token or equivalent private transport.

## Internal endpoints

### `GET /health`

Returns auth availability, configured model, and optional upstream rate-limit
metadata. It must not return token values.

### `POST /v1/legal-answer`

Receives source-bounded legal graph context and returns a strict
source-grounded answer shape.

Important validation rule:

- every returned `citations[].source_id` must match one of the request
  `context_items[].id` values;
- otherwise Graphify backend discards the LLM answer and uses deterministic
  fallback.

## Schema

The JSON Schema source of truth is:

- `apps/legal-graph-chat/contract/coreline-codex-proxy.schema.json`

Schema version:

- `coreline-codex-proxy.v1`

## Legal safety rule

The proxy must not generate legal advice, outcome predictions, or action
recommendations. It should summarize graph/source evidence and explicitly
preserve uncertainty when context is insufficient.

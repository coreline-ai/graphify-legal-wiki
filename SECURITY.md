# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.5.x   | Yes       |
| < 0.5   | No        |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report security issues via GitHub's private vulnerability reporting, or email the maintainer directly. Please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and aim to release a fix within 7 days for critical issues.

## Security Model

graphify is a **local development tool**. It runs as an AI coding assistant skill and optionally as a local MCP stdio server. Code AST extraction, graph build, clustering, export, watch, and MCP query run locally. Semantic extraction for docs, papers, and images is orchestrated by the user's AI assistant platform and may send those file contents to that platform's configured model provider. Video/audio transcription runs locally when the optional video dependencies are installed. Explicit `ingest`/`add` commands fetch user-provided URLs.

### Threat Surface

| Vector | Mitigation |
|--------|-----------|
| SSRF via URL fetch | `security.validate_url()` allows only `http` and `https` schemes, blocks private/loopback/link-local IPs, and blocks cloud metadata endpoints. Redirect targets are re-validated. All fetch paths including tweet oEmbed go through `safe_fetch()`. |
| Oversized downloads | `safe_fetch()` streams responses and aborts at 50 MB. `safe_fetch_text()` aborts at 10 MB. |
| Non-2xx HTTP responses | `safe_fetch()` raises `HTTPError` on non-2xx status codes - error pages are not silently treated as content. |
| Path traversal in MCP server | `security.validate_graph_path()` resolves paths and requires them to be inside `graphify-out/`. Also requires the `graphify-out/` directory to exist. |
| XSS in graph HTML output | `security.sanitize_label()` strips control characters, caps at 256 chars, and HTML-escapes all node labels and edge titles before pyvis embeds them. |
| Prompt injection via node labels | `sanitize_label()` also applied to MCP text output - node labels from user-controlled source files cannot break the text format returned to agents. |
| YAML frontmatter injection | `_yaml_str()` escapes backslashes, double quotes, and newlines before embedding user-controlled strings (webpage titles, query questions) in YAML frontmatter. |
| Encoding crashes on source files | All tree-sitter byte slices decoded with `errors="replace"` - non-UTF-8 source files degrade gracefully instead of crashing extraction. |
| Symlink traversal | `os.walk(..., followlinks=False)` is explicit throughout `detect.py`. |
| Corrupted graph.json | `_load_graph()` in `serve.py` wraps `json.JSONDecodeError` and prints a clear recovery message instead of crashing. |

### What graphify does NOT do

- Does not run a public network listener for core graph operations (MCP server communicates over stdio only)
- Does not execute code from source files (tree-sitter parses ASTs - no eval/exec)
- Does not use `shell=True` in graphify subprocess calls
- Does not store credentials or API keys
- Does not provide legal, medical, or financial advice; downstream UIs should present graph traversal as source-backed exploration only

### Legal Graph Chat demo boundary

`apps/legal-graph-chat/` is a local-first demo UI/API for source-backed graph and precedent corpus exploration. Keep it on loopback by default, mount `data/legalize-kr/` and `data/precedent-kr/` as read-only local corpora, keep source viewers path-whitelisted/truncated, and put any non-localhost deployment behind an auth proxy/private network. The production scaffold should publish only nginx; backend, Postgres, and optional Codex proxy services remain internal. LLM answer generation must stay disabled by default and must not present output as legal advice.

### Optional network calls

- `ingest` subcommand: fetches URLs explicitly provided by the user
- PDF extraction: reads local files only (pypdf does not make network calls)
- watch mode: local filesystem events only (watchdog does not make network calls)

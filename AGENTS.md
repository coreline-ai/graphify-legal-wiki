## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)

For the local legal graph GUI workstream:
- The current large demo graph is under `data/legalize-kr/graphify-out/`, not repository-root `graphify-out/`.
- Treat `data/legalize-kr/` and `data/precedent-kr/` as large local corpora; do not add them to commits unless explicitly requested.
- UI/API work should return slim DTOs and must not make the browser fetch the full 86MiB `graph.json` by default.

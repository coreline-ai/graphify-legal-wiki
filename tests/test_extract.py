from pathlib import Path
import pytest
from graphify.extract import extract_python, extract_js, extract, collect_files, _make_id
from graphify.cache import file_hash

FIXTURES = Path(__file__).parent / "fixtures"


def test_make_id_strips_dots_and_underscores():
    assert _make_id("_auth") == "auth"
    assert _make_id(".httpx._client") == "httpx_client"


def test_make_id_consistent():
    """Same input always produces same output."""
    assert _make_id("foo", "Bar") == _make_id("foo", "Bar")


def test_make_id_no_leading_trailing_underscores():
    result = _make_id("__init__")
    assert not result.startswith("_")
    assert not result.endswith("_")


def test_extract_python_finds_class():
    result = extract_python(FIXTURES / "sample.py")
    labels = [n["label"] for n in result["nodes"]]
    assert "Transformer" in labels


def test_extract_python_finds_methods():
    result = extract_python(FIXTURES / "sample.py")
    labels = [n["label"] for n in result["nodes"]]
    assert any("__init__" in l or "forward" in l for l in labels)


def test_extract_python_no_dangling_edges():
    """All edge sources must reference a known node (targets may be external imports)."""
    result = extract_python(FIXTURES / "sample.py")
    node_ids = {n["id"] for n in result["nodes"]}
    for edge in result["edges"]:
        assert edge["source"] in node_ids, f"Dangling source: {edge['source']}"


def test_structural_edges_are_extracted():
    """contains / method / inherits / imports edges must always be EXTRACTED."""
    result = extract_python(FIXTURES / "sample.py")
    structural = {"contains", "method", "inherits", "imports", "imports_from"}
    for edge in result["edges"]:
        if edge["relation"] in structural:
            assert edge["confidence"] == "EXTRACTED", f"Expected EXTRACTED: {edge}"


def test_extract_merges_multiple_files():
    files = list(FIXTURES.glob("*.py"))
    result = extract(files)
    assert len(result["nodes"]) > 0
    assert result["input_tokens"] == 0


def test_collect_files_from_dir():
    files = collect_files(FIXTURES)
    supported = {".py", ".js", ".ts", ".tsx", ".go", ".rs",
                 ".java", ".c", ".cpp", ".cc", ".cxx", ".rb",
                 ".cs", ".kt", ".kts", ".scala", ".php", ".h", ".hpp",
                 ".swift", ".lua", ".toc", ".zig", ".ps1", ".ex", ".exs",
                 ".m", ".mm"}
    assert all(f.suffix in supported for f in files)
    assert len(files) > 0


def test_collect_files_skips_hidden():
    files = collect_files(FIXTURES)
    for f in files:
        assert not any(part.startswith(".") for part in f.parts)


def test_collect_files_follows_symlinked_directory(tmp_path):
    real_dir = tmp_path / "real_src"
    real_dir.mkdir()
    (real_dir / "lib.py").write_text("x = 1")
    (tmp_path / "linked_src").symlink_to(real_dir)

    files_no = collect_files(tmp_path, follow_symlinks=False)
    files_yes = collect_files(tmp_path, follow_symlinks=True)

    assert [f.name for f in files_no].count("lib.py") == 1
    assert [f.name for f in files_yes].count("lib.py") == 2


def test_collect_files_handles_circular_symlinks(tmp_path):
    sub = tmp_path / "pkg"
    sub.mkdir()
    (sub / "mod.py").write_text("x = 1")
    (sub / "cycle").symlink_to(tmp_path)

    files = collect_files(tmp_path, follow_symlinks=True)
    assert any(f.name == "mod.py" for f in files)


def test_no_dangling_edges_on_extract():
    """After merging multiple files, no internal edges should be dangling."""
    files = list(FIXTURES.glob("*.py"))
    result = extract(files)
    node_ids = {n["id"] for n in result["nodes"]}
    internal_relations = {"contains", "method", "inherits", "calls"}
    for edge in result["edges"]:
        if edge["relation"] in internal_relations:
            assert edge["source"] in node_ids, f"Dangling source: {edge}"
            assert edge["target"] in node_ids, f"Dangling target: {edge}"


def test_calls_edges_emitted():
    """Call-graph pass must produce INFERRED calls edges."""
    result = extract_python(FIXTURES / "sample_calls.py")
    calls = [e for e in result["edges"] if e["relation"] == "calls"]
    assert len(calls) > 0, "Expected at least one calls edge"


def test_calls_edges_are_extracted():
    """AST-resolved call edges are deterministic and should be EXTRACTED/1.0."""
    result = extract_python(FIXTURES / "sample_calls.py")
    for edge in result["edges"]:
        if edge["relation"] == "calls":
            assert edge["confidence"] == "EXTRACTED"
            assert edge["weight"] == 1.0


def test_calls_no_self_loops():
    result = extract_python(FIXTURES / "sample_calls.py")
    for edge in result["edges"]:
        if edge["relation"] == "calls":
            assert edge["source"] != edge["target"], f"Self-loop: {edge}"


def test_run_analysis_calls_compute_score():
    """run_analysis() calls compute_score() - must appear as a calls edge."""
    result = extract_python(FIXTURES / "sample_calls.py")
    calls = {(e["source"], e["target"]) for e in result["edges"] if e["relation"] == "calls"}
    node_by_label = {n["label"]: n["id"] for n in result["nodes"]}
    src = node_by_label.get("run_analysis()")
    tgt = node_by_label.get("compute_score()")
    assert src and tgt, "run_analysis or compute_score node not found"
    assert (src, tgt) in calls, f"run_analysis -> compute_score not found in {calls}"


def test_run_analysis_calls_normalize():
    result = extract_python(FIXTURES / "sample_calls.py")
    calls = {(e["source"], e["target"]) for e in result["edges"] if e["relation"] == "calls"}
    node_by_label = {n["label"]: n["id"] for n in result["nodes"]}
    src = node_by_label.get("run_analysis()")
    tgt = node_by_label.get("normalize()")
    assert src and tgt
    assert (src, tgt) in calls


def test_method_calls_module_function():
    """Analyzer.process() calls run_analysis() - cross class→function calls edge."""
    result = extract_python(FIXTURES / "sample_calls.py")
    calls = {(e["source"], e["target"]) for e in result["edges"] if e["relation"] == "calls"}
    node_by_label = {n["label"]: n["id"] for n in result["nodes"]}
    src = node_by_label.get(".process()")
    tgt = node_by_label.get("run_analysis()")
    assert src and tgt
    assert (src, tgt) in calls


def test_calls_deduplication():
    """Same caller→callee pair must appear only once even if called multiple times."""
    result = extract_python(FIXTURES / "sample_calls.py")
    call_pairs = [(e["source"], e["target"]) for e in result["edges"] if e["relation"] == "calls"]
    assert len(call_pairs) == len(set(call_pairs)), "Duplicate calls edges found"


# ── Phase 4 additions: cache, edge cases, dispatch, structural integrity ────


def test_cache_key_includes_content_hash(tmp_path):
    """Same file path with different content must yield distinct cache keys."""
    f = tmp_path / "module.py"
    f.write_text("x = 1\n")
    h1 = file_hash(f, tmp_path)
    f.write_text("x = 2\n")
    h2 = file_hash(f, tmp_path)
    assert h1 != h2, "content change should rotate cache key"


def test_file_hash_out_of_tree_falls_back_to_absolute(tmp_path):
    """File outside `root` should still yield a stable hash via the absolute path fallback."""
    root = tmp_path / "project"
    root.mkdir()
    outside = tmp_path / "external"
    outside.mkdir()
    f = outside / "lib.py"
    f.write_text("y = 1\n")

    h_a = file_hash(f, root)
    h_b = file_hash(f, root)
    assert h_a == h_b, "out-of-tree hash must be stable across calls"

    # Sanity: a different file with the same content but different absolute path → different hash
    other = outside / "lib2.py"
    other.write_text("y = 1\n")
    assert file_hash(other, root) != h_a


def test_extract_python_empty_file(tmp_path):
    """Empty .py file: only the file-level node, no edges, no exception."""
    f = tmp_path / "empty.py"
    f.write_text("")
    result = extract_python(f)
    assert "error" not in result
    # Empty file produces just the file node with zero structural edges
    assert result["edges"] == []
    # Either zero nodes or just the file node — both are acceptable "empty extraction" outcomes
    assert len(result["nodes"]) <= 1


def test_extract_js_empty_file(tmp_path):
    """Empty .ts file: extractor must not crash."""
    f = tmp_path / "empty.ts"
    f.write_text("")
    result = extract_js(f)
    assert "error" not in result
    assert result["edges"] == []
    assert len(result["nodes"]) <= 1


def test_extract_python_syntax_error_does_not_raise(tmp_path):
    """Malformed Python source must return without bubbling an exception."""
    f = tmp_path / "broken.py"
    f.write_text("def foo(:::\n    pass\n!!!@@@ not valid python @@!!!\n")
    # Should not raise; tree-sitter is error-tolerant.
    result = extract_python(f)
    assert isinstance(result, dict)
    assert "nodes" in result and "edges" in result
    # Whatever it returns, structurally: no edge dangles outside its node set + raw_calls list.
    node_ids = {n["id"] for n in result["nodes"]}
    structural = {"contains", "method", "inherits"}
    for edge in result["edges"]:
        if edge["relation"] in structural:
            assert edge["source"] in node_ids


def test_extract_python_dedup_duplicate_definition(tmp_path):
    """Two top-level functions with the same name must collapse to a single node id."""
    f = tmp_path / "dup.py"
    f.write_text(
        "def foo():\n    return 1\n\n"
        "def foo():\n    return 2\n"
    )
    result = extract_python(f)
    ids = [n["id"] for n in result["nodes"]]
    assert len(ids) == len(set(ids)), f"duplicate ids in nodes: {ids}"


def test_edge_endpoints_resolve_python_and_typescript():
    """Structural edges (contains/method/inherits) must point at known nodes for ≥2 languages."""
    structural = {"contains", "method", "inherits"}

    py = extract_python(FIXTURES / "sample.py")
    py_ids = {n["id"] for n in py["nodes"]}
    for e in py["edges"]:
        if e["relation"] in structural:
            assert e["source"] in py_ids, f"py dangling source: {e}"
            assert e["target"] in py_ids, f"py dangling target: {e}"

    ts = extract_js(FIXTURES / "sample.ts")
    ts_ids = {n["id"] for n in ts["nodes"]}
    for e in ts["edges"]:
        if e["relation"] in structural:
            assert e["source"] in ts_ids, f"ts dangling source: {e}"
            assert e["target"] in ts_ids, f"ts dangling target: {e}"


def test_python_dispatch_uses_python_config(mocker):
    """extract_python must drive _extract_generic with the Python LanguageConfig."""
    from graphify import extract as ex_mod
    spy = mocker.patch.object(
        ex_mod, "_extract_generic", return_value={"nodes": [], "edges": []}
    )
    ex_mod.extract_python(FIXTURES / "sample.py")
    assert spy.called
    # Second positional arg is the LanguageConfig; must be the Python one
    config_arg = spy.call_args[0][1]
    assert config_arg is ex_mod._PYTHON_CONFIG


def test_confidence_labels_are_valid():
    """Every edge must carry a confidence label drawn from the documented vocabulary."""
    allowed = {"EXTRACTED", "INFERRED", "AMBIGUOUS"}
    files = list(FIXTURES.glob("sample_calls.py")) + list(FIXTURES.glob("sample.py"))
    result = extract(files)
    for edge in result["edges"]:
        assert "confidence" in edge, f"edge missing confidence: {edge}"
        assert edge["confidence"] in allowed, f"unexpected confidence {edge['confidence']!r}: {edge}"

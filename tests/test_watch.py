"""Tests for watch.py - file watcher helpers (no watchdog required)."""
import time
from pathlib import Path
import pytest

from graphify.watch import _notify_only, _WATCHED_EXTENSIONS


# --- _notify_only ---

def test_notify_only_creates_flag(tmp_path):
    _notify_only(tmp_path)
    flag = tmp_path / "graphify-out" / "needs_update"
    assert flag.exists()
    assert flag.read_text() == "1"

def test_notify_only_creates_flag_dir(tmp_path):
    # graphify-out dir does not exist yet
    assert not (tmp_path / "graphify-out").exists()
    _notify_only(tmp_path)
    assert (tmp_path / "graphify-out").is_dir()

def test_notify_only_idempotent(tmp_path):
    _notify_only(tmp_path)
    _notify_only(tmp_path)
    flag = tmp_path / "graphify-out" / "needs_update"
    assert flag.read_text() == "1"


# --- _WATCHED_EXTENSIONS ---

def test_watched_extensions_includes_code():
    assert ".py" in _WATCHED_EXTENSIONS
    assert ".ts" in _WATCHED_EXTENSIONS
    assert ".go" in _WATCHED_EXTENSIONS
    assert ".rs" in _WATCHED_EXTENSIONS

def test_watched_extensions_includes_docs():
    assert ".md" in _WATCHED_EXTENSIONS
    assert ".txt" in _WATCHED_EXTENSIONS
    assert ".pdf" in _WATCHED_EXTENSIONS

def test_watched_extensions_includes_images():
    assert ".png" in _WATCHED_EXTENSIONS
    assert ".jpg" in _WATCHED_EXTENSIONS

def test_watched_extensions_excludes_noise():
    assert ".json" not in _WATCHED_EXTENSIONS
    assert ".pyc" not in _WATCHED_EXTENSIONS
    assert ".log" not in _WATCHED_EXTENSIONS


# --- watch() import error without watchdog ---

def test_check_update_no_flag_returns_true(tmp_path):
    """check_update returns True and is silent when needs_update flag is absent."""
    from graphify.watch import check_update
    assert check_update(tmp_path) is True


def test_check_update_with_flag_returns_true_and_prints(tmp_path, capsys):
    """check_update returns True and prints notification when flag exists."""
    from graphify.watch import check_update
    flag = tmp_path / "graphify-out" / "needs_update"
    flag.parent.mkdir(parents=True, exist_ok=True)
    flag.write_text("1")
    result = check_update(tmp_path)
    assert result is True
    out = capsys.readouterr().out
    assert "graphify --update" in out


def test_check_update_does_not_clear_flag(tmp_path):
    """check_update never removes the needs_update flag (clearing is LLM's job)."""
    from graphify.watch import check_update
    flag = tmp_path / "graphify-out" / "needs_update"
    flag.parent.mkdir(parents=True, exist_ok=True)
    flag.write_text("1")
    check_update(tmp_path)
    assert flag.exists()


def test_watch_raises_without_watchdog(tmp_path, monkeypatch):
    import builtins
    real_import = builtins.__import__

    def mock_import(name, *args, **kwargs):
        if name == "watchdog.observers" or name == "watchdog.events":
            raise ImportError("mocked missing watchdog")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", mock_import)

    from graphify.watch import watch
    with pytest.raises(ImportError, match="watchdog not installed"):
        watch(tmp_path)


# ── Phase 4 additions: incremental re-extract integration ──────────────────
#
# These tests drive the underlying extract() loop directly (no watchdog).
# They cover the file-change → re-extract → graph-rebuild contract that
# watch._rebuild_code() relies on: cache invalidation, additions, deletions.


def test_incremental_extract_picks_up_added_file(tmp_path):
    """Initial run extracts 2 files; adding a 3rd file then re-running must include it."""
    from graphify.extract import extract, collect_files

    (tmp_path / "a.py").write_text("def alpha(): pass\n")
    (tmp_path / "b.py").write_text("def beta(): pass\n")

    files1 = collect_files(tmp_path)
    result1 = extract(files1, cache_root=tmp_path)
    labels1 = {n["label"] for n in result1["nodes"]}
    assert "alpha()" in labels1
    assert "beta()" in labels1
    assert "gamma()" not in labels1

    # Add a new file → re-collect → re-extract
    (tmp_path / "c.py").write_text("def gamma(): pass\n")
    files2 = collect_files(tmp_path)
    assert len(files2) == 3
    result2 = extract(files2, cache_root=tmp_path)
    labels2 = {n["label"] for n in result2["nodes"]}
    assert "gamma()" in labels2, "new file's symbol must appear after rebuild"
    assert "alpha()" in labels2 and "beta()" in labels2


def test_modified_file_invalidates_cache(tmp_path):
    """Editing a file's content must surface the new edges/nodes on re-extract."""
    from graphify.extract import extract

    f = tmp_path / "m.py"
    f.write_text("def first(): pass\n")
    r1 = extract([f], cache_root=tmp_path)
    labels1 = {n["label"] for n in r1["nodes"]}
    assert "first()" in labels1
    assert "second()" not in labels1

    # Mutate the file's content; cache key (hash of content) must rotate
    f.write_text("def first(): pass\n\ndef second(): pass\n")
    r2 = extract([f], cache_root=tmp_path)
    labels2 = {n["label"] for n in r2["nodes"]}
    assert "second()" in labels2, "modified file must produce fresh nodes"
    assert "first()" in labels2


def test_deleted_file_drops_from_rebuild(tmp_path):
    """When a file is removed from the input list, its symbols must not appear."""
    from graphify.extract import extract, collect_files

    (tmp_path / "keep.py").write_text("def keeper(): pass\n")
    doomed = tmp_path / "doomed.py"
    doomed.write_text("def doomed_fn(): pass\n")

    r1 = extract(collect_files(tmp_path), cache_root=tmp_path)
    labels1 = {n["label"] for n in r1["nodes"]}
    assert "keeper()" in labels1
    assert "doomed_fn()" in labels1

    # Delete the file from disk → collect_files no longer returns it
    doomed.unlink()
    r2 = extract(collect_files(tmp_path), cache_root=tmp_path)
    labels2 = {n["label"] for n in r2["nodes"]}
    assert "doomed_fn()" not in labels2, "removed file's symbols must drop"
    assert "keeper()" in labels2


def test_rebuild_code_writes_graph_outputs(tmp_path):
    """_rebuild_code drives the full extract→build→cluster→export pipeline.

    Integration smoke test: writing two .py files in a fresh dir and running
    _rebuild_code should produce graph.json + GRAPH_REPORT.md under graphify-out/.
    """
    from graphify.watch import _rebuild_code

    (tmp_path / "p.py").write_text("def proc(): return 1\n")
    (tmp_path / "q.py").write_text("def query(): return 2\n")

    ok = _rebuild_code(tmp_path)
    assert ok is True

    out = tmp_path / "graphify-out"
    assert (out / "graph.json").exists(), "graph.json must be written"
    assert (out / "GRAPH_REPORT.md").exists(), "GRAPH_REPORT.md must be written"


def test_rebuild_code_allows_deleted_file_to_shrink_graph(tmp_path):
    """watch rebuild is the current-files-are-truth path, so deletions must remove nodes."""
    import json
    from graphify.watch import _rebuild_code

    keep = tmp_path / "keep.py"
    doomed = tmp_path / "doomed.py"
    keep.write_text("def keeper(): return 1\n")
    doomed.write_text("def doomed_fn(): return 2\n")

    assert _rebuild_code(tmp_path) is True
    doomed.unlink()
    assert _rebuild_code(tmp_path) is True

    graph = json.loads((tmp_path / "graphify-out" / "graph.json").read_text(encoding="utf-8"))
    labels = {node.get("label") for node in graph.get("nodes", [])}
    assert "keeper()" in labels
    assert "doomed_fn()" not in labels

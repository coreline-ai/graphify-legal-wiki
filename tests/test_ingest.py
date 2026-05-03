"""Tests for graphify.ingest.save_query_result"""
from __future__ import annotations
import io
import re
import socket
import urllib.error
from pathlib import Path
from unittest import mock

import pytest
from graphify.ingest import save_query_result


def test_file_created(tmp_path):
    out = save_query_result("what is attention?", "Attention is...", tmp_path / "memory")
    assert out.exists()


def test_filename_format(tmp_path):
    mem = tmp_path / "memory"
    out = save_query_result("what connects A to B?", "They share...", mem)
    assert out.name.startswith("query_")
    assert out.suffix == ".md"


def test_frontmatter_question(tmp_path):
    mem = tmp_path / "memory"
    question = "what is attention?"
    out = save_query_result(question, "Attention is softmax.", mem)
    content = out.read_text()
    assert "question:" in content
    assert "attention" in content.lower()


def test_frontmatter_type(tmp_path):
    mem = tmp_path / "memory"
    out = save_query_result("q", "a", mem, query_type="path_query")
    content = out.read_text()
    assert 'type: "path_query"' in content


def test_source_nodes_included(tmp_path):
    mem = tmp_path / "memory"
    nodes = ["AttentionLayer", "SoftmaxFunc"]
    out = save_query_result("q", "a", mem, source_nodes=nodes)
    content = out.read_text()
    assert "AttentionLayer" in content
    assert "SoftmaxFunc" in content


def test_source_nodes_capped_at_10(tmp_path):
    mem = tmp_path / "memory"
    nodes = [f"Node{i}" for i in range(20)]
    out = save_query_result("q", "a", mem, source_nodes=nodes)
    content = out.read_text()
    # Only first 10 should appear in frontmatter source_nodes line
    fm_line = [l for l in content.splitlines() if l.startswith("source_nodes:")][0]
    assert fm_line.count('"Node') == 10


def test_memory_dir_created(tmp_path):
    mem = tmp_path / "deep" / "memory"
    assert not mem.exists()
    save_query_result("q", "a", mem)
    assert mem.exists()


def test_answer_in_body(tmp_path):
    mem = tmp_path / "memory"
    answer = "The answer is forty-two."
    out = save_query_result("what is the answer?", answer, mem)
    content = out.read_text()
    assert answer in content


# ── Phase 4 additions: ingest failure modes (network mocked) ───────────────
#
# These tests stub graphify.security._build_opener so no real network is hit.
# They verify behaviour around timeouts, HTTP error codes, and oversized
# responses against the safe_fetch / ingest contract.


def _fake_opener(response_factory):
    """Build a fake OpenerDirector whose .open() invokes response_factory()."""
    opener = mock.MagicMock()
    opener.open.side_effect = lambda req, timeout=None: response_factory()
    return opener


class _FakeResp:
    """Minimal context-manager wrapping a bytes payload, like urlopen returns."""
    def __init__(self, payload: bytes, status: int = 200):
        self._buf = io.BytesIO(payload)
        self.status = status
        self.code = status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self._buf.close()
        return False

    def read(self, n=-1):
        return self._buf.read(n)


def test_ingest_network_timeout_no_partial_file(tmp_path):
    """socket.timeout from the opener must surface as RuntimeError; no file written."""
    from graphify import ingest as ingest_mod

    target = tmp_path / "raw"

    def boom():
        raise socket.timeout("simulated timeout")

    with mock.patch("graphify.security._build_opener",
                    return_value=_fake_opener(boom)), \
         mock.patch("graphify.security.validate_url", side_effect=lambda u: u):
        with pytest.raises(RuntimeError, match="failed to fetch"):
            ingest_mod.ingest("https://example.com/page", target)

    # No partial markdown should have landed in the target dir
    files = list(target.glob("*"))
    assert files == [], f"expected no files written on timeout, got {files}"


def test_ingest_http_404_error_no_file(tmp_path):
    """HTTPError 404 from the opener must surface as RuntimeError; no file written."""
    from graphify import ingest as ingest_mod

    target = tmp_path / "raw"

    def boom():
        raise urllib.error.HTTPError(
            "https://example.com/missing", 404, "Not Found", {}, None
        )

    with mock.patch("graphify.security._build_opener",
                    return_value=_fake_opener(boom)), \
         mock.patch("graphify.security.validate_url", side_effect=lambda u: u):
        with pytest.raises(RuntimeError, match="failed to fetch"):
            ingest_mod.ingest("https://example.com/missing", target)

    files = list(target.glob("*"))
    assert files == [], f"expected no files written on HTTP 404, got {files}"


def test_safe_fetch_oversized_response_rejected():
    """safe_fetch must abort with OSError once the size cap is exceeded."""
    from graphify import security

    # Build a payload comfortably above the 10 MB text cap; safe_fetch
    # streams in 64 KB chunks and raises OSError once total > max_bytes.
    big = b"A" * (256 * 1024)  # 256 KB

    def make_resp():
        return _FakeResp(big, status=200)

    with mock.patch("graphify.security._build_opener",
                    return_value=_fake_opener(make_resp)), \
         mock.patch("graphify.security.validate_url", side_effect=lambda u: u):
        # Pass a tiny max_bytes so 256 KB blows the cap
        with pytest.raises(OSError, match="exceeds size limit"):
            security.safe_fetch("https://example.com/big", max_bytes=128 * 1024)


def test_html_to_markdown_handles_garbage_input():
    """The HTML→markdown helper must degrade gracefully on malformed HTML."""
    from graphify.ingest import _html_to_markdown

    garbage = "<<<not <really> html >>> <script>x=1</script> <p>hi"
    out = _html_to_markdown(garbage, "https://example.com/x")
    # Should produce a string and not raise; "hi" survives, scripts are stripped.
    assert isinstance(out, str)
    assert "hi" in out
    assert "<script" not in out.lower()

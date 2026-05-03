"""Shared text-normalization helpers for deterministic graph builders.

Consolidates the small per-builder helpers (``norm_title`` / ``norm_law`` /
``norm_case``) that previously lived inside the legalize / precedent scripts.

Behaviour MUST stay byte-identical to the original helpers — fixtures and
deterministic graph IDs depend on the exact output. Each strategy below is a
straight 1:1 port of the original function (same regexes, same order of
operations).
"""
from __future__ import annotations

import re

# ── Strategy: title (from graphify_legalize_deterministic.norm_title) ─────────
_TITLE_BAD_TAIL_RE = re.compile(r"\s+(제\d+조.*|별표.*|별지.*)$")
_TITLE_BRACKETS_RE = re.compile(r"[「」『』《》〈〉\[\]`'\"“”‘’]")
_TITLE_HTML_RE = re.compile(r"<[^>]+>")

# ── Strategy: law (from graphify_precedent_deterministic.norm_law) ───────────
_LAW_PARENS_RE = re.compile(r"\([^)]*\)")
# NOTE: precedent variant uses straight curly-quote pairs ("""'') —
# different bytes than the title variant. Preserve verbatim.
_LAW_BRACKETS_RE = re.compile(r"[「」『』《》〈〉\[\]`'\"""'']")

# ── Shared whitespace pattern used by all three strategies ───────────────────
_SPACE_RE = re.compile(r"\s+")


def normalize_text(
    value: str,
    *,
    strategy: str = "title",
    max_length: int | None = None,
) -> str:
    """Normalize a piece of Korean legal text.

    strategy:
      - ``"title"``: matches ``norm_title`` from the legalize builder. Strips
        bracket/quote characters, HTML tags, trailing 제N조/별표/별지 tails,
        normalises NBSP and middle-dot, and removes ALL whitespace.
      - ``"law"``: matches ``norm_law`` from the precedent builder. Strips
        parenthetical content, bracket/quote characters and ALL whitespace.
        Caps length at 60 unless ``max_length`` is given.
      - ``"case"``: matches ``norm_case`` from the precedent builder. Strips
        ALL whitespace and lowercases.

    ``max_length``: optional explicit cap. When provided it overrides the
    strategy's default cap.
    """
    s = (value or "").strip()

    if strategy == "title":
        s = s.replace("·", "ㆍ")
        s = s.replace(" ", " ")
        s = _TITLE_BAD_TAIL_RE.sub("", s)
        s = _TITLE_BRACKETS_RE.sub("", s)
        s = _TITLE_HTML_RE.sub("", s)
        s = _SPACE_RE.sub("", s)
        if max_length is not None:
            s = s[:max_length]
        return s

    if strategy == "law":
        s = _LAW_PARENS_RE.sub("", s)
        s = _LAW_BRACKETS_RE.sub("", s)
        s = _SPACE_RE.sub("", s)
        cap = 60 if max_length is None else max_length
        return s[:cap]

    if strategy == "case":
        s = _SPACE_RE.sub("", s).lower()
        if max_length is not None:
            s = s[:max_length]
        return s

    raise ValueError(f"unknown normalize strategy: {strategy!r}")

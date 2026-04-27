#!/usr/bin/env python3
"""Build a graphify-compatible deterministic graph for data/precedent-kr.

Analogous to graphify_legalize_deterministic.py but for 판례 (court precedents).
No-LLM: extracts metadata from YAML frontmatter, case/law references from body text,
and court hierarchy (대법원 → 하급심) from metadata.

Node kinds:
  precedent_case       - 판례 문서
  case_type            - 사건종류 (민사/형사/세무/…)
  court_tier           - 법원등급 (대법원/하급심)
  court                - 법원명 (서울중앙지방법원/…)
  external_law_ref     - 고빈도 법령 참조 허브 (≥ MIN_LAW_HUB_COUNT)

Edge relations:
  is_case_type         - precedent → case_type
  decided_by_tier      - precedent → court_tier
  decided_by_court     - precedent → court
  cites_precedent      - precedent → precedent  (선고 사건번호 판결)
  cites_law            - precedent → external_law_ref (법령명 제N조)
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, datetime
from pathlib import Path
import hashlib
import json
import math
import re
import sys
from typing import Any

import yaml

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from graphify.build import build_from_json
from graphify.cluster import cluster, score_all
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.report import generate
from graphify.export import to_json, to_html
from graphify.wiki import to_wiki

ROOT = REPO / "data" / "precedent-kr"
OUT = ROOT / "graphify-out"

# Law hub: only create external_law_ref node if cited ≥ this many times across corpus.
MIN_LAW_HUB_COUNT = 100
# Max external law hubs to avoid noise.
MAX_LAW_HUBS = 500

# ──────────────────────────── Regex ────────────────────────────

SPACE_RE = re.compile(r"\s+")

# Law name extraction: captures Korean law names ending in 법/령/규칙/규정
# before a 제N조 citation.  Allows multi-word names (up to ~8 tokens).
# Use [ \t]+ (not \s+) so the match never crosses a newline — prevents capturing
# preceding sentence context when law names appear on indented lines.
_LAW_WORD = r"[가-힣a-zA-Z0-9·ㆍ\-]+"
LAW_NAME_RE = re.compile(
    rf"({_LAW_WORD}(?:[ \t]+{_LAW_WORD}){{0,7}}(?:법|령|규칙|규정)[가-힣\w]*)"
    r"(?:\([^)]{0,80}\))?"   # optional (약칭 ...) parenthetical
    r"[ \t]+제\d+조",
    re.UNICODE,
)
# Filter relative references ("같은법", "같은시행령", "위시행령", "이 법" …)
SAME_LAW_RE = re.compile(
    r"^(?:같[은의]|이[ \t]|위[ \t]|위시행|위법|해당[ \t]|본[ \t]|동법|본법)",
    re.UNICODE,
)

# Case number after 선고: "선고 2012다65317 판결".
# Metadata/citations may contain comma-separated or abbreviated lists:
# "2000므1257(본소), 1264(반소)".
_CASE_NUM = r"\d{2,4}[가-힣]+\d+[가-힣\d]*"
_CASE_NUM_RE = re.compile(_CASE_NUM, re.UNICODE)
_CASE_PREFIX_RE = re.compile(r"^(\d{2,4}[가-힣]+)\d+", re.UNICODE)
_ABBREVIATED_CASE_RE = re.compile(r"^\s*(\d+[가-힣\d]*)", re.UNICODE)
CASE_CITATION_RE = re.compile(
    r"선고[ \t]+([0-9가-힣A-Za-z, ·ㆍ;()/\\_-]{3,160}?)[ \t]*(?:판결|결정|명령)",
    re.UNICODE,
)


# ──────────────────────────── Helpers ────────────────────────────

def as_jsonable(v: Any) -> Any:
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    if isinstance(v, dict):
        return {str(k): as_jsonable(val) for k, val in v.items()}
    if isinstance(v, list):
        return [as_jsonable(x) for x in v]
    return v


def stable_id(prefix: str, text: str, n: int = 12) -> str:
    h = hashlib.blake2s(text.encode("utf-8"), digest_size=8).hexdigest()[:n]
    return f"{prefix}_{h}"


def norm_law(s: str) -> str:
    """Normalise a law name: remove spaces, parens, quotes."""
    s = (s or "").strip()
    s = re.sub(r"\([^)]*\)", "", s)
    s = re.sub(r"[「」『』《》〈〉\[\]`'\"""'']", "", s)
    s = SPACE_RE.sub("", s)
    return s[:60]  # cap length


def norm_case(s: str) -> str:
    """Normalise a case number for dedup matching."""
    return SPACE_RE.sub("", (s or "").strip()).lower()


def extract_case_number_tokens(raw: str) -> list[str]:
    """Extract full case-number tokens from metadata or citation snippets.

    The corpus frequently stores multiple case numbers in one field.  If a later
    token is abbreviated (e.g. "2000므1257(본소), 1264(반소)"), infer the year/type
    prefix from the previous full token.
    """
    if not raw:
        return []
    normalized = (
        str(raw)
        .replace("ㆍ", ",")
        .replace("·", ",")
        .replace("，", ",")
        .replace("、", ",")
    )
    parts = re.split(r"[,;/]|\s+및\s+|\s+및(?=\d)", normalized)
    tokens: list[str] = []
    current_prefix: str | None = None
    for part in parts:
        part = part.strip()
        if not part:
            continue
        matches = list(_CASE_NUM_RE.finditer(part))
        if matches:
            for match in matches:
                token = match.group(0)
                tokens.append(token)
                prefix_match = _CASE_PREFIX_RE.match(token)
                if prefix_match:
                    current_prefix = prefix_match.group(1)
            continue
        if current_prefix:
            abbreviated = _ABBREVIATED_CASE_RE.match(part)
            if abbreviated:
                tokens.append(f"{current_prefix}{abbreviated.group(1)}")
    return list(dict.fromkeys(tokens))


def format_case_label(case_name: str, case_number: str, court_name: str, judgment_date: Any) -> str:
    parts = [case_name.strip() or "판례"]
    if case_number:
        parts.append(SPACE_RE.sub(" ", str(case_number)).strip())
    if court_name:
        parts.append(str(court_name).strip())
    if judgment_date:
        parts.append(str(judgment_date).strip())
    return " · ".join(part for part in parts if part)


def split_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    if text.startswith("---\n"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            try:
                data = yaml.safe_load(parts[1]) or {}
                if isinstance(data, dict):
                    return as_jsonable(data), parts[2]
            except Exception:
                return {}, parts[2]
    return {}, text


def add_node(nodes: list[dict], seen: set[str], node: dict) -> None:
    if node["id"] in seen:
        return
    seen.add(node["id"])
    nodes.append(node)


def edge_key(e: dict) -> tuple:
    return (e["source"], e["target"], e.get("relation", ""), e.get("source_file", ""))


def add_edge(edges_by_key: dict, edge: dict) -> None:
    k = edge_key(edge)
    existing = edges_by_key.get(k)
    if existing:
        existing["weight"] = float(existing.get("weight", 1.0)) + float(edge.get("weight", 1.0))
        existing["reference_count"] = int(existing.get("reference_count", 1)) + int(edge.get("reference_count", 1))
        return
    edges_by_key[k] = edge


def rel_edge(source: str, target: str, relation: str, source_file: str,
             *, weight: float = 1.0, count: int = 1) -> dict:
    return {
        "source": source,
        "target": target,
        "relation": relation,
        "confidence": "EXTRACTED",
        "confidence_score": 1.0,
        "source_file": source_file,
        "source_location": None,
        "weight": weight,
        "reference_count": count,
    }


def node_base(node_id: str, label: str, file_type: str = "document",
              source_file: str = "") -> dict:
    return {
        "id": node_id,
        "label": label,
        "file_type": file_type,
        "source_file": source_file,
        "source_location": None,
        "source_url": None,
        "captured_at": None,
        "author": None,
        "contributor": None,
    }


# ──────────────────────────── Reference extraction ────────────────────────────

def extract_law_refs(body: str) -> list[str]:
    """Return raw law names cited as 'NAME 제N조' in body text."""
    names: list[str] = []
    for m in LAW_NAME_RE.finditer(body):
        name = m.group(1).strip()
        if SAME_LAW_RE.match(name):
            continue
        if len(name) < 2:
            continue
        names.append(name)
    return names


def extract_case_refs(body: str) -> list[str]:
    """Return case numbers from '선고 CASE 판결' patterns."""
    case_nums: list[str] = []
    for m in CASE_CITATION_RE.finditer(body):
        raw = m.group(1)
        case_nums.extend(extract_case_number_tokens(raw))
    return case_nums


# ──────────────────────────── Document loading ────────────────────────────

def load_docs() -> tuple[list[dict], dict]:
    """Load all precedent .md files; extract law/case refs per doc."""
    # Structure: {사건종류}/{법원등급}/*.md  (also README.md at root)
    md_files = [ROOT / "README.md"] + sorted(ROOT.glob("*/*/*.md"))
    docs: list[dict] = []
    law_ref_counter: Counter[str] = Counter()
    case_ref_counter: Counter[str] = Counter()
    total_words = 0

    for path in md_files:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        rel = path.relative_to(ROOT).as_posix()
        fm, body = split_frontmatter(text)
        words = len(text.split())
        total_words += words

        if rel == "README.md":
            law_refs: list[str] = []
            case_refs: list[str] = []
        else:
            law_refs = extract_law_refs(body)
            case_refs = extract_case_refs(body)

        law_ref_counter.update(norm_law(r) for r in law_refs if norm_law(r))
        case_ref_counter.update(norm_case(r) for r in case_refs if norm_case(r))

        docs.append({
            "path": path,
            "rel": rel,
            "body": body,
            "fm": fm,
            "words": words,
            "law_refs": law_refs,
            "case_refs": case_refs,
        })

    detection = {
        "total_files": len(md_files),
        "total_words": total_words,
        "files": {"document": [d["rel"] for d in docs]},
        "skipped_sensitive": [],
        "warning": (
            f"Large corpus: {len(md_files)} files · ~{total_words:,} words. "
            "Deterministic precedent-reference extraction used; LLM skipped."
        ),
    }
    return docs, {
        "law_refs": law_ref_counter,
        "case_refs": case_ref_counter,
        "detection": detection,
    }


# ──────────────────────────── Community labelling ────────────────────────────

def choose_labels(G, communities: dict[int, list[str]]) -> dict[int, str]:
    labels: dict[int, str] = {}
    for cid, members in communities.items():
        case_type_counts: Counter[str] = Counter()
        court_counts: Counter[str] = Counter()
        tier_counts: Counter[str] = Counter()
        doc_labels: list[tuple[int, str]] = []
        for nid in members:
            d = G.nodes[nid]
            label = d.get("label", nid)
            kind = d.get("node_kind", "")
            if kind == "case_type":
                case_type_counts[label.replace("사건종류: ", "")] += max(1, G.degree(nid))
            elif kind == "court":
                court_counts[label] += max(1, G.degree(nid))
            elif kind == "court_tier":
                tier_counts[label.replace("법원등급: ", "")] += max(1, G.degree(nid))
            elif kind == "precedent_case":
                doc_labels.append((G.degree(nid), label))
        if case_type_counts and case_type_counts.most_common(1)[0][1] >= 5:
            labels[cid] = f"{case_type_counts.most_common(1)[0][0]} 사건"
        elif court_counts and court_counts.most_common(1)[0][1] >= 5:
            labels[cid] = f"{court_counts.most_common(1)[0][0]} 판례"
        elif tier_counts:
            labels[cid] = f"{tier_counts.most_common(1)[0][0]} 판례"
        elif doc_labels:
            labels[cid] = f"{sorted(doc_labels, reverse=True)[0][1]} 관련"
        else:
            labels[cid] = f"Community {cid}"
    return ensure_unique_labels(labels)


def ensure_unique_labels(labels: dict[int, str]) -> dict[int, str]:
    counts = Counter(labels.values())
    seen: Counter[str] = Counter()
    unique: dict[int, str] = {}
    for cid in sorted(labels):
        label = labels[cid]
        if counts[label] <= 1:
            unique[cid] = label
            continue
        seen[label] += 1
        unique[cid] = f"{label} #{seen[label]}"
    return unique


# ──────────────────────────── Main pipeline ────────────────────────────

def main() -> None:
    if not ROOT.exists():
        raise SystemExit(f"missing input: {ROOT}")
    OUT.mkdir(parents=True, exist_ok=True)

    print("Loading documents …")
    docs, stats = load_docs()
    law_ref_counter: Counter[str] = stats["law_refs"]
    detection = stats["detection"]
    # stats["case_refs"] is not used here: case refs are matched directly via
    # case_num_to_nodes index (node-level, not corpus-level aggregation).

    nodes: list[dict] = []
    seen_nodes: set[str] = set()
    edges_by_key: dict[tuple, dict] = {}

    # Lookup indexes
    path_to_doc: dict[str, str] = {}
    case_num_to_nodes: dict[str, list[str]] = defaultdict(list)

    # README node
    add_node(nodes, seen_nodes, {
        **node_base("doc_readme", "Precedent KR README", "document", "README.md"),
        "node_kind": "readme",
        "summary": "대한민국 판례 Markdown 저장소 설명 문서",
    })

    print("Building precedent case nodes …")
    # ── Pass 1: precedent_case nodes + indexes ──
    for doc in docs:
        rel = doc["rel"]
        if rel == "README.md":
            continue
        fm = doc["fm"]

        case_seq = str(fm.get("판례일련번호", "")).strip().strip("'")
        case_number = str(fm.get("사건번호", Path(rel).stem))
        case_name = str(fm.get("사건명", Path(rel).stem))
        court_name = str(fm.get("법원명", ""))
        court_tier = str(fm.get("법원등급", ""))
        # 사건종류 falls back to the parent folder name (e.g. "민사")
        parts = Path(rel).parts
        case_type = str(fm.get("사건종류", parts[-3] if len(parts) >= 3 else ""))
        judgment_date = fm.get("선고일자")
        source_url = str(fm.get("출처") or "") or None
        label = format_case_label(case_name, case_number, court_name, judgment_date)

        node_id = stable_id("prec", f"{rel}|{case_seq}|{case_number}")
        path_to_doc[rel] = node_id

        case_number_tokens = extract_case_number_tokens(case_number)
        token_keys = {norm_case(token) for token in case_number_tokens}
        for nc in token_keys:
            case_num_to_nodes[nc].append(node_id)
        full_case_number_key = norm_case(case_number)
        if full_case_number_key and full_case_number_key not in token_keys:
            case_num_to_nodes[full_case_number_key].append(node_id)

        add_node(nodes, seen_nodes, {
            **node_base(node_id, label, "document", rel),
            "source_url": source_url,
            "author": court_name,
            "node_kind": "precedent_case",
            "case_seq": case_seq,
            "case_number": case_number,
            "case_name": case_name,
            "canonical_title": case_name,
            "case_number_tokens": case_number_tokens,
            "court_name": court_name,
            "court_tier": court_tier,
            "case_type": case_type,
            "judgment_date": as_jsonable(judgment_date),
            "word_count": doc["words"],
        })

    print("Building metadata nodes and edges …")
    # ── Pass 2: metadata concept nodes + edges ──
    for doc in docs:
        rel = doc["rel"]
        if rel == "README.md":
            continue
        src = path_to_doc[rel]
        fm = doc["fm"]

        parts = Path(rel).parts
        case_type = str(fm.get("사건종류", parts[-3] if len(parts) >= 3 else ""))
        court_tier = str(fm.get("법원등급", ""))
        court_name = str(fm.get("법원명", ""))

        if case_type:
            ct_id = stable_id("case_type", case_type)
            add_node(nodes, seen_nodes, {
                **node_base(ct_id, f"사건종류: {case_type}", "document", ""),
                "node_kind": "case_type",
            })
            add_edge(edges_by_key, rel_edge(src, ct_id, "is_case_type", rel))

        if court_tier:
            tier_id = stable_id("court_tier", court_tier)
            add_node(nodes, seen_nodes, {
                **node_base(tier_id, f"법원등급: {court_tier}", "document", ""),
                "node_kind": "court_tier",
            })
            add_edge(edges_by_key, rel_edge(src, tier_id, "decided_by_tier", rel))

        if court_name:
            court_id = stable_id("court", court_name)
            add_node(nodes, seen_nodes, {
                **node_base(court_id, court_name, "document", ""),
                "node_kind": "court",
            })
            add_edge(edges_by_key, rel_edge(src, court_id, "decided_by_court", rel))

    # Keep README connected to the metadata schema rather than as a singleton.
    for node in list(nodes):
        if node.get("node_kind") in {"case_type", "court_tier"}:
            add_edge(edges_by_key, rel_edge("doc_readme", node["id"], "documents_schema", "README.md", weight=0.2))

    print("Matching case-to-case citation edges …")
    # ── Pass 3: cites_precedent edges (선고 사건번호 판결) ──
    matched_case_refs = 0
    unmatched_case_refs: Counter[str] = Counter()

    for doc in docs:
        rel = doc["rel"]
        if rel == "README.md":
            continue
        src = path_to_doc[rel]
        per_target: Counter[str] = Counter()

        for raw_case in doc["case_refs"]:
            nc = norm_case(raw_case)
            if not nc:
                continue
            targets = case_num_to_nodes.get(nc, [])
            targets = [t for t in set(targets) if t != src]
            if not targets:
                unmatched_case_refs[nc] += 1
                continue
            for tgt in targets[:3]:
                per_target[tgt] += 1
                matched_case_refs += 1

        for tgt, count in per_target.items():
            add_edge(edges_by_key, rel_edge(
                src, tgt, "cites_precedent", rel,
                weight=1.0 + math.log(count, 2), count=count,
            ))

    print("Building external law reference hubs …")
    # ── Pass 4: external_law_ref hub nodes (high-signal law citations) ──
    law_hub_ids: dict[str, str] = {}  # norm_law → node_id

    for nl, count in law_ref_counter.most_common(MAX_LAW_HUBS):
        if count < MIN_LAW_HUB_COUNT:
            break
        ext_id = stable_id("ext_law", nl)
        add_node(nodes, seen_nodes, {
            **node_base(ext_id, f"법령참조: {nl}", "document", ""),
            "node_kind": "external_law_ref",
            "reference_count": count,
        })
        law_hub_ids[nl] = ext_id

    print(f"  {len(law_hub_ids)} law hubs created (≥{MIN_LAW_HUB_COUNT} mentions).")

    matched_law_refs = 0
    for doc in docs:
        rel = doc["rel"]
        if rel == "README.md":
            continue
        src = path_to_doc[rel]
        counts: Counter[str] = Counter(norm_law(r) for r in doc["law_refs"])
        for nl, ext_id in law_hub_ids.items():
            c = counts.get(nl, 0)
            if c:
                add_edge(edges_by_key, rel_edge(
                    src, ext_id, "cites_law", rel,
                    weight=1.0 + math.log(c, 2), count=c,
                ))
                matched_law_refs += 1

    edges = list(edges_by_key.values())
    extraction = {
        "nodes": nodes,
        "edges": edges,
        "hyperedges": [],
        "input_tokens": 0,
        "output_tokens": 0,
    }

    print(f"Extraction done: {len(nodes):,} nodes · {len(edges):,} edges")
    print("Writing intermediate JSON files …")

    (OUT / ".graphify_detect.json").write_text(
        json.dumps(detection, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (OUT / ".graphify_extract.json").write_text(
        json.dumps(extraction, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    empty = {"nodes": [], "edges": [], "hyperedges": [], "input_tokens": 0, "output_tokens": 0}
    (OUT / ".graphify_ast.json").write_text(
        json.dumps(empty, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (OUT / ".graphify_semantic.json").write_text(
        json.dumps(extraction, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print("Building NetworkX graph …")
    G = build_from_json(extraction)

    print("Clustering communities …")
    communities = cluster(G)
    for cid, members in communities.items():
        for nid in members:
            if nid in G.nodes:
                G.nodes[nid]["community"] = cid
    cohesion = score_all(G, communities)
    labels = choose_labels(G, communities)

    print("Analysing graph …")
    gods = god_nodes(G)
    surprises = surprising_connections(G, communities)
    questions = suggest_questions(G, communities, labels)

    print("Generating report …")
    report = generate(
        G, communities, cohesion, labels, gods, surprises, detection,
        {"input": 0, "output": 0}, str(ROOT), suggested_questions=questions,
    )
    report += "\n\n## Extraction Mode\n"
    report += (
        "- Deterministic precedent-reference extraction: YAML frontmatter, "
        "사건종류/법원등급/법원명 metadata links, "
        "and explicit case/law citations extracted from body text via regex.\n"
    )
    report += "- LLM semantic extraction was not used; token cost is 0.\n"
    report += f"- Matched case-to-case citation edges: {matched_case_refs:,}.\n"
    report += f"- Matched law-reference hub edges: {matched_law_refs:,} "
    report += f"(law hubs with ≥{MIN_LAW_HUB_COUNT} corpus mentions: {len(law_hub_ids):,}).\n"
    report += f"- Unmatched case citations (target not in corpus): {sum(unmatched_case_refs.values()):,}.\n"

    (OUT / "GRAPH_REPORT.md").write_text(report, encoding="utf-8")
    to_json(G, communities, str(OUT / "graph.json"), force=True)

    analysis = {
        "communities": {str(k): v for k, v in communities.items()},
        "cohesion": {str(k): v for k, v in cohesion.items()},
        "gods": gods,
        "surprises": surprises,
        "questions": questions,
        "mode": "deterministic_legal_reference",
    }
    (OUT / ".graphify_analysis.json").write_text(
        json.dumps(analysis, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (OUT / ".graphify_labels.json").write_text(
        json.dumps({str(k): v for k, v in labels.items()}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print("Generating HTML …")
    node_limit = 5000
    if G.number_of_nodes() <= node_limit:
        to_html(G, communities, str(OUT / "graph.html"), community_labels=labels)
        html_mode = "full"
    else:
        import networkx as nx
        node_to_community = {
            nid: cid for cid, members in communities.items() for nid in members
        }
        meta = nx.Graph()
        for cid, members in communities.items():
            meta.add_node(str(cid), label=labels.get(cid, f"Community {cid}"))
        edge_counts: Counter[tuple[int, int]] = Counter()
        for u, v in G.edges():
            cu = node_to_community.get(u)
            cv = node_to_community.get(v)
            if cu is not None and cv is not None and cu != cv:
                edge_counts[(min(cu, cv), max(cu, cv))] += 1
        for (cu, cv), w in edge_counts.items():
            meta.add_edge(
                str(cu), str(cv),
                weight=w, relation=f"{w} cross-community edges",
                confidence="AGGREGATED",
            )
        if meta.number_of_edges() or meta.number_of_nodes():
            meta_communities = {cid: [str(cid)] for cid in communities}
            member_counts = {cid: len(members) for cid, members in communities.items()}
            to_html(
                meta, meta_communities, str(OUT / "graph.html"),
                community_labels=labels, member_counts=member_counts,
            )
            html_mode = "aggregated"
        else:
            html_mode = "skipped"

    print("Generating wiki …")
    wiki_count = to_wiki(
        G, communities, OUT / "wiki",
        community_labels=labels, cohesion=cohesion, god_nodes_data=gods,
    )

    now = datetime.now().astimezone().isoformat()
    cost = {
        "runs": [{
            "date": now,
            "input_tokens": 0,
            "output_tokens": 0,
            "files": detection["total_files"],
            "mode": "deterministic_legal_reference",
        }],
        "total_input_tokens": 0,
        "total_output_tokens": 0,
    }
    (OUT / "cost.json").write_text(
        json.dumps(cost, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    summary = {
        "mode": "deterministic_legal_reference",
        "input_files": detection["total_files"],
        "input_words": detection["total_words"],
        "nodes": G.number_of_nodes(),
        "edges": G.number_of_edges(),
        "communities": len(communities),
        "wiki_articles": wiki_count + 1,
        "html_mode": html_mode,
        "law_hub_nodes": len(law_hub_ids),
        "matched_case_citation_edges": matched_case_refs,
        "matched_law_hub_edges": matched_law_refs,
        "unmatched_case_citations": sum(unmatched_case_refs.values()),
        "output_dir": str(OUT),
    }
    (OUT / "run-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

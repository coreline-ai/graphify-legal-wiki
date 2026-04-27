#!/usr/bin/env python3
"""Build a graphify-compatible deterministic graph for data/legalize-kr.

This is a no-LLM fallback for very large legal corpora: it extracts explicit
metadata, 법령 family/type/ministry links, common article-topic hubs, and explicit
cross-law references from 「...」 citations.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, datetime
from pathlib import Path
import hashlib
import json
import math
import os
import re
import sys
from typing import Any

import yaml

# Make local graphify package importable when running from repo root.
REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from graphify.build import build_from_json
from graphify.cluster import cluster, score_all
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.report import generate
from graphify.export import to_json, to_html
from graphify.wiki import to_wiki

ROOT = REPO / "data" / "legalize-kr"
OUT = ROOT / "graphify-out"

# Create external-reference hubs for old/renamed laws that are cited often but
# do not exist as current corpus files. A lower threshold gives search/UI a real
# target for more historical references without exploding the graph.
MIN_EXTERNAL_REF_HUB_COUNT = 10
MAX_EXTERNAL_REF_HUBS = 500

ARTICLE_RE = re.compile(r"^#{3,6}\s*제[^\s#]+조(?:의\d+)?\s*\(([^)]+)\)", re.M)
REF_RE = re.compile(r"「([^」]{2,100})」")
SPACE_RE = re.compile(r"\s+")
BAD_REF_TAIL_RE = re.compile(r"\s+(제\d+조.*|별표.*|별지.*)$")


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


def norm_title(s: str) -> str:
    s = (s or "").strip()
    s = s.replace("·", "ㆍ")
    s = s.replace("\u00a0", " ")
    s = BAD_REF_TAIL_RE.sub("", s)
    # Strip common quoting/bracketing and markdown residue.
    s = re.sub(r"[「」『』《》〈〉\[\]`'\"“”‘’]", "", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = SPACE_RE.sub("", s)
    return s


def clean_topic(s: str) -> str:
    s = (s or "").strip()
    s = re.sub(r"^[\(（]+", "", s)
    s = re.sub(r"[\)）]+$", "", s)
    s = SPACE_RE.sub(" ", s)
    return s


def split_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    if text.startswith("---\n"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            raw = parts[1]
            body = parts[2]
            try:
                data = yaml.safe_load(raw) or {}
                if isinstance(data, dict):
                    return as_jsonable(data), body
            except Exception:
                return {}, body
    return {}, text


def add_node(nodes: list[dict[str, Any]], seen: set[str], node: dict[str, Any]) -> None:
    if node["id"] in seen:
        return
    seen.add(node["id"])
    nodes.append(node)


def edge_key(e: dict[str, Any]) -> tuple[str, str, str, str]:
    return (e["source"], e["target"], e.get("relation", ""), e.get("source_file", ""))


def add_edge(edges_by_key: dict[tuple[str, str, str, str], dict[str, Any]], edge: dict[str, Any]) -> None:
    k = edge_key(edge)
    existing = edges_by_key.get(k)
    if existing:
        existing["weight"] = float(existing.get("weight", 1.0)) + float(edge.get("weight", 1.0))
        existing["reference_count"] = int(existing.get("reference_count", 1)) + int(edge.get("reference_count", 1))
        return
    edges_by_key[k] = edge


def rel_edge(source: str, target: str, relation: str, source_file: str, *, weight: float = 1.0, count: int = 1) -> dict[str, Any]:
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


def node_base(node_id: str, label: str, file_type: str = "document", source_file: str = "") -> dict[str, Any]:
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


def format_law_label(title: str, legal_type: str, law_mst: str, duplicate_title: bool) -> str:
    """Keep common law labels short, but disambiguate historical duplicates."""
    if not duplicate_title:
        return title
    suffix = legal_type or "문서"
    if law_mst:
        suffix = f"{suffix} · MST {law_mst}"
    return f"{title} ({suffix})"


def load_docs() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    md_files = [ROOT / "README.md"] + sorted((ROOT / "kr").glob("*/*.md"))
    docs: list[dict[str, Any]] = []
    topic_counter: Counter[str] = Counter()
    ref_counter: Counter[str] = Counter()
    total_words = 0

    for path in md_files:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        rel = path.relative_to(ROOT).as_posix()
        fm, body = split_frontmatter(text)
        words = len(text.split())
        total_words += words
        topics = [clean_topic(m.group(1)) for m in ARTICLE_RE.finditer(body)]
        topics = [t for t in topics if t]
        refs = [m.group(1).strip() for m in REF_RE.finditer(body)]
        refs = [r for r in refs if r]
        topic_counter.update(topics)
        ref_counter.update(norm_title(r) for r in refs if norm_title(r))
        docs.append({
            "path": path,
            "rel": rel,
            "text": text,
            "body": body,
            "fm": fm,
            "words": words,
            "topics": topics,
            "refs": refs,
        })

    detection = {
        "total_files": len(md_files),
        "total_words": total_words,
        "files": {"document": [d["rel"] for d in docs]},
        "skipped_sensitive": [],
        "warning": f"Large corpus: {len(md_files)} files · ~{total_words:,} words. Deterministic legal-reference extraction used; LLM semantic extraction skipped.",
    }
    return docs, {"topics": topic_counter, "refs": ref_counter, "detection": detection}


def choose_labels(G, communities: dict[int, list[str]]) -> dict[int, str]:
    labels: dict[int, str] = {}
    for cid, members in communities.items():
        ministry_counts: Counter[str] = Counter()
        type_counts: Counter[str] = Counter()
        family_labels: Counter[str] = Counter()
        doc_labels: list[tuple[int, str]] = []
        for nid in members:
            d = G.nodes[nid]
            label = d.get("label", nid)
            if d.get("node_kind") == "ministry":
                ministry_counts[label] += max(1, G.degree(nid))
            elif d.get("node_kind") == "legal_type":
                type_counts[label.replace("법령구분: ", "")] += max(1, G.degree(nid))
            elif d.get("node_kind") == "family":
                family_labels[label] += max(1, G.degree(nid))
            elif d.get("node_kind") == "law_document":
                doc_labels.append((G.degree(nid), label))
        if ministry_counts and ministry_counts.most_common(1)[0][1] >= 5:
            labels[cid] = f"{ministry_counts.most_common(1)[0][0]} 소관 법령"
        elif type_counts and type_counts.most_common(1)[0][1] >= 5:
            labels[cid] = f"{type_counts.most_common(1)[0][0]} 중심 법령"
        elif family_labels:
            labels[cid] = f"{family_labels.most_common(1)[0][0]} 법령군"
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


def main() -> None:
    if not ROOT.exists():
        raise SystemExit(f"missing input: {ROOT}")
    OUT.mkdir(parents=True, exist_ok=True)

    docs, stats = load_docs()
    topic_counter: Counter[str] = stats["topics"]
    ref_counter: Counter[str] = stats["refs"]
    detection = stats["detection"]

    # Limit topic hubs to genuinely shared article headings to avoid 100k+ topic nodes.
    common_topics = {t for t, c in topic_counter.items() if c >= 100}

    nodes: list[dict[str, Any]] = []
    seen_nodes: set[str] = set()
    edges_by_key: dict[tuple[str, str, str, str], dict[str, Any]] = {}

    title_to_docs: dict[str, list[str]] = defaultdict(list)
    path_to_doc: dict[str, str] = {}
    family_to_docs: dict[str, list[dict[str, str]]] = defaultdict(list)
    law_title_counts: Counter[str] = Counter()
    for doc in docs:
        rel = doc["rel"]
        if rel == "README.md":
            continue
        fm = doc["fm"]
        title = str(fm.get("제목") or Path(rel).parent.name)
        law_title_counts[norm_title(title)] += 1

    # README node.
    add_node(nodes, seen_nodes, {
        **node_base("doc_readme", "Legalize KR README", "document", "README.md"),
        "node_kind": "readme",
        "summary": "대한민국 법령 Markdown 저장소 설명 문서",
    })

    # First pass: law document nodes and lookup indexes.
    for doc in docs:
        rel = doc["rel"]
        if rel == "README.md":
            continue
        fm = doc["fm"]
        title = str(fm.get("제목") or Path(rel).parent.name)
        law_id = str(fm.get("법령ID") or "").strip().strip("'")
        law_mst = str(fm.get("법령MST") or "").strip()
        legal_type = str(fm.get("법령구분") or Path(rel).stem)
        family = Path(rel).parent.name
        label = format_law_label(title, legal_type, law_mst, law_title_counts[norm_title(title)] > 1)
        source_url = str(fm.get("출처") or "") or None
        ministries = fm.get("소관부처") or []
        if isinstance(ministries, str):
            ministries = [ministries]
        node_id = stable_id("law", f"{rel}|{law_id}|{law_mst}")
        path_to_doc[rel] = node_id
        title_to_docs[norm_title(title)].append(node_id)
        # Also index no-space path family + file stem variants.
        if legal_type in {"법률", "대통령령", "총리령", "부령", "대법원규칙", "헌법재판소규칙"}:
            title_to_docs[norm_title(family)].append(node_id)
        family_to_docs[family].append({"id": node_id, "rel": rel, "title": title, "type": legal_type})
        body = doc["body"]
        article_count = len(doc["topics"])
        node = {
            **node_base(node_id, label, "document", rel),
            "source_url": source_url,
            "author": ", ".join(map(str, ministries)) if ministries else None,
            "node_kind": "law_document",
            "canonical_title": title,
            "law_id": law_id,
            "law_mst": law_mst,
            "legal_type": legal_type,
            "ministry": ministries,
            "promulgation_date": as_jsonable(fm.get("공포일자")),
            "effective_date": as_jsonable(fm.get("시행일자")),
            "status": fm.get("상태"),
            "legal_field": fm.get("법령분야"),
            "article_count": article_count,
            "word_count": doc["words"],
            "family": family,
        }
        add_node(nodes, seen_nodes, node)

    # Metadata concept nodes + edges.
    for doc in docs:
        rel = doc["rel"]
        if rel == "README.md":
            continue
        src = path_to_doc[rel]
        fm = doc["fm"]
        family = Path(rel).parent.name
        legal_type = str(fm.get("법령구분") or Path(rel).stem)
        ministries = fm.get("소관부처") or []
        if isinstance(ministries, str):
            ministries = [ministries]
        legal_field = str(fm.get("법령분야") or "").strip()

        family_id = stable_id("family", family)
        add_node(nodes, seen_nodes, {**node_base(family_id, f"법령군: {family}", "document", f"kr/{family}/"), "node_kind": "family", "family_name": family})
        add_edge(edges_by_key, rel_edge(src, family_id, "belongs_to_family", rel))

        type_id = stable_id("type", legal_type)
        add_node(nodes, seen_nodes, {**node_base(type_id, f"법령구분: {legal_type}", "document", ""), "node_kind": "legal_type"})
        add_edge(edges_by_key, rel_edge(src, type_id, "has_legal_type", rel))

        for m in ministries:
            m = str(m).strip()
            if not m:
                continue
            mid = stable_id("ministry", m)
            add_node(nodes, seen_nodes, {**node_base(mid, m, "document", ""), "node_kind": "ministry"})
            add_edge(edges_by_key, rel_edge(src, mid, "administered_by", rel))

        if legal_field:
            fid = stable_id("field", legal_field)
            add_node(nodes, seen_nodes, {**node_base(fid, f"법령분야: {legal_field}", "document", ""), "node_kind": "legal_field"})
            add_edge(edges_by_key, rel_edge(src, fid, "in_legal_field", rel))

        # Common article-topic hubs.
        for topic, count in Counter(t for t in doc["topics"] if t in common_topics).items():
            tid = stable_id("topic", topic)
            add_node(nodes, seen_nodes, {
                **node_base(tid, f"조문 주제: {topic}", "document", ""),
                "node_kind": "article_topic",
                "global_count": topic_counter[topic],
            })
            add_edge(edges_by_key, rel_edge(src, tid, "conceptually_related_to", rel, weight=float(count), count=count))

    # Keep README connected without creating a massive corpus hub. The README
    # documents schema/metadata, so low-weight schema links are the right shape.
    for node in list(nodes):
        if node.get("node_kind") in {"legal_type", "legal_field"}:
            add_edge(edges_by_key, rel_edge("doc_readme", node["id"], "documents_schema", "README.md", weight=0.2))

    # Same-family implementing hierarchy.
    for family, entries in family_to_docs.items():
        law_nodes = [e for e in entries if e["rel"].endswith("/법률.md")]
        decree_nodes = [e for e in entries if e["rel"].endswith("/시행령.md") or e["type"] == "대통령령"]
        rule_nodes = [e for e in entries if e["rel"].endswith("/시행규칙.md")]
        for law in law_nodes:
            for child in decree_nodes + rule_nodes:
                if child["id"] != law["id"]:
                    add_edge(edges_by_key, rel_edge(child["id"], law["id"], "implements", child["rel"]))
        for dec in decree_nodes:
            for rule in rule_nodes:
                if rule["id"] != dec["id"]:
                    add_edge(edges_by_key, rel_edge(rule["id"], dec["id"], "implements", rule["rel"]))

    # Explicit 「법령명」 references.
    matched_refs = 0
    unmatched_refs: Counter[str] = Counter()
    for doc in docs:
        rel = doc["rel"]
        if rel == "README.md":
            continue
        src = path_to_doc[rel]
        per_target: Counter[str] = Counter()
        for raw in doc["refs"]:
            nt = norm_title(raw)
            if not nt:
                continue
            targets = title_to_docs.get(nt) or []
            targets = [t for t in set(targets) if t != src]
            if not targets:
                unmatched_refs[nt] += 1
                continue
            for tgt in targets[:4]:  # avoid rare duplicate title fan-out explosions
                per_target[tgt] += 1
                matched_refs += 1
        for tgt, count in per_target.items():
            add_edge(edges_by_key, rel_edge(src, tgt, "references", rel, weight=1.0 + math.log(count, 2), count=count))

    # Add high-signal external law reference nodes for unmatched citation hubs.
    for nt, count in unmatched_refs.most_common(MAX_EXTERNAL_REF_HUBS):
        if count < MIN_EXTERNAL_REF_HUB_COUNT:
            break
        ext_id = stable_id("external_law", nt)
        add_node(nodes, seen_nodes, {
            **node_base(ext_id, f"외부참조: {nt}", "document", ""),
            "node_kind": "external_law_reference",
            "reference_count": count,
        })
    # Connect docs to external hubs only for these high-signal refs.
    external_norms = {n["label"].replace("외부참조: ", ""): n["id"] for n in nodes if n.get("node_kind") == "external_law_reference"}
    external_ref_mentions = 0
    if external_norms:
        for doc in docs:
            rel = doc["rel"]
            if rel == "README.md":
                continue
            src = path_to_doc[rel]
            counts = Counter(norm_title(r) for r in doc["refs"])
            for nt, ext_id in external_norms.items():
                c = counts.get(nt, 0)
                targets = [t for t in set(title_to_docs.get(nt) or []) if t != src]
                if c and not targets:
                    external_ref_mentions += c
                    add_edge(edges_by_key, rel_edge(src, ext_id, "references", rel, weight=1.0 + math.log(c, 2), count=c))
    residual_unmatched_refs = max(0, sum(unmatched_refs.values()) - external_ref_mentions)

    edges = list(edges_by_key.values())
    extraction = {"nodes": nodes, "edges": edges, "hyperedges": [], "input_tokens": 0, "output_tokens": 0}

    (OUT / ".graphify_detect.json").write_text(json.dumps(detection, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / ".graphify_extract.json").write_text(json.dumps(extraction, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / ".graphify_ast.json").write_text(json.dumps({"nodes": [], "edges": [], "hyperedges": [], "input_tokens": 0, "output_tokens": 0}, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / ".graphify_semantic.json").write_text(json.dumps(extraction, ensure_ascii=False, indent=2), encoding="utf-8")

    G = build_from_json(extraction)
    communities = cluster(G)
    for cid, members in communities.items():
        for nid in members:
            if nid in G.nodes:
                G.nodes[nid]["community"] = cid
    cohesion = score_all(G, communities)
    labels = choose_labels(G, communities)
    gods = god_nodes(G)
    surprises = surprising_connections(G, communities)
    questions = suggest_questions(G, communities, labels)

    report = generate(G, communities, cohesion, labels, gods, surprises, detection, {"input": 0, "output": 0}, str(ROOT), suggested_questions=questions)
    # Append a run note so the audit trail is honest about deterministic extraction.
    report += "\n\n## Extraction Mode\n"
    report += "- Deterministic legal-reference extraction: YAML frontmatter, same-family 법률/시행령/시행규칙 hierarchy, common article headings, and explicit `「...」` cross-law citations.\n"
    report += "- LLM semantic extraction was not used for this run; token cost is 0.\n"
    report += f"- Matched explicit references to in-corpus laws: {matched_refs:,}.\n"
    report += f"- External reference hubs: {sum(1 for n in nodes if n.get('node_kind') == 'external_law_reference'):,}; external reference mentions captured: {external_ref_mentions:,}; residual unmatched mentions: {residual_unmatched_refs:,}.\n"

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
    (OUT / ".graphify_analysis.json").write_text(json.dumps(analysis, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / ".graphify_labels.json").write_text(json.dumps({str(k): v for k, v in labels.items()}, ensure_ascii=False, indent=2), encoding="utf-8")

    # HTML: full graph if small, aggregated community graph if too large.
    node_limit = 5000
    if G.number_of_nodes() <= node_limit:
        to_html(G, communities, str(OUT / "graph.html"), community_labels=labels)
        html_mode = "full"
    else:
        import networkx as nx
        node_to_community = {nid: cid for cid, members in communities.items() for nid in members}
        meta = nx.Graph()
        for cid, members in communities.items():
            meta.add_node(str(cid), label=labels.get(cid, f"Community {cid}"))
        edge_counts: Counter[tuple[int, int]] = Counter()
        for u, v in G.edges():
            cu, cv = node_to_community.get(u), node_to_community.get(v)
            if cu is not None and cv is not None and cu != cv:
                edge_counts[(min(cu, cv), max(cu, cv))] += 1
        for (cu, cv), w in edge_counts.items():
            meta.add_edge(str(cu), str(cv), weight=w, relation=f"{w} cross-community edges", confidence="AGGREGATED")
        if meta.number_of_edges() or meta.number_of_nodes():
            meta_communities = {cid: [str(cid)] for cid in communities}
            member_counts = {cid: len(members) for cid, members in communities.items()}
            to_html(meta, meta_communities, str(OUT / "graph.html"), community_labels=labels, member_counts=member_counts)
            html_mode = "aggregated"
        else:
            html_mode = "skipped"

    wiki_count = to_wiki(G, communities, OUT / "wiki", community_labels=labels, cohesion=cohesion, god_nodes_data=gods)

    cost = {
        "runs": [{
            "date": datetime.now().astimezone().isoformat(),
            "input_tokens": 0,
            "output_tokens": 0,
            "files": detection["total_files"],
            "mode": "deterministic_legal_reference",
        }],
        "total_input_tokens": 0,
        "total_output_tokens": 0,
    }
    (OUT / "cost.json").write_text(json.dumps(cost, ensure_ascii=False, indent=2), encoding="utf-8")

    summary = {
        "mode": "deterministic_legal_reference",
        "input_files": detection["total_files"],
        "input_words": detection["total_words"],
        "nodes": G.number_of_nodes(),
        "edges": G.number_of_edges(),
        "communities": len(communities),
        "wiki_articles": wiki_count + 1,
        "html_mode": html_mode,
        "common_topic_hubs": len(common_topics),
        "matched_reference_edges": matched_refs,
        "external_reference_hubs": sum(1 for n in nodes if n.get("node_kind") == "external_law_reference"),
        "external_reference_hub_edges": external_ref_mentions,
        "unmatched_reference_mentions": residual_unmatched_refs,
        "raw_unmatched_reference_mentions": sum(unmatched_refs.values()),
        "output_dir": str(OUT),
    }
    (OUT / "run-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

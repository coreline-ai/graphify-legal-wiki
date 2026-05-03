"""Pre-compute 3D force-directed positions for a graphify graph.json.

For graphs ≤ 20K nodes a single spring_layout(dim=3) call is feasible. Above
that, NetworkX's pure-Python implementation becomes impractical (12+ minutes
on 124K precedent), so we use a multilevel layout:

  1. Coarsen by `community` attribute into a small supergraph
  2. Run spring_layout on the supergraph (cheap)
  3. Run spring_layout on each within-community subgraph
  4. Place each node at `community_center + local_offset`

The script writes x/y/z attributes back into the same `graph.json` (atomic
rename). The backend's `_full_graph_spherical_positions` then prefers these
pre-computed coords when present, skipping its lazy compute.

Usage:
    python dev-plan/scripts/precompute_3d_layout.py data/legalize-kr/graphify-out/graph.json
    python dev-plan/scripts/precompute_3d_layout.py data/precedent-kr/graphify-out/graph.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path
from typing import Any

import networkx as nx
from networkx.readwrite import json_graph


def coarsen_by_community(graph: nx.Graph) -> tuple[nx.Graph, dict[Any, list[Any]]]:
    members: dict[Any, list[Any]] = {}
    for nid, attrs in graph.nodes(data=True):
        cid = attrs.get("community")
        if cid is None:
            cid = f"__solo_{nid}"
        members.setdefault(cid, []).append(nid)

    super_g: nx.Graph = nx.Graph()
    super_g.add_nodes_from(members.keys())

    for u, v, data in graph.edges(data=True):
        cu = graph.nodes[u].get("community")
        cv = graph.nodes[v].get("community")
        cu = cu if cu is not None else f"__solo_{u}"
        cv = cv if cv is not None else f"__solo_{v}"
        if cu == cv:
            continue
        weight = float(data.get("weight", 1.0) or 1.0)
        if super_g.has_edge(cu, cv):
            super_g[cu][cv]["weight"] += weight
        else:
            super_g.add_edge(cu, cv, weight=weight)
    return super_g, members


def layout_internal(
    graph: nx.Graph,
    members: list[Any],
    community_radius: float,
    *,
    iterations: int,
    seed: int,
) -> dict[Any, tuple[float, float, float]]:
    if len(members) == 1:
        return {members[0]: (0.0, 0.0, 0.0)}

    sub = graph.subgraph(members)
    if sub.number_of_edges() == 0:
        # No internal edges: spread on a small sphere around the center.
        positions: dict[Any, tuple[float, float, float]] = {}
        golden = math.pi * (3 - math.sqrt(5))
        for i, nid in enumerate(members):
            frac = (i + 0.5) / len(members)
            y_unit = max(-0.99, min(0.99, 1.0 - 2.0 * frac))
            lat_r = math.sqrt(max(0.0, 1.0 - y_unit * y_unit))
            theta = i * golden
            positions[nid] = (
                math.cos(theta) * lat_r * community_radius,
                y_unit * community_radius,
                math.sin(theta) * lat_r * community_radius,
            )
        return positions

    # Boost intra-community edges (already filtered to within community here so
    # this is a uniform pull, just normalize).
    weighted = nx.Graph()
    weighted.add_nodes_from(sub.nodes())
    for u, v, data in sub.edges(data=True):
        weighted.add_edge(u, v, weight=float(data.get("weight", 1.0) or 1.0))

    n = weighted.number_of_nodes()
    k = max(2.5 / math.sqrt(max(n, 1)), 0.045)
    pos = nx.spring_layout(
        weighted,
        dim=3,
        seed=seed,
        iterations=iterations,
        k=k,
        scale=community_radius,
        weight="weight",
    )
    return {nid: (float(p[0]), float(p[1]), float(p[2])) for nid, p in pos.items()}


def multilevel_layout(graph: nx.Graph, *, super_scale: float = 720.0, seed: int = 42) -> dict[Any, tuple[float, float, float]]:
    super_g, members = coarsen_by_community(graph)
    print(f"  coarsened: {super_g.number_of_nodes()} super-nodes, {super_g.number_of_edges()} super-edges", flush=True)

    # Layout the supergraph: small N (one node per community), use generous iterations.
    if super_g.number_of_nodes() == 1:
        # Single community → place center at origin; full layout is just internal.
        super_pos = {next(iter(super_g.nodes)): (0.0, 0.0, 0.0)}
    else:
        super_n = super_g.number_of_nodes()
        super_k = max(2.5 / math.sqrt(super_n), 0.18)
        sp = nx.spring_layout(
            super_g,
            dim=3,
            seed=seed,
            iterations=200,
            k=super_k,
            scale=super_scale,
            weight="weight",
        )
        super_pos = {cid: (float(p[0]), float(p[1]), float(p[2])) for cid, p in sp.items()}

    # Per-community internal layout, scaled to a fraction of supernode spacing.
    avg_spacing = (
        math.sqrt(4.0 * math.pi * super_scale * super_scale / max(super_g.number_of_nodes(), 1))
        if super_g.number_of_nodes() > 1
        else super_scale
    )
    base_internal_radius = max(50.0, avg_spacing * 0.32)

    positions: dict[Any, tuple[float, float, float]] = {}
    sorted_communities = sorted(members.items(), key=lambda kv: -len(kv[1]))
    print(f"  laying out {len(sorted_communities)} communities (largest = {len(sorted_communities[0][1])} nodes)", flush=True)

    for community_index, (cid, member_ids) in enumerate(sorted_communities):
        size = len(member_ids)
        # Larger communities get bigger internal radius so density stays even.
        internal_radius = base_internal_radius * max(0.5, math.sqrt(size / max(len(member_ids[:1]), 1)))
        internal_radius = min(internal_radius, avg_spacing * 0.45)
        # Iteration count scales down with community size to bound total cost.
        if size <= 200:
            iters = 80
        elif size <= 1500:
            iters = 50
        elif size <= 5000:
            iters = 30
        else:
            iters = 20

        t0 = time.time()
        try:
            local = layout_internal(graph, member_ids, internal_radius, iterations=iters, seed=seed + community_index)
        except Exception as exc:  # noqa: BLE001 — fallback path keeps the script running
            print(f"    community {cid} ({size} nodes): internal layout failed ({type(exc).__name__}); using sphere fallback", flush=True)
            local = layout_internal(graph, member_ids, internal_radius, iterations=0, seed=seed)

        center = super_pos.get(cid, (0.0, 0.0, 0.0))
        for nid in member_ids:
            lx, ly, lz = local.get(nid, (0.0, 0.0, 0.0))
            positions[nid] = (
                round(center[0] + lx, 3),
                round(center[1] + ly, 3),
                round(center[2] + lz, 3),
            )

        if community_index < 5 or community_index % 10 == 0:
            print(f"    community {cid} ({size} nodes, iter={iters}): {time.time() - t0:.1f}s", flush=True)

    return positions


def single_pass_layout(graph: nx.Graph, *, scale: float = 720.0, seed: int = 42) -> dict[Any, tuple[float, float, float]]:
    n = graph.number_of_nodes()
    k = max(2.5 / math.sqrt(max(n, 1)), 0.045)
    print(f"  spring_layout(dim=3, iterations=80, k={k:.4f}) on {n} nodes...", flush=True)
    pos = nx.spring_layout(graph, dim=3, seed=seed, iterations=80, k=k, scale=scale, weight="weight")
    return {nid: (round(float(p[0]), 3), round(float(p[1]), 3), round(float(p[2]), 3)) for nid, p in pos.items()}


def load_graph(path: Path) -> tuple[dict[str, Any], nx.Graph]:
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    edges_key = "edges" if "edges" in data else "links"
    graph = json_graph.node_link_graph(data, edges=edges_key)
    return data, graph


def write_graph(data: dict[str, Any], positions: dict[Any, tuple[float, float, float]], target: Path) -> None:
    nodes_key = "nodes"
    for node in data.get(nodes_key, []):
        nid = node.get("id")
        if nid in positions:
            x, y, z = positions[nid]
            node["x"] = x
            node["y"] = y
            node["z"] = z
    tmp = target.with_suffix(target.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)
    os.replace(tmp, target)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("graph_path", help="path to graphify-out/graph.json")
    parser.add_argument("--threshold", type=int, default=20_000, help="multilevel above this node count")
    parser.add_argument("--scale", type=float, default=720.0)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    path = Path(args.graph_path)
    if not path.exists():
        print(f"not found: {path}", file=sys.stderr)
        return 2

    print(f"loading {path}...", flush=True)
    t0 = time.time()
    data, graph = load_graph(path)
    print(f"  {graph.number_of_nodes()} nodes / {graph.number_of_edges()} edges in {time.time() - t0:.1f}s", flush=True)

    if graph.number_of_nodes() <= args.threshold:
        print("running single-pass spring_layout...", flush=True)
        t0 = time.time()
        positions = single_pass_layout(graph, scale=args.scale, seed=args.seed)
        print(f"  done in {time.time() - t0:.1f}s", flush=True)
    else:
        print("running multilevel layout (community supergraph + per-community subgraphs)...", flush=True)
        t0 = time.time()
        positions = multilevel_layout(graph, super_scale=args.scale, seed=args.seed)
        print(f"  done in {time.time() - t0:.1f}s", flush=True)

    print(f"writing {len(positions)} positions back to {path}...", flush=True)
    t0 = time.time()
    write_graph(data, positions, path)
    print(f"  done in {time.time() - t0:.1f}s", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

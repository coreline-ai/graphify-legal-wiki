import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { EdgeMode, GraphNodeDTO, GraphPayloadDTO } from '../api/types';
import { ensureCanvasBackingStore } from '../utils/canvas2dRenderer';
import { communityColorHex, edgeVisualColor, edgeVisualOpacity, edgeVisualWidth, graphStats, isFocusEdge, layoutGraph } from '../utils/graphLayout';
import type { LayoutGraphResult } from '../utils/graphLayout';

interface GraphFallbackProps {
  title: string;
  payload: GraphPayloadDTO | null;
  emptyText: string;
  edgeMode?: EdgeMode;
  onEdgeModeChange?: (mode: EdgeMode) => void;
  selectedNodeId?: string;
  onSelectNode?: (node: GraphNodeDTO) => void;
  onExpandNode?: (node: GraphNodeDTO) => void;
  loading?: boolean;
  edgeStrength?: number;
}

const LARGE_2D_NODE_THRESHOLD = 700;
const LARGE_2D_EDGE_THRESHOLD = 2500;
const LARGE_2D_EDGE_RENDER_LIMIT = 10000;
const CANVAS_WIDTH = 980;
const CANVAS_HEIGHT = 580;

function shouldUseCanvas2d(payload: GraphPayloadDTO): boolean {
  return payload.nodes.length > LARGE_2D_NODE_THRESHOLD || payload.edges.length > LARGE_2D_EDGE_THRESHOLD;
}

function LargeGraphCanvas({
  title,
  layout,
  selectedNodeId,
  onSelectNode,
  edgeStrength,
}: {
  title: string;
  layout: LayoutGraphResult;
  selectedNodeId?: string;
  onSelectNode?: (node: GraphNodeDTO) => void;
  edgeStrength: number;
}) {
  const stackRef = useRef<HTMLDivElement | null>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const selectionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hitTestNode = (event: ReactPointerEvent<HTMLDivElement>): GraphNodeDTO | null => {
    const stack = stackRef.current;
    if (!stack) return null;
    const rect = stack.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * CANVAS_WIDTH;
    const y = ((event.clientY - rect.top) / Math.max(rect.height, 1)) * CANVAS_HEIGHT;
    let nearest: GraphNodeDTO | null = null;
    let nearestDistance = 10;
    for (const node of layout.nodes) {
      const radius = layout.nodes.length > 1000 ? Math.min(4.2, Math.max(2.4, node.radius * 0.34)) : Math.min(8, node.radius);
      const distance = Math.hypot(node.px - x, node.py - y);
      if (distance <= Math.max(8, radius + 4) && distance < nearestDistance) {
        nearest = node;
        nearestDistance = distance;
      }
    }
    return nearest;
  };

  useLayoutEffect(() => {
    const canvas = baseCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const { dpr } = ensureCanvasBackingStore(canvas, CANVAS_WIDTH, CANVAS_HEIGHT, window.devicePixelRatio);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    context.lineCap = 'round';

    for (const edge of layout.edges) {
      context.globalAlpha = edgeVisualOpacity(edge, layout.edges.length, edgeStrength);
      context.strokeStyle = edgeVisualColor(edge);
      context.lineWidth = Math.max(0.35, Math.min(1.8, edgeVisualWidth(edge, edgeStrength)));
      context.beginPath();
      context.moveTo(edge.sourceNode.px, edge.sourceNode.py);
      context.lineTo(edge.targetNode.px, edge.targetNode.py);
      context.stroke();
    }

    context.globalAlpha = 0.96;
    for (const node of layout.nodes) {
      const radius = layout.nodes.length > 1000 ? Math.min(4.2, Math.max(2.4, node.radius * 0.34)) : Math.min(8, node.radius);
      context.fillStyle = communityColorHex(node.community);
      context.beginPath();
      context.arc(node.px, node.py, radius, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  }, [edgeStrength, layout]);

  useLayoutEffect(() => {
    const canvas = selectionCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const { dpr } = ensureCanvasBackingStore(canvas, CANVAS_WIDTH, CANVAS_HEIGHT, window.devicePixelRatio);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    const selectedNode = selectedNodeId ? layout.nodes.find((node) => node.id === selectedNodeId) : null;
    if (selectedNode) {
      for (const edge of layout.edges) {
        if (!isFocusEdge(edge, selectedNode.id)) continue;
        context.globalAlpha = Math.min(1, 0.86 * edgeStrength);
        context.strokeStyle = '#f4eaff';
        context.lineWidth = Math.max(1.1, Math.min(4, edgeVisualWidth(edge, edgeStrength) + 0.8));
        context.beginPath();
        context.moveTo(edge.sourceNode.px, edge.sourceNode.py);
        context.lineTo(edge.targetNode.px, edge.targetNode.py);
        context.stroke();
      }
    }
    if (selectedNode) {
      context.globalAlpha = 1;
      context.strokeStyle = '#a882ff';
      context.lineWidth = 3;
      context.beginPath();
      context.arc(selectedNode.px, selectedNode.py, 9, 0, Math.PI * 2);
      context.stroke();
    }
    context.globalAlpha = 1;
  }, [edgeStrength, layout, selectedNodeId]);

  return (
    <div className="lg-graph-svg" role="img" aria-label={`${title}: canvas 2D renderer for ${layout.nodes.length} nodes, ${layout.edges.length} rendered edges`}>
      <div
        ref={stackRef}
        className="lg-graph-canvas-stack"
        onPointerDown={(event) => {
          const node = hitTestNode(event);
          if (node) onSelectNode?.(node);
        }}
      >
        <canvas
          ref={baseCanvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          aria-hidden="true"
        />
        <canvas
          ref={selectionCanvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          aria-label={`${title} canvas node picker`}
        />
      </div>
    </div>
  );
}

export function GraphFallback({
  title,
  payload,
  emptyText,
  edgeMode = 'focus',
  onEdgeModeChange,
  selectedNodeId,
  onSelectNode,
  onExpandNode,
  loading = false,
  edgeStrength = 1,
}: GraphFallbackProps) {
  const [showLabels, setShowLabels] = useState(false);
  const [query, setQuery] = useState('');
  const filteredPayload = useMemo<GraphPayloadDTO | null>(() => {
    if (!payload) return null;
    if (!query.trim()) return payload;
    const normalized = query.trim().toLowerCase();
    const nodes = payload.nodes.filter((node) => node.label.toLowerCase().includes(normalized) || node.id.toLowerCase().includes(normalized));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = payload.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
    return { ...payload, nodes, edges };
  }, [payload, query]);

  const useCanvas2d = Boolean(filteredPayload && shouldUseCanvas2d(filteredPayload));
  const layout = useMemo(
    () => (filteredPayload ? layoutGraph(filteredPayload, CANVAS_WIDTH, CANVAS_HEIGHT, edgeMode, useCanvas2d ? LARGE_2D_EDGE_RENDER_LIMIT : Number.POSITIVE_INFINITY) : null),
    [filteredPayload, edgeMode, useCanvas2d],
  );
  const selectedNode = layout?.nodes.find((node) => node.id === selectedNodeId);
  const selectedIsCommunity = selectedNode?.id.startsWith('community-') ?? false;
  const selectedGodNodes = Array.isArray(selectedNode?.metadata?.god_nodes)
    ? selectedNode.metadata.god_nodes.slice(0, 3).map(String)
    : [];
  const selectNodeIfChanged = (node: GraphNodeDTO) => {
    if (node.id === selectedNodeId) return;
    onSelectNode?.(node);
  };

  return (
    <section className="lg-graph-viewport" data-edge-mode={edgeMode} aria-label={title}>
      <div className="lg-graph-toolbar" aria-label={`${title} toolbar`}>
        <div className="lg-graph-toolbar__group">
          <label className="lg-search-label">
            <span className="sr-only">노드 검색</span>
            <input
              className="lg-input lg-graph-search"
              type="search"
              placeholder="Search node"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && filteredPayload?.nodes[0]) {
                  event.preventDefault();
                  selectNodeIfChanged(filteredPayload.nodes[0]);
                }
              }}
              aria-label="노드 검색"
            />
          </label>
          <select
            className="lg-select"
            value={edgeMode}
            onChange={(event) => onEdgeModeChange?.(event.target.value as EdgeMode)}
            aria-label="Edge 표시 모드"
          >
            <option value="hidden">Edges hidden</option>
            <option value="focus">Focus edges</option>
            <option value="all">All edges</option>
          </select>
          <button
            type="button"
            className="lg-button"
            aria-label={showLabels ? '노드 라벨 숨기기' : '노드 라벨 보이기'}
            onClick={() => setShowLabels((value) => !value)}
          >
            Labels {showLabels ? 'on' : 'off'}
          </button>
        </div>
        <div className="lg-graph-toolbar__group lg-graph-toolbar__meta" aria-live="polite">
          <span className="lg-chip" data-tone="accent">{useCanvas2d ? 'Canvas 2D fallback' : 'DOM/SVG fallback'}</span>
          <span className="lg-chip">{filteredPayload ? graphStats(filteredPayload) : 'no graph loaded'}</span>
          {useCanvas2d && layout ? <span className="lg-chip">rendered {layout.edges.length.toLocaleString()} links</span> : null}
        </div>
      </div>

      {loading ? <div className="lg-graph-overlay" role="status">그래프 payload 로딩 중…</div> : null}

      {!layout || layout.nodes.length === 0 ? (
        <div className="lg-empty-state">
          <strong>{emptyText}</strong>
          <span>backend slim API 응답을 기다립니다. 전체 graph.json은 직접 가져오지 않습니다.</span>
        </div>
      ) : useCanvas2d ? (
        <LargeGraphCanvas title={title} layout={layout} selectedNodeId={selectedNodeId} onSelectNode={selectNodeIfChanged} edgeStrength={edgeStrength} />
      ) : (
        <svg className="lg-graph-svg" viewBox="0 0 980 580" role="img" aria-label={`${title}: ${layout.nodes.length} nodes, ${layout.edges.length} visible edges`}>
          <defs>
            <filter id="selectedGlow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <g className="lg-graph-edges" aria-hidden="true">
            {layout.edges.map((edge) => (
              <line
                key={edge.id ?? `${edge.source}-${edge.target}`}
                x1={edge.sourceNode.px}
                y1={edge.sourceNode.py}
                x2={edge.targetNode.px}
                y2={edge.targetNode.py}
                stroke="var(--lg-text-muted)"
                strokeOpacity={edge.opacity}
                strokeWidth={edge.width}
                strokeDasharray={edge.dashed ? '4 5' : undefined}
              />
            ))}
          </g>
          <g className="lg-graph-nodes">
            {layout.nodes.map((node) => {
              const isSelected = node.id === selectedNodeId;
              return (
                <g
                  key={node.id}
                  className="lg-graph-node"
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.label} node 선택`}
                  data-selected={isSelected}
                  transform={`translate(${node.px} ${node.py})`}
                  onClick={() => selectNodeIfChanged(node)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      selectNodeIfChanged(node);
                    }
                  }}
                >
                  <circle
                    r={isSelected ? node.radius + 4 : node.radius}
                    fill={node.colorVar}
                    fillOpacity={node.source_file || node.path ? 0.92 : 0.52}
                    stroke={isSelected ? 'var(--lg-accent)' : 'var(--lg-border)'}
                    strokeWidth={isSelected ? 2.5 : 1}
                    filter={isSelected ? 'url(#selectedGlow)' : undefined}
                  />
                  {(showLabels || isSelected) && (
                    <text x={node.radius + 7} y="4" className="lg-graph-label">
                      {node.label.slice(0, 38)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      )}

      {selectedNode ? (
        <div className="lg-graph-selection lg-card">
          <strong>{selectedNode.label}</strong>
          <span>Community {selectedNode.community ?? '—'} · degree {selectedNode.degree ?? '—'}</span>
          {selectedIsCommunity ? (
            <>
              <span>members {String(selectedNode.metadata?.member_count ?? selectedNode.degree ?? '—')} · edges {String(selectedNode.metadata?.edge_count ?? '—')}</span>
              {selectedGodNodes.length ? <code>top: {selectedGodNodes.join(', ')}</code> : null}
            </>
          ) : (
            <button type="button" className="lg-button" onClick={() => onExpandNode?.(selectedNode)} aria-label={`${selectedNode.label} 주변 subgraph 확장`}>
              주변 subgraph 확장
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
}

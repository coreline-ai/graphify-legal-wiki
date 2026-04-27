import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, MutableRefObject } from 'react';
import type { ForceGraphMethods, ForceGraphProps, LinkObject, NodeObject } from 'react-force-graph-3d';
import type { Material } from 'three';
import type { EdgeMode, EvidenceItem, GraphEdgeDTO, GraphNodeDTO, GraphPayloadDTO } from '../api/types';
import {
  edgeColor,
  edgeOpacity,
  edgeWidth,
  graphStats,
  nodeWebGLValue,
  toWebGLGraphData,
  visibleEdgesForMode,
} from '../utils/graphLayout';
import { shouldShowGraphSelection, type GraphRenderMode } from '../utils/graphViewState';
import { EvidenceCard } from './EvidenceCard';
import { GraphFallback } from './GraphFallback';
import { StaticBufferGraph } from './StaticBufferGraph';

type WebGLNode = NodeObject<GraphNodeDTO> & {
  id: string;
  label: string;
  community?: GraphNodeDTO['community'];
  degree?: GraphNodeDTO['degree'];
  source_file?: string;
  path?: string;
  val: number;
  color: string;
  raw: GraphNodeDTO;
};

type WebGLLink = LinkObject<WebGLNode, GraphEdgeDTO> & {
  id: string;
  source: string | WebGLNode;
  target: string | WebGLNode;
  relation?: string;
  confidence?: GraphEdgeDTO['confidence'];
  weight?: number | null;
  width: number;
  opacity: number;
  color: string;
  raw: GraphEdgeDTO;
};

type ForceGraph3DComponent = ComponentType<
  ForceGraphProps<WebGLNode, WebGLLink> & {
    ref?: MutableRefObject<ForceGraphMethods<WebGLNode, WebGLLink> | undefined>;
  }
>;

type LineBasicMaterialConstructor = new (parameters?: {
  color?: string;
  transparent?: boolean;
  opacity?: number;
  linewidth?: number;
  depthWrite?: boolean;
}) => Material;

type RefreshableForceGraphMethods = ForceGraphMethods<WebGLNode, WebGLLink> & {
  refresh?: () => void;
};

type GraphDimensions = {
  width: number;
  height: number;
};

type PerformanceProfile = 'auto' | 'normal' | 'large';

type RendererPerformanceSettings = {
  nodeResolution: number;
  nodeOpacity: number;
  linkOpacity: number;
  linkMaterialOpacityMultiplier: number;
  cooldownTicks: number;
  cooldownTime: number;
  d3VelocityDecay: number;
  refreshDelayMs: number;
};

const FALLBACK_GRAPH_DIMENSIONS: GraphDimensions = { width: 320, height: 420 };
const LARGE_GRAPH_NODE_THRESHOLD = 1500;
const LARGE_GRAPH_LINK_THRESHOLD = 3000;

const NORMAL_RENDERER_SETTINGS: RendererPerformanceSettings = {
  nodeResolution: 14,
  nodeOpacity: 0.92,
  linkOpacity: 0.62,
  linkMaterialOpacityMultiplier: 1,
  cooldownTicks: 160,
  cooldownTime: 8000,
  d3VelocityDecay: 0.36,
  refreshDelayMs: 120,
};

const LARGE_RENDERER_SETTINGS: RendererPerformanceSettings = {
  nodeResolution: 5,
  nodeOpacity: 0.82,
  linkOpacity: 0.24,
  linkMaterialOpacityMultiplier: 0.35,
  cooldownTicks: 45,
  cooldownTime: 2200,
  d3VelocityDecay: 0.55,
  refreshDelayMs: 240,
};

function normalizeGraphDimensions(width: number, height: number): GraphDimensions {
  return {
    width: width > 0 ? Math.floor(width) : FALLBACK_GRAPH_DIMENSIONS.width,
    height: height > 0 ? Math.floor(height) : FALLBACK_GRAPH_DIMENSIONS.height,
  };
}

interface WebGLGraphProps {
  title: string;
  payload: GraphPayloadDTO | null;
  emptyText: string;
  edgeMode?: EdgeMode;
  onEdgeModeChange?: (mode: EdgeMode) => void;
  selectedNodeId?: string;
  onSelectNode?: (node: GraphNodeDTO) => void;
  onExpandNode?: (node: GraphNodeDTO) => void;
  evidenceItems?: EvidenceItem[];
  onSelectEvidence?: (evidence: EvidenceItem) => void;
  loading?: boolean;
  loadingLabel?: string;
  performanceProfile?: PerformanceProfile;
  edgeStrength?: number;
  onEdgeStrengthChange?: (value: number) => void;
}

function isWebGLAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
  } catch {
    return false;
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nodeSource(node: GraphNodeDTO | null): string {
  return node?.source_file || node?.path || 'source 없음';
}

function nodeLabelHtml(node: WebGLNode): string {
  return [
    `<strong>${escapeHtml(node.label || node.id)}</strong>`,
    `community: ${escapeHtml(node.community ?? '—')}`,
    `degree: ${escapeHtml(node.degree ?? '—')}`,
    `source: ${escapeHtml(nodeSource(node.raw))}`,
  ].join('<br />');
}

function linkLabelHtml(link: WebGLLink): string {
  return [
    `<strong>${escapeHtml(link.relation || 'edge')}</strong>`,
    `confidence: ${escapeHtml(link.confidence ?? 'UNKNOWN')}`,
    `weight: ${escapeHtml(link.weight ?? 1)}`,
  ].join('<br />');
}

function inspectableNode(node: WebGLNode | GraphNodeDTO | null | undefined): GraphNodeDTO | null {
  if (!node) return null;
  return 'raw' in node && node.raw ? node.raw : (node as GraphNodeDTO);
}

function layoutModeChipLabel(layoutMode: GraphPayloadDTO['layout_mode'] | undefined): string {
  if (!layoutMode) return '';
  if (layoutMode === 'circular') return 'layout circular static';
  if (layoutMode === 'spherical') return 'layout spherical 3D';
  return `layout ${layoutMode}`;
}

export function WebGLGraph({
  title,
  payload,
  emptyText,
  edgeMode = 'focus',
  onEdgeModeChange,
  selectedNodeId,
  onSelectNode,
  onExpandNode,
  evidenceItems = [],
  onSelectEvidence,
  loading = false,
  loadingLabel,
  performanceProfile = 'auto',
  edgeStrength = 1,
  onEdgeStrengthChange,
}: WebGLGraphProps) {
  const graphRef = useRef<ForceGraphMethods<WebGLNode, WebGLLink> | undefined>(undefined);
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const materialCache = useRef<Map<string, Material>>(new Map());
  const largeGraphRefreshKeyRef = useRef('');
  const [ForceGraph3D, setForceGraph3D] = useState<ForceGraph3DComponent | null>(null);
  const [LineBasicMaterial, setLineBasicMaterial] = useState<LineBasicMaterialConstructor | null>(null);
  const [webglSupported, setWebglSupported] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [hoverNode, setHoverNode] = useState<GraphNodeDTO | null>(null);
  const [localSelectedNode, setLocalSelectedNode] = useState<GraphNodeDTO | null>(null);
  const [renderMode, setRenderMode] = useState<GraphRenderMode>('3d');
  const [paused, setPaused] = useState(false);
  const [engineState, setEngineState] = useState<'warming' | 'cooling' | 'cooled'>('warming');
  const [graphDimensions, setGraphDimensions] = useState<GraphDimensions>(FALLBACK_GRAPH_DIMENSIONS);

  const filteredPayload = useMemo<GraphPayloadDTO | null>(() => {
    if (!payload) return null;
    if (!query.trim()) return payload;
    const normalized = query.trim().toLowerCase();
    const nodes = payload.nodes.filter((node) => node.label.toLowerCase().includes(normalized) || node.id.toLowerCase().includes(normalized));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = payload.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
    return { ...payload, nodes, edges };
  }, [payload, query]);

  useEffect(() => {
    setWebglSupported(isWebGLAvailable());
  }, []);


  const hasStaticLayout = useMemo(
    () => Boolean(filteredPayload?.nodes.length && filteredPayload.nodes.every((node) => typeof node.x === 'number' && typeof node.y === 'number' && typeof node.z === 'number')),
    [filteredPayload],
  );

  useEffect(() => {
    const hasPayloadStaticLayout = Boolean(
      payload?.nodes.length &&
        payload.nodes.every((node) => typeof node.x === 'number' && typeof node.y === 'number' && typeof node.z === 'number'),
    );
    if (performanceProfile === 'large' && hasPayloadStaticLayout) {
      setRenderMode('3d');
    }
  }, [payload, performanceProfile]);

  const staticLayoutCandidate = Boolean(renderMode === '3d' && filteredPayload && hasStaticLayout && performanceProfile === 'large');
  const graphData = useMemo(() => (filteredPayload && !staticLayoutCandidate ? toWebGLGraphData(filteredPayload, edgeMode) : null), [filteredPayload, edgeMode, staticLayoutCandidate]);
  const isLargeGraph = useMemo(() => {
    if (staticLayoutCandidate) return true;
    if (performanceProfile === 'large') return true;
    if (performanceProfile === 'normal') return false;
    return Boolean(graphData && (graphData.nodes.length > LARGE_GRAPH_NODE_THRESHOLD || graphData.links.length > LARGE_GRAPH_LINK_THRESHOLD));
  }, [graphData, performanceProfile, staticLayoutCandidate]);
  const rendererSettings = isLargeGraph ? LARGE_RENDERER_SETTINGS : NORMAL_RENDERER_SETTINGS;
  const shouldUseStaticRenderer = Boolean(staticLayoutCandidate || (renderMode === '3d' && filteredPayload && hasStaticLayout && graphData && graphData.links.length > LARGE_GRAPH_LINK_THRESHOLD));
  const visibleLinkCount = useMemo(() => {
    if (!filteredPayload) return 0;
    return shouldUseStaticRenderer ? visibleEdgesForMode(filteredPayload, edgeMode).length : graphData?.links.length ?? 0;
  }, [edgeMode, filteredPayload, graphData, shouldUseStaticRenderer]);
  const graphRefreshKey = graphData ? `${title}:${edgeMode}:${graphData.nodes.length}:${graphData.links.length}:${performanceProfile}` : '';

  useEffect(() => {
    if (webglSupported !== true || ForceGraph3D || loadError || renderMode !== '3d' || shouldUseStaticRenderer || !filteredPayload?.nodes.length) return;
    let cancelled = false;

    Promise.all([import('react-force-graph-3d'), import('three')])
      .then(([graphModule, threeModule]) => {
        if (cancelled) return;
        setForceGraph3D(() => graphModule.default as ForceGraph3DComponent);
        setLineBasicMaterial(() => threeModule.LineBasicMaterial as LineBasicMaterialConstructor);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : '3D renderer module load failed');
      });

    return () => {
      cancelled = true;
    };
  }, [ForceGraph3D, filteredPayload, loadError, renderMode, shouldUseStaticRenderer, webglSupported]);
  const selectedNode = useMemo(() => {
    const fromHover = hoverNode;
    if (fromHover) return fromHover;
    if (localSelectedNode?.id === selectedNodeId) return localSelectedNode;
    return filteredPayload?.nodes.find((node) => node.id === selectedNodeId) ?? localSelectedNode;
  }, [filteredPayload, hoverNode, localSelectedNode, selectedNodeId]);

  useEffect(() => {
    largeGraphRefreshKeyRef.current = '';
  }, [graphData]);

  useEffect(() => {
    if (renderMode !== '3d' || !ForceGraph3D || !graphData) return;
    const container = canvasContainerRef.current;
    if (!container) return;

    let animationFrameId: number | null = null;

    const measureContainer = () => {
      if (animationFrameId !== null) return;
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        const rect = container.getBoundingClientRect();
        const nextDimensions = normalizeGraphDimensions(rect.width, rect.height);
        setGraphDimensions((currentDimensions) => {
          if (currentDimensions.width === nextDimensions.width && currentDimensions.height === nextDimensions.height) {
            return currentDimensions;
          }
          return nextDimensions;
        });
      });
    };

    measureContainer();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measureContainer);
      return () => {
        if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
        window.removeEventListener('resize', measureContainer);
      };
    }

    const resizeObserver = new ResizeObserver(measureContainer);
    resizeObserver.observe(container);

    return () => {
      if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
    };
  }, [ForceGraph3D, graphData, renderMode]);

  useEffect(() => {
    if (renderMode !== '3d' || !ForceGraph3D || !graphData) return;
    if (isLargeGraph && largeGraphRefreshKeyRef.current === graphRefreshKey) return;
    const timeoutId = window.setTimeout(() => {
      const graph = graphRef.current as RefreshableForceGraphMethods | undefined;
      if (!graph) return;
      try {
        graph.refresh?.();
        if (isLargeGraph) {
          largeGraphRefreshKeyRef.current = graphRefreshKey;
          return;
        }
        graph.zoomToFit(650, 64);
      } catch {
        // Renderer resize/zoom is best-effort while the WebGL canvas settles.
      }
    }, rendererSettings.refreshDelayMs);

    return () => window.clearTimeout(timeoutId);
  }, [ForceGraph3D, graphData, graphDimensions.height, graphDimensions.width, graphRefreshKey, isLargeGraph, renderMode, rendererSettings.refreshDelayMs]);

  const linkMaterial = useCallback(
    (link: WebGLLink): Material | boolean | null => {
      if (!LineBasicMaterial) return null;
      const baseOpacity = link.opacity ?? edgeOpacity(link.raw);
      const opacityBase = isLargeGraph ? Math.min(baseOpacity * rendererSettings.linkMaterialOpacityMultiplier, rendererSettings.linkOpacity) : baseOpacity;
      const opacity = Math.min(1, opacityBase * edgeStrength);
      const width = (link.width ?? edgeWidth(link.raw)) * Math.max(0.65, Math.min(1.8, edgeStrength));
      const color = link.color ?? edgeColor(link.raw);
      const key = `${color}:${opacity}:${width}`;
      const cached = materialCache.current.get(key);
      if (cached) return cached;
      const material = new LineBasicMaterial({
        color,
        transparent: opacity < 1,
        opacity,
        linewidth: width,
        depthWrite: false,
      });
      materialCache.current.set(key, material);
      return material;
    },
    [LineBasicMaterial, edgeStrength, isLargeGraph, rendererSettings.linkMaterialOpacityMultiplier, rendererSettings.linkOpacity],
  );

  const focusCameraOnNode = useCallback((node: Partial<WebGLNode>, raw: GraphNodeDTO) => {
    const distance = 160 + Math.max(0, nodeWebGLValue(raw)) * 3;
    const x = typeof node.x === 'number' ? node.x : 0;
    const y = typeof node.y === 'number' ? node.y : 0;
    const z = typeof node.z === 'number' ? node.z : 0;
    try {
      graphRef.current?.cameraPosition({ x: x + distance, y: y + distance * 0.45, z: z + distance }, { x, y, z }, 650);
    } catch {
      // Camera controls are best-effort; selection still works if the renderer rejects the call.
    }
  }, []);

  const handleNodeClick = useCallback(
    (node: WebGLNode) => {
      const raw = inspectableNode(node);
      if (!raw) return;
      setLocalSelectedNode(raw);
      if (raw.id !== selectedNodeId) onSelectNode?.(raw);
      focusCameraOnNode(node, raw);
    },
    [focusCameraOnNode, onSelectNode, selectedNodeId],
  );

  const focusSearchResult = useCallback(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized || !filteredPayload?.nodes.length) return;
    const raw =
      filteredPayload.nodes.find((node) => node.id.toLowerCase() === normalized || node.label.toLowerCase() === normalized) ??
      filteredPayload.nodes[0];
    const rendered = graphData?.nodes.find((node) => node.id === raw.id);
    setLocalSelectedNode(raw);
    if (raw.id !== selectedNodeId) onSelectNode?.(raw);
    if (rendered && renderMode === '3d') focusCameraOnNode(rendered, raw);
  }, [filteredPayload, focusCameraOnNode, graphData, onSelectNode, query, renderMode, selectedNodeId]);

  const togglePause = useCallback(() => {
    if (!graphRef.current) return;
    if (paused) {
      graphRef.current.resumeAnimation();
      graphRef.current.d3ReheatSimulation();
      setEngineState('warming');
      setPaused(false);
    } else {
      graphRef.current.pauseAnimation();
      setPaused(true);
    }
  }, [paused]);

  const zoomToFit = useCallback(() => {
    try {
      graphRef.current?.zoomToFit(650, 64);
    } catch {
      // Safe no-op for renderer states that are not ready yet.
    }
  }, []);

  const handleEngineTick = useCallback(() => {
    setEngineState((current) => (current === 'cooling' ? current : 'cooling'));
  }, []);

  const handleEngineStop = useCallback(() => {
    setEngineState((current) => (current === 'cooled' ? current : 'cooled'));
  }, []);

  const handleNodeHover = useCallback((node: WebGLNode | null) => {
    const nextNode = inspectableNode(node);
    setHoverNode((currentNode) => (currentNode?.id === nextNode?.id ? currentNode : nextNode));
  }, []);

  if (!filteredPayload || filteredPayload.nodes.length === 0) {
    return (
      <GraphFallback
        title={title}
        payload={filteredPayload}
        emptyText={emptyText}
        edgeMode={edgeMode}
        onEdgeModeChange={onEdgeModeChange}
        selectedNodeId={selectedNodeId}
        onSelectNode={onSelectNode}
        onExpandNode={onExpandNode}
        loading={loading}
        edgeStrength={edgeStrength}
      />
    );
  }

  if (webglSupported === false || loadError) {
    return (
      <section className="lg-webgl-fallback">
        <div className="lg-state-warning" role="status">
          <strong>WebGL 3D renderer를 사용할 수 없어 DOM/SVG fallback으로 전환했습니다.</strong>
          <span>{loadError || '이 브라우저/하드웨어에서 WebGL context 생성이 실패했습니다.'}</span>
        </div>
        <GraphFallback
          title={`${title} fallback`}
          payload={filteredPayload}
          emptyText={emptyText}
          edgeMode={edgeMode}
          onEdgeModeChange={onEdgeModeChange}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          onExpandNode={onExpandNode}
          loading={loading}
          edgeStrength={edgeStrength}
        />
      </section>
    );
  }

  const moduleLoading = webglSupported === null || (!shouldUseStaticRenderer && (!ForceGraph3D || !graphData));
  const layoutModeLabel = layoutModeChipLabel(filteredPayload.layout_mode);

  return (
    <section className="lg-graph-viewport lg-webgl-viewport" data-edge-mode={edgeMode} data-render-mode={renderMode} aria-label={title}>
      <div className="lg-graph-toolbar" aria-label={`${title} toolbar`}>
        <div className="lg-graph-toolbar__group">
          <label className="lg-search-label">
            <span className="sr-only">노드 검색</span>
            <input
              className="lg-input lg-graph-search"
              type="search"
              placeholder="Search 3D node"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  focusSearchResult();
                }
              }}
              aria-label="3D 노드 검색"
            />
          </label>
          <button type="button" className="lg-button" onClick={focusSearchResult} disabled={!filteredPayload.nodes.length} aria-label="검색 첫 결과로 camera focus 이동">
            Focus result
          </button>
          <select
            className="lg-select"
            value={edgeMode}
            onChange={(event) => onEdgeModeChange?.(event.target.value as EdgeMode)}
            aria-label="3D Edge 표시 모드"
          >
            <option value="hidden">Edges hidden</option>
            <option value="focus">Focus edges</option>
            <option value="all">All edges</option>
          </select>
          <button type="button" className="lg-button" onClick={togglePause} disabled={moduleLoading || shouldUseStaticRenderer} aria-label={shouldUseStaticRenderer ? 'Static renderer는 physics simulation을 사용하지 않습니다' : paused ? '3D 렌더러 재개' : '3D 렌더러 일시정지'}>
            {shouldUseStaticRenderer ? 'Static layout' : paused ? 'Resume physics' : 'Pause physics'}
          </button>
          <button type="button" className="lg-button" onClick={zoomToFit} disabled={moduleLoading || shouldUseStaticRenderer} aria-label={shouldUseStaticRenderer ? 'Static renderer는 마우스 wheel/drag로 탐색합니다' : '3D 그래프 전체 보기'}>
            Zoom to fit
          </button>
          {onEdgeStrengthChange ? (
            <label className="lg-edge-strength-control">
              <span>Line strength {edgeStrength.toFixed(1)}x</span>
              <input
                type="range"
                min="0.5"
                max="3"
                step="0.1"
                value={edgeStrength}
                onChange={(event) => onEdgeStrengthChange(Number(event.currentTarget.value))}
                aria-label="Edge line strength"
              />
            </label>
          ) : null}
          <div className="lg-segmented" aria-label="그래프 보기 전환">
            <button type="button" data-active={renderMode === '3d'} onClick={() => setRenderMode('3d')}>3D</button>
            <button type="button" data-active={renderMode === '2d'} onClick={() => setRenderMode('2d')}>2D</button>
            <button type="button" data-active={renderMode === 'evidence'} onClick={() => setRenderMode('evidence')}>근거</button>
          </div>
        </div>
        <div className="lg-graph-toolbar__group lg-graph-toolbar__meta" aria-live="polite">
          <span className="lg-chip" data-tone="accent">WebGL 3D</span>
          {shouldUseStaticRenderer ? <span className="lg-chip" data-tone="accent">static renderer</span> : null}
          {layoutModeLabel ? <span className="lg-chip" data-tone={filteredPayload.layout_mode === 'circular' || filteredPayload.layout_mode === 'spherical' ? 'accent' : undefined}>{layoutModeLabel}</span> : null}
          {isLargeGraph ? <span className="lg-chip" title="Reduced geometry, particles, opacity, and physics runtime are active.">large graph profile</span> : null}
          <span className="lg-chip">{graphStats(filteredPayload)}</span>
          <span className="lg-chip">visible {visibleLinkCount.toLocaleString()} links</span>
          <span className="lg-chip">{shouldUseStaticRenderer ? 'physics off · static layout' : `physics ${paused ? 'paused' : engineState}`}</span>
        </div>
      </div>

      {(loading || moduleLoading) && renderMode === '3d' ? (
        <div className="lg-graph-overlay" role="status">
          {loading ? (loadingLabel || '그래프 payload를 가져오는 중입니다…') : '3D renderer chunk lazy-load 중…'}
        </div>
      ) : null}

      {renderMode === '2d' ? (
        <div className="lg-webgl-embedded-fallback" aria-label={`${title} 2D fallback`}>
          <GraphFallback
            title={`${title} 2D`}
            payload={filteredPayload}
            emptyText={emptyText}
            edgeMode={edgeMode}
            onEdgeModeChange={onEdgeModeChange}
            selectedNodeId={selectedNodeId}
            onSelectNode={onSelectNode}
            onExpandNode={onExpandNode}
            loading={loading}
            edgeStrength={edgeStrength}
          />
        </div>
      ) : null}

      {renderMode === 'evidence' ? (
        <div className="lg-graph-evidence-list" aria-label={`${title} evidence list`}>
          {evidenceItems.length ? (
            evidenceItems.map((item) => <EvidenceCard key={item.id} evidence={item} onSelect={onSelectEvidence} />)
          ) : (
            <div className="lg-empty-state">이 그래프 payload에 연결된 별도 evidence list가 없습니다. 노드를 선택하면 inspector에서 source를 확인할 수 있습니다.</div>
          )}
        </div>
      ) : null}

      {renderMode === '3d' && shouldUseStaticRenderer && filteredPayload ? (
        <div ref={canvasContainerRef} className="lg-webgl-canvas lg-webgl-canvas--static" role="img" aria-label={`${title}: static renderer for ${filteredPayload.nodes.length} nodes, ${filteredPayload.edges.length} edges`}>
          <StaticBufferGraph title={title} payload={filteredPayload} edgeMode={edgeMode} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} edgeStrength={edgeStrength} />
        </div>
      ) : null}

      {renderMode === '3d' && !shouldUseStaticRenderer && ForceGraph3D && graphData ? (
        <div ref={canvasContainerRef} className="lg-webgl-canvas" role="img" aria-label={`${title}: ${graphData.nodes.length} nodes, ${graphData.links.length} visible links`}>
          <ForceGraph3D
            ref={graphRef}
            graphData={graphData}
            nodeId="id"
            linkSource="source"
            linkTarget="target"
            backgroundColor="rgba(0,0,0,0)"
            showNavInfo={false}
            width={graphDimensions.width}
            height={graphDimensions.height}
            nodeVal={(node: WebGLNode) => node.val}
            nodeColor={(node: WebGLNode) => node.color}
            nodeLabel={(node: WebGLNode) => nodeLabelHtml(node)}
            nodeOpacity={rendererSettings.nodeOpacity}
            nodeResolution={rendererSettings.nodeResolution}
            linkWidth={(link: WebGLLink) => link.width}
            linkColor={(link: WebGLLink) => link.color}
            linkMaterial={linkMaterial}
            linkOpacity={rendererSettings.linkOpacity}
            linkLabel={(link: WebGLLink) => linkLabelHtml(link)}
            linkDirectionalParticles={(link: WebGLLink) => (isLargeGraph ? 0 : String(link.confidence ?? '').toUpperCase() === 'EXTRACTED' ? 1 : 0)}
            linkDirectionalParticleWidth={(link: WebGLLink) => Math.max(0.6, link.width * 0.7)}
            cooldownTicks={rendererSettings.cooldownTicks}
            cooldownTime={rendererSettings.cooldownTime}
            d3VelocityDecay={rendererSettings.d3VelocityDecay}
            onEngineTick={handleEngineTick}
            onEngineStop={handleEngineStop}
            onNodeHover={handleNodeHover}
            onNodeClick={(node: WebGLNode) => handleNodeClick(node)}
            onBackgroundClick={() => setHoverNode(null)}
            enableNodeDrag
            enableNavigationControls
            showPointerCursor
          />
        </div>
      ) : null}

      {shouldShowGraphSelection(renderMode, Boolean(selectedNode)) && selectedNode ? (
        <div className="lg-graph-selection lg-card lg-webgl-selection">
          <span className="lg-chip" data-tone="accent">{hoverNode ? 'hover' : 'selected'} node</span>
          <strong>{selectedNode.label}</strong>
          <span>Community {selectedNode.community ?? '—'} · degree {selectedNode.degree ?? '—'}</span>
          {selectedNode.id.startsWith('community-') ? (
            <>
              <span>members {String(selectedNode.metadata?.member_count ?? selectedNode.degree ?? '—')} · edges {String(selectedNode.metadata?.edge_count ?? '—')}</span>
              {Array.isArray(selectedNode.metadata?.god_nodes) && selectedNode.metadata.god_nodes.length ? (
                <code>top: {selectedNode.metadata.god_nodes.slice(0, 3).map(String).join(', ')}</code>
              ) : null}
            </>
          ) : (
            <>
              <code>{nodeSource(selectedNode)}</code>
              <button type="button" className="lg-button" onClick={() => onExpandNode?.(selectedNode)} aria-label={`${selectedNode.label} 주변 subgraph 확장`}>
                주변 subgraph 확장
              </button>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

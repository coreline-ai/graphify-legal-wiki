import type { EdgeMode, GraphEdgeDTO, GraphNodeDTO, GraphPayloadDTO } from '../api/types';

const COMMUNITY_HEX = [
  '#a882ff',
  '#53dfdd',
  '#e9973f',
  '#44cf6e',
  '#027aff',
  '#fa99cd',
  '#e0de71',
  '#fb464c',
  '#8bd5ff',
  '#b6f09c',
  '#c8a7ff',
  '#c9c9c9',
];

export interface PositionedNode extends GraphNodeDTO {
  px: number;
  py: number;
  radius: number;
  colorVar: string;
}

export interface PositionedEdge extends GraphEdgeDTO {
  sourceNode: PositionedNode;
  targetNode: PositionedNode;
  opacity: number;
  width: number;
  dashed: boolean;
}

export interface LayoutGraphResult {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
}

export type EdgeLodLayer = 'backbone' | 'context' | 'density' | 'focus';

interface StaticProjectionPoint {
  id: string;
  sx: number;
  sy: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function communityIndex(community: GraphNodeDTO['community']): number {
  if (typeof community === 'number' && Number.isFinite(community)) return Math.abs(Math.trunc(community)) % 12;
  if (typeof community === 'string' && community.trim() !== '') {
    const parsed = Number(community.replace(/[^0-9-]/g, ''));
    return Number.isFinite(parsed) ? Math.abs(Math.trunc(parsed)) % 12 : 11;
  }
  return 11;
}

export function communityColorVar(community: GraphNodeDTO['community']): string {
  return `var(--lg-community-${communityIndex(community)})`;
}

export function communityColorHex(community: GraphNodeDTO['community']): string {
  return COMMUNITY_HEX[communityIndex(community)] ?? COMMUNITY_HEX[11];
}

export function nodeRadius(node: GraphNodeDTO): number {
  const degree = node.degree ?? node.size ?? 1;
  return Math.max(5, Math.min(18, 5 + Math.sqrt(Math.max(0, degree))));
}

export function nodeWebGLValue(node: GraphNodeDTO): number {
  const degree = node.degree ?? node.size ?? 1;
  return Math.max(1.8, Math.min(34, 1.8 + Math.sqrt(Math.max(0, degree)) * 1.18));
}

export function edgeOpacity(edge: GraphEdgeDTO): number {
  const confidence = String(edge.confidence ?? '').toUpperCase();
  if (confidence === 'EXTRACTED') return 0.72;
  if (confidence === 'INFERRED') return 0.38;
  if (confidence === 'AMBIGUOUS') return 0.46;
  return 0.54;
}

export function edgeLodLayer(edge: GraphEdgeDTO): EdgeLodLayer {
  const layer = String(edge.metadata?.lod_layer ?? '').toLowerCase();
  if (layer === 'backbone' || layer === 'context' || layer === 'density' || layer === 'focus') return layer;
  return 'context';
}

export function edgeVisualOpacity(edge: GraphEdgeDTO, edgeCount: number, strength = 1): number {
  const layer = edgeLodLayer(edge);
  const safeStrength = Math.max(0.25, Math.min(3, strength));
  if (layer === 'focus') return Math.min(1, 0.82 * safeStrength);
  if (layer === 'backbone') return Math.min(0.72, 0.22 * safeStrength);
  if (layer === 'density') {
    if (edgeCount >= 150_000) return Math.min(0.035, 0.0045 * safeStrength);
    if (edgeCount >= 25_000) return Math.min(0.055, 0.012 * safeStrength);
    return Math.min(0.08, 0.026 * safeStrength);
  }
  if (edgeCount >= 10_000) return Math.min(0.18, 0.055 * safeStrength);
  if (edgeCount >= 5_000) return Math.min(0.24, 0.085 * safeStrength);
  return Math.min(edgeOpacity(edge), 0.16 * safeStrength);
}

export function edgeVisualColor(edge: GraphEdgeDTO): string {
  const layer = edgeLodLayer(edge);
  if (layer === 'focus') return '#f4eaff';
  if (layer === 'backbone') return '#d8d2ff';
  if (layer === 'density') return '#87909f';
  return edgeColor(edge);
}

export function edgeWidth(edge: GraphEdgeDTO): number {
  const rawWeight = typeof edge.weight === 'number' && Number.isFinite(edge.weight) ? edge.weight : 1;
  return Math.max(0.55, Math.min(5.5, Math.sqrt(Math.max(0.1, rawWeight))));
}

export function edgeVisualWidth(edge: GraphEdgeDTO, strength = 1): number {
  const layer = edgeLodLayer(edge);
  const base = edgeWidth(edge);
  const multiplier = layer === 'focus' ? 1.8 : layer === 'backbone' ? 1.25 : layer === 'density' ? 0.65 : 0.9;
  return Math.max(0.35, Math.min(5.8, base * multiplier * Math.max(0.65, Math.min(1.8, strength))));
}

export function isFocusEdge(edge: GraphEdgeDTO, selectedNodeId?: string): boolean {
  return Boolean(selectedNodeId && (edge.source === selectedNodeId || edge.target === selectedNodeId));
}


export function edgeColor(edge: GraphEdgeDTO): string {
  const confidence = String(edge.confidence ?? '').toUpperCase();
  if (confidence === 'EXTRACTED') return '#c9c9c9';
  if (confidence === 'INFERRED') return '#53dfdd';
  if (confidence === 'AMBIGUOUS') return '#e9973f';
  return '#8bd5ff';
}

export function visibleEdgesForMode(payload: GraphPayloadDTO, edgeMode: EdgeMode = 'focus'): GraphEdgeDTO[] {
  if (edgeMode === 'hidden') return [];
  const focusNodeId = payload.focus_node_id || payload.seed_node_ids?.[0];
  return payload.edges.filter((edge) => edgeMode === 'all' || !focusNodeId || edge.source === focusNodeId || edge.target === focusNodeId);
}

function staticProjectionPoint(node: GraphNodeDTO): StaticProjectionPoint | null {
  if (isFiniteNumber(node.x) && isFiniteNumber(node.z)) {
    return { id: node.id, sx: node.x, sy: node.z };
  }
  if (isFiniteNumber(node.x) && isFiniteNumber(node.y)) {
    return { id: node.id, sx: node.x, sy: node.y };
  }
  return null;
}

function staticProjectionMap(payload: GraphPayloadDTO, width: number, height: number): Map<string, { px: number; py: number }> | null {
  const projectionPoints = payload.nodes.map(staticProjectionPoint);
  if (!projectionPoints.length || projectionPoints.some((point) => point === null)) return null;

  const points = projectionPoints as StaticProjectionPoint[];
  const padding = Math.min(56, Math.max(32, Math.min(width, height) * 0.08));
  const usableWidth = Math.max(1, width - padding * 2);
  const usableHeight = Math.max(1, height - padding * 2);
  const bounds = points.reduce(
    (current, point) => ({
      minX: Math.min(current.minX, point.sx),
      maxX: Math.max(current.maxX, point.sx),
      minY: Math.min(current.minY, point.sy),
      maxY: Math.max(current.maxY, point.sy),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanY = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min(usableWidth / spanX, usableHeight / spanY);
  const worldCenterX = (bounds.minX + bounds.maxX) / 2;
  const worldCenterY = (bounds.minY + bounds.maxY) / 2;
  const viewportCenterX = width / 2;
  const viewportCenterY = height / 2;
  const projected = new Map<string, { px: number; py: number }>();

  for (const point of points) {
    projected.set(point.id, {
      px: viewportCenterX + (point.sx - worldCenterX) * scale,
      py: viewportCenterY + (point.sy - worldCenterY) * scale,
    });
  }
  return projected;
}

export function layoutGraph(payload: GraphPayloadDTO, width = 960, height = 560, edgeMode: EdgeMode = 'focus', edgeRenderLimit = Number.POSITIVE_INFINITY): LayoutGraphResult {
  const centerX = width / 2;
  const centerY = height / 2;
  const ringRadius = Math.max(90, Math.min(width, height) * 0.34);
  const projectedStaticPositions = staticProjectionMap(payload, width, height);
  const nodes = payload.nodes.map<PositionedNode>((node, index) => {
    const projected = projectedStaticPositions?.get(node.id);
    if (projected) {
      return {
        ...node,
        px: projected.px,
        py: projected.py,
        radius: nodeRadius(node),
        colorVar: communityColorVar(node.community),
      };
    }

    const communityOffset = communityIndex(node.community) * 0.19;
    const angle = (index / Math.max(payload.nodes.length, 1)) * Math.PI * 2 + communityOffset;
    const radiusJitter = 1 + ((index % 7) - 3) * 0.025;
    return {
      ...node,
      px: centerX + Math.cos(angle) * ringRadius * radiusJitter,
      py: centerY + Math.sin(angle) * ringRadius * radiusJitter,
      radius: nodeRadius(node),
      colorVar: communityColorVar(node.community),
    };
  });

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const visibleEdges = visibleEdgesForMode(payload, edgeMode).slice(0, edgeRenderLimit);

  const edges = visibleEdges
    .map<PositionedEdge | null>((edge) => {
      const sourceNode = nodeMap.get(edge.source);
      const targetNode = nodeMap.get(edge.target);
      if (!sourceNode || !targetNode) return null;
      const confidence = String(edge.confidence ?? '').toUpperCase();
      return {
        ...edge,
        sourceNode,
        targetNode,
        opacity: edgeVisualOpacity(edge, visibleEdges.length),
        width: edgeVisualWidth(edge),
        dashed: confidence === 'INFERRED' || confidence === 'AMBIGUOUS',
      };
    })
    .filter((edge): edge is PositionedEdge => Boolean(edge));

  return { nodes, edges };
}

export interface WebGLGraphNode extends GraphNodeDTO {
  val: number;
  color: string;
  raw: GraphNodeDTO;
}

export interface WebGLGraphLink extends Omit<GraphEdgeDTO, 'source' | 'target'> {
  id: string;
  source: string;
  target: string;
  width: number;
  opacity: number;
  color: string;
  raw: GraphEdgeDTO;
}

export interface WebGLGraphData {
  nodes: WebGLGraphNode[];
  links: WebGLGraphLink[];
}

export function toWebGLGraphData(payload: GraphPayloadDTO, edgeMode: EdgeMode = 'focus'): WebGLGraphData {
  const nodeIds = new Set(payload.nodes.map((node) => node.id));
  return {
    nodes: payload.nodes.map((node) => ({
      ...node,
      val: nodeWebGLValue(node),
      color: communityColorHex(node.community),
      raw: node,
    })),
    links: visibleEdgesForMode(payload, edgeMode)
      .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
      .map((edge, index) => ({
        ...edge,
        id: edge.id ?? `${edge.source}->${edge.target}:${edge.relation ?? 'edge'}:${index}`,
        width: edgeVisualWidth(edge),
        opacity: edgeVisualOpacity(edge, payload.edges.length),
        color: edgeVisualColor(edge),
        raw: edge,
      })),
  };
}

export function graphStats(payload: GraphPayloadDTO): string {
  return `${payload.nodes.length.toLocaleString()} nodes · ${payload.edges.length.toLocaleString()} edges`;
}

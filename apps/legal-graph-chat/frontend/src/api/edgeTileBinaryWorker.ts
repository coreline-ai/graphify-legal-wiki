import type { EdgeMode, EdgeTileResponse, GraphEdgeDTO, GraphKey } from './types';

interface EdgeTileBinaryWorkerRequest {
  id: string;
  apiBaseUrl: string;
  path: string;
  params: Record<string, string | number | boolean | null | undefined>;
  nodeIds: string[];
}

interface EdgeTileBinaryWorkerSuccess {
  id: string;
  ok: true;
  payload: EdgeTileResponse;
}

interface EdgeTileBinaryWorkerFailure {
  id: string;
  ok: false;
  message: string;
  status?: number;
  detail?: unknown;
}

type EdgeTileBinaryWorkerResponse = EdgeTileBinaryWorkerSuccess | EdgeTileBinaryWorkerFailure;

interface BinaryEdgeTileHeader {
  format?: string;
  graph?: GraphKey | string;
  edge_mode?: EdgeMode;
  tile?: number;
  tile_size?: number;
  returned_edges?: number;
  total_edges?: number;
  has_more?: boolean;
  focus_node_id?: string | null;
  nodes_in_scope?: number | null;
  lod_layer?: string | null;
  layer_codes?: Record<string, string>;
  warnings?: string[];
}

const MAGIC = 'GF3E\x01';
const DEFAULT_LAYER_NAMES: Record<number, string> = {
  0: 'context',
  1: 'backbone',
  2: 'density',
  3: 'focus',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildUrl(apiBaseUrl: string, path: string, params: EdgeTileBinaryWorkerRequest['params']): string {
  const url = new URL(path, apiBaseUrl);
  Object.entries(params ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function decodeMagic(bytes: Uint8Array): string {
  return `${String.fromCharCode(bytes[0] ?? 0)}${String.fromCharCode(bytes[1] ?? 0)}${String.fromCharCode(bytes[2] ?? 0)}${String.fromCharCode(bytes[3] ?? 0)}${String.fromCharCode(bytes[4] ?? 0)}`;
}

function layerNamesFrom(header: BinaryEdgeTileHeader): Record<number, string> {
  const raw = header.layer_codes;
  if (!raw || !isRecord(raw)) return DEFAULT_LAYER_NAMES;
  const names: Record<number, string> = { ...DEFAULT_LAYER_NAMES };
  Object.entries(raw).forEach(([code, label]) => {
    const numericCode = Number(code);
    if (Number.isFinite(numericCode) && typeof label === 'string' && label) {
      names[numericCode] = label;
    }
  });
  return names;
}

function decodeBinaryEdgeTile(buffer: ArrayBuffer, nodeIds: string[]): EdgeTileResponse {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 9 || decodeMagic(bytes) !== MAGIC) {
    throw new Error('Invalid binary edge tile magic. Expected GF3E\\x01.');
  }

  const view = new DataView(buffer);
  const headerLength = view.getUint32(5, true);
  const headerStart = 9;
  const headerEnd = headerStart + headerLength;
  if (headerEnd > bytes.byteLength) {
    throw new Error('Invalid binary edge tile header length.');
  }
  const header = JSON.parse(new TextDecoder().decode(bytes.slice(headerStart, headerEnd))) as BinaryEdgeTileHeader;
  if (header.format !== 'graphify.edge-tile.binary.v1') {
    throw new Error(`Unsupported binary edge tile format: ${header.format || 'unknown'}`);
  }

  const edgeCount = Math.max(0, Number(header.returned_edges ?? 0));
  const edgeBytes = edgeCount * 8;
  const edgeOffset = headerEnd;
  const layerOffset = edgeOffset + edgeBytes;
  if (layerOffset + edgeCount > bytes.byteLength) {
    throw new Error('Binary edge tile arrays are truncated.');
  }

  const layerNames = layerNamesFrom(header);
  const edges: GraphEdgeDTO[] = [];
  for (let index = 0; index < edgeCount; index += 1) {
    const sourceIndex = view.getUint32(edgeOffset + index * 8, true);
    const targetIndex = view.getUint32(edgeOffset + index * 8 + 4, true);
    const source = nodeIds[sourceIndex];
    const target = nodeIds[targetIndex];
    if (!source || !target) continue;
    const layerCode = bytes[layerOffset + index] ?? 0;
    const lodLayer = layerNames[layerCode] ?? 'context';
    edges.push({
      id: `bin-tile-${header.tile ?? 0}-${index}-${source}->${target}`,
      source,
      target,
      relation: 'related',
      confidence: 'EXTRACTED',
      weight: 1,
      metadata: {
        lod_layer: lodLayer,
        tile: header.tile ?? 0,
        binary_tile: true,
      },
    });
  }

  return {
    graph: header.graph ?? '',
    edge_mode: header.edge_mode ?? 'all',
    tile: Number(header.tile ?? 0),
    tile_size: Number(header.tile_size ?? 0),
    returned_edges: edges.length,
    total_edges: Number(header.total_edges ?? 0),
    has_more: Boolean(header.has_more),
    focus_node_id: header.focus_node_id ?? null,
    nodes_in_scope: header.nodes_in_scope ?? null,
    lod_layer: header.lod_layer ?? null,
    edges,
    warnings: Array.isArray(header.warnings) ? header.warnings : [],
  };
}

async function fetchBinaryEdgeTile(request: EdgeTileBinaryWorkerRequest): Promise<EdgeTileBinaryWorkerResponse> {
  try {
    const response = await fetch(buildUrl(request.apiBaseUrl, request.path, request.params), {
      headers: { Accept: 'application/octet-stream' },
    });
    if (!response.ok) {
      const contentType = response.headers.get('content-type') ?? '';
      const detail = contentType.includes('application/json') ? await response.json() : await response.text();
      return {
        id: request.id,
        ok: false,
        status: response.status,
        detail,
        message: response.statusText || 'Binary edge tile request failed',
      };
    }
    const buffer = await response.arrayBuffer();
    return { id: request.id, ok: true, payload: decodeBinaryEdgeTile(buffer, request.nodeIds) };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      message: error instanceof Error ? error.message : 'Binary edge tile worker decode failed',
    };
  }
}

self.addEventListener('message', (event: MessageEvent<EdgeTileBinaryWorkerRequest>) => {
  void fetchBinaryEdgeTile(event.data).then((message) => {
    (self as unknown as Worker).postMessage(message);
  });
});

export type { EdgeTileBinaryWorkerRequest, EdgeTileBinaryWorkerResponse };

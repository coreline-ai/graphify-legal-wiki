import type {
  EdgeMode,
  EdgeTileResponse,
  GraphBinaryWorkerStats,
  GraphEdgeDTO,
  GraphKey,
  GraphNodeDTO,
  GraphPayloadDTO,
  StaticLayoutMode,
} from './types';

type RequestParams = Record<string, string | number | boolean | null | undefined>;

export type GraphBinaryWorkerRequest =
  | {
      id: string;
      type: 'INIT_GRAPH_NODES_BINARY';
      apiBaseUrl: string;
      path: string;
      params: RequestParams;
    }
  | {
      id: string;
      type: 'LOAD_EDGE_TILE_BINARY';
      apiBaseUrl: string;
      path: string;
      params: RequestParams;
    }
  | {
      id: string;
      type: 'CLEAR_GRAPH';
    }
  | {
      id: string;
      type: 'GET_STATS';
    }
  | {
      id: string;
      type: 'ABORT_REQUEST';
      targetId: string;
    };

export type GraphBinaryWorkerResponse =
  | {
      id: string;
      type: 'INIT_GRAPH_NODES_BINARY_RESULT';
      ok: true;
      payload: GraphPayloadDTO;
      stats: GraphBinaryWorkerStats;
    }
  | {
      id: string;
      type: 'LOAD_EDGE_TILE_BINARY_RESULT';
      ok: true;
      payload: EdgeTileResponse;
      stats: GraphBinaryWorkerStats;
    }
  | {
      id: string;
      type: 'CLEAR_GRAPH_RESULT';
      ok: true;
      payload: GraphBinaryWorkerStats;
      stats: GraphBinaryWorkerStats;
    }
  | {
      id: string;
      type: 'GET_STATS_RESULT';
      ok: true;
      payload: GraphBinaryWorkerStats;
      stats: GraphBinaryWorkerStats;
    }
  | {
      id: string;
      type: 'ERROR';
      ok: false;
      message: string;
      status?: number;
      detail?: unknown;
      stats: GraphBinaryWorkerStats;
    };

interface BinaryArraySchema {
  type?: string;
  components?: number;
  count?: number;
  byte_length?: number;
  encoding?: string;
}

interface BinaryNodesHeader {
  format?: string;
  graph_id?: GraphKey | string;
  graph?: GraphKey | string;
  edge_mode?: EdgeMode;
  layout_mode?: StaticLayoutMode;
  static_layout_mode?: StaticLayoutMode;
  node_count?: number;
  generated_at?: string;
  label?: string;
  partial?: boolean;
  warnings?: string[];
  arrays?: Record<string, BinaryArraySchema | undefined>;
  array_byte_lengths?: Record<string, unknown>;
  schema?: Record<string, unknown>;
  strings?: Record<string, unknown>;
  string_table?: Record<string, unknown>;
  id_table?: BinaryArraySchema;
  node_order_hash?: string;
  nodes?: Array<{ id?: unknown; label?: unknown }>;
  node_ids?: unknown[];
  ids?: unknown[];
}

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
  node_order_hash?: string;
  lod_layer?: string | null;
  layer_codes?: Record<string, string>;
  warnings?: string[];
}

interface GraphWorkerState {
  initialized: boolean;
  graph?: GraphKey | string;
  layoutMode?: StaticLayoutMode;
  edgeMode?: EdgeMode;
  label?: string;
  generatedAt?: string;
  partial?: boolean;
  warnings: string[];
  nodeIds: string[];
  nodeIndex: Map<string, number>;
  positions: Float32Array;
  sizes: Float32Array;
  degrees: Float32Array | Uint32Array | Int32Array;
  communities: Int32Array | Uint32Array | Float32Array;
  flags: Uint8Array;
  payloadBytes: number;
  nodeOrderHash?: string;
  scopeKey?: string;
  edgeTileCount: number;
}

export interface DecodedGraphNodesBinary {
  payload: GraphPayloadDTO;
  state: GraphWorkerState;
  stats: GraphBinaryWorkerStats;
}

const NODE_MAGIC = 'GF3N\x01';
const EDGE_MAGIC = 'GF3E\x01';
const HEADER_PREFIX_BYTES = 9;
const DEFAULT_LAYER_NAMES: Record<number, string> = {
  0: 'context',
  1: 'backbone',
  2: 'density',
  3: 'focus',
};

const emptyFloat32 = new Float32Array(0);
const emptyInt32 = new Int32Array(0);
const emptyUint8 = new Uint8Array(0);

let graphState: GraphWorkerState = createEmptyState();
const activeControllers = new Map<string, AbortController>();

function createEmptyState(): GraphWorkerState {
  return {
    initialized: false,
    warnings: [],
    nodeIds: [],
    nodeIndex: new Map<string, number>(),
    positions: emptyFloat32,
    sizes: emptyFloat32,
    degrees: emptyFloat32,
    communities: emptyInt32,
    flags: emptyUint8,
    payloadBytes: 0,
    edgeTileCount: 0,
  };
}

function statsFromState(state: GraphWorkerState = graphState): GraphBinaryWorkerStats {
  return {
    initialized: state.initialized,
    graph: state.graph,
    layout_mode: state.layoutMode,
    edge_mode: state.edgeMode,
    node_count: state.nodeIds.length,
    payload_bytes: state.payloadBytes,
    node_order_hash: state.nodeOrderHash,
    scope_key: state.scopeKey,
    edge_tile_count: state.edgeTileCount,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringFrom(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function numberFrom(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function booleanFrom(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return undefined;
}

function arrayFrom<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function decodeMagic(bytes: Uint8Array): string {
  return `${String.fromCharCode(bytes[0] ?? 0)}${String.fromCharCode(bytes[1] ?? 0)}${String.fromCharCode(bytes[2] ?? 0)}${String.fromCharCode(bytes[3] ?? 0)}${String.fromCharCode(bytes[4] ?? 0)}`;
}

function readHeader<T>(buffer: ArrayBuffer, expectedMagic: string): { bytes: Uint8Array; view: DataView; header: T; headerEnd: number } {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < HEADER_PREFIX_BYTES || decodeMagic(bytes) !== expectedMagic) {
    throw new Error(`Invalid binary graph magic. Expected ${expectedMagic.replace('\x01', '\\x01')}.`);
  }

  const view = new DataView(buffer);
  const headerLength = view.getUint32(5, true);
  const headerStart = HEADER_PREFIX_BYTES;
  const headerEnd = headerStart + headerLength;
  if (headerEnd > bytes.byteLength) {
    throw new Error('Invalid binary graph header length.');
  }

  const header = JSON.parse(new TextDecoder().decode(bytes.slice(headerStart, headerEnd))) as T;
  return { bytes, view, header, headerEnd };
}

function schemaFrom(header: BinaryNodesHeader, names: string[]): BinaryArraySchema | undefined {
  const arrays = isRecord(header.arrays) ? header.arrays : {};
  for (const name of names) {
    const schema = arrays[name];
    if (isRecord(schema)) return schema;
  }
  const schemaRoot = isRecord(header.schema) ? header.schema : {};
  const byteLengths = isRecord(header.array_byte_lengths) ? header.array_byte_lengths : {};
  for (const name of names) {
    const schema = schemaRoot[name];
    if (isRecord(schema)) {
      return {
        ...(schema as BinaryArraySchema),
        count: numberFrom((schema as BinaryArraySchema).count) ?? numberFrom(header.node_count) ?? undefined,
        byte_length: byteLengthFromUnknown((schema as BinaryArraySchema).byte_length) ?? byteLengthFromUnknown(byteLengths[name]) ?? undefined,
      };
    }
  }
  for (const name of names) {
    const value = (header as unknown as Record<string, unknown>)[name];
    if (isRecord(value)) return value as BinaryArraySchema;
  }
  return undefined;
}

function bytesPerElement(type: string): number {
  switch (type.toLowerCase()) {
    case 'float64':
    case 'double':
      return 8;
    case 'float32':
    case 'uint32':
    case 'int32':
      return 4;
    case 'uint16':
    case 'int16':
      return 2;
    case 'uint8':
    case 'int8':
    case 'bool':
    case 'boolean':
      return 1;
    default:
      throw new Error(`Unsupported GF3N array type: ${type}`);
  }
}

function cloneBytes(buffer: ArrayBuffer, offset: number, byteLength: number): Uint8Array {
  return new Uint8Array(buffer, offset, byteLength).slice();
}

function readFloat32Array(
  buffer: ArrayBuffer,
  offset: number,
  schema: BinaryArraySchema | undefined,
  nodeCount: number,
  components: number,
  fallback?: (index: number) => number,
): { array: Float32Array; offset: number } {
  const count = Math.max(0, numberFrom(schema?.count) ?? nodeCount);
  const componentCount = Math.max(1, numberFrom(schema?.components) ?? components);
  const length = count * componentCount;
  if (!schema) {
    const defaults = new Float32Array(nodeCount * components);
    if (fallback) {
      for (let index = 0; index < defaults.length; index += 1) defaults[index] = fallback(index);
    }
    return { array: defaults, offset };
  }
  const type = stringFrom(schema.type, 'float32').toLowerCase();
  const expectedByteLength = length * bytesPerElement(type);
  const byteLength = Math.max(0, numberFrom(schema.byte_length) ?? expectedByteLength);
  if (offset + byteLength > buffer.byteLength) throw new Error(`GF3N ${type} array is truncated.`);

  const bytes = cloneBytes(buffer, offset, byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const byteOffset = index * bytesPerElement(type);
    if (byteOffset + bytesPerElement(type) > bytes.byteLength) break;
    switch (type) {
      case 'float32':
        out[index] = view.getFloat32(byteOffset, true);
        break;
      case 'float64':
      case 'double':
        out[index] = view.getFloat64(byteOffset, true);
        break;
      case 'uint32':
        out[index] = view.getUint32(byteOffset, true);
        break;
      case 'int32':
        out[index] = view.getInt32(byteOffset, true);
        break;
      case 'uint16':
        out[index] = view.getUint16(byteOffset, true);
        break;
      case 'int16':
        out[index] = view.getInt16(byteOffset, true);
        break;
      case 'uint8':
      case 'bool':
      case 'boolean':
        out[index] = view.getUint8(byteOffset);
        break;
      case 'int8':
        out[index] = view.getInt8(byteOffset);
        break;
      default:
        throw new Error(`Unsupported GF3N float-compatible array type: ${type}`);
    }
  }
  return { array: out, offset: offset + byteLength };
}

function readUint32LikeArray(
  buffer: ArrayBuffer,
  offset: number,
  schema: BinaryArraySchema | undefined,
  nodeCount: number,
): { array: Float32Array | Uint32Array | Int32Array; offset: number } {
  if (!schema) return { array: new Float32Array(nodeCount), offset };
  const type = stringFrom(schema.type, 'uint32').toLowerCase();
  const count = Math.max(0, numberFrom(schema.count) ?? nodeCount);
  const components = Math.max(1, numberFrom(schema.components) ?? 1);
  const length = count * components;
  const expectedByteLength = length * bytesPerElement(type);
  const byteLength = Math.max(0, numberFrom(schema.byte_length) ?? expectedByteLength);
  if (offset + byteLength > buffer.byteLength) throw new Error(`GF3N ${type} array is truncated.`);

  if (type === 'uint32' && byteLength >= expectedByteLength) {
    return { array: new Uint32Array(cloneBytes(buffer, offset, byteLength).buffer, 0, length), offset: offset + byteLength };
  }
  if (type === 'int32' && byteLength >= expectedByteLength) {
    return { array: new Int32Array(cloneBytes(buffer, offset, byteLength).buffer, 0, length), offset: offset + byteLength };
  }
  const read = readFloat32Array(buffer, offset, schema, nodeCount, 1);
  return { array: read.array, offset: read.offset };
}

function readInt32LikeArray(
  buffer: ArrayBuffer,
  offset: number,
  schema: BinaryArraySchema | undefined,
  nodeCount: number,
): { array: Int32Array | Uint32Array | Float32Array; offset: number } {
  if (!schema) {
    const defaults = new Int32Array(nodeCount);
    defaults.fill(-1);
    return { array: defaults, offset };
  }
  const type = stringFrom(schema.type, 'int32').toLowerCase();
  const count = Math.max(0, numberFrom(schema.count) ?? nodeCount);
  const components = Math.max(1, numberFrom(schema.components) ?? 1);
  const length = count * components;
  const expectedByteLength = length * bytesPerElement(type);
  const byteLength = Math.max(0, numberFrom(schema.byte_length) ?? expectedByteLength);
  if (offset + byteLength > buffer.byteLength) throw new Error(`GF3N ${type} array is truncated.`);

  if (type === 'int32' && byteLength >= expectedByteLength) {
    return { array: new Int32Array(cloneBytes(buffer, offset, byteLength).buffer, 0, length), offset: offset + byteLength };
  }
  if (type === 'uint32' && byteLength >= expectedByteLength) {
    return { array: new Uint32Array(cloneBytes(buffer, offset, byteLength).buffer, 0, length), offset: offset + byteLength };
  }
  const read = readFloat32Array(buffer, offset, schema, nodeCount, 1);
  return { array: read.array, offset: read.offset };
}

function readUint8Array(
  buffer: ArrayBuffer,
  offset: number,
  schema: BinaryArraySchema | undefined,
  nodeCount: number,
): { array: Uint8Array; offset: number } {
  if (!schema) return { array: new Uint8Array(nodeCount), offset };
  const count = Math.max(0, numberFrom(schema.count) ?? nodeCount);
  const components = Math.max(1, numberFrom(schema.components) ?? 1);
  const length = count * components;
  const byteLength = Math.max(0, numberFrom(schema.byte_length) ?? length);
  if (offset + byteLength > buffer.byteLength) throw new Error('GF3N uint8 array is truncated.');
  return { array: cloneBytes(buffer, offset, byteLength).slice(0, length), offset: offset + byteLength };
}

function byteLengthFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  if (isRecord(value)) {
    return (
      byteLengthFromUnknown(value.byte_length) ??
      byteLengthFromUnknown(value.bytes) ??
      byteLengthFromUnknown(value.id_table_byte_length) ??
      byteLengthFromUnknown(value.node_ids_byte_length)
    );
  }
  return null;
}

function idTableSchemaFrom(header: BinaryNodesHeader): BinaryArraySchema | undefined {
  return (
    schemaFrom(header, ['ids', 'id_table', 'node_ids', 'node_id_table']) ??
    (isRecord(header.id_table) ? header.id_table : undefined)
  );
}

function idByteLengthFrom(header: BinaryNodesHeader, fallback: number): number {
  const schema = idTableSchemaFrom(header);
  const strings = isRecord(header.strings) ? header.strings : {};
  const stringTable = isRecord(header.string_table) ? header.string_table : {};
  const arrayByteLengths = isRecord(header.array_byte_lengths) ? header.array_byte_lengths : {};
  return Math.max(
    0,
    byteLengthFromUnknown(schema?.byte_length) ??
      byteLengthFromUnknown(arrayByteLengths.ids) ??
      byteLengthFromUnknown(strings.ids) ??
      byteLengthFromUnknown(strings.node_ids) ??
      byteLengthFromUnknown(strings.id_table) ??
      byteLengthFromUnknown(strings.id_table_byte_length) ??
      byteLengthFromUnknown(strings.node_ids_byte_length) ??
      byteLengthFromUnknown(stringTable.ids) ??
      byteLengthFromUnknown(stringTable.node_ids) ??
      byteLengthFromUnknown(stringTable.byte_length) ??
      byteLengthFromUnknown((header as unknown as Record<string, unknown>).id_table_byte_length) ??
      byteLengthFromUnknown((header as unknown as Record<string, unknown>).node_ids_byte_length) ??
      byteLengthFromUnknown((header as unknown as Record<string, unknown>).string_table_byte_length) ??
      fallback,
  );
}

function headerIdsFrom(header: BinaryNodesHeader, nodeCount: number): string[] {
  const directIds = arrayFrom<unknown>(header.node_ids ?? header.ids)
    .map((id) => stringFrom(id))
    .filter(Boolean);
  if (directIds.length >= nodeCount) return directIds.slice(0, nodeCount);

  const nodeIds = arrayFrom<{ id?: unknown; label?: unknown }>(header.nodes)
    .map((node, index) => stringFrom(node.id ?? node.label, `node-${index}`))
    .filter(Boolean);
  if (nodeIds.length >= nodeCount) return nodeIds.slice(0, nodeCount);
  return [];
}

function decodeLengthPrefixedIds(bytes: Uint8Array, nodeCount: number): string[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const ids: string[] = [];
  let cursor = 0;
  while (ids.length < nodeCount && cursor + 4 <= bytes.byteLength) {
    const length = view.getUint32(cursor, true);
    cursor += 4;
    if (length > bytes.byteLength - cursor) return null;
    ids.push(decoder.decode(bytes.slice(cursor, cursor + length)));
    cursor += length;
  }
  if (ids.length !== nodeCount) return null;
  while (cursor < bytes.byteLength && (bytes[cursor] === 0 || bytes[cursor] === 10 || bytes[cursor] === 13)) cursor += 1;
  return cursor === bytes.byteLength ? ids : null;
}

function decodeDelimitedIds(bytes: Uint8Array, nodeCount: number): string[] | null {
  const text = new TextDecoder().decode(bytes).replace(/\0+$/g, '').trimEnd();
  if (!text && nodeCount > 0) return null;
  const delimiter = text.includes('\0') ? '\0' : '\n';
  const ids = text.split(delimiter).map((id) => id.trim()).filter(Boolean);
  return ids.length >= nodeCount ? ids.slice(0, nodeCount) : null;
}

function decodeNodeIds(header: BinaryNodesHeader, buffer: ArrayBuffer, offset: number, nodeCount: number): { ids: string[]; offset: number } {
  const fromHeader = headerIdsFrom(header, nodeCount);
  if (fromHeader.length >= nodeCount) return { ids: fromHeader, offset };

  const remaining = Math.max(0, buffer.byteLength - offset);
  const byteLength = Math.min(remaining, idByteLengthFrom(header, remaining));
  if (byteLength > 0) {
    const idBytes = cloneBytes(buffer, offset, byteLength);
    const encoding = stringFrom(idTableSchemaFrom(header)?.encoding, '').toLowerCase();
    const decoded = encoding.includes('newline') || encoding.includes('delimited') || encoding.includes('null')
      ? decodeDelimitedIds(idBytes, nodeCount) ?? decodeLengthPrefixedIds(idBytes, nodeCount)
      : decodeLengthPrefixedIds(idBytes, nodeCount) ?? decodeDelimitedIds(idBytes, nodeCount);
    if (decoded && decoded.length >= nodeCount) return { ids: decoded, offset: offset + byteLength };
  }

  return {
    ids: Array.from({ length: nodeCount }, (_, index) => `node-${index}`),
    offset: offset + byteLength,
  };
}

function scopeKeyFromParams(params: RequestParams = {}): string {
  const graph = stringFrom(params.graph, '');
  const nodeLimit = params.node_limit ?? '';
  const minDegree = params.min_degree ?? '';
  const communityId = params.community_id ?? '';
  return `graph=${graph}|node_limit=${nodeLimit}|min_degree=${minDegree}|community_id=${communityId}`;
}

function layerNamesFrom(header: BinaryEdgeTileHeader): Record<number, string> {
  const raw = header.layer_codes;
  if (!raw || !isRecord(raw)) return DEFAULT_LAYER_NAMES;
  const names: Record<number, string> = { ...DEFAULT_LAYER_NAMES };
  Object.entries(raw).forEach(([code, label]) => {
    const numericCode = Number(code);
    if (Number.isFinite(numericCode) && typeof label === 'string' && label) names[numericCode] = label;
  });
  return names;
}

function validateNodeFormat(header: BinaryNodesHeader): void {
  if (!header.format) return;
  if (header.format.includes('node') || header.format.includes('nodes') || header.format.includes('full3d')) return;
  throw new Error(`Unsupported GF3N format: ${header.format}`);
}

export function decodeGraphNodesBinary(buffer: ArrayBuffer, params: RequestParams = {}): DecodedGraphNodesBinary {
  const { header, headerEnd } = readHeader<BinaryNodesHeader>(buffer, NODE_MAGIC);
  validateNodeFormat(header);

  const positionSchema = schemaFrom(header, ['positions', 'node_positions']);
  const sizeSchema = schemaFrom(header, ['sizes', 'node_sizes']);
  const degreeSchema = schemaFrom(header, ['degrees', 'node_degrees']);
  const communitySchema = schemaFrom(header, ['communities', 'community_ids', 'node_communities']);
  const flagSchema = schemaFrom(header, ['flags', 'node_flags']);
  const inferredNodeCount = numberFrom(header.node_count) ?? numberFrom(positionSchema?.count) ?? 0;
  const nodeCount = Math.max(0, inferredNodeCount);

  let offset = headerEnd;
  const positions = readFloat32Array(buffer, offset, positionSchema, nodeCount, 3);
  offset = positions.offset;
  const sizes = readFloat32Array(buffer, offset, sizeSchema, nodeCount, 1, () => 1);
  offset = sizes.offset;
  const degrees = readUint32LikeArray(buffer, offset, degreeSchema, nodeCount);
  offset = degrees.offset;
  const communities = readInt32LikeArray(buffer, offset, communitySchema, nodeCount);
  offset = communities.offset;
  const flags = readUint8Array(buffer, offset, flagSchema, nodeCount);
  offset = flags.offset;
  const nodeIds = decodeNodeIds(header, buffer, offset, nodeCount).ids;

  const nodeIndex = new Map<string, number>();
  nodeIds.forEach((id, index) => nodeIndex.set(id, index));

  const layoutMode = (header.layout_mode ?? header.static_layout_mode) as StaticLayoutMode | undefined;
  const edgeMode = header.edge_mode === 'hidden' || header.edge_mode === 'focus' || header.edge_mode === 'all' ? header.edge_mode : 'hidden';
  const warnings = arrayFrom<string>(header.warnings);

  const nodes: GraphNodeDTO[] = nodeIds.map((id, index) => {
    const flag = flags.array[index] ?? 0;
    const community = Number(communities.array[index]);
    const degree = Number(degrees.array[index] ?? 0);
    return {
      id,
      label: id,
      community: Number.isFinite(community) && community >= 0 ? community : null,
      degree: Number.isFinite(degree) ? degree : null,
      type: 'node',
      file_type: '',
      source_file: '',
      source_url: '',
      path: '',
      score: null,
      size: Number(sizes.array[index] ?? 1) || 1,
      is_hub: Boolean(flag & 1),
      x: Number(positions.array[index * 3] ?? 0),
      y: Number(positions.array[index * 3 + 1] ?? 0),
      z: Number(positions.array[index * 3 + 2] ?? 0),
      metadata: {
        binary_node: true,
        node_index: index,
        source_available: Boolean(flag & 2),
        flags: flag,
      },
    };
  });

  const payload: GraphPayloadDTO = {
    nodes,
    edges: [],
    edge_mode: edgeMode,
    layout_mode: layoutMode,
    label: stringFrom(header.label, ''),
    generated_at: stringFrom(header.generated_at, ''),
    partial: booleanFrom(header.partial),
    warnings,
  };

  const state: GraphWorkerState = {
    initialized: true,
    graph: header.graph ?? header.graph_id ?? stringFrom(params.graph, ''),
    layoutMode,
    edgeMode,
    label: payload.label,
    generatedAt: payload.generated_at,
    partial: payload.partial,
    warnings,
    nodeIds,
    nodeIndex,
    positions: positions.array,
    sizes: sizes.array,
    degrees: degrees.array,
    communities: communities.array,
    flags: flags.array,
    payloadBytes: buffer.byteLength,
    nodeOrderHash: stringFrom(header.node_order_hash, ''),
    scopeKey: scopeKeyFromParams(params),
    edgeTileCount: 0,
  };

  return { payload, state, stats: statsFromState(state) };
}

function decodeBinaryEdgeTile(buffer: ArrayBuffer, state: GraphWorkerState, params: RequestParams = {}): EdgeTileResponse {
  if (!state.initialized || state.nodeIds.length === 0) {
    throw new Error('Persistent graph worker is not initialized. Call INIT_GRAPH_NODES_BINARY first.');
  }
  const scopeKey = scopeKeyFromParams(params);
  if (state.scopeKey && scopeKey !== state.scopeKey) {
    throw new Error('Edge tile scope does not match initialized graph node scope. Re-initialize graph nodes first.');
  }

  const { bytes, view, header, headerEnd } = readHeader<BinaryEdgeTileHeader>(buffer, EDGE_MAGIC);
  if (header.format && header.format !== 'graphify.edge-tile.binary.v1') {
    throw new Error(`Unsupported binary edge tile format: ${header.format}`);
  }
  if (header.graph && state.graph && header.graph !== state.graph) {
    throw new Error(`Edge tile graph ${header.graph} does not match initialized graph ${state.graph}.`);
  }
  if (header.nodes_in_scope && header.nodes_in_scope > state.nodeIds.length) {
    throw new Error('Edge tile references more nodes than the initialized graph state.');
  }

  const edgeCount = Math.max(0, Number(header.returned_edges ?? 0));
  const edgeBytes = edgeCount * 8;
  const edgeOffset = headerEnd;
  const layerOffset = edgeOffset + edgeBytes;
  if (layerOffset + edgeCount > bytes.byteLength) throw new Error('Binary edge tile arrays are truncated.');

  const sourceIndices = new Uint32Array(edgeCount);
  const targetIndices = new Uint32Array(edgeCount);
  const layerCodes = new Uint8Array(edgeCount);
  let validCount = 0;
  for (let index = 0; index < edgeCount; index += 1) {
    const sourceIndex = view.getUint32(edgeOffset + index * 8, true);
    const targetIndex = view.getUint32(edgeOffset + index * 8 + 4, true);
    const layerCode = bytes[layerOffset + index] ?? 0;
    if (sourceIndex >= state.nodeIds.length || targetIndex >= state.nodeIds.length) continue;
    sourceIndices[validCount] = sourceIndex;
    targetIndices[validCount] = targetIndex;
    layerCodes[validCount] = layerCode;
    validCount += 1;
  }

  state.edgeTileCount += 1;
  const edgeSourceIndices = validCount === edgeCount ? sourceIndices : sourceIndices.slice(0, validCount);
  const edgeTargetIndices = validCount === edgeCount ? targetIndices : targetIndices.slice(0, validCount);
  const edgeLayers = validCount === edgeCount ? layerCodes : layerCodes.slice(0, validCount);
  return {
    graph: header.graph ?? state.graph ?? '',
    edge_mode: header.edge_mode ?? 'all',
    tile: Number(header.tile ?? 0),
    tile_size: Number(header.tile_size ?? 0),
    returned_edges: validCount,
    total_edges: Number(header.total_edges ?? 0),
    has_more: Boolean(header.has_more),
    focus_node_id: header.focus_node_id ?? null,
    nodes_in_scope: header.nodes_in_scope ?? state.nodeIds.length,
    lod_layer: header.lod_layer ?? null,
    edges: [],
    edgeSourceIndices,
    edgeTargetIndices,
    edgeLayers,
    node_order_hash: header.node_order_hash,
    binary: true,
    warnings: Array.isArray(header.warnings) ? header.warnings : [],
  };
}

function buildUrl(apiBaseUrl: string, path: string, params: RequestParams): string {
  const url = new URL(path, apiBaseUrl);
  Object.entries(params ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function stringifyDetail(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringifyDetail).filter(Boolean).join('; ');
  if (isRecord(value)) {
    const loc = Array.isArray(value.loc) ? value.loc.map(String).join('.') : '';
    const message = stringifyDetail(value.msg ?? value.message ?? value.error);
    if (message) return loc ? `${loc}: ${message}` : message;
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

function errorMessageFromPayload(payload: unknown, fallback: string): string {
  if (typeof payload === 'string') return payload || fallback;
  if (!isRecord(payload)) return fallback;
  return stringifyDetail(payload.message) || stringifyDetail(payload.error) || stringifyDetail(payload.detail) || stringifyDetail(payload.recover_action) || fallback;
}

async function responseError(response: Response): Promise<{ status: number; detail: unknown; message: string }> {
  const contentType = response.headers.get('content-type') ?? '';
  const detail = contentType.includes('application/json') ? await response.json() : await response.text();
  return {
    status: response.status,
    detail,
    message: errorMessageFromPayload(detail, response.statusText || 'Binary graph request failed'),
  };
}

async function initGraphNodesBinary(request: Extract<GraphBinaryWorkerRequest, { type: 'INIT_GRAPH_NODES_BINARY' }>): Promise<GraphBinaryWorkerResponse> {
  const controller = new AbortController();
  activeControllers.set(request.id, controller);
  try {
    const response = await fetch(buildUrl(request.apiBaseUrl, request.path, request.params), {
      headers: { Accept: 'application/octet-stream' },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = await responseError(response);
      return { id: request.id, type: 'ERROR', ok: false, ...error, stats: statsFromState() };
    }

    const buffer = await response.arrayBuffer();
    const decoded = decodeGraphNodesBinary(buffer, request.params);
    graphState = decoded.state;
    return {
      id: request.id,
      type: 'INIT_GRAPH_NODES_BINARY_RESULT',
      ok: true,
      payload: decoded.payload,
      stats: statsFromState(),
    };
  } catch (error) {
    return {
      id: request.id,
      type: 'ERROR',
      ok: false,
      status: error instanceof DOMException && error.name === 'AbortError' ? 499 : undefined,
      message: error instanceof Error ? error.message : 'GF3N graph node worker decode failed',
      stats: statsFromState(),
    };
  } finally {
    activeControllers.delete(request.id);
  }
}

async function loadEdgeTileBinary(request: Extract<GraphBinaryWorkerRequest, { type: 'LOAD_EDGE_TILE_BINARY' }>): Promise<GraphBinaryWorkerResponse> {
  if (!graphState.initialized) {
    return {
      id: request.id,
      type: 'ERROR',
      ok: false,
      message: 'Persistent graph worker is not initialized. Call INIT_GRAPH_NODES_BINARY first.',
      stats: statsFromState(),
    };
  }
  const controller = new AbortController();
  activeControllers.set(request.id, controller);
  try {
    const response = await fetch(buildUrl(request.apiBaseUrl, request.path, request.params), {
      headers: { Accept: 'application/octet-stream' },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = await responseError(response);
      return { id: request.id, type: 'ERROR', ok: false, ...error, stats: statsFromState() };
    }

    const buffer = await response.arrayBuffer();
    const payload = decodeBinaryEdgeTile(buffer, graphState, request.params);
    return {
      id: request.id,
      type: 'LOAD_EDGE_TILE_BINARY_RESULT',
      ok: true,
      payload,
      stats: statsFromState(),
    };
  } catch (error) {
    return {
      id: request.id,
      type: 'ERROR',
      ok: false,
      status: error instanceof DOMException && error.name === 'AbortError' ? 499 : undefined,
      message: error instanceof Error ? error.message : 'GF3E edge tile worker decode failed',
      stats: statsFromState(),
    };
  } finally {
    activeControllers.delete(request.id);
  }
}

async function handleMessage(request: GraphBinaryWorkerRequest): Promise<GraphBinaryWorkerResponse | null> {
  switch (request.type) {
    case 'INIT_GRAPH_NODES_BINARY':
      return initGraphNodesBinary(request);
    case 'LOAD_EDGE_TILE_BINARY':
      return loadEdgeTileBinary(request);
    case 'CLEAR_GRAPH': {
      graphState = createEmptyState();
      const stats = statsFromState();
      return { id: request.id, type: 'CLEAR_GRAPH_RESULT', ok: true, payload: stats, stats };
    }
    case 'GET_STATS': {
      const stats = statsFromState();
      return { id: request.id, type: 'GET_STATS_RESULT', ok: true, payload: stats, stats };
    }
    case 'ABORT_REQUEST': {
      activeControllers.get(request.targetId)?.abort();
      return null;
    }
    default:
      return {
        id: (request as { id?: string }).id ?? 'unknown',
        type: 'ERROR',
        ok: false,
        message: 'Unknown graph binary worker message type',
        stats: statsFromState(),
      };
  }
}

type WorkerScopeLike = {
  addEventListener: (type: 'message', listener: (event: MessageEvent<GraphBinaryWorkerRequest>) => void) => void;
  postMessage: (message: GraphBinaryWorkerResponse) => void;
};

const maybeWorkerScope = globalThis as unknown as Partial<WorkerScopeLike>;
if (typeof maybeWorkerScope.addEventListener === 'function' && typeof maybeWorkerScope.postMessage === 'function') {
  maybeWorkerScope.addEventListener('message', (event: MessageEvent<GraphBinaryWorkerRequest>) => {
    void handleMessage(event.data).then((message) => {
      if (message) maybeWorkerScope.postMessage?.(message);
    });
  });
}

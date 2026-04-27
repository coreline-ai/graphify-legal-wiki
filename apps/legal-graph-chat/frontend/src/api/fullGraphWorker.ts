import type { EdgeMode, GraphEdgeDTO, GraphNodeDTO, GraphPayloadDTO, StaticLayoutMode } from './types';

interface WorkerRequest {
  id: string;
  apiBaseUrl: string;
  path: string;
  params: Record<string, string | number | boolean | null | undefined>;
}

interface WorkerSuccess {
  id: string;
  ok: true;
  payload: GraphPayloadDTO;
}

interface WorkerFailure {
  id: string;
  ok: false;
  message: string;
  status?: number;
  detail?: unknown;
}

type WorkerResponse = WorkerSuccess | WorkerFailure;

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

function metadataFrom(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalizeNode(raw: unknown, index = 0): GraphNodeDTO {
  const record = isRecord(raw) ? raw : {};
  const id = stringFrom(record.id ?? record.node_id ?? record.key ?? record.label, `node-${index}`);
  const metadata = metadataFrom(record.metadata);
  return {
    id,
    label: stringFrom(record.label ?? record.name ?? record.title ?? id, id),
    community: (record.community ?? record.community_id ?? null) as string | number | null,
    degree: numberFrom(record.degree ?? record.reference_count ?? record.count),
    type: stringFrom(record.type ?? record.node_kind ?? record.kind, 'node'),
    file_type: stringFrom(record.file_type, ''),
    source_file: stringFrom(record.source_file ?? record.source ?? record.file, ''),
    source_url: stringFrom(record.source_url, ''),
    path: stringFrom(record.path ?? record.source_path, ''),
    score: numberFrom(record.score ?? record.rank),
    size: numberFrom(record.size ?? record.weight),
    is_hub: Boolean(record.is_hub),
    x: numberFrom(record.x) ?? undefined,
    y: numberFrom(record.y) ?? undefined,
    z: numberFrom(record.z) ?? undefined,
    metadata,
  };
}

function normalizeEdge(raw: unknown, index = 0): GraphEdgeDTO {
  const record = isRecord(raw) ? raw : {};
  const source = stringFrom(record.source ?? record.from ?? record.source_id, '');
  const target = stringFrom(record.target ?? record.to ?? record.target_id, '');
  return {
    id: stringFrom(record.id, source && target ? `${source}->${target}-${index}` : `edge-${index}`),
    source,
    target,
    relation: stringFrom(record.relation ?? record.type ?? record.label, 'related'),
    confidence: stringFrom(record.confidence ?? record.evidence_type, 'UNKNOWN'),
    confidence_score: numberFrom(record.confidence_score),
    weight: numberFrom(record.weight ?? record.count ?? record.score),
    source_file: stringFrom(record.source_file ?? record.source_path ?? record.file, ''),
    source_url: stringFrom(record.source_url, ''),
    path: stringFrom(record.path, ''),
    metadata: metadataFrom(record.metadata),
  };
}

function normalizeGraphPayload(raw: unknown): GraphPayloadDTO {
  const record = isRecord(raw) ? raw : {};
  const nodes = arrayFrom<unknown>(record.nodes).map(normalizeNode);
  const edges = arrayFrom<unknown>(record.edges).map(normalizeEdge).filter((edge) => edge.source && edge.target);
  const edgeMode = record.edge_mode === 'hidden' || record.edge_mode === 'focus' || record.edge_mode === 'all'
    ? record.edge_mode as EdgeMode
    : undefined;
  const layoutMode = stringFrom(record.layout_mode ?? record.static_layout_mode, '') as StaticLayoutMode;
  return {
    nodes,
    edges,
    seed_node_ids: arrayFrom<string>(record.seed_node_ids ?? record.seeds),
    focus_node_id: stringFrom(record.focus_node_id ?? record.focus, ''),
    edge_mode: edgeMode,
    layout_mode: layoutMode || undefined,
    label: stringFrom(record.label ?? record.title, ''),
    generated_at: stringFrom(record.generated_at, ''),
    partial: booleanFrom(record.partial),
    warnings: arrayFrom<string>(record.warnings),
  };
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

function buildUrl(apiBaseUrl: string, path: string, params: WorkerRequest['params']): string {
  const url = new URL(path, apiBaseUrl);
  Object.entries(params ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  return url.toString();
}

async function fetchFullGraph(request: WorkerRequest): Promise<WorkerResponse> {
  try {
    const response = await fetch(buildUrl(request.apiBaseUrl, request.path, request.params), {
      headers: { Accept: 'application/json' },
    });
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    const payload = contentType.includes('application/json') && text ? JSON.parse(text) : text;
    if (!response.ok) {
      return {
        id: request.id,
        ok: false,
        status: response.status,
        detail: payload,
        message: errorMessageFromPayload(payload, response.statusText),
      };
    }
    return { id: request.id, ok: true, payload: normalizeGraphPayload(payload) };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      message: error instanceof Error ? error.message : 'Full graph worker fetch failed',
    };
  }
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  void fetchFullGraph(event.data).then((message) => {
    (self as unknown as Worker).postMessage(message);
  });
});

export type { WorkerRequest, WorkerResponse };

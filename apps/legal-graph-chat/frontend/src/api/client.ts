import {
  normalizeAnswerResponse,
  normalizeCommunityPayload,
  normalizeEdgeTileResponse,
  normalizeGraphPayload,
  normalizeHealth,
  normalizePrecedentHealth,
  normalizePrecedentSearchResponse,
  normalizePrecedentSourceResponse,
  normalizeQueryResponse,
  normalizeSuggestedQuestions,
} from './normalizers';
import type {
  AnswerRequest,
  AnswerResponse,
  CommunityPayloadDTO,
  EdgeMode,
  EdgeTileResponse,
  ExplainResponse,
  GraphBinaryWorkerStats,
  GraphCatalogResponse,
  GraphKey,
  GraphPayloadDTO,
  HealthResponse,
  NormalizedHealth,
  PrecedentHealthResponse,
  PrecedentSearchRequest,
  PrecedentSearchResponse,
  PrecedentSourceResponse,
  QueryRequest,
  QueryResponse,
  SourceResponse,
  StaticLayoutMode,
} from './types';

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8765';
const REQUEST_TIMEOUT_MS = 60_000;
const FULL_GRAPH_WORKER_TIMEOUT_MS = 180_000;

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/$/, '');

export class ApiError extends Error {
  status?: number;
  detail?: unknown;

  constructor(message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringifyDetail(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => stringifyDetail(item))
      .filter(Boolean)
      .join('; ');
  }
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

export function apiErrorMessageFromPayload(payload: unknown, fallback: string): string {
  if (typeof payload === 'string') return payload || fallback;
  if (!isRecord(payload)) return fallback;
  const message =
    stringifyDetail(payload.message) ||
    stringifyDetail(payload.error) ||
    stringifyDetail(payload.detail) ||
    stringifyDetail(payload.recover_action);
  return message || fallback;
}

function graphParam(graph?: GraphKey): Record<string, string> | undefined {
  return graph ? { graph } : undefined;
}

function buildUrl(path: string, params?: Record<string, string | number | boolean | undefined | null>): string {
  const url = new URL(path, API_BASE_URL);
  Object.entries(params ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

async function requestJson<T>(path: string, init?: RequestInit, params?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
  const controller = new AbortController();
  const externalSignal = init?.signal;
  const abortFromExternal = () => controller.abort();
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  }
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(buildUrl(path, params), {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();

    if (!response.ok) {
      throw new ApiError(apiErrorMessageFromPayload(payload, response.statusText), response.status, payload);
    }

    return payload as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (externalSignal?.aborted) {
        throw new ApiError('요청이 취소되었습니다.', 499);
      }
      throw new ApiError('요청 시간이 초과되었습니다. backend 상태와 payload limit을 확인하세요.');
    }
    throw error;
  } finally {
    externalSignal?.removeEventListener('abort', abortFromExternal);
    globalThis.clearTimeout(timeout);
  }
}

export async function getGraphs(signal?: AbortSignal): Promise<GraphCatalogResponse> {
  return requestJson<GraphCatalogResponse>('/graphs', { signal });
}

export async function getHealth(signal?: AbortSignal, graph?: GraphKey): Promise<NormalizedHealth> {
  const raw = await requestJson<HealthResponse>('/health', { signal }, graphParam(graph));
  return normalizeHealth(raw);
}

export async function getSuggestedQuestions(signal?: AbortSignal, graph?: GraphKey): Promise<string[]> {
  const raw = await requestJson<unknown>('/suggested-questions', { signal }, graphParam(graph));
  return normalizeSuggestedQuestions(raw);
}

export async function postQuery(request: QueryRequest, signal?: AbortSignal, graph?: GraphKey): Promise<QueryResponse> {
  const raw = await requestJson<unknown>('/query', {
    method: 'POST',
    body: JSON.stringify(request),
    signal,
  }, graphParam(graph));
  return normalizeQueryResponse(raw, request.question);
}

export async function postAnswer(request: AnswerRequest, signal?: AbortSignal, graph?: GraphKey): Promise<AnswerResponse> {
  const raw = await requestJson<unknown>('/answer', {
    method: 'POST',
    body: JSON.stringify(request),
    signal,
  }, graphParam(graph));
  return normalizeAnswerResponse(raw, request.question);
}

export async function getExplain(params: { label?: string; id?: string }, signal?: AbortSignal, graph?: GraphKey): Promise<ExplainResponse> {
  return requestJson<ExplainResponse>('/explain', { signal }, { ...params, ...graphParam(graph) });
}

export async function getSubgraph(params: {
  node_id: string;
  depth?: number;
  max_nodes?: number;
  max_edges?: number;
}, signal?: AbortSignal, graph?: GraphKey): Promise<GraphPayloadDTO> {
  const raw = await requestJson<unknown>('/subgraph', { signal }, { ...params, ...graphParam(graph) });
  return normalizeGraphPayload(raw);
}

export async function postSubgraph3d(request: {
  question?: string;
  node_id?: string;
  max_nodes?: number;
  max_edges?: number;
}, signal?: AbortSignal, graph?: GraphKey): Promise<GraphPayloadDTO> {
  const raw = await requestJson<unknown>('/subgraph/3d', {
    method: 'POST',
    body: JSON.stringify(request),
    signal,
  }, graphParam(graph));
  return normalizeGraphPayload(raw);
}

export async function getCommunities3d(signal?: AbortSignal, graph?: GraphKey): Promise<CommunityPayloadDTO> {
  const raw = await requestJson<unknown>('/communities/3d', { signal }, graphParam(graph));
  return normalizeCommunityPayload(raw);
}

export interface FullGraph3dParams extends Record<string, string | number | boolean | null | undefined> {
  edge_mode?: EdgeMode;
  focus_node_id?: string;
  confirm_all_edges?: boolean;
  node_limit?: number;
  edge_limit?: number;
  min_degree?: number;
  community_id?: string;
  static_layout?: boolean;
  static_layout_mode?: StaticLayoutMode;
}

export async function getFullGraph3d(params: FullGraph3dParams, signal?: AbortSignal, graph?: GraphKey): Promise<GraphPayloadDTO> {
  const raw = await requestJson<unknown>('/graph/full-3d', { signal }, { ...params, ...graphParam(graph) });
  return normalizeGraphPayload(raw);
}

interface FullGraphWorkerResponse {
  id: string;
  ok: boolean;
  payload?: GraphPayloadDTO;
  message?: string;
  status?: number;
  detail?: unknown;
}

interface EdgeTileBinaryWorkerResponse {
  id: string;
  ok: boolean;
  payload?: EdgeTileResponse;
  message?: string;
  status?: number;
  detail?: unknown;
}

type GraphBinaryWorkerRequestType =
  | 'INIT_GRAPH_NODES_BINARY'
  | 'LOAD_EDGE_TILE_BINARY'
  | 'CLEAR_GRAPH'
  | 'GET_STATS'
  | 'ABORT_REQUEST';

interface GraphBinaryWorkerMessage {
  id: string;
  type: GraphBinaryWorkerRequestType | string;
  ok?: boolean;
  payload?: unknown;
  message?: string;
  status?: number;
  detail?: unknown;
  stats?: GraphBinaryWorkerStats;
}

interface PendingGraphBinaryWorkerRequest {
  resolve: (message: GraphBinaryWorkerMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof globalThis.setTimeout>;
  abortFromExternal?: () => void;
  signal?: AbortSignal;
}

function supportsFullGraphWorker(): boolean {
  return typeof Worker !== 'undefined' && typeof URL !== 'undefined';
}

let graphBinaryWorker: Worker | null = null;
const graphBinaryWorkerPending = new Map<string, PendingGraphBinaryWorkerRequest>();

function requestId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function rejectGraphBinaryWorkerPending(error: Error): void {
  graphBinaryWorkerPending.forEach((pending, id) => {
    globalThis.clearTimeout(pending.timeout);
    pending.signal?.removeEventListener('abort', pending.abortFromExternal ?? (() => undefined));
    pending.reject(error);
    graphBinaryWorkerPending.delete(id);
  });
}

function ensureGraphBinaryWorker(): Worker | null {
  if (!supportsFullGraphWorker()) return null;
  if (graphBinaryWorker) return graphBinaryWorker;

  try {
    graphBinaryWorker = new Worker(new URL('./graphBinaryWorker.ts', import.meta.url), { type: 'module' });
  } catch {
    graphBinaryWorker = null;
    return null;
  }

  graphBinaryWorker.onmessage = (event: MessageEvent<GraphBinaryWorkerMessage>) => {
    const message = event.data;
    const pending = graphBinaryWorkerPending.get(message.id);
    if (!pending) return;
    graphBinaryWorkerPending.delete(message.id);
    globalThis.clearTimeout(pending.timeout);
    pending.signal?.removeEventListener('abort', pending.abortFromExternal ?? (() => undefined));
    if (message.ok) {
      pending.resolve(message);
      return;
    }
    pending.reject(new ApiError(message.message || 'Graph binary worker request failed', message.status, message.detail));
  };
  graphBinaryWorker.onerror = (event) => {
    const message = event.message || 'Graph binary worker failed';
    graphBinaryWorker?.terminate();
    graphBinaryWorker = null;
    rejectGraphBinaryWorkerPending(new ApiError(message));
  };
  return graphBinaryWorker;
}

export function initGraphBinaryWorker(): boolean {
  return Boolean(ensureGraphBinaryWorker());
}

export function disposeGraphBinaryWorker(): void {
  graphBinaryWorker?.terminate();
  graphBinaryWorker = null;
  rejectGraphBinaryWorkerPending(new ApiError('Graph binary worker disposed'));
}

async function postGraphBinaryWorkerMessage<T>(
  message: Omit<GraphBinaryWorkerMessage, 'id' | 'ok' | 'payload' | 'message' | 'status' | 'detail' | 'stats'> & {
    apiBaseUrl?: string;
    path?: string;
    params?: Record<string, string | number | boolean | null | undefined>;
  },
  signal?: AbortSignal,
): Promise<{ payload: T; stats?: GraphBinaryWorkerStats }> {
  const worker = ensureGraphBinaryWorker();
  if (!worker) throw new ApiError('Graph binary worker is unavailable');

  return new Promise<{ payload: T; stats?: GraphBinaryWorkerStats }>((resolve, reject) => {
    const id = requestId();
    const abortFromExternal = () => {
      worker.postMessage({ id: `abort-${id}`, type: 'ABORT_REQUEST', targetId: id });
      const pending = graphBinaryWorkerPending.get(id);
      if (pending) {
        graphBinaryWorkerPending.delete(id);
        globalThis.clearTimeout(pending.timeout);
      }
      reject(new ApiError('요청이 취소되었습니다.', 499));
    };
    const timeout = globalThis.setTimeout(() => {
      graphBinaryWorkerPending.delete(id);
      signal?.removeEventListener('abort', abortFromExternal);
      worker.postMessage({ id: `abort-${id}`, type: 'ABORT_REQUEST', targetId: id });
      reject(new ApiError('Graph binary worker 요청 시간이 초과되었습니다. JSON fallback 또는 더 작은 tile_size를 사용하세요.'));
    }, FULL_GRAPH_WORKER_TIMEOUT_MS);

    if (signal?.aborted) {
      globalThis.clearTimeout(timeout);
      reject(new ApiError('요청이 취소되었습니다.', 499));
      return;
    }
    signal?.addEventListener('abort', abortFromExternal, { once: true });

    graphBinaryWorkerPending.set(id, {
      resolve: (response) => resolve({ payload: response.payload as T, stats: response.stats }),
      reject,
      timeout,
      abortFromExternal,
      signal,
    });
    worker.postMessage({ id, ...message });
  });
}

export async function clearGraphBinaryWorker(signal?: AbortSignal): Promise<GraphBinaryWorkerStats> {
  if (!supportsFullGraphWorker() || !graphBinaryWorker) {
    return { initialized: false, node_count: 0, payload_bytes: 0, edge_tile_count: 0 };
  }
  const response = await postGraphBinaryWorkerMessage<GraphBinaryWorkerStats>({ type: 'CLEAR_GRAPH' }, signal);
  return response.payload;
}

export async function getGraphBinaryWorkerStats(signal?: AbortSignal): Promise<GraphBinaryWorkerStats> {
  if (!supportsFullGraphWorker() || !graphBinaryWorker) {
    return { initialized: false, node_count: 0, payload_bytes: 0, edge_tile_count: 0 };
  }
  const response = await postGraphBinaryWorkerMessage<GraphBinaryWorkerStats>({ type: 'GET_STATS' }, signal);
  return response.payload;
}

export async function getFullGraph3dWithWorker(params: FullGraph3dParams, signal?: AbortSignal, graph?: GraphKey): Promise<GraphPayloadDTO> {
  if (!supportsFullGraphWorker()) return getFullGraph3d(params, signal, graph);

  return new Promise<GraphPayloadDTO>((resolve, reject) => {
    const worker = new Worker(new URL('./fullGraphWorker.ts', import.meta.url), { type: 'module' });
    const requestId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let settled = false;
    const cleanup = () => {
      worker.terminate();
      signal?.removeEventListener('abort', abortFromExternal);
      globalThis.clearTimeout(timeout);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const abortFromExternal = () => {
      settle(() => reject(new ApiError('요청이 취소되었습니다.', 499)));
    };
    const timeout = globalThis.setTimeout(() => {
      settle(() => reject(new ApiError('Full 3D worker 요청 시간이 초과되었습니다. edge tile 또는 hidden mode로 다시 시도하세요.')));
    }, FULL_GRAPH_WORKER_TIMEOUT_MS);

    if (signal?.aborted) {
      abortFromExternal();
      return;
    }
    signal?.addEventListener('abort', abortFromExternal, { once: true });
    worker.onmessage = (event: MessageEvent<FullGraphWorkerResponse>) => {
      const message = event.data;
      if (message.id !== requestId) return;
      if (message.ok && message.payload) {
        settle(() => resolve(message.payload as GraphPayloadDTO));
        return;
      }
      settle(() => reject(new ApiError(message.message || 'Full graph worker request failed', message.status, message.detail)));
    };
    worker.onerror = (event) => {
      settle(() => reject(new ApiError(event.message || 'Full graph worker failed')));
    };
    worker.postMessage({
      id: requestId,
      apiBaseUrl: API_BASE_URL,
      path: '/graph/full-3d',
      params: { ...params, ...graphParam(graph) },
    });
  });
}

export async function getFullGraphNodesBinaryWithWorker(
  params: FullGraph3dParams = {},
  signal?: AbortSignal,
  graph?: GraphKey,
): Promise<GraphPayloadDTO> {
  const jsonFallbackParams: FullGraph3dParams = { ...params, edge_mode: 'hidden' };
  if (!supportsFullGraphWorker()) return getFullGraph3d(jsonFallbackParams, signal, graph);

  try {
    const response = await postGraphBinaryWorkerMessage<GraphPayloadDTO>(
      {
        type: 'INIT_GRAPH_NODES_BINARY',
        apiBaseUrl: API_BASE_URL,
        path: '/graph/full-3d/nodes/binary',
        params: { ...jsonFallbackParams, ...graphParam(graph) },
      },
      signal,
    );
    return response.payload;
  } catch (error) {
    if (error instanceof ApiError && error.status === 499) throw error;
    await clearGraphBinaryWorker().catch(() => undefined);
    return getFullGraph3d(jsonFallbackParams, signal, graph);
  }
}

export interface FullGraphEdgeTileParams extends Record<string, string | number | boolean | null | undefined> {
  edge_mode?: EdgeMode;
  focus_node_id?: string;
  confirm_all_edges?: boolean;
  tile?: number;
  tile_size?: number;
  node_limit?: number;
  min_degree?: number;
  community_id?: string;
  lod_layer?: string;
}

export async function getFullGraphEdgeTile(params: FullGraphEdgeTileParams, signal?: AbortSignal, graph?: GraphKey): Promise<EdgeTileResponse> {
  const raw = await requestJson<unknown>('/graph/full-3d/edge-tile', { signal }, { ...params, ...graphParam(graph) });
  return normalizeEdgeTileResponse(raw);
}

export async function getFullGraphEdgeTileBinaryWithPersistentWorker(
  params: FullGraphEdgeTileParams,
  signal?: AbortSignal,
  graph?: GraphKey,
): Promise<EdgeTileResponse> {
  if (!supportsFullGraphWorker()) return getFullGraphEdgeTile(params, signal, graph);

  try {
    const response = await postGraphBinaryWorkerMessage<EdgeTileResponse>(
      {
        type: 'LOAD_EDGE_TILE_BINARY',
        apiBaseUrl: API_BASE_URL,
        path: '/graph/full-3d/edge-tile/binary',
        params: { ...params, ...graphParam(graph) },
      },
      signal,
    );
    return response.payload;
  } catch (error) {
    if (error instanceof ApiError && error.status === 499) throw error;
    return getFullGraphEdgeTile(params, signal, graph);
  }
}

export async function getFullGraphEdgeTileBinaryWithWorker(
  params: FullGraphEdgeTileParams,
  nodeIds: string[],
  signal?: AbortSignal,
  graph?: GraphKey,
): Promise<EdgeTileResponse> {
  if (!supportsFullGraphWorker()) return getFullGraphEdgeTile(params, signal, graph);

  try {
    return await new Promise<EdgeTileResponse>((resolve, reject) => {
      const worker = new Worker(new URL('./edgeTileBinaryWorker.ts', import.meta.url), { type: 'module' });
      const requestId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      let settled = false;
      const cleanup = () => {
        worker.terminate();
        signal?.removeEventListener('abort', abortFromExternal);
        globalThis.clearTimeout(timeout);
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const abortFromExternal = () => {
        settle(() => reject(new ApiError('요청이 취소되었습니다.', 499)));
      };
      const timeout = globalThis.setTimeout(() => {
        settle(() => reject(new ApiError('Binary edge tile worker 요청 시간이 초과되었습니다. JSON tile fallback 또는 더 작은 tile_size를 사용하세요.')));
      }, FULL_GRAPH_WORKER_TIMEOUT_MS);

      if (signal?.aborted) {
        abortFromExternal();
        return;
      }
      signal?.addEventListener('abort', abortFromExternal, { once: true });
      worker.onmessage = (event: MessageEvent<EdgeTileBinaryWorkerResponse>) => {
        const message = event.data;
        if (message.id !== requestId) return;
        if (message.ok && message.payload) {
          settle(() => resolve(message.payload as EdgeTileResponse));
          return;
        }
        settle(() => reject(new ApiError(message.message || 'Binary edge tile worker request failed', message.status, message.detail)));
      };
      worker.onerror = (event) => {
        settle(() => reject(new ApiError(event.message || 'Binary edge tile worker failed')));
      };
      worker.postMessage({
        id: requestId,
        apiBaseUrl: API_BASE_URL,
        path: '/graph/full-3d/edge-tile/binary',
        params: { ...params, ...graphParam(graph) },
        nodeIds,
      });
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 499) throw error;
    return getFullGraphEdgeTile(params, signal, graph);
  }
}

export async function getSource(path: string, signal?: AbortSignal, graph?: GraphKey): Promise<SourceResponse> {
  return requestJson<SourceResponse>('/source', { signal }, { path, ...graphParam(graph) });
}

export async function getPrecedentsHealth(signal?: AbortSignal): Promise<PrecedentHealthResponse> {
  const raw = await requestJson<unknown>('/precedents/health', { signal });
  return normalizePrecedentHealth(raw);
}

export async function searchPrecedents(request: PrecedentSearchRequest, signal?: AbortSignal): Promise<PrecedentSearchResponse> {
  const raw = await requestJson<unknown>('/precedents/search', { signal }, {
    q: request.q,
    category: request.category,
    court: request.court,
    limit: request.limit,
  });
  return normalizePrecedentSearchResponse(raw, request.q);
}

export async function getPrecedentSource(path: string, signal?: AbortSignal): Promise<PrecedentSourceResponse> {
  const raw = await requestJson<unknown>('/precedents/source', { signal }, { path });
  return normalizePrecedentSourceResponse(raw, path);
}

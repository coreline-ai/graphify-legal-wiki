import {
  normalizeAnswerResponse,
  normalizeCommunityPayload,
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
  ExplainResponse,
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
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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
    window.clearTimeout(timeout);
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

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
const REQUEST_TIMEOUT_MS = 18_000;

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
      const message = typeof payload === 'string' ? payload : payload?.message ?? payload?.detail ?? response.statusText;
      throw new ApiError(String(message), response.status, payload);
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

export async function getHealth(signal?: AbortSignal): Promise<NormalizedHealth> {
  const raw = await requestJson<HealthResponse>('/health', { signal });
  return normalizeHealth(raw);
}

export async function getSuggestedQuestions(signal?: AbortSignal): Promise<string[]> {
  const raw = await requestJson<unknown>('/suggested-questions', { signal });
  return normalizeSuggestedQuestions(raw);
}

export async function postQuery(request: QueryRequest, signal?: AbortSignal): Promise<QueryResponse> {
  const raw = await requestJson<unknown>('/query', {
    method: 'POST',
    body: JSON.stringify(request),
    signal,
  });
  return normalizeQueryResponse(raw, request.question);
}

export async function postAnswer(request: AnswerRequest, signal?: AbortSignal): Promise<AnswerResponse> {
  const raw = await requestJson<unknown>('/answer', {
    method: 'POST',
    body: JSON.stringify(request),
    signal,
  });
  return normalizeAnswerResponse(raw, request.question);
}

export async function getExplain(params: { label?: string; id?: string }, signal?: AbortSignal): Promise<ExplainResponse> {
  return requestJson<ExplainResponse>('/explain', { signal }, params);
}

export async function getSubgraph(params: {
  node_id: string;
  depth?: number;
  max_nodes?: number;
  max_edges?: number;
}, signal?: AbortSignal): Promise<GraphPayloadDTO> {
  const raw = await requestJson<unknown>('/subgraph', { signal }, params);
  return normalizeGraphPayload(raw);
}

export async function postSubgraph3d(request: {
  question?: string;
  node_id?: string;
  max_nodes?: number;
  max_edges?: number;
}, signal?: AbortSignal): Promise<GraphPayloadDTO> {
  const raw = await requestJson<unknown>('/subgraph/3d', {
    method: 'POST',
    body: JSON.stringify(request),
    signal,
  });
  return normalizeGraphPayload(raw);
}

export async function getCommunities3d(signal?: AbortSignal): Promise<CommunityPayloadDTO> {
  const raw = await requestJson<unknown>('/communities/3d', { signal });
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

export async function getFullGraph3d(params: FullGraph3dParams, signal?: AbortSignal): Promise<GraphPayloadDTO> {
  const raw = await requestJson<unknown>('/graph/full-3d', { signal }, params);
  return normalizeGraphPayload(raw);
}

export async function getSource(path: string, signal?: AbortSignal): Promise<SourceResponse> {
  return requestJson<SourceResponse>('/source', { signal }, { path });
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

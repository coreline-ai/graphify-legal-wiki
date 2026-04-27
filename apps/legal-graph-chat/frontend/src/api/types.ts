export type EdgeMode = 'hidden' | 'focus' | 'all';
export type StaticLayoutMode = 'clustered' | 'circular' | 'spherical' | (string & {});
export type WorkspaceTab = 'chat' | 'precedents' | 'subgraph' | 'communities' | 'full3d' | 'verify';
export type GraphKey = 'legalize-kr' | 'precedent-kr';

export type Confidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS' | 'UNKNOWN' | string;
export type AnswerMode = 'deterministic' | 'extractive' | 'llm' | 'disabled' | string;

export interface HealthResponse {
  ok?: boolean;
  status?: string;
  loaded?: boolean;
  graph_loaded?: boolean;
  nodes?: number;
  edges?: number;
  communities?: number;
  node_count?: number;
  edge_count?: number;
  community_count?: number;
  graph_version?: string;
  graph_hash?: string;
  updated_at?: string;
  data_path?: string;
  graph?: {
    nodes?: number;
    edges?: number;
    communities?: number;
    version?: string;
    hash?: string;
  };
  warnings?: string[];
  message?: string;
}

export interface NormalizedHealth {
  ok: boolean;
  statusText: string;
  loaded: boolean;
  nodes: number | null;
  edges: number | null;
  communities: number | null;
  version?: string;
  hash?: string;
  warnings: string[];
  message?: string;
}

export interface GraphCatalogItem {
  id: GraphKey;
  label: string;
  description?: string;
  default_question?: string;
  data_root?: string;
  graph_path?: string;
  available?: boolean;
  loaded?: boolean;
  graph_size_bytes?: number | null;
  generated_at?: string | null;
  mode?: string | null;
  nodes?: number | null;
  edges?: number | null;
  communities?: number | null;
  warnings?: string[];
}

export interface GraphCatalogResponse {
  default_graph: GraphKey;
  graphs: GraphCatalogItem[];
}

export interface QueryRequest {
  question: string;
  max_nodes?: number;
  max_edges?: number;
}

export interface GraphNodeDTO {
  id: string;
  label: string;
  community?: number | string | null;
  degree?: number | null;
  type?: string;
  file_type?: string;
  source_file?: string;
  source_url?: string;
  path?: string;
  score?: number | null;
  size?: number | null;
  is_hub?: boolean;
  x?: number;
  y?: number;
  z?: number;
  metadata?: Record<string, unknown>;
}

export interface GraphEdgeDTO {
  id?: string;
  source: string;
  target: string;
  relation?: string;
  confidence?: Confidence;
  confidence_score?: number | null;
  weight?: number | null;
  source_file?: string;
  source_url?: string;
  path?: string;
  metadata?: Record<string, unknown>;
}

export interface GraphPayloadDTO {
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
  seed_node_ids?: string[];
  focus_node_id?: string;
  edge_mode?: EdgeMode;
  layout_mode?: StaticLayoutMode;
  label?: string;
  generated_at?: string;
  partial?: boolean;
  warnings?: string[];
}

export interface EvidenceItem {
  id: string;
  label: string;
  relation: string;
  confidence: Confidence;
  source_file?: string;
  source_url?: string;
  path?: string;
  community?: number | string | null;
  degree?: number | null;
  score?: number | null;
  rationale?: string;
  node_id?: string;
  target?: string;
}

export interface RankReason {
  matched_terms: string[];
  seed_nodes?: GraphNodeDTO[];
  hub_dampening_applied?: boolean;
  stop_hub_threshold?: number;
  max_degree?: number;
}

export interface QueryResponse {
  question?: string;
  summary?: string;
  answer?: string;
  evidence?: EvidenceItem[];
  graph?: GraphPayloadDTO;
  rank_reason?: RankReason;
  warnings?: string[];
  no_evidence?: boolean;
}

export interface Citation {
  id: string;
  label?: string;
  source_file?: string;
  source_url?: string;
  path?: string;
  quote?: string;
  excerpt?: string;
  line_start?: number | null;
  line_end?: number | null;
  evidence_id?: string;
  metadata?: Record<string, unknown>;
}

export interface LlmStatus {
  status?: string;
  enabled?: boolean;
  provider?: string;
  model?: string;
  fallback?: boolean;
  reason?: string;
  warnings?: string[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ValidatedCitation extends Citation {
  valid?: boolean;
  status?: string;
  score?: number | null;
  reason?: string;
  warning?: string;
}

export interface AnswerRequest {
  question: string;
  mode?: AnswerMode;
  max_nodes?: number;
  max_edges?: number;
  include_graph?: boolean;
}

export interface AnswerResponse {
  question?: string;
  answer: string;
  summary?: string;
  mode: AnswerMode;
  provider?: string;
  model?: string;
  llm_status?: string | LlmStatus;
  disclaimer: string;
  warnings: string[];
  citations: Citation[];
  validated_citations?: ValidatedCitation[];
  evidence: EvidenceItem[];
  graph?: GraphPayloadDTO;
  generated_at?: string;
  no_evidence?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ExplainResponse {
  id?: string;
  label?: string;
  summary?: string;
  evidence?: EvidenceItem[];
  node?: GraphNodeDTO;
  graph?: GraphPayloadDTO;
  source_file?: string;
  warnings?: string[];
}

export interface CommunityDTO extends GraphNodeDTO {
  member_count?: number;
  edge_count?: number;
  god_nodes?: string[];
  top_nodes?: string[];
  cohesion?: number | null;
}

export interface CommunityPayloadDTO {
  communities: CommunityDTO[];
  edges: GraphEdgeDTO[];
  generated_at?: string;
  partial?: boolean;
  warnings?: string[];
}

export interface SourceResponse {
  path: string;
  content: string;
  language?: string;
  truncated?: boolean;
  start_line?: number;
  end_line?: number;
}

export interface PrecedentHealthResponse {
  ok: boolean;
  status?: string;
  available?: boolean;
  enabled?: boolean;
  file_count: number | null;
  category_count: number | null;
  categories: string[];
  courts: string[];
  indexed_at?: string;
  warnings: string[];
  message?: string;
  backend_status?: unknown;
  index_status?: unknown;
  metadata?: Record<string, unknown>;
}

export interface PrecedentSearchRequest {
  q: string;
  category?: string;
  court?: string;
  limit?: number;
}

export interface PrecedentSearchResult {
  id: string;
  title: string;
  summary?: string;
  excerpt?: string;
  category?: string;
  court?: string;
  path: string;
  source_path?: string;
  case_number?: string;
  date?: string;
  score?: number | null;
  scores?: Record<string, unknown>;
  rank_explain?: unknown;
  metadata?: Record<string, unknown>;
}

export interface PrecedentSearchResponse {
  query: string;
  results: PrecedentSearchResult[];
  total: number | null;
  limit?: number;
  warnings: string[];
  backend_status?: unknown;
  index_status?: unknown;
  rank_explain?: unknown;
  scores?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface PrecedentSourceResponse {
  path: string;
  content: string;
  title?: string;
  category?: string;
  court?: string;
  language?: string;
  truncated?: boolean;
  start_line?: number;
  end_line?: number;
  warnings: string[];
}

export interface SuggestedQuestionsResponse {
  questions: string[];
}

export interface ApiErrorShape {
  message: string;
  status?: number;
  detail?: unknown;
}

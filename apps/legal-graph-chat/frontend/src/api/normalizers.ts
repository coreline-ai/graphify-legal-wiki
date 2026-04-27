import type {
  AnswerMode,
  AnswerResponse,
  Citation,
  CommunityPayloadDTO,
  EdgeMode,
  EdgeTileResponse,
  EvidenceItem,
  GraphEdgeDTO,
  GraphNodeDTO,
  GraphPayloadDTO,
  HealthResponse,
  LlmStatus,
  NormalizedHealth,
  PrecedentHealthResponse,
  PrecedentSearchResponse,
  PrecedentSearchResult,
  PrecedentSourceResponse,
  QueryResponse,
  StaticLayoutMode,
  ValidatedCitation,
} from './types';

const fallbackSummary =
  '근거가 있는 노드와 엣지를 기준으로 한 그래프 탐색 결과입니다. 각 항목의 source file을 확인해 검증하세요.';
const fallbackAnswerDisclaimer =
  '이 답변은 그래프/판례 문서 탐색을 돕기 위한 source-grounded 설명이며 법률 자문, 법적 판단, 행동 권고가 아닙니다.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringFrom(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
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

function stringArrayFrom(value: unknown): string[] {
  return arrayFrom<unknown>(value)
    .map((item) => stringFrom(item))
    .filter(Boolean);
}

function metadataFrom(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function optionalStatusFrom(value: unknown): string | Record<string, unknown> | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (isRecord(value)) return value;
  return stringFrom(value);
}

export function normalizeHealth(raw: HealthResponse | null | undefined): NormalizedHealth {
  const graph = raw?.graph ?? {};
  const nodes = raw?.nodes ?? raw?.node_count ?? graph.nodes ?? null;
  const edges = raw?.edges ?? raw?.edge_count ?? graph.edges ?? null;
  const communities = raw?.communities ?? raw?.community_count ?? graph.communities ?? null;
  const loaded = Boolean(raw?.loaded ?? raw?.graph_loaded ?? raw?.ok);
  const ok = Boolean(raw?.ok ?? loaded);

  return {
    ok,
    loaded,
    statusText: raw?.status ?? (ok ? 'ready' : 'unavailable'),
    nodes: numberFrom(nodes),
    edges: numberFrom(edges),
    communities: numberFrom(communities),
    version: raw?.graph_version ?? graph.version,
    hash: raw?.graph_hash ?? graph.hash,
    warnings: raw?.warnings ?? [],
    message: raw?.message,
  };
}

export function normalizeNode(raw: unknown, index = 0): GraphNodeDTO {
  const record = isRecord(raw) ? raw : {};
  const id = stringFrom(record.id ?? record.node_id ?? record.key ?? record.label, `node-${index}`);
  const label = stringFrom(record.label ?? record.name ?? record.title ?? id, id);

  return {
    id,
    label,
    community: (record.community ?? record.community_id ?? null) as string | number | null,
    degree: numberFrom(record.degree ?? record.reference_count ?? record.count),
    type: stringFrom(record.type ?? record.kind, 'node'),
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
    metadata: record,
  };
}

export function normalizeEdge(raw: unknown, index = 0): GraphEdgeDTO {
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
    metadata: record,
  };
}

export function normalizeGraphPayload(raw: unknown): GraphPayloadDTO {
  const record = isRecord(raw) ? raw : {};
  const nodes = arrayFrom<unknown>(record.nodes).map(normalizeNode);
  const edges = arrayFrom<unknown>(record.edges)
    .map(normalizeEdge)
    .filter((edge) => edge.source && edge.target);
  const layoutMode = stringFrom(record.layout_mode ?? record.static_layout_mode, '') as StaticLayoutMode;

  return {
    nodes,
    edges,
    seed_node_ids: arrayFrom<string>(record.seed_node_ids ?? record.seeds),
    focus_node_id: stringFrom(record.focus_node_id ?? record.focus, ''),
    edge_mode: record.edge_mode === 'hidden' || record.edge_mode === 'focus' || record.edge_mode === 'all' ? record.edge_mode : undefined,
    layout_mode: layoutMode || undefined,
    label: stringFrom(record.label ?? record.title, ''),
    generated_at: stringFrom(record.generated_at, ''),
    partial: booleanFrom(record.partial),
    warnings: arrayFrom<string>(record.warnings),
  };
}

export function normalizeEdgeTileResponse(raw: unknown): EdgeTileResponse {
  const record = isRecord(raw) ? raw : {};
  const edgeMode = record.edge_mode === 'hidden' || record.edge_mode === 'focus' || record.edge_mode === 'all'
    ? record.edge_mode
    : 'all';
  return {
    graph: stringFrom(record.graph, ''),
    edge_mode: edgeMode as EdgeMode,
    tile: numberFrom(record.tile) ?? 0,
    tile_size: numberFrom(record.tile_size) ?? 0,
    returned_edges: numberFrom(record.returned_edges) ?? 0,
    total_edges: numberFrom(record.total_edges) ?? 0,
    has_more: Boolean(record.has_more),
    focus_node_id: stringFrom(record.focus_node_id, '') || null,
    nodes_in_scope: numberFrom(record.nodes_in_scope),
    lod_layer: stringFrom(record.lod_layer, '') || null,
    edges: arrayFrom<unknown>(record.edges).map(normalizeEdge).filter((edge) => edge.source && edge.target),
    warnings: arrayFrom<string>(record.warnings),
  };
}

export function normalizeEvidence(raw: unknown, index = 0): EvidenceItem {
  const record = isRecord(raw) ? raw : {};
  const node = isRecord(record.node) ? record.node : undefined;
  const label = stringFrom(record.label ?? record.title ?? node?.label ?? record.node_id, `Evidence ${index + 1}`);
  const nodeId = stringFrom(record.node_id ?? record.id ?? node?.id ?? label, label);

  return {
    id: stringFrom(record.id ?? nodeId, `evidence-${index}`),
    label,
    relation: stringFrom(record.relation ?? record.type ?? record.edge_relation, 'related'),
    confidence: stringFrom(record.confidence ?? record.evidence_type, 'UNKNOWN'),
    source_file: stringFrom(record.source_file ?? record.source ?? record.file ?? node?.source_file, ''),
    source_url: stringFrom(record.source_url ?? node?.source_url, ''),
    path: stringFrom(record.path ?? record.source_path ?? node?.path, ''),
    community: (record.community ?? record.community_id ?? node?.community ?? null) as string | number | null,
    degree: numberFrom(record.degree ?? node?.degree),
    score: numberFrom(record.score ?? record.rank),
    rationale: stringFrom(record.rationale ?? record.reason ?? record.summary, ''),
    node_id: nodeId,
    target: stringFrom(record.target ?? record.target_label, ''),
  };
}

function evidenceFromGraph(graph: GraphPayloadDTO): EvidenceItem[] {
  return graph.nodes
    .filter((node) => node.source_file || node.path)
    .slice(0, 8)
    .map((node, index) => ({
      id: `node-evidence-${node.id}-${index}`,
      label: node.label,
      relation: 'node-source',
      confidence: 'EXTRACTED',
      source_file: node.source_file,
      path: node.path,
      community: node.community,
      degree: node.degree,
      score: node.score,
      node_id: node.id,
      rationale: '응답 그래프에 source file이 연결된 노드입니다.',
    }));
}

export function normalizeQueryResponse(raw: unknown, question: string): QueryResponse {
  const record = isRecord(raw) ? raw : {};
  const graphCandidate = record.graph ?? record.subgraph ?? { nodes: record.nodes, edges: record.edges };
  const graph = normalizeGraphPayload(graphCandidate);
  const rawEvidence = record.evidence ?? record.sources ?? record.items ?? record.matches;
  let evidence = arrayFrom<unknown>(rawEvidence).map(normalizeEvidence);

  if (evidence.length === 0) {
    evidence = evidenceFromGraph(graph);
  }

  const hasEvidence = evidence.some((item) => item.source_file || item.path || item.relation || item.node_id);
  const summary = hasEvidence
    ? stringFrom(record.summary ?? record.answer ?? record.message, fallbackSummary)
    : '표시 가능한 source/evidence가 없어 답변 요약을 제한했습니다. 질문을 좁히거나 backend evidence payload를 확인하세요.';

  return {
    question: stringFrom(record.question, question),
    summary,
    answer: hasEvidence ? stringFrom(record.answer, '') : '',
    evidence,
    graph,
    rank_reason: isRecord(record.rank_reason)
      ? {
          matched_terms: arrayFrom<string>(record.rank_reason.matched_terms),
          seed_nodes: arrayFrom<unknown>(record.rank_reason.seed_nodes).map(normalizeNode),
          hub_dampening_applied: Boolean(record.rank_reason.hub_dampening_applied),
          stop_hub_threshold: numberFrom(record.rank_reason.stop_hub_threshold) ?? undefined,
          max_degree: numberFrom(record.rank_reason.max_degree) ?? undefined,
        }
      : undefined,
    warnings: arrayFrom<string>(record.warnings),
    no_evidence: !hasEvidence,
  };
}

export function normalizeCitation(raw: unknown, index = 0): Citation {
  const record = isRecord(raw) ? raw : {};
  const path = stringFrom(record.path ?? record.source_path ?? record.source_file ?? record.file, '');
  const label = stringFrom(record.label ?? record.title ?? record.source_file ?? record.path, '') || path || `Citation ${index + 1}`;

  return {
    id: stringFrom(record.id ?? record.evidence_id ?? (path || label), `citation-${index}`),
    label,
    source_file: stringFrom(record.source_file ?? record.source ?? record.file, ''),
    source_url: stringFrom(record.source_url ?? record.url, ''),
    path,
    quote: stringFrom(record.quote, ''),
    excerpt: stringFrom(record.excerpt ?? record.snippet ?? record.preview, ''),
    line_start: numberFrom(record.line_start ?? record.start_line),
    line_end: numberFrom(record.line_end ?? record.end_line),
    evidence_id: stringFrom(record.evidence_id ?? record.evidence, ''),
    metadata: record,
  };
}

export function normalizeValidatedCitation(raw: unknown, index = 0): ValidatedCitation {
  const record = isRecord(raw) ? raw : {};
  const citationSource = isRecord(record.citation) ? record.citation : record;
  const citation = normalizeCitation(citationSource, index);
  const validValue = record.valid ?? record.ok ?? record.is_valid;

  return {
    ...citation,
    valid: typeof validValue === 'boolean' ? validValue : undefined,
    status: stringFrom(record.status ?? record.validation_status ?? record.state, ''),
    score: numberFrom(record.score ?? record.confidence_score ?? record.validation_score),
    reason: stringFrom(record.reason ?? record.message ?? record.rationale, ''),
    warning: stringFrom(record.warning ?? record.error, ''),
    metadata: record,
  };
}

function citationFromEvidence(evidence: EvidenceItem, index: number): Citation {
  return {
    id: `evidence-citation-${evidence.id || index}`,
    label: evidence.label,
    source_file: evidence.source_file,
    source_url: evidence.source_url,
    path: evidence.path || evidence.source_file || '',
    excerpt: evidence.rationale,
    evidence_id: evidence.id,
  };
}

export function normalizeAnswerResponse(raw: unknown, question: string): AnswerResponse {
  const record = isRecord(raw) ? raw : {};
  const graphCandidate = record.graph ?? record.subgraph;
  const graph = graphCandidate ? normalizeGraphPayload(graphCandidate) : undefined;
  const rawEvidence = record.evidence ?? record.sources ?? record.items ?? record.matches;
  const answerMetadata = metadataFrom(record.metadata);
  const llmStatus = optionalStatusFrom(record.llm_status ?? record.llm ?? record.generation_status) as string | LlmStatus | undefined;
  const llmStatusRecord: Record<string, unknown> = isRecord(llmStatus) ? llmStatus : {};
  let evidence = arrayFrom<unknown>(rawEvidence).map(normalizeEvidence);
  let citations = arrayFrom<unknown>(record.citations ?? record.references).map(normalizeCitation);
  const validatedCitations = arrayFrom<unknown>(record.validated_citations ?? record.citation_validation ?? record.validations)
    .map(normalizeValidatedCitation);

  if (evidence.length === 0 && graph) {
    evidence = evidenceFromGraph(graph);
  }

  if (citations.length === 0 && evidence.length > 0) {
    citations = evidence
      .filter((item) => item.source_file || item.path || item.source_url)
      .slice(0, 8)
      .map(citationFromEvidence);
  }

  const answer = stringFrom(record.answer ?? record.content ?? record.text, '');
  const summary = stringFrom(record.summary ?? record.message, '');

  return {
    question: stringFrom(record.question, question),
    answer: answer || summary || '표시 가능한 source-grounded answer가 없습니다. backend /answer evidence payload를 확인하세요.',
    summary,
    mode: stringFrom(record.mode ?? record.answer_mode, 'deterministic') as AnswerMode,
    provider: stringFrom(record.provider ?? record.llm_provider ?? llmStatusRecord.provider ?? answerMetadata?.provider, ''),
    model: stringFrom(record.model ?? record.llm_model ?? llmStatusRecord.model ?? answerMetadata?.model, ''),
    llm_status: llmStatus,
    disclaimer: stringFrom(record.disclaimer ?? record.notice, fallbackAnswerDisclaimer),
    warnings: stringArrayFrom(record.warnings),
    citations,
    validated_citations: validatedCitations,
    evidence,
    graph,
    generated_at: stringFrom(record.generated_at ?? record.created_at, ''),
    no_evidence: Boolean(record.no_evidence ?? (evidence.length === 0 && citations.length === 0)),
    metadata: answerMetadata,
  };
}

export function normalizePrecedentHealth(raw: unknown): PrecedentHealthResponse {
  const record = isRecord(raw) ? raw : {};
  const categories = stringArrayFrom(record.categories);
  const courts = stringArrayFrom(record.courts);
  const fileCount = numberFrom(record.file_count ?? record.files ?? record.count ?? record.total_files);
  const categoryCount = numberFrom(record.category_count ?? record.categories_count) ?? (categories.length ? categories.length : null);
  const ok = Boolean(record.ok ?? record.available ?? record.enabled);

  return {
    ok,
    status: stringFrom(record.status, ok ? 'ready' : 'unavailable'),
    available: Boolean(record.available ?? ok),
    enabled: Boolean(record.enabled ?? ok),
    file_count: fileCount,
    category_count: categoryCount,
    categories,
    courts,
    indexed_at: stringFrom(record.indexed_at ?? record.updated_at, ''),
    warnings: stringArrayFrom(record.warnings),
    message: stringFrom(record.message, ''),
    backend_status: optionalStatusFrom(record.backend_status ?? record.backend ?? record.backend_health),
    index_status: optionalStatusFrom(record.index_status ?? record.index ?? record.search_index),
    metadata: metadataFrom(record.metadata),
  };
}

function normalizePrecedentResult(raw: unknown, index = 0): PrecedentSearchResult {
  const record = isRecord(raw) ? raw : {};
  const metadata = isRecord(record.metadata) ? record.metadata : record;
  const path = stringFrom(record.path ?? record.source_path ?? record.source_file ?? record.file_path ?? record.file, '');
  const title = stringFrom(record.title ?? record.case_name ?? record.name ?? record.label ?? record.case_number, '') || path || `Precedent ${index + 1}`;

  return {
    id: stringFrom(record.id ?? record.case_id ?? (path || title), `precedent-${index}`),
    title,
    summary: stringFrom(record.summary ?? record.description ?? record.text_preview, ''),
    excerpt: stringFrom(record.excerpt ?? record.snippet ?? record.highlight ?? record.preview, ''),
    category: stringFrom(record.category ?? metadata.category, ''),
    court: stringFrom(record.court ?? metadata.court, ''),
    path,
    source_path: stringFrom(record.source_path ?? record.source_file ?? path, ''),
    case_number: stringFrom(record.case_number ?? record.case_no ?? metadata.case_number, ''),
    date: stringFrom(record.date ?? record.decision_date ?? metadata.date, ''),
    score: numberFrom(record.score ?? record.rank),
    scores: metadataFrom(record.scores ?? record.score_breakdown ?? record.rank_scores),
    rank_explain: record.rank_explain ?? record.rank_reason ?? record.explain,
    metadata: record,
  };
}

export function normalizePrecedentSearchResponse(raw: unknown, query: string): PrecedentSearchResponse {
  const record = isRecord(raw) ? raw : {};
  const rawResults = record.results ?? record.items ?? record.matches;
  const results = arrayFrom<unknown>(rawResults).map(normalizePrecedentResult);

  return {
    query: stringFrom(record.query ?? record.q, query),
    results,
    total: numberFrom(record.total ?? record.total_count ?? record.count) ?? results.length,
    limit: numberFrom(record.limit) ?? undefined,
    warnings: stringArrayFrom(record.warnings),
    backend_status: optionalStatusFrom(record.backend_status ?? record.backend ?? record.backend_health),
    index_status: optionalStatusFrom(record.index_status ?? record.index ?? record.search_index),
    rank_explain: record.rank_explain ?? record.rank_reason ?? record.explain,
    scores: metadataFrom(record.scores ?? record.score_breakdown ?? record.rank_scores),
    metadata: metadataFrom(record.metadata),
  };
}

export function normalizePrecedentSourceResponse(raw: unknown, path: string): PrecedentSourceResponse {
  const record = isRecord(raw) ? raw : {};

  return {
    path: stringFrom(record.path ?? record.source_path, path),
    content: stringFrom(record.content ?? record.text ?? record.preview, ''),
    title: stringFrom(record.title ?? record.case_name, ''),
    category: stringFrom(record.category, ''),
    court: stringFrom(record.court, ''),
    language: stringFrom(record.language, 'text'),
    truncated: Boolean(record.truncated),
    start_line: numberFrom(record.start_line) ?? undefined,
    end_line: numberFrom(record.end_line) ?? undefined,
    warnings: stringArrayFrom(record.warnings),
  };
}

export function normalizeCommunityPayload(raw: unknown): CommunityPayloadDTO {
  const record = isRecord(raw) ? raw : {};
  const communitySource = record.communities ?? record.nodes;
  const communities = arrayFrom<unknown>(communitySource).map((item, index) => {
    const node = normalizeNode(item, index);
    const source = isRecord(item) ? item : {};
    return {
      ...node,
      id: node.id || `community-${index}`,
      label: node.label || `Community ${index}`,
      community: node.community ?? index,
      member_count: numberFrom(source.member_count ?? source.members ?? source.node_count) ?? undefined,
      edge_count: numberFrom(source.edge_count) ?? undefined,
      god_nodes: arrayFrom<string>(source.god_nodes),
      top_nodes: arrayFrom<string>(source.top_nodes ?? source.god_nodes),
      cohesion: numberFrom(source.cohesion),
    };
  });

  return {
    communities,
    edges: arrayFrom<unknown>(record.edges).map(normalizeEdge),
    generated_at: stringFrom(record.generated_at, ''),
    warnings: arrayFrom<string>(record.warnings),
  };
}

export function normalizeSuggestedQuestions(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((item) => stringFrom(item)).filter(Boolean);
  if (!isRecord(raw)) return [];
  return arrayFrom<unknown>(raw.questions ?? raw.suggested_questions)
    .map((item) => stringFrom(item))
    .filter(Boolean);
}

import {
  FormEvent,
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  ApiError,
  getCommunities3d,
  getExplain,
  getFullGraph3d,
  getGraphs,
  getHealth,
  getPrecedentSource,
  getPrecedentsHealth,
  getSource,
  getSuggestedQuestions,
  getSubgraph,
  postAnswer,
  postQuery,
  postSubgraph3d,
  searchPrecedents,
} from "./api/client";
import type {
  AnswerResponse,
  Citation,
  CommunityPayloadDTO,
  EdgeMode,
  EvidenceItem,
  GraphCatalogItem,
  GraphKey,
  GraphNodeDTO,
  GraphPayloadDTO,
  NormalizedHealth,
  PrecedentHealthResponse,
  PrecedentSearchResponse,
  PrecedentSearchResult,
  PrecedentSourceResponse,
  QueryResponse,
  StaticLayoutMode,
  ValidatedCitation,
  WorkspaceTab,
} from "./api/types";
import { EvidenceCard } from "./components/EvidenceCard";
import { HealthCard } from "./components/HealthCard";
import { WarningModal } from "./components/WarningModal";
import {
  clampInspectorWidth,
  getDefaultInspectorWidth,
  getPaneBounds,
  parsePaneLayoutPreference,
  PANE_LAYOUT_STORAGE_KEY,
  serializePaneLayoutPreference,
} from "./utils/paneLayout";
import { activeEvidenceFor } from "./utils/evidenceState";

const WebGLGraph = lazy(() =>
  import("./components/WebGLGraph").then((module) => ({
    default: module.WebGLGraph,
  })),
);

const DEFAULT_QUESTION = "개인정보 보호법 전자정부법 관계";
const LEGAL_DISCLAIMER =
  "이 UI는 법령/판례 그래프 탐색 도구입니다. 답변은 선택된 graph.json의 노드/엣지와 source file을 기반으로 한 탐색 결과이며, 법률 자문이 아닙니다.";
const GRAPH_PRESETS: Record<
  GraphKey,
  {
    label: string;
    shortLabel: string;
    description: string;
    defaultQuestion: string;
    safeNodeLimit: number;
    focusEdgeLimit: number;
    allEdgeSampleLimit: number;
    rawAllEnabled: boolean;
  }
> = {
  "legalize-kr": {
    label: "legalize-kr 법령 그래프",
    shortLabel: "법령",
    description: "법령 문서의 참조·소관·유형 관계",
    defaultQuestion: DEFAULT_QUESTION,
    safeNodeLimit: 1500,
    focusEdgeLimit: 1500,
    allEdgeSampleLimit: 12000,
    rawAllEnabled: true,
  },
  "precedent-kr": {
    label: "precedent-kr 판례 그래프",
    shortLabel: "판례",
    description: "판례 인용·법령 참조·법원/사건종류 관계",
    defaultQuestion: "손해배상 계약 해제 대법원",
    safeNodeLimit: 2500,
    focusEdgeLimit: 1800,
    allEdgeSampleLimit: 12000,
    rawAllEnabled: false,
  },
};
const DOC_LINKS = [
  { label: "GRAPH_REPORT", path: "GRAPH_REPORT.md" },
  { label: "Wiki Index", path: "wiki/index.md" },
  { label: "VERIFY", path: "VERIFY.md" },
] as const;
const PRECEDENT_DEFAULT_QUERY = "손해배상 계약 해제";
const FULL_3D_STATIC_LAYOUT_MODE: StaticLayoutMode = "spherical";
const FULL_3D_STATIC_LAYOUT_COPY = "spherical 3D layout";
const FULL_3D_SAFE_EDGE_MODE: EdgeMode = "all";

const LEGAL_REVIEW_CHECKS = [
  {
    id: "notAdvice",
    label:
      "이 화면은 법률 자문이 아니라 source-grounded 탐색임을 사용자에게 설명했습니다.",
  },
  {
    id: "citations",
    label: "답변·판례 미리보기의 citation/source를 직접 열어 확인했습니다.",
  },
  {
    id: "facts",
    label:
      "구체적 사실관계 판단, 승소 가능성, 행동 권고로 읽히는 문구가 없는지 확인했습니다.",
  },
  {
    id: "expert",
    label:
      "실제 의사결정에는 변호사 등 전문가 검토가 필요하다는 안내가 보입니다.",
  },
] as const;

type LegalReviewCheckId = (typeof LEGAL_REVIEW_CHECKS)[number]["id"];

interface LegalFeedbackState {
  risk: "clear" | "unclear" | "misread";
  notes: string;
  submitted: boolean;
}

interface StatusChip {
  label: string;
  title?: string;
  tone?: "accent" | "warning";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) {
    return (
      value
        .map(displayValue)
        .filter((item) => item !== "—")
        .join(", ") || "—"
    );
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function compactValue(value: unknown, maxLength = 72): string {
  const text = displayValue(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatBytes(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return "—";
  if (value >= 1024 * 1024 * 1024)
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (value >= 1024 * 1024)
    return `${(value / (1024 * 1024)).toFixed(0)}MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)}KB`;
  return `${value}B`;
}

function statusChipsFrom(value: unknown, label: string): StatusChip[] {
  if (value === null || value === undefined || value === "") return [];
  if (!isRecord(value)) {
    return [
      {
        label: `${label}: ${compactValue(value, 48)}`,
        title: displayValue(value),
      },
    ];
  }

  const preferredKeys = [
    "status",
    "state",
    "ok",
    "available",
    "enabled",
    "backend",
    "provider",
    "model",
    "engine",
    "index",
    "version",
    "indexed_at",
    "updated_at",
  ];
  const chips = preferredKeys
    .filter(
      (key) =>
        value[key] !== undefined && value[key] !== null && value[key] !== "",
    )
    .slice(0, 5)
    .map((key) => ({
      label: `${label} ${key}: ${compactValue(value[key], 34)}`,
      title: `${key}: ${displayValue(value[key])}`,
      tone:
        key === "status" || key === "state" ? ("accent" as const) : undefined,
    }));

  return chips.length
    ? chips
    : [
        {
          label: `${label}: ${compactValue(value, 48)}`,
          title: displayValue(value),
        },
      ];
}

function statusWarningsFrom(value: unknown, label: string): string[] {
  if (!isRecord(value)) return [];
  const warnings = Array.isArray(value.warnings)
    ? value.warnings.map(displayValue).filter(Boolean)
    : [];
  const warning =
    value.warning === undefined || value.warning === null
      ? ""
      : displayValue(value.warning);
  const error =
    value.error === undefined || value.error === null
      ? ""
      : displayValue(value.error);
  const message =
    value.message === undefined || value.message === null
      ? ""
      : displayValue(value.message);
  return [
    ...warnings,
    warning,
    error ? `${label}: ${error}` : "",
    message &&
    (warning ||
      error ||
      value.ok === false ||
      value.available === false ||
      value.enabled === false)
      ? `${label}: ${message}`
      : "",
  ].filter(Boolean);
}

function metadataChips(
  metadata: Record<string, unknown> | undefined,
  omit: string[] = [],
): StatusChip[] {
  if (!metadata) return [];
  const omitted = new Set(omit);
  return Object.entries(metadata)
    .filter(
      ([key, value]) =>
        !omitted.has(key) &&
        value !== undefined &&
        value !== null &&
        value !== "",
    )
    .slice(0, 6)
    .map(([key, value]) => ({
      label: `${key}: ${compactValue(value, 42)}`,
      title: `${key}: ${displayValue(value)}`,
    }));
}

function scoreChips(scores: unknown, label = "score"): StatusChip[] {
  if (!scores) return [];
  if (!isRecord(scores))
    return [
      {
        label: `${label}: ${compactValue(scores, 42)}`,
        title: displayValue(scores),
      },
    ];
  return Object.entries(scores)
    .filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    )
    .slice(0, 5)
    .map(([key, value]) => ({
      label: `${key}: ${compactValue(value, 28)}`,
      title: `${key}: ${displayValue(value)}`,
    }));
}

function GraphWorkspaceFallback({ label }: { label: string }) {
  return (
    <section
      className="lg-graph-viewport lg-graph-lazy-fallback"
      aria-label={`${label} loading`}
    >
      <div className="lg-graph-overlay" role="status">
        <strong>{label} workspace code 로딩 중…</strong>
        <span>
          Chat/Precedents와 분리된 3D chunk를 필요한 탭에서만 가져옵니다.
        </span>
      </div>
    </section>
  );
}

function communityToGraph(
  payload: CommunityPayloadDTO | null,
): GraphPayloadDTO | null {
  if (!payload) return null;
  return {
    nodes: payload.communities.map((community) => ({
      ...community,
      id: community.id,
      label: community.label,
      degree: community.member_count,
      size: community.size ?? Math.sqrt(community.member_count || 1),
      source_file: "",
      metadata: {
        member_count: community.member_count,
        edge_count: community.edge_count,
        god_nodes: community.god_nodes ?? community.top_nodes ?? [],
        wiki_path: wikiPathFor(community.label),
      },
    })),
    edges: payload.edges,
    edge_mode: "all",
    label: "Community Overview",
  };
}

function wikiPathFor(label: string): string {
  return `wiki/${label.trim().replace(/\s+/g, "_")}.md`;
}

function iconFor(tab: WorkspaceTab): string {
  return {
    chat: "💬",
    precedents: "§",
    subgraph: "◎",
    communities: "◌",
    full3d: "🌐",
    verify: "✓",
  }[tab];
}

function formatNullableCount(value: number | null | undefined): string {
  return typeof value === "number" ? value.toLocaleString() : "—";
}

function citationSourcePath(citation: Citation): string {
  return citation.source_file || citation.path || "";
}

function validationForCitation(
  citation: Citation,
  validations: ValidatedCitation[] | undefined,
): ValidatedCitation | undefined {
  return validations?.find(
    (item) =>
      item.id === citation.id ||
      (item.evidence_id && item.evidence_id === citation.evidence_id) ||
      citationSourcePath(item) === citationSourcePath(citation),
  );
}

function validationLabel(validation: ValidatedCitation): string {
  if (typeof validation.valid === "boolean")
    return validation.valid ? "validated" : "citation warning";
  return validation.status || "validation metadata";
}

function precedentPath(result: PrecedentSearchResult): string {
  return result.source_path || result.path;
}

function graphQuestionForPrecedent(result: PrecedentSearchResult): string {
  return [result.title, result.case_number, result.category, result.court]
    .filter(Boolean)
    .join(" ")
    .trim();
}

export default function App() {
  const [activeGraphKey, setActiveGraphKey] =
    useState<GraphKey>("legalize-kr");
  const [graphCatalog, setGraphCatalog] = useState<GraphCatalogItem[]>([]);
  const [graphCatalogError, setGraphCatalogError] = useState("");
  const [tab, setTab] = useState<WorkspaceTab>("chat");
  const [question, setQuestion] = useState(DEFAULT_QUESTION);
  const [health, setHealth] = useState<NormalizedHealth | null>(null);
  const [healthError, setHealthError] = useState("");
  const [suggested, setSuggested] = useState<string[]>([]);
  const [queryResult, setQueryResult] = useState<QueryResponse | null>(null);
  const [answerResult, setAnswerResult] = useState<AnswerResponse | null>(null);
  const [answerError, setAnswerError] = useState("");
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceItem | null>(
    null,
  );
  const [selectedCommunity, setSelectedCommunity] =
    useState<GraphNodeDTO | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [sourceText, setSourceText] = useState<string>("");
  const [sourceTitle, setSourceTitle] = useState<string>("");
  const [precedentHealth, setPrecedentHealth] =
    useState<PrecedentHealthResponse | null>(null);
  const [precedentQuery, setPrecedentQuery] = useState(PRECEDENT_DEFAULT_QUERY);
  const [precedentCategory, setPrecedentCategory] = useState("");
  const [precedentCourt, setPrecedentCourt] = useState("");
  const [precedentLimit, setPrecedentLimit] = useState(8);
  const [precedentResults, setPrecedentResults] =
    useState<PrecedentSearchResponse | null>(null);
  const [selectedPrecedent, setSelectedPrecedent] =
    useState<PrecedentSearchResult | null>(null);
  const [precedentSource, setPrecedentSource] =
    useState<PrecedentSourceResponse | null>(null);
  const [precedentError, setPrecedentError] = useState("");
  const [subgraph, setSubgraph] = useState<GraphPayloadDTO | null>(null);
  const [communityPayload, setCommunityPayload] =
    useState<CommunityPayloadDTO | null>(null);
  const [fullGraph, setFullGraph] = useState<GraphPayloadDTO | null>(null);
  const [fullGraphProgress, setFullGraphProgress] = useState("");
  const [edgeMode, setEdgeMode] = useState<EdgeMode>("focus");
  const [fullEdgeMode, setFullEdgeMode] = useState<EdgeMode>(FULL_3D_SAFE_EDGE_MODE);
  const [fullEdgeStrength, setFullEdgeStrength] = useState(1.4);
  const [showFullWarning, setShowFullWarning] = useState(false);
  const [showAllEdgesWarning, setShowAllEdgesWarning] = useState(false);
  const [legalReviewChecks, setLegalReviewChecks] = useState<
    Record<LegalReviewCheckId, boolean>
  >({
    notAdvice: false,
    citations: false,
    facts: false,
    expert: false,
  });
  const [legalFeedback, setLegalFeedback] = useState<LegalFeedbackState>({
    risk: "clear",
    notes: "",
    submitted: false,
  });
  const [loading, setLoading] = useState<string>("");
  const [error, setError] = useState<string>("");
  const controllers = useRef<Partial<Record<string, AbortController>>>({});
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const latestInspectorWidthRef = useRef(0);
  const initialLayoutWidth =
    typeof window !== "undefined" ? window.innerWidth : 1440;
  const [layoutViewportWidth, setLayoutViewportWidth] =
    useState(initialLayoutWidth);
  const [inspectorWidth, setInspectorWidth] = useState(() =>
    getDefaultInspectorWidth(initialLayoutWidth),
  );
  const [isPaneResizing, setIsPaneResizing] = useState(false);

  useEffect(() => {
    const controller = nextController("graph-catalog");
    setGraphCatalogError("");
    getGraphs(controller.signal)
      .then((catalog) => {
        if (!isCurrentRequest("graph-catalog", controller)) return;
        setGraphCatalog(catalog.graphs ?? []);
      })
      .catch((err) => {
        if (!isCanceledError(err)) {
          setGraphCatalogError(
            err instanceof Error ? err.message : "그래프 목록 로딩 실패",
          );
        }
      })
      .finally(() => finishRequest("graph-catalog", controller));
    return () => {
      Object.values(controllers.current).forEach((controller) =>
        controller?.abort(),
      );
    };
  }, []);

  useEffect(() => {
    void refreshHealth(activeGraphKey);
    const controller = nextController("suggestions");
    getSuggestedQuestions(controller.signal, activeGraphKey)
      .then((items) => {
        if (isCurrentRequest("suggestions", controller)) setSuggested(items);
      })
      .catch((err) => {
        if (!isCanceledError(err)) setSuggested([]);
      })
      .finally(() => finishRequest("suggestions", controller));
  }, [activeGraphKey]);

  useEffect(() => {
    latestInspectorWidthRef.current = inspectorWidth;
  }, [inspectorWidth]);

  useEffect(() => {
    const shell = appShellRef.current;
    if (!shell || typeof window === "undefined") return;

    const measureWidth = () =>
      Math.max(
        0,
        Math.floor(shell.getBoundingClientRect().width || window.innerWidth),
      );
    const initialWidth = measureWidth();
    const storedWidth = parsePaneLayoutPreference(
      window.localStorage.getItem(PANE_LAYOUT_STORAGE_KEY),
      initialWidth,
    );
    const initialInspectorWidth =
      storedWidth ?? getDefaultInspectorWidth(initialWidth);
    latestInspectorWidthRef.current = initialInspectorWidth;
    setLayoutViewportWidth(initialWidth);
    setInspectorWidth(initialInspectorWidth);

    let animationFrameId: number | null = null;
    const measureAndClamp = () => {
      if (animationFrameId !== null) return;
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        const viewportWidth = measureWidth();
        setLayoutViewportWidth(viewportWidth);
        setInspectorWidth((currentWidth) => {
          const nextWidth = clampInspectorWidth(viewportWidth, currentWidth);
          latestInspectorWidthRef.current = nextWidth;
          return nextWidth;
        });
      });
    };

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measureAndClamp);
      return () => {
        if (animationFrameId !== null)
          window.cancelAnimationFrame(animationFrameId);
        window.removeEventListener("resize", measureAndClamp);
      };
    }

    const resizeObserver = new ResizeObserver(measureAndClamp);
    resizeObserver.observe(shell);
    return () => {
      if (animationFrameId !== null)
        window.cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
    };
  }, []);

  const activeGraph = useMemo(
    () => subgraph ?? queryResult?.graph ?? null,
    [queryResult, subgraph],
  );
  const activeGraphPreset = GRAPH_PRESETS[activeGraphKey];
  const activeGraphCatalogItem = useMemo(
    () =>
      graphCatalog.find((item) => item.id === activeGraphKey) ?? {
        id: activeGraphKey,
        label: activeGraphPreset.label,
        description: activeGraphPreset.description,
        default_question: activeGraphPreset.defaultQuestion,
        nodes: health?.nodes,
        edges: health?.edges,
        communities: health?.communities,
      },
    [activeGraphKey, activeGraphPreset, graphCatalog, health],
  );
  const graphSwitcherItems = useMemo(
    () =>
      (graphCatalog.length
        ? graphCatalog
        : (Object.entries(GRAPH_PRESETS) as [GraphKey, (typeof GRAPH_PRESETS)[GraphKey]][]).map(
            ([id, preset]) => ({
              id,
              label: preset.label,
              description: preset.description,
              default_question: preset.defaultQuestion,
            }),
          )
      ).filter((item): item is GraphCatalogItem =>
        item.id === "legalize-kr" || item.id === "precedent-kr",
      ),
    [graphCatalog],
  );
  const fullGraphLimits = activeGraphPreset;
  const activeDocLinks = useMemo(
    () =>
      activeGraphKey === "precedent-kr"
        ? DOC_LINKS.filter((item) => item.path !== "VERIFY.md")
        : [...DOC_LINKS],
    [activeGraphKey],
  );
  const communityGraph = useMemo(
    () => communityToGraph(communityPayload),
    [communityPayload],
  );
  const precedentCategoryOptions = useMemo(
    () => precedentHealth?.categories.slice(0, 12) ?? [],
    [precedentHealth],
  );
  const precedentCourtOptions = useMemo(
    () => precedentHealth?.courts.slice(0, 12) ?? [],
    [precedentHealth],
  );
  const precedentHealthChips = useMemo<StatusChip[]>(
    () => [
      ...statusChipsFrom(precedentHealth?.backend_status, "backend"),
      ...statusChipsFrom(precedentHealth?.index_status, "index"),
      ...metadataChips(precedentHealth?.metadata, [
        "categories",
        "courts",
        "warnings",
      ]),
    ],
    [precedentHealth],
  );
  const precedentHealthStatusWarnings = useMemo(
    () => [
      ...statusWarningsFrom(precedentHealth?.backend_status, "backend"),
      ...statusWarningsFrom(precedentHealth?.index_status, "index"),
    ],
    [precedentHealth],
  );
  const precedentSearchChips = useMemo<StatusChip[]>(
    () => [
      ...statusChipsFrom(precedentResults?.backend_status, "backend"),
      ...statusChipsFrom(precedentResults?.index_status, "index"),
      ...statusChipsFrom(precedentResults?.rank_explain, "rank"),
      ...scoreChips(precedentResults?.scores, "scores"),
    ],
    [precedentResults],
  );
  const precedentSearchStatusWarnings = useMemo(
    () => [
      ...statusWarningsFrom(precedentResults?.backend_status, "backend"),
      ...statusWarningsFrom(precedentResults?.index_status, "index"),
    ],
    [precedentResults],
  );
  const answerStatusChips = useMemo<StatusChip[]>(
    () => [
      ...(answerResult?.provider
        ? [{ label: `provider: ${answerResult.provider}` }]
        : []),
      ...(answerResult?.model
        ? [{ label: `model: ${answerResult.model}` }]
        : []),
      ...statusChipsFrom(answerResult?.llm_status, "llm"),
      ...metadataChips(answerResult?.metadata, [
        "provider",
        "model",
        "llm_status",
        "citations",
        "evidence",
        "graph",
        "warnings",
      ]),
    ],
    [answerResult],
  );
  const legalReviewComplete = useMemo(
    () => LEGAL_REVIEW_CHECKS.every((item) => legalReviewChecks[item.id]),
    [legalReviewChecks],
  );

  function nextController(key: string): AbortController {
    controllers.current[key]?.abort();
    const controller = new AbortController();
    controllers.current[key] = controller;
    return controller;
  }

  function isCurrentRequest(key: string, controller: AbortController): boolean {
    return (
      controllers.current[key] === controller && !controller.signal.aborted
    );
  }

  function finishRequest(key: string, controller: AbortController) {
    if (controllers.current[key] === controller) {
      controllers.current[key] = undefined;
    }
  }

  function abortRequest(key: string) {
    controllers.current[key]?.abort();
  }

  function isCanceledError(err: unknown): boolean {
    return err instanceof ApiError && err.status === 499;
  }

  function resetGraphWorkspace(graphKey: GraphKey, nextQuestion?: string) {
    Object.values(controllers.current).forEach((controller) =>
      controller?.abort(),
    );
    controllers.current = {};
    setHealth(null);
    setHealthError("");
    setSuggested([]);
    setQueryResult(null);
    setAnswerResult(null);
    setAnswerError("");
    setSelectedEvidence(null);
    setSelectedCommunity(null);
    setSelectedNodeId("");
    setSourceText("");
    setSourceTitle("");
    setSubgraph(null);
    setCommunityPayload(null);
    setFullGraph(null);
    setFullGraphProgress("");
    setFullEdgeMode(FULL_3D_SAFE_EDGE_MODE);
    setError("");
    setLoading("");
    setTab("chat");
    setQuestion(nextQuestion ?? GRAPH_PRESETS[graphKey].defaultQuestion);
  }

  function selectGraph(graphKey: GraphKey) {
    if (graphKey === activeGraphKey) return;
    resetGraphWorkspace(graphKey);
    setActiveGraphKey(graphKey);
  }

  async function refreshHealth(graphKey: GraphKey = activeGraphKey) {
    const controller = nextController("health");
    setHealthError("");
    try {
      const next = await getHealth(controller.signal, graphKey);
      if (!isCurrentRequest("health", controller)) return;
      setHealth(next);
    } catch (err) {
      if (isCanceledError(err)) return;
      setHealthError(err instanceof Error ? err.message : "backend 연결 실패");
    } finally {
      finishRequest("health", controller);
    }
  }

  async function runQuery(nextQuestion = question, graphKey: GraphKey = activeGraphKey) {
    if (!nextQuestion.trim()) return;
    const controller = nextController("query");
    setLoading("query");
    setError("");
    setAnswerError("");
    setAnswerResult(null);
    try {
      const result = await postQuery(
        { question: nextQuestion.trim(), max_nodes: 80, max_edges: 240 },
        controller.signal,
        graphKey,
      );
      if (!isCurrentRequest("query", controller)) return;
      setQueryResult(result);
      setSubgraph(result.graph ?? null);
      setSelectedEvidence(result.evidence?.[0] ?? null);
      setSelectedCommunity(null);
      setSelectedNodeId(
        result.evidence?.[0]?.node_id ?? result.graph?.seed_node_ids?.[0] ?? "",
      );
      setTab("chat");
    } catch (err) {
      if (isCanceledError(err)) return;
      setError(err instanceof Error ? err.message : "질의 실패");
    } finally {
      if (isCurrentRequest("query", controller)) setLoading("");
      finishRequest("query", controller);
    }
  }

  async function runAnswer(nextQuestion = question) {
    const trimmed = nextQuestion.trim();
    if (!trimmed) return;
    const controller = nextController("answer");
    setLoading("answer");
    setAnswerError("");
    try {
      const result = await postAnswer(
        {
          question: trimmed,
          mode: "deterministic",
          max_nodes: 80,
          max_edges: 240,
          include_graph: true,
        },
        controller.signal,
        activeGraphKey,
      );
      if (!isCurrentRequest("answer", controller)) return;
      setAnswerResult(result);
      if (result.graph) setSubgraph(result.graph);
      if (result.evidence.length) {
        setSelectedEvidence(result.evidence[0]);
        setSelectedNodeId(result.evidence[0].node_id ?? selectedNodeId);
      }
      setTab("chat");
    } catch (err) {
      if (isCanceledError(err)) return;
      setAnswerError(err instanceof Error ? err.message : "/answer 요청 실패");
    } finally {
      if (isCurrentRequest("answer", controller)) setLoading("");
      finishRequest("answer", controller);
    }
  }

  async function loadPrecedentHealth() {
    const controller = nextController("precedents-health");
    setPrecedentError("");
    try {
      const next = await getPrecedentsHealth(controller.signal);
      if (!isCurrentRequest("precedents-health", controller)) return;
      setPrecedentHealth(next);
    } catch (err) {
      if (isCanceledError(err)) return;
      setPrecedentError(
        err instanceof Error ? err.message : "precedent health 확인 실패",
      );
    } finally {
      finishRequest("precedents-health", controller);
    }
  }

  function openPrecedents() {
    setTab("precedents");
    if (!precedentHealth) void loadPrecedentHealth();
  }

  async function loadPrecedentSource(result: PrecedentSearchResult) {
    const path = precedentPath(result);
    setSelectedPrecedent(result);
    if (!path) {
      setPrecedentSource({
        path: "",
        title: result.title,
        category: result.category,
        court: result.court,
        content:
          result.excerpt ||
          result.summary ||
          "이 판례 결과에는 안전 source path가 없습니다.",
        warnings: ["source path 없음"],
      });
      return;
    }

    const controller = nextController("precedents-source");
    setLoading("precedents-source");
    setPrecedentError("");
    try {
      const source = await getPrecedentSource(path, controller.signal);
      if (!isCurrentRequest("precedents-source", controller)) return;
      setPrecedentSource(source);
      setSourceTitle(source.title || source.path);
      setSourceText(source.content);
    } catch (err) {
      if (isCanceledError(err)) return;
      setPrecedentSource({
        path,
        title: result.title,
        category: result.category,
        court: result.court,
        content:
          err instanceof Error ? err.message : "precedent source preview 실패",
        warnings: ["source preview 실패"],
      });
      setPrecedentError(
        err instanceof Error ? err.message : "precedent source preview 실패",
      );
    } finally {
      if (isCurrentRequest("precedents-source", controller)) setLoading("");
      finishRequest("precedents-source", controller);
    }
  }

  async function runPrecedentSearch() {
    const trimmed = precedentQuery.trim();
    if (!trimmed) return;
    const controller = nextController("precedents-search");
    setLoading("precedents-search");
    setPrecedentError("");
    try {
      const result = await searchPrecedents(
        {
          q: trimmed,
          category: precedentCategory.trim() || undefined,
          court: precedentCourt.trim() || undefined,
          limit: precedentLimit,
        },
        controller.signal,
      );
      if (!isCurrentRequest("precedents-search", controller)) return;
      setPrecedentResults(result);
      const first = result.results[0];
      if (first) {
        await loadPrecedentSource(first);
      } else {
        setSelectedPrecedent(null);
        setPrecedentSource(null);
      }
    } catch (err) {
      if (isCanceledError(err)) return;
      setPrecedentError(err instanceof Error ? err.message : "판례 검색 실패");
    } finally {
      if (isCurrentRequest("precedents-search", controller)) setLoading("");
      finishRequest("precedents-search", controller);
    }
  }

  function submitPrecedentSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runPrecedentSearch();
  }

  function convertPrecedentToGraphQuery(result: PrecedentSearchResult) {
    const nextQuestion = graphQuestionForPrecedent(result) || precedentQuery;
    if (activeGraphKey !== "precedent-kr") {
      resetGraphWorkspace("precedent-kr", nextQuestion);
      setActiveGraphKey("precedent-kr");
    }
    setQuestion(nextQuestion);
    void runQuery(nextQuestion, "precedent-kr");
  }

  async function loadSourcePath(path: string, title = path) {
    if (!path) {
      setSourceTitle("source file 없음");
      setSourceText("이 evidence에는 source path가 없습니다.");
      return;
    }
    const controller = nextController("source");
    setLoading("source");
    try {
      const source = await getSource(path, controller.signal, activeGraphKey);
      if (!isCurrentRequest("source", controller)) return;
      setSourceTitle(source.path);
      setSourceText(source.content);
    } catch (err) {
      if (isCanceledError(err)) return;
      setSourceTitle(title);
      setSourceText(err instanceof Error ? err.message : "source 열람 실패");
    } finally {
      if (isCurrentRequest("source", controller)) setLoading("");
      finishRequest("source", controller);
    }
  }

  async function loadSource(evidence: EvidenceItem) {
    setSelectedEvidence(evidence);
    setSelectedCommunity(null);
    await loadSourcePath(
      evidence.source_file || evidence.path || "",
      evidence.label,
    );
  }

  async function loadNodeExplain(
    node: GraphNodeDTO,
    options: { updateSubgraph?: boolean } = {},
  ) {
    const updateSubgraph = options.updateSubgraph ?? true;
    const controller = nextController("explain");
    setSelectedNodeId((current) => (current === node.id ? current : node.id));
    setSelectedCommunity(null);
    setError("");
    try {
      const explanation = await getExplain(
        { id: node.id },
        controller.signal,
        activeGraphKey,
      );
      if (!isCurrentRequest("explain", controller)) return;
      setSelectedEvidence(explanation.evidence?.[0] ?? null);
      if (updateSubgraph) setSubgraph(explanation.graph ?? subgraph);
      setSourceTitle(explanation.label ?? node.label);
      setSourceText(
        explanation.summary ?? "선택한 노드의 설명을 가져왔습니다.",
      );
    } catch (err) {
      if (isCanceledError(err)) return;
      setError(err instanceof Error ? err.message : "node 설명 로딩 실패");
    } finally {
      finishRequest("explain", controller);
    }
  }

  function loadCommunityDetail(node: GraphNodeDTO) {
    const metadata = node.metadata ?? {};
    const godNodes = Array.isArray(metadata.god_nodes)
      ? metadata.god_nodes.map(String)
      : [];
    const wikiPath = String(metadata.wiki_path || wikiPathFor(node.label));
    setSelectedNodeId(node.id);
    setSelectedCommunity(node);
    setSelectedEvidence(null);
    setSourceTitle(`${node.label} community`);
    setSourceText(
      [
        `${node.label}`,
        "",
        `member_count: ${metadata.member_count ?? node.degree ?? "—"}`,
        `edge_count: ${metadata.edge_count ?? "—"}`,
        `wiki: ${wikiPath}`,
        "",
        "Top God Nodes:",
        ...(godNodes.length
          ? godNodes.map((item, index) => `${index + 1}. ${item}`)
          : ["- 없음"]),
      ].join("\n"),
    );
  }

  async function loadSubgraphForNode(node: GraphNodeDTO) {
    const controller = nextController("subgraph");
    setSelectedNodeId(node.id);
    setLoading("subgraph");
    try {
      const graph = await getSubgraph(
        { node_id: node.id, depth: 1, max_nodes: 120, max_edges: 500 },
        controller.signal,
        activeGraphKey,
      );
      if (!isCurrentRequest("subgraph", controller)) return;
      setSubgraph(graph);
      setTab("subgraph");
    } catch (err) {
      if (isCanceledError(err)) return;
      setError(err instanceof Error ? err.message : "subgraph 로딩 실패");
    } finally {
      if (isCurrentRequest("subgraph", controller)) setLoading("");
      finishRequest("subgraph", controller);
    }
  }

  async function loadQuestionSubgraph(questionOverride = question) {
    const controller = nextController("subgraph");
    setLoading("subgraph");
    try {
      const graph = await postSubgraph3d(
        { question: questionOverride, max_nodes: 120, max_edges: 500 },
        controller.signal,
        activeGraphKey,
      );
      if (!isCurrentRequest("subgraph", controller)) return;
      setSubgraph(graph);
      setTab("subgraph");
    } catch (err) {
      if (isCanceledError(err)) return;
      setError(err instanceof Error ? err.message : "3D subgraph 로딩 실패");
    } finally {
      if (isCurrentRequest("subgraph", controller)) setLoading("");
      finishRequest("subgraph", controller);
    }
  }

  async function loadCommunities() {
    setTab("communities");
    if (communityPayload) return;
    const controller = nextController("communities");
    setLoading("communities");
    try {
      const next = await getCommunities3d(controller.signal, activeGraphKey);
      if (!isCurrentRequest("communities", controller)) return;
      setCommunityPayload(next);
    } catch (err) {
      if (isCanceledError(err)) return;
      setError(
        err instanceof Error ? err.message : "community overview 로딩 실패",
      );
    } finally {
      if (isCurrentRequest("communities", controller)) setLoading("");
      finishRequest("communities", controller);
    }
  }

  function fullGraphFocusNode(mode: EdgeMode, focusNodeId?: string) {
    const candidate = focusNodeId ?? selectedNodeId;
    if (mode !== "focus" || !candidate || candidate.startsWith("community-"))
      return undefined;
    return candidate;
  }

  function fullGraphRequestParams(
    mode: EdgeMode,
    confirmAllEdges = false,
    allNodes = false,
  ) {
    const staticLayoutParams = {
      static_layout: true,
      static_layout_mode: FULL_3D_STATIC_LAYOUT_MODE,
    };
    if (allNodes) {
      return {
        ...staticLayoutParams,
        edge_limit: 0,
      };
    }
    if (mode === "all" && confirmAllEdges) {
      if (fullGraphLimits.rawAllEnabled) return staticLayoutParams;
      return {
        ...staticLayoutParams,
        node_limit: fullGraphLimits.safeNodeLimit,
        edge_limit: fullGraphLimits.allEdgeSampleLimit,
      };
    }
    return {
      ...staticLayoutParams,
      node_limit: fullGraphLimits.safeNodeLimit,
      edge_limit:
        mode === "hidden"
          ? 0
          : mode === "focus"
            ? fullGraphLimits.focusEdgeLimit
            : fullGraphLimits.allEdgeSampleLimit,
    };
  }

  function fullGraphRequestCopy(
    mode: EdgeMode,
    focusNodeId?: string,
    confirmAllEdges = false,
    allNodes = false,
  ): string {
    const graphLabel = activeGraphPreset.shortLabel;
    if (allNodes) {
      return `${graphLabel} 전체 노드 실루엣을 요청 중입니다 · ${FULL_3D_STATIC_LAYOUT_COPY} · edges hidden · force simulation off`;
    }
    if (mode === "hidden") {
      return `${graphLabel} safe overview를 요청 중입니다 · ${FULL_3D_STATIC_LAYOUT_COPY} · top ${fullGraphLimits.safeNodeLimit.toLocaleString()} nodes · edges hidden`;
    }
    if (mode === "focus") {
      return `${graphLabel} focus edge safe mode 요청 중입니다 · ${FULL_3D_STATIC_LAYOUT_COPY} · top ${fullGraphLimits.safeNodeLimit.toLocaleString()} nodes · max ${fullGraphLimits.focusEdgeLimit.toLocaleString()} edges${focusNodeId ? ` · focus ${focusNodeId}` : ""}`;
    }
    if (confirmAllEdges && fullGraphLimits.rawAllEnabled) {
      return `${graphLabel} raw all-edge spherical 3D layout 요청 중입니다 · force simulation off`;
    }
    return `${graphLabel} connected safe overview 요청 중입니다 · ${FULL_3D_STATIC_LAYOUT_COPY} · top ${fullGraphLimits.safeNodeLimit.toLocaleString()} nodes · sampled ${fullGraphLimits.allEdgeSampleLimit.toLocaleString()} edges · force simulation off`;
  }

  async function loadFullGraph(
    mode: EdgeMode = fullEdgeMode,
    focusNodeId?: string,
    confirmAllEdges = false,
    allNodes = false,
  ) {
    const controller = nextController("full3d");
    const focusNode = fullGraphFocusNode(mode, focusNodeId);
    setLoading("full3d");
    setError("");
    setTab("full3d");
    setFullGraphProgress(
      fullGraphRequestCopy(mode, focusNode, confirmAllEdges, allNodes),
    );
    try {
      const graph = await getFullGraph3d(
        {
          edge_mode: mode,
          focus_node_id: focusNode,
          confirm_all_edges: mode === "all" ? true : undefined,
          ...fullGraphRequestParams(mode, confirmAllEdges, allNodes),
        },
        controller.signal,
        activeGraphKey,
      );
      if (!isCurrentRequest("full3d", controller)) return;
      const graphWithLayout = {
        ...graph,
        layout_mode: graph.layout_mode || FULL_3D_STATIC_LAYOUT_MODE,
      };
      setFullGraph(graphWithLayout);
      setFullEdgeMode(mode);
      const boundedLabel = graphWithLayout.partial ? " · bounded safe payload" : "";
      const warningLabel = graphWithLayout.warnings?.length
        ? ` · ${graphWithLayout.warnings[0]}`
        : "";
      setFullGraphProgress(
        `로드 완료: ${graphWithLayout.nodes.length.toLocaleString()} nodes · ${graphWithLayout.edges.length.toLocaleString()} edges · edge mode ${graphWithLayout.edge_mode || mode} · layout ${graphWithLayout.layout_mode}${boundedLabel}${warningLabel}`,
      );
    } catch (err) {
      if (isCanceledError(err)) {
        setFullGraphProgress(
          "전체 그래프 요청을 취소했습니다. Hidden/focus/all edge 옵션을 선택해 다시 요청할 수 있습니다.",
        );
        return;
      }
      const message =
        err instanceof Error ? err.message : "Full 3D payload 로딩 실패";
      setFullGraphProgress(`요청 실패: ${message}`);
      setError(message);
    } finally {
      if (isCurrentRequest("full3d", controller)) setLoading("");
      finishRequest("full3d", controller);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runQuery();
  }

  const paneBounds = useMemo(
    () => getPaneBounds(layoutViewportWidth),
    [layoutViewportWidth],
  );
  const appShellStyle = useMemo(
    () =>
      ({
        "--lg-inspector-width": `${Math.round(inspectorWidth)}px`,
      }) as CSSProperties,
    [inspectorWidth],
  );

  function persistInspectorWidth(width: number) {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        PANE_LAYOUT_STORAGE_KEY,
        serializePaneLayoutPreference(width),
      );
    } catch {
      // Preference persistence is best-effort; layout should keep working without storage.
    }
  }

  function setInspectorWidthForViewport(
    viewportWidth: number,
    requestedWidth: number,
    persist = false,
  ) {
    const nextWidth = clampInspectorWidth(viewportWidth, requestedWidth);
    latestInspectorWidthRef.current = nextWidth;
    setLayoutViewportWidth(viewportWidth);
    setInspectorWidth(nextWidth);
    if (persist) persistInspectorWidth(nextWidth);
  }

  function resetInspectorWidth() {
    setInspectorWidthForViewport(
      layoutViewportWidth,
      getDefaultInspectorWidth(layoutViewportWidth),
      true,
    );
  }

  function handlePaneResizePointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (event.button !== 0) return;
    const shell = appShellRef.current;
    if (!shell || typeof window === "undefined") return;

    event.preventDefault();
    const target = event.currentTarget;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // Window-level pointer listeners below still keep the drag working.
    }
    setIsPaneResizing(true);

    const updateFromClientX = (clientX: number) => {
      const rect = shell.getBoundingClientRect();
      const requestedWidth = rect.right - clientX;
      setInspectorWidthForViewport(rect.width, requestedWidth);
    };

    updateFromClientX(event.clientX);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      updateFromClientX(moveEvent.clientX);
    };

    const finishDrag = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
      try {
        target.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore release errors when the pointer was already released by the browser.
      }
      setIsPaneResizing(false);
      persistInspectorWidth(latestInspectorWidthRef.current);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishDrag, { once: true });
    window.addEventListener("pointercancel", finishDrag, { once: true });
  }

  function handlePaneResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setInspectorWidthForViewport(
        layoutViewportWidth,
        inspectorWidth + step,
        true,
      );
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setInspectorWidthForViewport(
        layoutViewportWidth,
        inspectorWidth - step,
        true,
      );
    } else if (event.key === "Home") {
      event.preventDefault();
      setInspectorWidthForViewport(
        layoutViewportWidth,
        paneBounds.inspectorMin,
        true,
      );
    } else if (event.key === "End") {
      event.preventDefault();
      setInspectorWidthForViewport(
        layoutViewportWidth,
        paneBounds.inspectorMax,
        true,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      resetInspectorWidth();
    }
  }

  const evidence = activeEvidenceFor(answerResult, queryResult);

  return (
    <div
      ref={appShellRef}
      className={`lg-app-shell${isPaneResizing ? " lg-resizing-panes" : ""}`}
      style={appShellStyle}
    >
      <nav className="lg-ribbon" aria-label="Workspace commands">
        {(
          [
            "chat",
            "precedents",
            "subgraph",
            "communities",
            "full3d",
            "verify",
          ] as WorkspaceTab[]
        ).map((item) => (
          <button
            key={item}
            type="button"
            className="lg-icon-button lg-ribbon-button"
            data-active={tab === item}
            aria-label={`${item} 열기`}
            onClick={() => {
              if (item === "communities") void loadCommunities();
              else if (item === "precedents") openPrecedents();
              else if (item === "full3d") setShowFullWarning(true);
              else setTab(item);
            }}
          >
            <span aria-hidden="true">{iconFor(item)}</span>
          </button>
        ))}
      </nav>

      <aside className="lg-sidebar" aria-label="Graph navigation">
        <header className="lg-pane-header">
          <span>Graphify Graph</span>
          <button
            type="button"
            className="lg-button"
            onClick={() => void refreshHealth(activeGraphKey)}
            aria-label="그래프 상태 새로고침"
          >
            상태 확인
          </button>
        </header>
        <section className="lg-sidebar-section lg-graph-switcher">
          <div className="lg-section-heading-row">
            <h2>그래프 선택</h2>
            <span className="lg-chip" data-tone="accent">
              {activeGraphPreset.shortLabel}
            </span>
          </div>
          <div className="lg-graph-switcher__cards">
            {graphSwitcherItems.map((item) => {
              const preset = GRAPH_PRESETS[item.id];
              const selected = item.id === activeGraphKey;
              const nodes =
                selected && health?.nodes !== null && health?.nodes !== undefined
                  ? health.nodes
                  : item.nodes;
              const edges =
                selected && health?.edges !== null && health?.edges !== undefined
                  ? health.edges
                  : item.edges;
              const communities =
                selected &&
                health?.communities !== null &&
                health?.communities !== undefined
                  ? health.communities
                  : item.communities;
              return (
                <button
                  key={item.id}
                  type="button"
                  className="lg-graph-choice"
                  data-active={selected}
                  onClick={() => selectGraph(item.id)}
                  aria-pressed={selected}
                  aria-label={`${preset.label} 선택`}
                >
                  <span className="lg-graph-choice__title">
                    {preset.label}
                  </span>
                  <span className="lg-graph-choice__description">
                    {item.description || preset.description}
                  </span>
                  <span className="lg-graph-choice__meta">
                    {(nodes ?? "—").toLocaleString?.() ?? nodes} nodes ·{" "}
                    {(edges ?? "—").toLocaleString?.() ?? edges} edges ·{" "}
                    {(communities ?? "—").toLocaleString?.() ?? communities} communities
                  </span>
                  <span className="lg-graph-choice__meta">
                    {item.available === false ? "graph.json 없음" : "graph.json"} ·{" "}
                    {formatBytes(item.graph_size_bytes)}
                  </span>
                </button>
              );
            })}
          </div>
          {graphCatalogError ? (
            <p className="lg-inline-warning">{graphCatalogError}</p>
          ) : null}
        </section>
        <HealthCard
          health={health}
          error={healthError}
          title={`${activeGraphKey} graph health`}
        />
        <section className="lg-sidebar-section">
          <h2>추천 질문</h2>
          <div className="lg-chip-list">
            {(suggested.length
              ? suggested
              : [
                  activeGraphPreset.defaultQuestion,
                  "민법 계약 손해배상",
                  activeGraphKey === "precedent-kr"
                    ? "대법원 손해배상 판례 인용"
                    : "전자정부법 시행령 연결 구조",
                ]
            )
              .slice(0, 6)
              .map((item) => (
                <button
                  key={item}
                  type="button"
                  className="lg-chip lg-chip-button"
                  onClick={() => {
                    setQuestion(item);
                    void runQuery(item);
                  }}
                  aria-label={`추천 질문 실행: ${item}`}
                >
                  {item}
                </button>
              ))}
          </div>
        </section>
        <section className="lg-sidebar-section">
          <h2>원칙</h2>
          <p>{LEGAL_DISCLAIMER}</p>
        </section>
        <section className="lg-sidebar-section">
          <h2>산출물 바로가기</h2>
          <div className="lg-chip-list">
            {activeDocLinks.map((item) => (
              <button
                key={item.path}
                type="button"
                className="lg-chip lg-chip-button"
                onClick={() => void loadSourcePath(item.path, item.label)}
                aria-label={`${item.label} 문서 열기`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </section>
      </aside>

      <div className="lg-tabbar" role="tablist" aria-label="Workspace tabs">
        <button
          className="lg-tab"
          data-active={tab === "chat"}
          onClick={() => setTab("chat")}
          type="button"
        >
          Chat
        </button>
        <button
          className="lg-tab"
          data-active={tab === "precedents"}
          onClick={openPrecedents}
          type="button"
        >
          Precedents
        </button>
        <button
          className="lg-tab"
          data-active={tab === "subgraph"}
          onClick={() => void loadQuestionSubgraph()}
          type="button"
        >
          3D Subgraph
        </button>
        <button
          className="lg-tab"
          data-active={tab === "communities"}
          onClick={() => void loadCommunities()}
          type="button"
        >
          Community Overview
        </button>
        <button
          className="lg-tab"
          data-active={tab === "full3d"}
          onClick={() => setShowFullWarning(true)}
          type="button"
        >
          Full 3D Graph
        </button>
        <button
          className="lg-tab"
          data-active={tab === "verify"}
          onClick={() => setTab("verify")}
          type="button"
        >
          Verify
        </button>
      </div>

      <main className="lg-main-workspace" aria-live="polite">
        {error ? (
          <div className="lg-state-error" role="alert">
            {error}
          </div>
        ) : null}
        {tab === "chat" ? (
          <section className="lg-chat-pane">
            <div className="lg-chat-scroll">
              <article className="lg-message lg-message-assistant">
                <span className="lg-chip" data-tone="accent">
                  source-first
                </span>
                <h1>{activeGraphPreset.label}를 질문으로 탐색하세요</h1>
                <p>
                  {queryResult?.summary ??
                    `${activeGraphPreset.description}를 기준으로 관련 노드, 근거 source, 제한 subgraph를 함께 보여줍니다.`}
                </p>
                {queryResult?.rank_reason ? (
                  <p className="lg-message-meta">
                    matched:{" "}
                    {queryResult.rank_reason.matched_terms.join(", ") || "—"} ·
                    hub dampening{" "}
                    {queryResult.rank_reason.hub_dampening_applied
                      ? "on"
                      : "off"}
                  </p>
                ) : null}
                <div className="lg-message-actions">
                  <button
                    className="lg-button"
                    data-variant="primary"
                    type="button"
                    onClick={() => void runAnswer()}
                    disabled={loading === "answer"}
                    aria-label="Source-grounded answer 생성"
                  >
                    {loading === "answer"
                      ? "Answer 생성 중…"
                      : "Source-grounded answer"}
                  </button>
                  <button
                    className="lg-button"
                    type="button"
                    onClick={() => void loadQuestionSubgraph()}
                    aria-label="질문 결과 3D subgraph 열기"
                  >
                    Open 3D subgraph
                  </button>
                  <button
                    className="lg-button"
                    type="button"
                    onClick={() => void loadCommunities()}
                    aria-label="Community overview 열기"
                  >
                    Community overview
                  </button>
                </div>
              </article>
              {answerError ? (
                <div className="lg-state-error" role="alert">
                  /answer: {answerError}
                </div>
              ) : null}
              {answerResult ? (
                <article
                  className="lg-card lg-answer-panel"
                  aria-label="Source-grounded answer panel"
                >
                  <div className="lg-answer-panel__header">
                    <div>
                      <span className="lg-chip" data-tone="accent">
                        mode: {answerResult.mode}
                      </span>
                      {answerResult.validated_citations?.length ? (
                        <span className="lg-chip">
                          validated citations{" "}
                          {answerResult.validated_citations.length}
                        </span>
                      ) : null}
                      {answerResult.no_evidence ? (
                        <span className="lg-chip">evidence limited</span>
                      ) : null}
                    </div>
                    <span className="lg-answer-panel__meta">
                      {answerResult.generated_at || "deterministic/extractive"}
                    </span>
                  </div>
                  <h2>Source-grounded answer</h2>
                  <p className="lg-answer-panel__disclaimer">
                    {answerResult.disclaimer || LEGAL_DISCLAIMER}
                  </p>
                  <p>{answerResult.answer}</p>
                  {answerResult.summary &&
                  answerResult.summary !== answerResult.answer ? (
                    <p className="lg-answer-panel__summary">
                      {answerResult.summary}
                    </p>
                  ) : null}
                  {answerStatusChips.length ? (
                    <div
                      className="lg-answer-status"
                      aria-label="LLM and answer metadata"
                    >
                      <strong>LLM / metadata</strong>
                      <div className="lg-chip-list">
                        {answerStatusChips.map((chip) => (
                          <span
                            key={`${chip.label}-${chip.title ?? ""}`}
                            className="lg-chip"
                            data-tone={chip.tone}
                            title={chip.title}
                          >
                            {chip.label}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {answerResult.warnings.length ? (
                    <div className="lg-answer-panel__warnings" role="status">
                      <strong>Warnings</strong>
                      <ul>
                        {answerResult.warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div className="lg-answer-panel__sections">
                    <section>
                      <h3>Citations</h3>
                      {answerResult.citations.length ? (
                        <div className="lg-citation-list">
                          {answerResult.citations.map((citation) => {
                            const path = citationSourcePath(citation);
                            const validation = validationForCitation(
                              citation,
                              answerResult.validated_citations,
                            );
                            return (
                              <button
                                key={citation.id}
                                type="button"
                                className="lg-citation-card"
                                onClick={() =>
                                  void loadSourcePath(
                                    path,
                                    citation.label || path || "citation",
                                  )
                                }
                                disabled={!path}
                                aria-label={`${citation.label || citation.id} citation source 열기`}
                              >
                                <span>{citation.label || citation.id}</span>
                                <code>
                                  {path ||
                                    citation.source_url ||
                                    "source path 없음"}
                                </code>
                                {validation ? (
                                  <span
                                    className="lg-chip"
                                    data-tone={
                                      validation.valid === false
                                        ? "warning"
                                        : "accent"
                                    }
                                    title={
                                      validation.reason ||
                                      validation.warning ||
                                      validation.status
                                    }
                                  >
                                    {validationLabel(validation)}
                                  </span>
                                ) : null}
                                {citation.excerpt || citation.quote ? (
                                  <small>
                                    {citation.excerpt || citation.quote}
                                  </small>
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="lg-muted-copy">
                          표시 가능한 citation이 없습니다. source 없는 답변은
                          제한됩니다.
                        </p>
                      )}
                    </section>
                    <section>
                      <h3>Evidence</h3>
                      {answerResult.evidence.length ? (
                        <div className="lg-answer-evidence-list">
                          {answerResult.evidence.slice(0, 4).map((item) => (
                            <EvidenceCard
                              key={item.id}
                              evidence={item}
                              selected={selectedEvidence?.id === item.id}
                              onSelect={(next) => void loadSource(next)}
                            />
                          ))}
                        </div>
                      ) : (
                        <p className="lg-muted-copy">
                          Backend evidence payload가 비어 있습니다.
                        </p>
                      )}
                    </section>
                  </div>
                </article>
              ) : null}
              {evidence.length ? (
                <section
                  className="lg-evidence-grid"
                  aria-label="그래프 근거 목록"
                >
                  {evidence.map((item) => (
                    <EvidenceCard
                      key={item.id}
                      evidence={item}
                      selected={selectedEvidence?.id === item.id}
                      onSelect={(next) => void loadSource(next)}
                    />
                  ))}
                </section>
              ) : (
                <div className="lg-empty-state">
                  Evidence: 답변을 선택하면 근거가 표시됩니다.
                </div>
              )}
            </div>
            <form className="lg-chat-composer" onSubmit={submit}>
              <input
                className="lg-input"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                aria-label={`${activeGraphPreset.shortLabel} 그래프 질문`}
                placeholder={`예: ${activeGraphPreset.defaultQuestion}`}
              />
              <button
                className="lg-button"
                data-variant="primary"
                type="submit"
                disabled={loading === "query"}
                aria-label="질문 실행"
              >
                {loading === "query" ? "탐색 중…" : "질문"}
              </button>
            </form>
          </section>
        ) : null}

        {tab === "precedents" ? (
          <section
            className="lg-precedents-pane"
            aria-label="Precedents search workspace"
          >
            <div className="lg-precedents-toolbar">
              <div>
                <span className="lg-chip" data-tone="accent">
                  read-only precedent corpus
                </span>
                <h1>Precedents</h1>
                <p>
                  판례 corpus는 backend `/precedents/*` slim DTO로만
                  검색·미리보기합니다. 브라우저는 raw corpus 파일을 직접
                  fetch하지 않습니다.
                </p>
              </div>
              <button
                className="lg-button"
                type="button"
                onClick={() => void loadPrecedentHealth()}
                aria-label="판례 corpus 상태 확인"
              >
                corpus health
              </button>
            </div>

            <div className="lg-precedents-grid">
              <section className="lg-card lg-precedent-search-card">
                <div
                  className="lg-precedent-health"
                  data-state={
                    precedentError
                      ? "error"
                      : precedentHealth?.ok
                        ? "ready"
                        : "unknown"
                  }
                >
                  <span className="lg-health-dot" aria-hidden="true" />
                  <div>
                    <strong>
                      {precedentHealth?.status ||
                        (precedentError
                          ? "precedents unavailable"
                          : "precedents not checked")}
                    </strong>
                    <span>
                      files {formatNullableCount(precedentHealth?.file_count)} ·
                      categories{" "}
                      {formatNullableCount(precedentHealth?.category_count)}
                    </span>
                  </div>
                </div>
                {precedentHealthChips.length ? (
                  <div
                    className="lg-chip-list lg-status-chip-list"
                    aria-label="Precedent backend and index status"
                  >
                    {precedentHealthChips.map((chip) => (
                      <span
                        key={`${chip.label}-${chip.title ?? ""}`}
                        className="lg-chip"
                        data-tone={chip.tone}
                        title={chip.title}
                      >
                        {chip.label}
                      </span>
                    ))}
                  </div>
                ) : null}
                {precedentError ? (
                  <div className="lg-state-error" role="alert">
                    {precedentError}
                  </div>
                ) : null}
                {precedentHealthStatusWarnings.length ? (
                  <div className="lg-state-warning" role="status">
                    {precedentHealthStatusWarnings
                      .slice(0, 3)
                      .map((warning) => (
                        <span key={warning}>{warning}</span>
                      ))}
                  </div>
                ) : null}
                {precedentHealth?.warnings.length ? (
                  <div className="lg-state-warning" role="status">
                    {precedentHealth.warnings.slice(0, 3).map((warning) => (
                      <span key={warning}>{warning}</span>
                    ))}
                  </div>
                ) : null}

                <form
                  className="lg-precedent-form"
                  onSubmit={submitPrecedentSearch}
                >
                  <label>
                    <span>Search query</span>
                    <input
                      className="lg-input"
                      value={precedentQuery}
                      onChange={(event) =>
                        setPrecedentQuery(event.target.value)
                      }
                      placeholder="예: 손해배상 계약 해제"
                      aria-label="판례 검색어"
                    />
                  </label>
                  <div className="lg-precedent-form__filters">
                    <label>
                      <span>Category</span>
                      <input
                        className="lg-input"
                        value={precedentCategory}
                        onChange={(event) =>
                          setPrecedentCategory(event.target.value)
                        }
                        list="precedent-category-options"
                        placeholder="전체"
                        aria-label="판례 category filter"
                      />
                      <datalist id="precedent-category-options">
                        {precedentCategoryOptions.map((item) => (
                          <option key={item} value={item} />
                        ))}
                      </datalist>
                    </label>
                    <label>
                      <span>Court</span>
                      <input
                        className="lg-input"
                        value={precedentCourt}
                        onChange={(event) =>
                          setPrecedentCourt(event.target.value)
                        }
                        list="precedent-court-options"
                        placeholder="전체"
                        aria-label="판례 court filter"
                      />
                      <datalist id="precedent-court-options">
                        {precedentCourtOptions.map((item) => (
                          <option key={item} value={item} />
                        ))}
                      </datalist>
                    </label>
                    <label>
                      <span>Limit</span>
                      <select
                        className="lg-select"
                        value={precedentLimit}
                        onChange={(event) =>
                          setPrecedentLimit(Number(event.target.value))
                        }
                        aria-label="판례 검색 결과 수"
                      >
                        <option value={5}>5</option>
                        <option value={8}>8</option>
                        <option value={12}>12</option>
                      </select>
                    </label>
                  </div>
                  <div className="lg-message-actions">
                    <button
                      className="lg-button"
                      data-variant="primary"
                      type="submit"
                      disabled={loading === "precedents-search"}
                    >
                      {loading === "precedents-search"
                        ? "검색 중…"
                        : "Search precedents"}
                    </button>
                    <button
                      className="lg-button"
                      type="button"
                      onClick={() => {
                        setPrecedentCategory("");
                        setPrecedentCourt("");
                      }}
                    >
                      filters reset
                    </button>
                  </div>
                </form>

                <div
                  className="lg-precedent-results"
                  aria-label="판례 검색 결과"
                >
                  <div className="lg-precedent-results__header">
                    <strong>Results</strong>
                    <span>
                      {precedentResults
                        ? `${precedentResults.results.length} / ${formatNullableCount(precedentResults.total)}`
                        : "검색 전"}
                    </span>
                  </div>
                  {precedentSearchChips.length ? (
                    <div
                      className="lg-chip-list lg-status-chip-list"
                      aria-label="Precedent search rank and index metadata"
                    >
                      {precedentSearchChips.map((chip) => (
                        <span
                          key={`${chip.label}-${chip.title ?? ""}`}
                          className="lg-chip"
                          data-tone={chip.tone}
                          title={chip.title}
                        >
                          {chip.label}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {precedentSearchStatusWarnings.length ? (
                    <div className="lg-state-warning" role="status">
                      {precedentSearchStatusWarnings
                        .slice(0, 3)
                        .map((warning) => (
                          <span key={warning}>{warning}</span>
                        ))}
                    </div>
                  ) : null}
                  {precedentResults?.warnings.length ? (
                    <div className="lg-state-warning" role="status">
                      {precedentResults.warnings.slice(0, 3).map((warning) => (
                        <span key={warning}>{warning}</span>
                      ))}
                    </div>
                  ) : null}
                  {precedentResults?.results.length ? (
                    precedentResults.results.map((result) => {
                      const path = precedentPath(result);
                      const resultScoreChips = scoreChips(result.scores);
                      return (
                        <article
                          className="lg-precedent-result"
                          key={result.id}
                          data-selected={selectedPrecedent?.id === result.id}
                        >
                          <button
                            type="button"
                            className="lg-precedent-result__main"
                            onClick={() => void loadPrecedentSource(result)}
                            aria-label={`${result.title} source preview 열기`}
                          >
                            <strong>{result.title}</strong>
                            <span className="lg-precedent-result__meta">
                              {result.case_number ? (
                                <span>{result.case_number}</span>
                              ) : null}
                              {result.date ? <span>{result.date}</span> : null}
                              {typeof result.score === "number" ? (
                                <span>score {result.score.toFixed(2)}</span>
                              ) : null}
                            </span>
                            <span className="lg-chip-list">
                              <span className="lg-chip">
                                {result.category || "category —"}
                              </span>
                              <span className="lg-chip">
                                {result.court || "court —"}
                              </span>
                              <span className="lg-chip" title={path}>
                                {path || "path —"}
                              </span>
                              {result.rank_explain ? (
                                <span
                                  className="lg-chip"
                                  data-tone="accent"
                                  title={displayValue(result.rank_explain)}
                                >
                                  rank: {compactValue(result.rank_explain, 46)}
                                </span>
                              ) : null}
                              {resultScoreChips.map((chip) => (
                                <span
                                  key={`${result.id}-${chip.label}`}
                                  className="lg-chip"
                                  title={chip.title}
                                >
                                  {chip.label}
                                </span>
                              ))}
                            </span>
                            {result.excerpt || result.summary ? (
                              <span className="lg-precedent-result__excerpt">
                                {result.excerpt || result.summary}
                              </span>
                            ) : null}
                          </button>
                          <div className="lg-message-actions">
                            <button
                              className="lg-button"
                              type="button"
                              onClick={() => void loadPrecedentSource(result)}
                              disabled={
                                !path || loading === "precedents-source"
                              }
                            >
                              source preview
                            </button>
                            <button
                              className="lg-button"
                              type="button"
                              onClick={() =>
                                convertPrecedentToGraphQuery(result)
                              }
                            >
                              graph query로 전환
                            </button>
                          </div>
                        </article>
                      );
                    })
                  ) : (
                    <div className="lg-empty-state">
                      판례 검색 결과가 여기에 표시됩니다. backend가 아직 없으면
                      오류와 복구 안내가 표시됩니다.
                    </div>
                  )}
                </div>
              </section>

              <section
                className="lg-card lg-precedent-source-card"
                aria-label="판례 source preview"
              >
                <div className="lg-precedent-source-card__header">
                  <div>
                    <span className="lg-chip" data-tone="accent">
                      safe source preview
                    </span>
                    <h2>
                      {precedentSource?.title ||
                        selectedPrecedent?.title ||
                        "Source preview"}
                    </h2>
                  </div>
                  {loading === "precedents-source" ? (
                    <span className="lg-chip">loading…</span>
                  ) : null}
                </div>
                <div className="lg-chip-list">
                  <span className="lg-chip">
                    {precedentSource?.category ||
                      selectedPrecedent?.category ||
                      "category —"}
                  </span>
                  <span className="lg-chip">
                    {precedentSource?.court ||
                      selectedPrecedent?.court ||
                      "court —"}
                  </span>
                  <span
                    className="lg-chip"
                    title={
                      precedentSource?.path ||
                      (selectedPrecedent
                        ? precedentPath(selectedPrecedent)
                        : "")
                    }
                  >
                    {precedentSource?.path ||
                      (selectedPrecedent
                        ? precedentPath(selectedPrecedent)
                        : "path —")}
                  </span>
                </div>
                {precedentSource?.warnings.length ? (
                  <div className="lg-state-warning" role="status">
                    {precedentSource.warnings.map((warning) => (
                      <span key={warning}>{warning}</span>
                    ))}
                  </div>
                ) : null}
                <pre>
                  {precedentSource?.content ||
                    selectedPrecedent?.excerpt ||
                    "검색 결과를 선택하면 backend source viewer를 통해 read-only preview가 표시됩니다."}
                </pre>
              </section>
            </div>
          </section>
        ) : null}

        {tab === "subgraph" ? (
          <Suspense fallback={<GraphWorkspaceFallback label="3D Subgraph" />}>
            <WebGLGraph
              title="3D Subgraph"
              payload={activeGraph}
              emptyText={`질문을 입력하면 관련 ${activeGraphPreset.shortLabel} 그래프가 여기에 표시됩니다.`}
              edgeMode={edgeMode}
              onEdgeModeChange={setEdgeMode}
              selectedNodeId={selectedNodeId}
              onSelectNode={(node) => void loadNodeExplain(node)}
              onExpandNode={(node) => void loadSubgraphForNode(node)}
              evidenceItems={evidence}
              onSelectEvidence={(next) => void loadSource(next)}
              loading={loading === "subgraph"}
              loadingLabel="질문 주변 3D subgraph payload를 가져오는 중입니다…"
            />
          </Suspense>
        ) : null}

        {tab === "communities" ? (
          <Suspense
            fallback={<GraphWorkspaceFallback label="Community Overview" />}
          >
            <WebGLGraph
              title="Community Overview"
              payload={communityGraph}
              emptyText="그래프 상태를 먼저 확인하세요."
              edgeMode="all"
              selectedNodeId={selectedNodeId}
              onSelectNode={(node) => loadCommunityDetail(node)}
              loading={loading === "communities"}
              loadingLabel="Community overview payload를 가져오는 중입니다…"
            />
          </Suspense>
        ) : null}

        {tab === "full3d" ? (
          <section
            className="lg-fullgraph-workspace"
            aria-label="Full graph workspace"
          >
            {fullGraphProgress || loading === "full3d" ? (
              <div className="lg-card lg-fullgraph-progress" role="status">
                <div className="lg-chip-list">
                  <span className="lg-chip" data-tone="accent">
                    {loading === "full3d" ? "requesting" : "full graph"}
                  </span>
                  <span className="lg-chip">{activeGraphPreset.shortLabel}</span>
                  <span className="lg-chip">edge mode {fullEdgeMode}</span>
                  <span className="lg-chip" data-tone="accent">
                    layout {fullGraph?.layout_mode || FULL_3D_STATIC_LAYOUT_MODE}
                  </span>
                  <span className="lg-chip">3D lazy chunk</span>
                  <span className="lg-chip" data-tone="accent">
                    {fullEdgeMode === "all" && fullGraph && !fullGraph.partial
                      ? "raw static mode"
                      : "safe mode"}
                  </span>
                </div>
                <strong>
                  {fullGraphProgress || "전체 그래프 요청을 준비 중입니다."}
                </strong>
                <p>
                  Full 3D는 기본적으로 sampled edge가 포함된 spherical 3D safe overview로 시작합니다.
                  {fullGraphLimits.rawAllEnabled
                    ? " raw all-edge는 static renderer로만 요청합니다."
                    : " 판례 그래프는 규모가 커서 raw all-edge 직접 로드를 UI에서 제한합니다."}
                  진행 중인 요청은 취소할 수 있습니다.
                </p>
                {loading !== "full3d" && !(fullEdgeMode === "all" && fullGraph && !fullGraph.partial) ? (
                  <button
                    className="lg-button"
                    type="button"
                    onClick={() => setShowAllEdgesWarning(true)}
                    aria-label={`${activeGraphPreset.shortLabel} all-edge static graph 요청 확인`}
                  >
                    {fullGraphLimits.rawAllEnabled
                      ? "Raw all-edge 로드"
                      : "Sampled all-edge 확대"}
                  </button>
                ) : null}
                {activeGraphKey === "precedent-kr" && loading !== "full3d" ? (
                  <button
                    className="lg-button"
                    data-variant={fullGraph?.nodes.length === 124263 ? "primary" : undefined}
                    type="button"
                    onClick={() => void loadFullGraph("hidden", undefined, false, true)}
                    aria-label="판례 그래프 전체 노드를 edge 없이 로드"
                  >
                    전체 124k 노드만 보기
                  </button>
                ) : null}
                {loading === "full3d" ? (
                  <button
                    className="lg-button"
                    type="button"
                    onClick={() => abortRequest("full3d")}
                    aria-label="전체 그래프 요청 취소"
                  >
                    요청 취소
                  </button>
                ) : null}
              </div>
            ) : null}
            <Suspense
              fallback={<GraphWorkspaceFallback label="Full 3D Graph" />}
            >
              <WebGLGraph
                title={`Full 3D Graph opt-in · ${activeGraphPreset.shortLabel}`}
                payload={fullGraph}
                emptyText="전체 3D 그래프는 성능 경고 확인 후 lazy-load됩니다."
                edgeMode={fullEdgeMode}
                onEdgeModeChange={(mode) => {
                  void loadFullGraph(mode);
                }}
                selectedNodeId={
                  selectedNodeId.startsWith("community-")
                    ? undefined
                    : selectedNodeId
                }
                onSelectNode={(node) => {
                  void loadNodeExplain(node, { updateSubgraph: false });
                  if (fullEdgeMode === "focus")
                    void loadFullGraph("focus", node.id);
                }}
                performanceProfile="large"
                edgeStrength={fullEdgeStrength}
                onEdgeStrengthChange={setFullEdgeStrength}
                loading={loading === "full3d"}
                loadingLabel={
                  fullGraphProgress ||
                  "전체 그래프 payload를 가져오는 중입니다…"
                }
              />
            </Suspense>
          </section>
        ) : null}

        {tab === "verify" ? (
          <section className="lg-verify-pane">
            <HealthCard
              health={health}
              error={healthError}
              title={`${activeGraphKey} graph health`}
            />
            <div className="lg-card lg-verify-card">
              <h1>검증 기준</h1>
              <p>
                선택 그래프: {activeGraphPreset.label}. 기대값:{" "}
                {(activeGraphCatalogItem.nodes ?? health?.nodes ?? "—").toLocaleString?.() ??
                  activeGraphCatalogItem.nodes}{" "}
                nodes ·{" "}
                {(activeGraphCatalogItem.edges ?? health?.edges ?? "—").toLocaleString?.() ??
                  activeGraphCatalogItem.edges}{" "}
                edges ·{" "}
                {(activeGraphCatalogItem.communities ?? health?.communities ?? "—").toLocaleString?.() ??
                  activeGraphCatalogItem.communities}{" "}
                communities. `/health?graph={activeGraphKey}` 결과와 GRAPH_REPORT 기준이 일치해야 합니다.
              </p>
              <div className="lg-message-actions">
                <button
                  className="lg-button"
                  type="button"
                  onClick={() => void refreshHealth(activeGraphKey)}
                  aria-label="그래프 상태 다시 확인"
                >
                  그래프 상태 확인
                </button>
                {activeDocLinks.map((item) => (
                  <button
                    key={item.path}
                    className="lg-button"
                    type="button"
                    onClick={() => void loadSourcePath(item.path, item.label)}
                  >
                    {item.label} 열기
                  </button>
                ))}
              </div>
            </div>
            <div className="lg-card lg-verify-card lg-legal-review-card">
              <div className="lg-legal-review-card__header">
                <div>
                  <span className="lg-chip" data-tone="accent">
                    User testing
                  </span>
                  <h1>법률 자문 오해 방지 체크</h1>
                </div>
                <span className="lg-chip">
                  {legalReviewComplete ? "checklist complete" : "review needed"}
                </span>
              </div>
              <p>
                테스트 참가자가 이 제품을 법률 자문 또는 행동 권고로 오해하지
                않는지 확인합니다. 저장은 로컬 UI 상태이며 backend로 전송하지
                않습니다.
              </p>
              <div className="lg-legal-checklist">
                {LEGAL_REVIEW_CHECKS.map((item) => (
                  <label key={item.id} className="lg-check-row">
                    <input
                      type="checkbox"
                      checked={legalReviewChecks[item.id]}
                      onChange={(event) =>
                        setLegalReviewChecks((current) => ({
                          ...current,
                          [item.id]: event.target.checked,
                        }))
                      }
                    />
                    <span>{item.label}</span>
                  </label>
                ))}
              </div>
              <div className="lg-legal-feedback">
                <label>
                  <span>사용자 이해도</span>
                  <select
                    className="lg-select"
                    value={legalFeedback.risk}
                    onChange={(event) =>
                      setLegalFeedback((current) => ({
                        ...current,
                        risk: event.target.value as LegalFeedbackState["risk"],
                        submitted: false,
                      }))
                    }
                  >
                    <option value="clear">탐색 도구로 이해함</option>
                    <option value="unclear">일부 문구가 애매함</option>
                    <option value="misread">법률 자문으로 오해함</option>
                  </select>
                </label>
                <label>
                  <span>관찰 메모</span>
                  <textarea
                    className="lg-textarea"
                    value={legalFeedback.notes}
                    onChange={(event) =>
                      setLegalFeedback((current) => ({
                        ...current,
                        notes: event.target.value,
                        submitted: false,
                      }))
                    }
                    placeholder="예: 참가자가 citation을 먼저 열어 확인했는지, 답변을 행동 권고로 읽었는지 기록"
                    rows={4}
                  />
                </label>
              </div>
              {legalFeedback.risk !== "clear" ? (
                <div className="lg-state-warning" role="status">
                  <strong>Copy/UX follow-up 필요</strong>
                  <span>
                    자문으로 오해될 수 있는 문구를 줄이고, citation/source 확인
                    행동을 먼저 유도하세요.
                  </span>
                </div>
              ) : null}
              <div className="lg-message-actions">
                <button
                  className="lg-button"
                  data-variant="primary"
                  type="button"
                  onClick={() =>
                    setLegalFeedback((current) => ({
                      ...current,
                      submitted: true,
                    }))
                  }
                >
                  feedback mark
                </button>
                <button
                  className="lg-button"
                  type="button"
                  onClick={() => {
                    setLegalReviewChecks({
                      notAdvice: false,
                      citations: false,
                      facts: false,
                      expert: false,
                    });
                    setLegalFeedback({
                      risk: "clear",
                      notes: "",
                      submitted: false,
                    });
                  }}
                >
                  reset
                </button>
                {legalFeedback.submitted ? (
                  <span className="lg-chip">local feedback captured</span>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}
      </main>

      <div
        className="lg-pane-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Main Workspace와 Evidence Source pane 너비 조절"
        aria-valuemin={paneBounds.inspectorMin}
        aria-valuemax={paneBounds.inspectorMax}
        aria-valuenow={Math.round(inspectorWidth)}
        aria-valuetext={`Evidence Source ${Math.round(inspectorWidth)}px`}
        data-active={isPaneResizing}
        tabIndex={0}
        title="드래그로 pane 간격 조절 · Enter로 기본값 복원"
        onPointerDown={handlePaneResizePointerDown}
        onKeyDown={handlePaneResizeKeyDown}
        onDoubleClick={resetInspectorWidth}
      />

      <aside className="lg-inspector" aria-label="Evidence inspector">
        <header className="lg-pane-header">Evidence / Source</header>
        {selectedEvidence ? (
          <section className="lg-inspector-section">
            <EvidenceCard evidence={selectedEvidence} selected />
          </section>
        ) : (
          <div className="lg-empty-state">
            답변을 선택하면 근거가 표시됩니다.
          </div>
        )}
        <section className="lg-inspector-section lg-source-viewer">
          <h2>{sourceTitle || "source file"}</h2>
          {selectedCommunity ? (
            <div className="lg-message-actions lg-community-actions">
              <button
                className="lg-button"
                type="button"
                onClick={() =>
                  void loadSourcePath(
                    String(
                      selectedCommunity.metadata?.wiki_path ||
                        wikiPathFor(selectedCommunity.label),
                    ),
                    `${selectedCommunity.label} wiki`,
                  )
                }
              >
                Wiki article 열기
              </button>
              <button
                className="lg-button"
                type="button"
                onClick={() => {
                  setQuestion(selectedCommunity.label);
                  void loadQuestionSubgraph(selectedCommunity.label);
                }}
              >
                이 커뮤니티 3D로 보기
              </button>
            </div>
          ) : null}
          <pre>
            {sourceText ||
              "source 파일을 선택하면 read-only preview가 표시됩니다."}
          </pre>
        </section>
      </aside>

      <footer className="lg-statusbar">
        <span>
          {health?.ok
            ? "OK"
            : healthError
              ? "Backend offline"
              : "Checking graph"}{" "}
          · {activeGraphKey}{" "}
          · {health?.nodes?.toLocaleString() ?? "—"} nodes ·{" "}
          {health?.edges?.toLocaleString() ?? "—"} edges
        </span>
        <span>
          mode: {tab} · selected: {selectedNodeId || "none"}
        </span>
      </footer>

      {showFullWarning ? (
        <WarningModal
          title={`${activeGraphPreset.shortLabel} 전체 3D 그래프를 로드합니다`}
          confirmLabel="Sampled edges로 로드"
          onConfirm={() => {
            setShowFullWarning(false);
            void loadFullGraph(FULL_3D_SAFE_EDGE_MODE);
          }}
          onCancel={() => setShowFullWarning(false)}
        >
          <p>
            선택한 {activeGraphPreset.label}는{" "}
            {(activeGraphCatalogItem.nodes ?? health?.nodes ?? "—").toLocaleString?.() ??
              activeGraphCatalogItem.nodes}
            개 노드와{" "}
            {(activeGraphCatalogItem.edges ?? health?.edges ?? "—").toLocaleString?.() ??
              activeGraphCatalogItem.edges}
            개 엣지를 가진 대형 그래프입니다.
            브라우저 freeze 방지를 위해 먼저 sampled edge가 포함된 spherical 3D layout의 top node safe overview로 시작합니다.
          </p>
          <p>
            기본 로드는 {fullGraphLimits.allEdgeSampleLimit.toLocaleString()}개 edge sample을 연결해 보여줍니다.
            {fullGraphLimits.rawAllEnabled
              ? " raw all-edge는 별도 확인 후 확장합니다."
              : " 판례 그래프 raw all-edge는 규모상 UI에서 직접 확장하지 않습니다. 대신 Full 3D 화면에서 전체 124k 노드만 edge 없이 보는 버튼을 제공합니다."}
          </p>
        </WarningModal>
      ) : null}

      {showAllEdgesWarning ? (
        <WarningModal
          title={
            fullGraphLimits.rawAllEnabled
              ? "Raw static all-edge를 요청합니다"
              : "Sampled all-edge safe view를 요청합니다"
          }
          confirmLabel={
            fullGraphLimits.rawAllEnabled
              ? "Raw static 로드"
              : "Sampled all-edge 로드"
          }
          onConfirm={() => {
            setShowAllEdgesWarning(false);
            void loadFullGraph("all", undefined, fullGraphLimits.rawAllEnabled);
          }}
          onCancel={() => setShowAllEdgesWarning(false)}
        >
          <p>
            {fullGraphLimits.rawAllEnabled
              ? "Raw all-edge 렌더링은 브라우저를 멈출 수 있어 기본 UX에서 제한합니다."
              : "판례 그래프는 761k+ edge 규모라 raw all-edge 직접 로드를 제한하고 sampled edge payload로 렌더링합니다."}
          </p>
          <p>
            이 작업은 backend spherical 3D x/y/z 좌표와 static renderer를 사용해 force simulation 없이 렌더링합니다.
          </p>
        </WarningModal>
      ) : null}
    </div>
  );
}

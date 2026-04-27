export const PANE_LAYOUT_STORAGE_KEY = "legal-graph-chat:pane-layout:v1";

export const PANE_LAYOUT_VERSION = 1;
export const RIBBON_WIDTH = 48;
export const LEFT_SIDEBAR_WIDTH = 288;
export const PANE_SPLITTER_WIDTH = 6;
export const MIN_SAFE_WORKSPACE_WIDTH = 280;
export const MIN_SAFE_INSPECTOR_WIDTH = 220;

export type ViewportTier = "wide" | "desktop" | "compact" | "below-target";

export interface PaneLayoutPreferenceV1 {
  version: typeof PANE_LAYOUT_VERSION;
  inspectorWidth: number;
  savedAt: string;
}

export interface PaneBounds {
  viewportTier: ViewportTier;
  viewportWidth: number;
  availableWidth: number;
  workspaceMin: number;
  inspectorMin: number;
  inspectorMax: number;
  inspectorDefault: number;
}

interface TierSpec {
  tier: ViewportTier;
  minViewportWidth: number;
  workspaceMin: number;
  inspectorMin: number;
  inspectorMax: number;
  inspectorDefault: number;
}

const TIER_SPECS: TierSpec[] = [
  {
    tier: "wide",
    minViewportWidth: 1360,
    workspaceMin: 720,
    inspectorMin: 320,
    inspectorMax: 520,
    inspectorDefault: 400,
  },
  {
    tier: "desktop",
    minViewportWidth: 1200,
    workspaceMin: 640,
    inspectorMin: 300,
    inspectorMax: 460,
    inspectorDefault: 360,
  },
  {
    tier: "compact",
    minViewportWidth: 1024,
    workspaceMin: 420,
    inspectorMin: 260,
    inspectorMax: 380,
    inspectorDefault: 300,
  },
  {
    tier: "below-target",
    minViewportWidth: 0,
    workspaceMin: 360,
    inspectorMin: 240,
    inspectorMax: 340,
    inspectorDefault: 280,
  },
];

function finiteNumber(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function tierForViewport(viewportWidth: number): TierSpec {
  const safeWidth = finiteNumber(viewportWidth);
  return (
    TIER_SPECS.find((spec) => safeWidth >= spec.minViewportWidth) ??
    TIER_SPECS[TIER_SPECS.length - 1]
  );
}

export function getPaneBounds(viewportWidth: number): PaneBounds {
  const safeViewportWidth = Math.max(
    0,
    Math.floor(finiteNumber(viewportWidth)),
  );
  const spec = tierForViewport(safeViewportWidth);
  const availableWidth = Math.max(
    0,
    safeViewportWidth - RIBBON_WIDTH - LEFT_SIDEBAR_WIDTH - PANE_SPLITTER_WIDTH,
  );

  if (availableWidth <= 0) {
    return {
      viewportTier: spec.tier,
      viewportWidth: safeViewportWidth,
      availableWidth,
      workspaceMin: 0,
      inspectorMin: MIN_SAFE_INSPECTOR_WIDTH,
      inspectorMax: MIN_SAFE_INSPECTOR_WIDTH,
      inspectorDefault: MIN_SAFE_INSPECTOR_WIDTH,
    };
  }

  const workspaceMin = Math.min(
    spec.workspaceMin,
    Math.max(MIN_SAFE_WORKSPACE_WIDTH, availableWidth - spec.inspectorMin),
  );
  const inspectorMin = Math.min(
    spec.inspectorMin,
    Math.max(MIN_SAFE_INSPECTOR_WIDTH, availableWidth - workspaceMin),
  );
  const inspectorMax = Math.max(
    inspectorMin,
    Math.min(spec.inspectorMax, availableWidth - workspaceMin),
  );
  const inspectorDefault = clamp(
    Math.min(spec.inspectorDefault, Math.round(availableWidth * 0.36)),
    inspectorMin,
    inspectorMax,
  );

  return {
    viewportTier: spec.tier,
    viewportWidth: safeViewportWidth,
    availableWidth,
    workspaceMin,
    inspectorMin,
    inspectorMax,
    inspectorDefault,
  };
}

export function clampInspectorWidth(
  viewportWidth: number,
  requestedWidth: number,
): number {
  const bounds = getPaneBounds(viewportWidth);
  return clamp(
    Math.round(finiteNumber(requestedWidth, bounds.inspectorDefault)),
    bounds.inspectorMin,
    bounds.inspectorMax,
  );
}

export function getDefaultInspectorWidth(viewportWidth: number): number {
  return getPaneBounds(viewportWidth).inspectorDefault;
}

export function parsePaneLayoutPreference(
  raw: string | null,
  viewportWidth: number,
): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PaneLayoutPreferenceV1>;
    if (
      parsed.version !== PANE_LAYOUT_VERSION ||
      typeof parsed.inspectorWidth !== "number"
    )
      return null;
    if (!Number.isFinite(parsed.inspectorWidth) || parsed.inspectorWidth <= 0)
      return null;
    return clampInspectorWidth(viewportWidth, parsed.inspectorWidth);
  } catch {
    return null;
  }
}

export function serializePaneLayoutPreference(inspectorWidth: number): string {
  const preference: PaneLayoutPreferenceV1 = {
    version: PANE_LAYOUT_VERSION,
    inspectorWidth: Math.round(
      finiteNumber(inspectorWidth, getDefaultInspectorWidth(1440)),
    ),
    savedAt: new Date().toISOString(),
  };
  return JSON.stringify(preference);
}

import { describe, expect, it } from "vitest";
import {
  clampInspectorWidth,
  getDefaultInspectorWidth,
  getPaneBounds,
  parsePaneLayoutPreference,
  PANE_LAYOUT_VERSION,
  serializePaneLayoutPreference,
} from "./paneLayout";

describe("paneLayout", () => {
  it("uses a workspace-first default at 1440px", () => {
    const bounds = getPaneBounds(1440);
    expect(bounds.viewportTier).toBe("wide");
    expect(bounds.workspaceMin).toBeGreaterThanOrEqual(720);
    expect(bounds.inspectorDefault).toBeGreaterThanOrEqual(370);
    expect(bounds.inspectorDefault).toBeLessThanOrEqual(400);
  });

  it("clamps inspector width to preserve workspace minimum", () => {
    const bounds = getPaneBounds(1440);
    expect(clampInspectorWidth(1440, 9999)).toBe(bounds.inspectorMax);
    expect(clampInspectorWidth(1440, 1)).toBe(bounds.inspectorMin);
  });

  it("adapts bounds for compact and narrow viewports", () => {
    const compact = getPaneBounds(1024);
    expect(compact.viewportTier).toBe("compact");
    expect(compact.inspectorMin).toBeGreaterThanOrEqual(220);
    expect(compact.inspectorMax).toBeGreaterThanOrEqual(compact.inspectorMin);

    const narrow = getPaneBounds(900);
    expect(narrow.viewportTier).toBe("below-target");
    expect(narrow.inspectorDefault).toBeGreaterThanOrEqual(narrow.inspectorMin);
    expect(narrow.inspectorDefault).toBeLessThanOrEqual(narrow.inspectorMax);
  });

  it("ignores invalid stored preferences", () => {
    expect(parsePaneLayoutPreference(null, 1440)).toBeNull();
    expect(parsePaneLayoutPreference("{bad json", 1440)).toBeNull();
    expect(
      parsePaneLayoutPreference(
        JSON.stringify({ version: 0, inspectorWidth: 400 }),
        1440,
      ),
    ).toBeNull();
    expect(
      parsePaneLayoutPreference(
        JSON.stringify({ version: PANE_LAYOUT_VERSION, inspectorWidth: -1 }),
        1440,
      ),
    ).toBeNull();
  });

  it("round-trips serialized preferences with viewport clamp", () => {
    const defaultWidth = getDefaultInspectorWidth(1440);
    const raw = serializePaneLayoutPreference(defaultWidth);
    expect(parsePaneLayoutPreference(raw, 1440)).toBe(defaultWidth);

    const oversized = serializePaneLayoutPreference(9999);
    expect(parsePaneLayoutPreference(oversized, 1440)).toBe(
      getPaneBounds(1440).inspectorMax,
    );
  });

  it("provides safe defaults for non-finite values", () => {
    expect(getDefaultInspectorWidth(Number.NaN)).toBeGreaterThan(0);
    expect(clampInspectorWidth(1440, Number.NaN)).toBe(
      getDefaultInspectorWidth(1440),
    );
  });
});

export type CanvasBackingStoreTarget = {
  width: number;
  height: number;
};

export const MAX_CANVAS_DEVICE_PIXEL_RATIO = 2;

export function normalizedCanvasDevicePixelRatio(devicePixelRatio: number | undefined): number {
  if (!Number.isFinite(devicePixelRatio) || !devicePixelRatio || devicePixelRatio <= 0) return 1;
  return Math.min(devicePixelRatio, MAX_CANVAS_DEVICE_PIXEL_RATIO);
}

export function ensureCanvasBackingStore(
  canvas: CanvasBackingStoreTarget,
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number | undefined,
): { dpr: number; width: number; height: number; resized: boolean } {
  const dpr = normalizedCanvasDevicePixelRatio(devicePixelRatio);
  const width = Math.max(1, Math.round(cssWidth * dpr));
  const height = Math.max(1, Math.round(cssHeight * dpr));
  const resized = canvas.width !== width || canvas.height !== height;

  if (resized) {
    canvas.width = width;
    canvas.height = height;
  }

  return { dpr, width, height, resized };
}

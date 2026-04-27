import { describe, expect, it } from 'vitest';
import { ensureCanvasBackingStore, normalizedCanvasDevicePixelRatio, type CanvasBackingStoreTarget } from './canvas2dRenderer';

function countedCanvas(initialWidth: number, initialHeight: number) {
  let width = initialWidth;
  let height = initialHeight;
  let widthWrites = 0;
  let heightWrites = 0;
  const canvas = {
    get width() {
      return width;
    },
    set width(value: number) {
      widthWrites += 1;
      width = value;
    },
    get height() {
      return height;
    },
    set height(value: number) {
      heightWrites += 1;
      height = value;
    },
  } satisfies CanvasBackingStoreTarget;

  return {
    canvas,
    writes: () => widthWrites + heightWrites,
  };
}

describe('canvas2dRenderer', () => {
  it('does not rewrite the backing store when the pixel size is unchanged', () => {
    const target = countedCanvas(1960, 1160);
    const result = ensureCanvasBackingStore(target.canvas, 980, 580, 2);

    expect(result.resized).toBe(false);
    expect(target.writes()).toBe(0);
  });

  it('resizes only when device-pixel backing dimensions changed', () => {
    const target = countedCanvas(980, 580);
    const result = ensureCanvasBackingStore(target.canvas, 980, 580, 2);

    expect(result).toMatchObject({ dpr: 2, width: 1960, height: 1160, resized: true });
    expect(target.writes()).toBe(2);
  });

  it('caps extreme device pixel ratios for large graph redraw cost', () => {
    expect(normalizedCanvasDevicePixelRatio(0)).toBe(1);
    expect(normalizedCanvasDevicePixelRatio(undefined)).toBe(1);
    expect(normalizedCanvasDevicePixelRatio(3)).toBe(2);
  });
});

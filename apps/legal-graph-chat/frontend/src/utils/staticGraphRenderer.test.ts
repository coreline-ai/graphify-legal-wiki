import { describe, expect, it } from 'vitest';
import {
  centerStaticPositions,
  staticCameraUp,
  staticCameraPosition,
  staticEdgeOpacity,
  staticInitialRotation,
  staticNodePointSize,
} from './staticGraphRenderer';

describe('staticGraphRenderer', () => {
  it('uses very low opacity for raw 176k all-edge rendering', () => {
    expect(staticEdgeOpacity(176_128)).toBeLessThanOrEqual(0.005);
    expect(staticEdgeOpacity(176_128)).toBeLessThan(staticEdgeOpacity(10_000));
    expect(staticEdgeOpacity(0)).toBe(0);
  });

  it('keeps large raw graph nodes visible above dense edges', () => {
    expect(staticNodePointSize(9_001, 176_128)).toBeGreaterThan(staticNodePointSize(1_500, 0));
    expect(staticNodePointSize(1_500, 0)).toBeGreaterThan(7);
  });

  it('centers backend static positions around the viewport origin', () => {
    const centered = centerStaticPositions([
      { id: 'a', x: 100, y: 10, z: -40 },
      { id: 'b', x: 300, y: 90, z: 160 },
    ]);

    expect(centered.center).toEqual({ x: 200, y: 50, z: 60 });
    expect(centered.positions.get('a')).toMatchObject({ x: -100, y: -40, z: -100 });
    expect(centered.positions.get('b')).toMatchObject({ x: 100, y: 40, z: 100 });
    expect(centered.maxDistance).toBeGreaterThan(140);
  });

  it('starts from an oblique camera position instead of flattening the z axis', () => {
    const camera = staticCameraPosition(800);
    expect(camera.x).not.toBe(0);
    expect(camera.y).not.toBe(0);
    expect(camera.z).toBeGreaterThan(0);
  });

  it('keeps circular annulus layouts close to top-down instead of oblique', () => {
    const camera = staticCameraPosition(800, 'circular');
    const rotation = staticInitialRotation('circular');
    const up = staticCameraUp('circular');

    expect(rotation).toEqual({ x: 0, y: 0, z: 0 });
    expect(camera.y).toBeGreaterThan(camera.z * 8);
    expect(Math.abs(camera.x)).toBeLessThan(0.001);
    expect(up).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('keeps spherical full graph layouts oblique and truly 3D', () => {
    const camera = staticCameraPosition(800, 'spherical');
    const rotation = staticInitialRotation('spherical');
    const up = staticCameraUp('spherical');

    expect(rotation.x).not.toBe(0);
    expect(rotation.y).not.toBe(0);
    expect(camera.x).not.toBe(0);
    expect(camera.y).not.toBe(0);
    expect(camera.z).toBeGreaterThan(0);
    expect(up).toEqual({ x: 0, y: 1, z: 0 });
  });
});

import type { StaticLayoutMode } from '../api/types';

export interface StaticPoint {
  id: string;
  x: number;
  y: number;
  z: number;
}

export interface StaticBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface StaticCenteredPositions {
  positions: Map<string, StaticPoint>;
  bounds: StaticBounds;
  center: Omit<StaticPoint, 'id'>;
  maxDistance: number;
}

export const STATIC_INITIAL_ROTATION = {
  x: -0.44,
  y: 0.34,
  z: 0,
} as const;

export const STATIC_CIRCULAR_INITIAL_ROTATION = {
  x: 0,
  y: 0,
  z: 0,
} as const;

function isFlatCircularLayout(layoutMode?: StaticLayoutMode | null): boolean {
  return layoutMode === 'circular';
}

export function staticInitialRotation(layoutMode?: StaticLayoutMode | null): Omit<StaticPoint, 'id'> {
  return isFlatCircularLayout(layoutMode) ? STATIC_CIRCULAR_INITIAL_ROTATION : STATIC_INITIAL_ROTATION;
}

export function staticCameraUp(layoutMode?: StaticLayoutMode | null): Omit<StaticPoint, 'id'> {
  return isFlatCircularLayout(layoutMode) ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
}

export function staticEdgeOpacity(edgeCount: number): number {
  if (edgeCount >= 150_000) return 0.0035;
  if (edgeCount >= 75_000) return 0.006;
  if (edgeCount >= 25_000) return 0.014;
  if (edgeCount >= 5_000) return 0.035;
  if (edgeCount > 0) return 0.14;
  return 0;
}

export function staticNodePointSize(nodeCount: number, edgeCount: number): number {
  if (edgeCount >= 100_000) return 7.8;
  if (nodeCount >= 5_000) return 6.8;
  if (nodeCount >= 1_000) return 7.2;
  return 5.8;
}

export function staticCameraPosition(maxDistance: number, layoutMode?: StaticLayoutMode | null): Omit<StaticPoint, 'id'> {
  const distance = Math.max(1100, maxDistance * 2.35);
  if (isFlatCircularLayout(layoutMode)) {
    return {
      x: 0,
      y: distance * 1.04,
      z: distance * 0.08,
    };
  }
  return {
    x: distance * 0.54,
    y: distance * 0.34,
    z: distance,
  };
}

export function centerStaticPositions(points: StaticPoint[]): StaticCenteredPositions {
  if (!points.length) {
    return {
      positions: new Map(),
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 },
      center: { x: 0, y: 0, z: 0 },
      maxDistance: 1,
    };
  }

  const bounds = points.reduce<StaticBounds>(
    (current, point) => ({
      minX: Math.min(current.minX, point.x),
      maxX: Math.max(current.maxX, point.x),
      minY: Math.min(current.minY, point.y),
      maxY: Math.max(current.maxY, point.y),
      minZ: Math.min(current.minZ, point.z),
      maxZ: Math.max(current.maxZ, point.z),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      minZ: Number.POSITIVE_INFINITY,
      maxZ: Number.NEGATIVE_INFINITY,
    },
  );

  const center = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    z: (bounds.minZ + bounds.maxZ) / 2,
  };
  let maxDistance = 1;
  const positions = new Map<string, StaticPoint>();
  for (const point of points) {
    const centered = {
      id: point.id,
      x: point.x - center.x,
      y: point.y - center.y,
      z: point.z - center.z,
    };
    maxDistance = Math.max(maxDistance, Math.hypot(centered.x, centered.y, centered.z));
    positions.set(point.id, centered);
  }

  return { positions, bounds, center, maxDistance };
}

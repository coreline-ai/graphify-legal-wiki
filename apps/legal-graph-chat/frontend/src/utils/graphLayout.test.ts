import { describe, expect, it } from 'vitest';
import { communityIndex, graphStats, layoutGraph, nodeRadius } from './graphLayout';
import type { GraphPayloadDTO } from '../api/types';

describe('graphLayout', () => {
  const payload: GraphPayloadDTO = {
    nodes: [
      { id: 'a', label: 'A', community: 0, degree: 4 },
      { id: 'b', label: 'B', community: 'community-13', degree: 100 },
      { id: 'c', label: 'C' },
    ],
    edges: [
      { source: 'a', target: 'b', confidence: 'EXTRACTED', weight: 2 },
      { source: 'b', target: 'c', confidence: 'INFERRED', weight: 1 },
    ],
    focus_node_id: 'a',
  };

  it('keeps community colors bounded to 12 design tokens', () => {
    expect(communityIndex(0)).toBe(0);
    expect(communityIndex('community-13')).toBe(1);
    expect(communityIndex(undefined)).toBe(11);
  });

  it('computes bounded node sizes', () => {
    expect(nodeRadius(payload.nodes[0])).toBeGreaterThan(5);
    expect(nodeRadius(payload.nodes[1])).toBeLessThanOrEqual(18);
  });

  it('filters focus edges without fetching full graph data', () => {
    const focusLayout = layoutGraph(payload, 640, 420, 'focus');
    const hiddenLayout = layoutGraph(payload, 640, 420, 'hidden');
    const allLayout = layoutGraph(payload, 640, 420, 'all');

    expect(focusLayout.nodes).toHaveLength(3);
    expect(focusLayout.edges).toHaveLength(1);
    expect(hiddenLayout.edges).toHaveLength(0);
    expect(allLayout.edges).toHaveLength(2);
  });

  it('projects backend 3D static coordinates into a centered 2D circle', () => {
    const staticPayload: GraphPayloadDTO = {
      layout_mode: 'spherical',
      nodes: [
        { id: 'left', label: 'Left', community: 0, degree: 4, x: -720, y: 0, z: 0 },
        { id: 'right', label: 'Right', community: 1, degree: 4, x: 720, y: 0, z: 0 },
        { id: 'top', label: 'Top', community: 2, degree: 4, x: 0, y: 0, z: -720 },
        { id: 'bottom', label: 'Bottom', community: 3, degree: 4, x: 0, y: 0, z: 720 },
      ],
      edges: [
        { source: 'left', target: 'right' },
        { source: 'top', target: 'bottom' },
      ],
    };

    const layout = layoutGraph(staticPayload, 640, 420, 'all');
    const centerX = 320;
    const centerY = 210;
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    const radii = layout.nodes.map((node) => Math.hypot(node.px - centerX, node.py - centerY));

    expect(byId.get('left')?.px).toBeLessThan(centerX);
    expect(byId.get('right')?.px).toBeGreaterThan(centerX);
    expect(byId.get('top')?.py).toBeLessThan(centerY);
    expect(byId.get('bottom')?.py).toBeGreaterThan(centerY);
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(0.001);
    expect(Math.min(...layout.nodes.map((node) => node.px))).toBeGreaterThanOrEqual(32);
    expect(Math.max(...layout.nodes.map((node) => node.px))).toBeLessThanOrEqual(608);
    expect(Math.min(...layout.nodes.map((node) => node.py))).toBeGreaterThanOrEqual(32);
    expect(Math.max(...layout.nodes.map((node) => node.py))).toBeLessThanOrEqual(388);
  });

  it('formats graph stats', () => {
    expect(graphStats(payload)).toBe('3 nodes · 2 edges');
  });
});

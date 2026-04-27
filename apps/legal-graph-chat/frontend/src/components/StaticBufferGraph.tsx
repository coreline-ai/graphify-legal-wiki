import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EdgeMode, GraphNodeDTO, GraphPayloadDTO } from '../api/types';
import { communityColorHex, edgeLodLayer, edgeVisualColor, graphStats, visibleEdgesForMode } from '../utils/graphLayout';
import {
  centerStaticPositions,
  staticCameraUp,
  staticInitialRotation,
  staticCameraPosition,
  staticEdgeOpacity,
  staticNodePointSize,
} from '../utils/staticGraphRenderer';
import type { StaticPoint } from '../utils/staticGraphRenderer';

type ThreeModule = typeof import('three');

interface StaticBufferGraphProps {
  title: string;
  payload: GraphPayloadDTO;
  edgeMode: EdgeMode;
  selectedNodeId?: string;
  onSelectNode?: (node: GraphNodeDTO) => void;
  edgeStrength?: number;
}

interface StaticDimensions {
  width: number;
  height: number;
}

interface StaticNodePosition {
  x: number;
  y: number;
  z: number;
}

interface StaticSceneController {
  updateSelectedNode: (selectedNodeId?: string, edgeStrength?: number) => void;
  updateEdgeStrength: (edgeStrength: number) => void;
  dispose: () => void;
}

const FALLBACK_DIMENSIONS: StaticDimensions = { width: 320, height: 420 };
const MAX_PIXEL_RATIO = 1.25;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function normalizeDimensions(width: number, height: number): StaticDimensions {
  return {
    width: width > 0 ? Math.floor(width) : FALLBACK_DIMENSIONS.width,
    height: height > 0 ? Math.floor(height) : FALLBACK_DIMENSIONS.height,
  };
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function fallbackPosition(node: GraphNodeDTO, index: number, total: number): StaticNodePosition {
  const communityRaw = typeof node.community === 'number' ? node.community : Number(String(node.community ?? '').replace(/[^0-9-]/g, ''));
  const community = Number.isFinite(communityRaw) ? Math.abs(Math.trunc(communityRaw)) : 0;
  const communityAngle = (community % 12) / 12 * Math.PI * 2;
  const centerRadius = 560;
  const localRadius = Math.max(80, Math.min(280, 9 * Math.sqrt(Math.max(total, 1)))) * Math.sqrt((index + 1) / Math.max(total, 1));
  const localAngle = index * GOLDEN_ANGLE;
  return {
    x: Math.cos(communityAngle) * centerRadius + Math.cos(localAngle) * localRadius,
    y: ((community % 5) - 2) * 70 + Math.sin(localAngle * 0.67) * localRadius * 0.38,
    z: Math.sin(communityAngle) * centerRadius + Math.sin(localAngle) * localRadius,
  };
}

function positionForNode(node: GraphNodeDTO, index: number, total: number): StaticNodePosition {
  if (finite(node.x) && finite(node.y) && finite(node.z)) {
    return { x: node.x, y: node.y, z: node.z };
  }
  return fallbackPosition(node, index, total);
}

function disposeObject(object: { dispose?: () => void } | null | undefined) {
  try {
    object?.dispose?.();
  } catch {
    // Best-effort cleanup for WebGL resources.
  }
}

function staticLayoutLabel(layoutMode: GraphPayloadDTO['layout_mode'] | undefined): string {
  if (!layoutMode) return 'static layout';
  if (layoutMode === 'circular') return 'circular static layout';
  if (layoutMode === 'spherical') return 'spherical 3D layout';
  return `${layoutMode} static layout`;
}

function createNodeCircleTexture(THREE: ThreeModule) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) return null;

  context.clearRect(0, 0, canvas.width, canvas.height);
  const gradient = context.createRadialGradient(28, 24, 4, 32, 32, 30);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.72, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(32, 32, 30, 0, Math.PI * 2);
  context.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export function StaticBufferGraph({ title, payload, edgeMode, selectedNodeId, onSelectNode, edgeStrength = 1 }: StaticBufferGraphProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneControllerRef = useRef<StaticSceneController | null>(null);
  const selectedNodeIdRef = useRef<string | undefined>(selectedNodeId);
  const onSelectNodeRef = useRef<typeof onSelectNode>(onSelectNode);
  const [dimensions, setDimensions] = useState<StaticDimensions | null>(null);
  const [status, setStatus] = useState('static renderer 영역 측정 중…');
  const renderStats = useMemo(() => {
    const edges = visibleEdgesForMode(payload, edgeMode);
    return { edges, text: `${graphStats(payload)} · rendered ${edges.length.toLocaleString()} edges` };
  }, [edgeMode, payload]);

  useEffect(() => {
    onSelectNodeRef.current = onSelectNode;
  }, [onSelectNode]);

  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId;
    sceneControllerRef.current?.updateSelectedNode(selectedNodeId, edgeStrength);
  }, [edgeStrength, selectedNodeId]);

  useEffect(() => {
    sceneControllerRef.current?.updateEdgeStrength(edgeStrength);
  }, [edgeStrength]);

  const handleSceneNodeSelect = useCallback((node: GraphNodeDTO) => {
    if (node.id === selectedNodeIdRef.current) return;
    onSelectNodeRef.current?.(node);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof window === 'undefined') return;
    let animationFrameId: number | null = null;
    const measure = () => {
      if (animationFrameId !== null) return;
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        const rect = container.getBoundingClientRect();
        setDimensions((current) => {
          const next = normalizeDimensions(rect.width, rect.height);
          return current && current.width === next.width && current.height === next.height ? current : next;
        });
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => {
        if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
        window.removeEventListener('resize', measure);
      };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => {
      if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !payload.nodes.length || !dimensions) return;
    let cancelled = false;
    let controller: StaticSceneController | null = null;
    setStatus('Three.js static buffer renderer 로딩 중…');

    import('three')
      .then((THREE) => {
        if (cancelled) return;
        controller = mountStaticScene(THREE, container, payload, renderStats.edges, dimensions, setStatus, selectedNodeIdRef.current, handleSceneNodeSelect, edgeStrength);
        sceneControllerRef.current = controller;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus(err instanceof Error ? err.message : 'static renderer load failed');
      });

    return () => {
      cancelled = true;
      if (sceneControllerRef.current === controller) sceneControllerRef.current = null;
      controller?.dispose();
    };
  }, [dimensions, handleSceneNodeSelect, payload, renderStats.edges]);

  return (
    <div className="lg-static-buffer-graph" aria-label={`${title} static renderer`}>
      <div ref={containerRef} className="lg-static-buffer-canvas" />
      <div className="lg-static-buffer-status" role="status">
        <span className="lg-chip" data-tone="accent">static BufferGeometry</span>
        <span className="lg-chip" data-tone={payload.layout_mode === 'circular' || payload.layout_mode === 'spherical' ? 'accent' : undefined}>{staticLayoutLabel(payload.layout_mode)}</span>
        <span className="lg-chip">{renderStats.text}</span>
        <span className="lg-chip">{status}</span>
      </div>
    </div>
  );
}

function mountStaticScene(
  THREE: ThreeModule,
  container: HTMLDivElement,
  payload: GraphPayloadDTO,
  edges: ReturnType<typeof visibleEdgesForMode>,
  dimensions: StaticDimensions,
  setStatus: (status: string) => void,
  selectedNodeId?: string,
  onSelectNode?: (node: GraphNodeDTO) => void,
  edgeStrength = 1,
): StaticSceneController {
  container.replaceChildren();

  const scene = new THREE.Scene();
  const group = new THREE.Group();
  scene.add(group);

  const camera = new THREE.PerspectiveCamera(55, dimensions.width / Math.max(dimensions.height, 1), 1, 8000);
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
  renderer.setSize(dimensions.width, dimensions.height, false);
  renderer.domElement.setAttribute('aria-label', 'Static full graph canvas');
  container.appendChild(renderer.domElement);

  const nodePositions = new Float32Array(payload.nodes.length * 3);
  const nodeColors = new Float32Array(payload.nodes.length * 3);
  const color = new THREE.Color();
  const rawNodePositions = payload.nodes.map<StaticPoint>((node, index) => ({
    id: node.id,
    ...positionForNode(node, index, payload.nodes.length),
  }));
  const centered = centerStaticPositions(rawNodePositions);
  const nodeMap = centered.positions;
  const maxDistance = centered.maxDistance;

  payload.nodes.forEach((node, index) => {
    const pos = nodeMap.get(node.id) ?? positionForNode(node, index, payload.nodes.length);
    nodePositions[index * 3] = pos.x;
    nodePositions[index * 3 + 1] = pos.y;
    nodePositions[index * 3 + 2] = pos.z;
    color.set(communityColorHex(node.community));
    nodeColors[index * 3] = color.r;
    nodeColors[index * 3 + 1] = color.g;
    nodeColors[index * 3 + 2] = color.b;
  });

  const nodeGeometry = new THREE.BufferGeometry();
  nodeGeometry.setAttribute('position', new THREE.BufferAttribute(nodePositions, 3));
  nodeGeometry.setAttribute('color', new THREE.BufferAttribute(nodeColors, 3));
  const nodeTexture = createNodeCircleTexture(THREE);
  const nodeMaterial = new THREE.PointsMaterial({
    size: staticNodePointSize(payload.nodes.length, edges.length),
    sizeAttenuation: false,
    map: nodeTexture ?? undefined,
    alphaTest: nodeTexture ? 0.02 : undefined,
    vertexColors: true,
    transparent: true,
    opacity: 0.98,
    depthTest: false,
    depthWrite: false,
  });
  const points = new THREE.Points(nodeGeometry, nodeMaterial);
  points.renderOrder = 2;

  const normalizedStrength = (value: number) => Math.max(0.5, Math.min(3, value));
  const strength = normalizedStrength(edgeStrength);
  const edgeLayers = {
    density: edges.filter((edge) => edgeLodLayer(edge) === 'density'),
    context: edges.filter((edge) => edgeLodLayer(edge) === 'context'),
    backbone: edges.filter((edge) => edgeLodLayer(edge) === 'backbone' || edgeLodLayer(edge) === 'focus'),
  };
  const edgeResources: Array<{ layer: 'density' | 'context' | 'backbone'; geometry: InstanceType<ThreeModule['BufferGeometry']>; material: InstanceType<ThreeModule['LineBasicMaterial']>; lines: InstanceType<ThreeModule['LineSegments']> }> = [];
  const buildEdgeGeometry = (layerEdges: typeof edges) => {
    const positions = new Float32Array(layerEdges.length * 6);
    const colors = new Float32Array(layerEdges.length * 6);
    let offset = 0;
    layerEdges.forEach((edge) => {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (!source || !target) return;
      const nextColor = new THREE.Color(edgeVisualColor(edge));
      positions[offset] = source.x;
      positions[offset + 1] = source.y;
      positions[offset + 2] = source.z;
      positions[offset + 3] = target.x;
      positions[offset + 4] = target.y;
      positions[offset + 5] = target.z;
      for (let i = 0; i < 2; i += 1) {
        const base = offset + i * 3;
        colors[base] = nextColor.r;
        colors[base + 1] = nextColor.g;
        colors[base + 2] = nextColor.b;
      }
      offset += 6;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(offset === positions.length ? positions : positions.slice(0, offset), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(offset === colors.length ? colors : colors.slice(0, offset), 3));
    return geometry;
  };
  const layerOpacity = (layer: 'density' | 'context' | 'backbone', nextStrength: number) => {
    if (layer === 'density') return Math.min(0.04, staticEdgeOpacity(edges.length) * nextStrength);
    if (layer === 'context') return Math.min(0.18, Math.max(staticEdgeOpacity(edges.length) * 1.6, 0.045) * nextStrength);
    return Math.min(0.46, 0.18 * nextStrength);
  };
  const addEdgeLayer = (layer: 'density' | 'context' | 'backbone', layerEdges: typeof edges, renderOrder: number) => {
    const opacity = layerOpacity(layer, strength);
    if (!layerEdges.length || opacity <= 0) return;
    const geometry = buildEdgeGeometry(layerEdges);
    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.renderOrder = renderOrder;
    group.add(lines);
    edgeResources.push({ layer, geometry, material, lines });
  };
  addEdgeLayer('density', edgeLayers.density, 0);
  addEdgeLayer('context', edgeLayers.context, 1);
  addEdgeLayer('backbone', edgeLayers.backbone, 2);
  group.add(points);

  const selectedPosition = new Float32Array(3);
  const selectedGeometry = new THREE.BufferGeometry();
  const selectedPositionAttribute = new THREE.BufferAttribute(selectedPosition, 3);
  selectedGeometry.setAttribute('position', selectedPositionAttribute);
  const selectedMaterial = new THREE.PointsMaterial({
    size: staticNodePointSize(payload.nodes.length, edges.length) + 6,
    sizeAttenuation: false,
    color: '#a882ff',
    map: nodeTexture ?? undefined,
    alphaTest: nodeTexture ? 0.02 : undefined,
    transparent: true,
    opacity: 1,
    depthTest: false,
    depthWrite: false,
  });
  const selectedPoints = new THREE.Points(selectedGeometry, selectedMaterial);
  selectedPoints.visible = false;
  selectedPoints.renderOrder = 3;
  group.add(selectedPoints);

  const focusEdgeGeometry = new THREE.BufferGeometry();
  focusEdgeGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
  const focusEdgeMaterial = new THREE.LineBasicMaterial({
    color: '#f4eaff',
    transparent: true,
    opacity: Math.min(1, 0.78 * strength),
    depthWrite: false,
  });
  const focusLines = new THREE.LineSegments(focusEdgeGeometry, focusEdgeMaterial);
  focusLines.visible = false;
  focusLines.renderOrder = 4;
  group.add(focusLines);

  const initialRotation = staticInitialRotation(payload.layout_mode);
  group.rotation.set(initialRotation.x, initialRotation.y, initialRotation.z);
  const initialCameraPosition = staticCameraPosition(maxDistance, payload.layout_mode);
  const initialCameraUp = staticCameraUp(payload.layout_mode);
  camera.up.set(initialCameraUp.x, initialCameraUp.y, initialCameraUp.z);
  camera.position.set(initialCameraPosition.x, initialCameraPosition.y, initialCameraPosition.z);
  camera.lookAt(0, 0, 0);

  let dragging = false;
  let movedDuringDrag = false;
  let lastX = 0;
  let lastY = 0;
  let renderFrame: number | null = null;
  const hitVector = new THREE.Vector3();
  const hitTestNode = (clientX: number, clientY: number): GraphNodeDTO | null => {
    const rect = renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const hitRadius = Math.max(7, staticNodePointSize(payload.nodes.length, edges.length) + 3);
    let nearest: GraphNodeDTO | null = null;
    let nearestDistance = hitRadius;
    for (let index = 0; index < payload.nodes.length; index += 1) {
      hitVector.set(nodePositions[index * 3], nodePositions[index * 3 + 1], nodePositions[index * 3 + 2]);
      group.localToWorld(hitVector);
      hitVector.project(camera);
      const px = (hitVector.x * 0.5 + 0.5) * rect.width;
      const py = (-hitVector.y * 0.5 + 0.5) * rect.height;
      const distance = Math.hypot(px - x, py - y);
      if (distance <= nearestDistance) {
        nearest = payload.nodes[index];
        nearestDistance = distance;
      }
    }
    return nearest;
  };
  const render = () => {
    if (renderFrame !== null) return;
    renderFrame = window.requestAnimationFrame(() => {
      renderFrame = null;
      renderer.render(scene, camera);
    });
  };
  const updateSelectedNode = (nextSelectedNodeId?: string, nextEdgeStrength = strength) => {
    const selectedIndex = nextSelectedNodeId ? payload.nodes.findIndex((node) => node.id === nextSelectedNodeId) : -1;
    if (selectedIndex < 0) {
      if (selectedPoints.visible) {
        selectedPoints.visible = false;
        focusLines.visible = false;
        render();
      }
      return;
    }

    selectedPosition[0] = nodePositions[selectedIndex * 3];
    selectedPosition[1] = nodePositions[selectedIndex * 3 + 1];
    selectedPosition[2] = nodePositions[selectedIndex * 3 + 2];
    selectedPositionAttribute.needsUpdate = true;
    selectedPoints.visible = true;
    const focusEdges = edges.filter((edge) => edge.source === nextSelectedNodeId || edge.target === nextSelectedNodeId);
    const focusPositions = new Float32Array(focusEdges.length * 6);
    let focusOffset = 0;
    for (const edge of focusEdges) {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (!source || !target) continue;
      focusPositions[focusOffset] = source.x;
      focusPositions[focusOffset + 1] = source.y;
      focusPositions[focusOffset + 2] = source.z;
      focusPositions[focusOffset + 3] = target.x;
      focusPositions[focusOffset + 4] = target.y;
      focusPositions[focusOffset + 5] = target.z;
      focusOffset += 6;
    }
    focusEdgeGeometry.setAttribute('position', new THREE.BufferAttribute(focusOffset === focusPositions.length ? focusPositions : focusPositions.slice(0, focusOffset), 3));
    focusEdgeGeometry.computeBoundingSphere();
    focusEdgeMaterial.opacity = Math.min(1, 0.82 * Math.max(0.5, Math.min(3, nextEdgeStrength)));
    focusEdgeMaterial.needsUpdate = true;
    focusLines.visible = focusOffset > 0;
    render();
  };
  const updateEdgeStrength = (nextEdgeStrength: number) => {
    const nextStrength = normalizedStrength(nextEdgeStrength);
    edgeResources.forEach(({ layer, material }) => {
      material.opacity = layerOpacity(layer, nextStrength);
      material.needsUpdate = true;
    });
    focusEdgeMaterial.opacity = Math.min(1, 0.82 * nextStrength);
    focusEdgeMaterial.needsUpdate = true;
    render();
  };

  const onPointerDown = (event: PointerEvent) => {
    dragging = true;
    movedDuringDrag = false;
    lastX = event.clientX;
    lastY = event.clientY;
    renderer.domElement.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!dragging) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 3) movedDuringDrag = true;
    group.rotation.y += dx * 0.0045;
    group.rotation.x += dy * 0.0035;
    render();
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!movedDuringDrag && onSelectNode) {
      const node = hitTestNode(event.clientX, event.clientY);
      if (node) onSelectNode(node);
    }
    dragging = false;
    renderer.domElement.releasePointerCapture?.(event.pointerId);
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const nextDistance = camera.position.length() * (event.deltaY > 0 ? 1.09 : 0.91);
    camera.position.setLength(Math.max(240, Math.min(maxDistance * 5.5, nextDistance)));
    render();
  };

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointercancel', onPointerUp);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

  setStatus(`ready · ${payload.nodes.length.toLocaleString()} nodes · ${edges.length.toLocaleString()} edges`);
  updateSelectedNode(selectedNodeId);
  render();

  return {
    updateSelectedNode,
    updateEdgeStrength,
    dispose: () => {
      if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      disposeObject(nodeGeometry);
      disposeObject(nodeMaterial);
      disposeObject(nodeTexture);
      disposeObject(selectedGeometry);
      disposeObject(selectedMaterial);
      disposeObject(focusEdgeGeometry);
      disposeObject(focusEdgeMaterial);
      edgeResources.forEach(({ geometry, material }) => {
        disposeObject(geometry);
        disposeObject(material);
      });
      renderer.dispose();
      container.replaceChildren();
    },
  };
}

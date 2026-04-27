export type GraphRenderMode = '3d' | '2d' | 'evidence';

export function shouldShowGraphSelection(renderMode: GraphRenderMode, hasSelectedNode: boolean): boolean {
  return hasSelectedNode && renderMode !== 'evidence';
}

import type { ViewId } from './types';

export type RendererId = 'react-flow' | 'sigma';
export type CanvasCommandType = 'zoom-in' | 'zoom-out' | 'fit';

export interface CanvasCommand {
  id: number;
  type: CanvasCommandType;
}

export interface RendererDefinition {
  id: RendererId;
  label: string;
  supports: readonly ViewId[];
  minimumNodeCount: number;
  supportsMinimap: boolean;
}

export const workspaceRenderers: readonly RendererDefinition[] = Object.freeze([
  {
    id: 'react-flow',
    label: 'react flow',
    supports: ['technical', 'product', 'onboarding'],
    minimumNodeCount: 0,
    supportsMinimap: true,
  },
  {
    // Onboarding is deliberately absent: its view is closure-filtered to a
    // reading order, so it stays well under the WebGL threshold and renders
    // ordered cards that the Sigma node programs cannot draw.
    id: 'sigma',
    label: 'sigma · webgl',
    supports: ['technical'],
    minimumNodeCount: 501,
    supportsMinimap: false,
  },
]);

export function rendererFor(
  view: ViewId,
  visibleNodeCount: number,
): RendererDefinition {
  return [...workspaceRenderers]
    .filter(
      (renderer) =>
        renderer.supports.includes(view) &&
        renderer.minimumNodeCount <= visibleNodeCount,
    )
    .sort((left, right) => right.minimumNodeCount - left.minimumNodeCount)[0]!;
}

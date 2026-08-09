'use client';

import { createContext, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react';
import type { CanvasToolbar } from '../components/CanvasToolbar';
import type { CanvasCommand, RendererDefinition } from '../rendererRegistry';
import type { ViewId } from '../types';

export interface WorkspaceViewCanvasProps {
  command: CanvasCommand | null;
  showMinimap: boolean;
  fitKey: string;
  graphRootLabel: string;
}

export interface WorkspaceViewRuntimeValue {
  id: ViewId;
  title: string;
  loadingLabel: string;
  visibleNodeCount: number;
  visibleEdgeCount: number;
  renderer: RendererDefinition;
  countLabel?: string;
  coverageSummary?: ComponentProps<typeof CanvasToolbar>['coverageSummary'];
  technicalExpansion?: ComponentProps<typeof CanvasToolbar>['technicalExpansion'];
  canvasRef: RefObject<HTMLDivElement>;
  renderCanvas(props: WorkspaceViewCanvasProps): ReactNode;
  statusLine: string;
}

const WorkspaceViewRuntimeContext = createContext<WorkspaceViewRuntimeValue | null>(null);

export function WorkspaceViewRuntimeProvider({
  value,
  children,
}: {
  value: WorkspaceViewRuntimeValue;
  children: ReactNode;
}) {
  return <WorkspaceViewRuntimeContext.Provider value={value}>{children}</WorkspaceViewRuntimeContext.Provider>;
}

export function useWorkspaceViewRuntime(): WorkspaceViewRuntimeValue {
  const value = useContext(WorkspaceViewRuntimeContext);
  if (value === null) throw new Error('A trusted workspace view must provide WorkspaceViewRuntime.');
  return value;
}

export function useMeasuredWorkspaceCanvas(): {
  canvasRef: RefObject<HTMLDivElement>;
  canvasSize: { width: number; height: number };
} {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 880, height: 600 });

  useEffect(() => {
    const element = canvasRef.current;
    if (element === null || typeof window === 'undefined') return undefined;
    const update = (): void => {
      const bounds = element.getBoundingClientRect();
      const next = { width: Math.round(bounds.width), height: Math.round(bounds.height) };
      setCanvasSize((current) => current.width === next.width && current.height === next.height ? current : next);
    };
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { canvasRef, canvasSize };
}

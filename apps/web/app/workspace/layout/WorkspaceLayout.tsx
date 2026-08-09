'use client';

import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import type {
  ResolvedWorkspaceLayout,
  ResolvedWorkspaceRegion,
  WorkspaceSlotId,
} from '../../../../../packages/workspace-packs/src/runtime';
import { ResizeHandle, type WorkspaceResizeEdge } from './ResizeHandle';
import './workspace-layout.css';

export interface WorkspaceRegionRenderResult {
  content: ReactNode;
  present: boolean;
}

export interface WorkspaceLayoutProps {
  layout: ResolvedWorkspaceLayout;
  viewId: string;
  renderRegion(regionId: string): WorkspaceRegionRenderResult;
  labelRegion?(regionId: string): string;
  onResize?(regionId: string, committedValue: number): void;
  onCollapse?(regionId: string): void;
  onExpand?(regionId: string): void;
}

interface LegacyWorkspaceLayoutProps
  extends Omit<WorkspaceLayoutProps, 'renderRegion'> {
  renderRegion(regionId: string): ReactNode;
}

interface RenderedRegion {
  region: ResolvedWorkspaceRegion;
  content: ReactNode;
}

const normalSlots: readonly WorkspaceSlotId[] = [
  'top',
  'navigation',
  'explorer',
  'primary',
  'inspector',
  'bottom',
];

function isRenderResult(value: ReactNode | WorkspaceRegionRenderResult): value is WorkspaceRegionRenderResult {
  return typeof value === 'object'
    && value !== null
    && 'present' in value
    && typeof value.present === 'boolean'
    && 'content' in value;
}

function normalizeRenderResult(value: ReactNode | WorkspaceRegionRenderResult): WorkspaceRegionRenderResult {
  if (isRenderResult(value)) return value;
  return { content: value, present: value !== null && value !== undefined && value !== false };
}

function edgeFor(region: ResolvedWorkspaceRegion): WorkspaceResizeEdge {
  if (region.resize === 'horizontal') {
    return region.slot === 'inspector' ? 'inline-start' : 'inline-end';
  }
  return region.slot === 'bottom' ? 'block-start' : 'block-end';
}

function dimensionStyle(region: ResolvedWorkspaceRegion, value: number): CSSProperties {
  if (region.resize === 'horizontal') return { inlineSize: `${value}px` };
  if (region.resize === 'vertical') return { blockSize: `${value}px` };
  if (!region.collapsed) return {};
  if (region.slot === 'top' || region.slot === 'bottom') return { blockSize: '44px' };
  return { inlineSize: '44px' };
}

function focusAfterPaint(callback: () => void): void {
  if (typeof window === 'undefined') return;
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => callback());
  } else {
    window.setTimeout(callback, 0);
  }
}

export function WorkspaceLayout(props: WorkspaceLayoutProps): ReactElement;
/** Compatibility overload for behavior-first tests authored before the presence signature landed. */
export function WorkspaceLayout(props: LegacyWorkspaceLayoutProps): ReactElement;
export function WorkspaceLayout({
  layout,
  viewId,
  renderRegion,
  labelRegion = (regionId) => regionId,
  onResize = () => undefined,
  onCollapse = () => undefined,
  onExpand = () => undefined,
}: WorkspaceLayoutProps | LegacyWorkspaceLayoutProps): ReactElement {
  const [previewSizes, setPreviewSizes] = useState<Readonly<Record<string, number>>>({});

  useEffect(() => {
    setPreviewSizes((current) => {
      const validIds = new Set(layout.regions.map((region) => region.id));
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => validIds.has(id)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [layout.regions]);

  const rendered = layout.regions
    .filter((region) => !region.hidden && (region.visibleInViews === null || region.visibleInViews.includes(viewId)))
    .map((region): RenderedRegion | null => {
      const result = normalizeRenderResult(renderRegion(region.id));
      if (region.slot !== 'primary' && !result.present) return null;
      return { region, content: result.content };
    })
    .filter((entry): entry is RenderedRegion => entry !== null);

  const groups = new Map<WorkspaceSlotId, RenderedRegion[]>();
  for (const slot of [...normalSlots, 'overlay'] as const) groups.set(slot, []);
  for (const entry of rendered) groups.get(entry.region.slot)!.push(entry);
  for (const entries of groups.values()) {
    entries.sort((left, right) => left.region.order - right.region.order || left.region.id.localeCompare(right.region.id));
  }

  const findDock = (regionId: string): HTMLElement | null => {
    if (typeof document === 'undefined') return null;
    return [...document.querySelectorAll<HTMLElement>('[data-workspace-dock]')]
      .find((element) => element.dataset.workspaceDock === regionId) ?? null;
  };

  const collapseRegion = (region: ResolvedWorkspaceRegion) => {
    if (region.slot === 'primary' || !region.collapsible) return;
    const dock = findDock(region.id);
    const ownedFocus = dock?.contains(document.activeElement) ?? false;
    onCollapse(region.id);
    if (ownedFocus) {
      focusAfterPaint(() => {
        const restore = findDock(region.id)?.querySelector<HTMLButtonElement>('[data-workspace-restore]');
        restore?.focus();
      });
    }
  };

  const expandRegion = (region: ResolvedWorkspaceRegion) => {
    if (region.slot === 'primary' || !region.collapsible) return;
    onExpand(region.id);
    focusAfterPaint(() => findDock(region.id)?.querySelector<HTMLElement>('[role="separator"]')?.focus());
  };

  const previewRegion = (regionId: string, value: number) => {
    setPreviewSizes((current) => current[regionId] === value ? current : { ...current, [regionId]: value });
  };

  const commitRegion = (regionId: string, value: number) => {
    setPreviewSizes((current) => ({ ...current, [regionId]: value }));
    onResize(regionId, value);
  };

  const cancelRegion = (regionId: string) => {
    setPreviewSizes((current) => {
      if (!(regionId in current)) return current;
      const next = { ...current };
      delete next[regionId];
      return next;
    });
  };

  const renderDock = ({ region, content }: RenderedRegion) => {
    const collapsible = region.slot !== 'primary' && region.collapsible;
    const collapsed = collapsible && region.collapsed;
    const displayValue = collapsed ? 44 : previewSizes[region.id] ?? region.size;
    const style = dimensionStyle({ ...region, collapsed }, displayValue);
    return (
      <div
        className={`workspace-layout__dock workspace-layout__dock--${region.slot}`}
        data-compact-behavior={region.compactBehavior}
        data-resize-axis={region.resize}
        data-workspace-dock={region.id}
        key={region.id}
        style={style}
      >
        <section
          className={`workspace-layout__region workspace-layout__region--${region.slot}`}
          data-compact-behavior={region.compactBehavior}
          id={region.id}
          aria-label={labelRegion(region.id)}
        >
          {collapsed ? (
            <button
              type="button"
              className="workspace-layout__restore"
              data-workspace-restore={region.id}
              onClick={() => expandRegion(region)}
            >
              Restore {labelRegion(region.id)}
            </button>
          ) : content}
        </section>
        {region.resize !== 'none' && !collapsed && (
          <ResizeHandle
            regionId={region.id}
            axis={region.resize}
            edge={edgeFor(region)}
            value={displayValue}
            minimum={region.minimumSize}
            maximum={region.maximumSize}
            collapsible={collapsible}
            collapsed={collapsed}
            onPreview={(value) => previewRegion(region.id, value)}
            onCommit={(value) => commitRegion(region.id, value)}
            onCancel={() => cancelRegion(region.id)}
            onCollapse={() => collapseRegion(region)}
            onExpand={() => expandRegion(region)}
          />
        )}
      </div>
    );
  };

  const renderGroup = (slot: WorkspaceSlotId) => {
    const entries = groups.get(slot) ?? [];
    if (entries.length === 0) return null;
    return (
      <div
        className={`workspace-layout__slot-group workspace-layout__slot-group--${slot}`}
        data-workspace-slot-group={slot}
        key={slot}
      >
        {entries.map(renderDock)}
      </div>
    );
  };

  return (
    <div className="workspace-layout" data-layout-id={layout.id} data-view-id={viewId}>
      {renderGroup('top')}
      <div className="workspace-layout__body">
        {renderGroup('navigation')}
        {renderGroup('explorer')}
        {renderGroup('primary')}
        {renderGroup('inspector')}
      </div>
      {renderGroup('bottom')}
      {renderGroup('overlay')}
    </div>
  );
}

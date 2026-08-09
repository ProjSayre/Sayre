'use client';

import type { ResolvedWorkspaceLayout } from '../../../../../packages/workspace-packs/src/runtime';
import { WorkspaceLayout } from '../../workspace/layout/WorkspaceLayout';

const layout = {
  id: 'layout.browser-review-geometry',
  regions: [
    ['top.a', 'top', 0, 56, 'vertical'],
    ['top.b', 'top', 1, 64, 'vertical'],
    ['navigation.a', 'navigation', 0, 60, 'horizontal'],
    ['navigation.b', 'navigation', 1, 72, 'horizontal'],
    ['explorer.a', 'explorer', 0, 76, 'horizontal'],
    ['explorer.b', 'explorer', 1, 84, 'horizontal'],
    ['primary', 'primary', 0, 320, 'none'],
    ['inspector.a', 'inspector', 0, 80, 'horizontal'],
    ['inspector.b', 'inspector', 1, 88, 'horizontal'],
    ['bottom.a', 'bottom', 0, 52, 'vertical'],
    ['bottom.b', 'bottom', 1, 68, 'vertical'],
  ].map(([id, slot, order, size, resize]) => ({
    id,
    slot,
    order,
    component: { id: 'sayre.browser-review-fixture', version: 1, props: {} },
    defaultSize: size,
    minimumSize: 44,
    maximumSize: 500,
    size,
    resize,
    collapsible: false,
    collapsed: false,
    hidden: false,
    compactBehavior: 'keep',
    visibleInViews: null,
  })),
} as unknown as ResolvedWorkspaceLayout;

export function WorkspaceLayoutReviewFixture() {
  return (
    <main
      data-review-layout-fixture="same-slot-axis-matrix"
      style={{ blockSize: '100vh', inlineSize: '100vw', overflow: 'hidden' }}
    >
      <WorkspaceLayout
        layout={layout}
        viewId="technical"
        renderRegion={(regionId) => ({
          present: true,
          content: <span data-review-region-content={regionId}>{regionId}</span>,
        })}
      />
    </main>
  );
}

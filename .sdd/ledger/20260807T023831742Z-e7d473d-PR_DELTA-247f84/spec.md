# FE-ARCH-01R — Product workspace compositor, interaction parity, and editor UX remediation

## Goal

Restore the Next.js product frontend to a contained, reliable, and polished workspace while preserving the Workspace Pack architecture. Every Technical, Product, Onboarding, settings, inspector, resize, recovery, and visual-editor interaction must remain reachable and correctly hit-testable at 1280px, 736px, and 320px, with real drag/drop and resizing proven in the browser before any further LLM-authoring experimentation.

## Scope

### In scope

- The product frontend under `apps/web`, plus a product-workspace browser regression script under root `scripts/` and its root package command. The root Vite marketing UI under `src/` is not the target.
- Remediation of the FE-ARCH Workspace Pack implementation already present on `ticket/fe-arch-01-workspace-packs`; this is not a second feature branch or an expansion into a new ticket.
- A contained compositor in which trusted view wrappers and the legacy `.mock-root` fill their assigned primary region instead of escaping to the viewport.
- Explicit region-presence resolution before `WorkspaceLayout` allocates a dock, so an inactive inspector or explorer cannot leave an invisible hit-testing layer or consume width.
- Deterministic ordered composition for multiple regions in one slot, sizing along the declared resize axis, correct handles at the shared region boundary, and collapse behavior that honors `collapsible`.
- Live resize preview with clamping and one persistence write on a successful pointer/keyboard commit; cancellation reverts preview and does not persist.
- Atomic Product-to-Technical “Explore code” navigation that retains the selected file, opens the Technical inspector and explorer, and preserves the return-to-feature path.
- A compact system-owned recovery menu outside pack control that does not become a second wrapping top bar, expose implementation-oriented pack IDs in normal chrome, cover the product top bar, or show destructive/reset actions until the menu is opened.
- A design-system-consistent Workspace Pack settings surface with legible pack identity/status, grouped actions, import feedback, and a usable fork form.
- A reorganized visual editor with grouped or disclosure-based controls, usable preview space at compact widths, truthful locked-primary behavior, filtered replacement choices, and real pointer/touch/keyboard drag/drop.
- Behavioral unit/integration coverage plus a headless Chromium product-workspace regression that measures rendered rectangles and hit targets at 1280px, 736px, and 320px. Regex checks for breakpoint literals do not count as responsive coverage.
- Preservation of already confirmed behavior: default/pitch activation, default restoration, Product and Onboarding rendering, editor Discard, local import/export/fork safety, and clean browser console operation.
- Existing semantic tokens and canonical pack color values remain manually editable by a developer in the built-in JSON/theme sources; no new styling abstraction may make ordinary color edits require generated code.

### Explicitly out of scope

- The root Vite marketing website (`src/`, `public/`, root `index.html`, and its marketing layouts).
- Further LLM authoring experiments, a production LLM frontend agent, prompt design, an LLM deployment claim, or marketplace hosting. The visual editor and its deterministic operations must pass this remediation gate first; LLM R&D may be respecified afterward.
- Changes to Workspace Pack schema v1, portable serialization, the semantic `WorkspaceEditOperation` union, import trust rules, or arbitrary-code restrictions unless a failing remediation test proves an existing contract defect that cannot be fixed in the product runtime.
- Backend services, graph schema, graph queries, MCP tools, authentication, tenant isolation, RBAC, WebSocket authorization, ingestion, queues, model providers, or server persistence.
- Replacing React Flow, Sigma.js, graphology, or the approximately 500-visible-node renderer boundary.
- A hosted marketplace, coworker synchronization, organization-wide pack storage, or public arbitrary-code extensions.

### Product and architecture alignment

- `origin/main` PRD v5 defines the Next.js Technical/Product/Onboarding product canvas but does not define Workspace Packs, a visual workspace editor, an LLM authoring surface, or a marketplace. Workspace Packs remain founder-directed scope from FE-ARCH-01. This remediation preserves the PRD's unchanged graph, renderer, service-layer, authorization, and multi-tenancy boundaries.
- All data passed to trusted catalog components remains server-authorized before it reaches the browser. Region presence, layout, and hit testing are presentation decisions only; they must not perform graph traversal or client-side authorization.
- Only Folder and File nodes render on canvas. The work does not add graph node types or alternate data paths.
- The checked-out pipeline predates newer JSON sidecars/stamps and requires the six markdown artifacts only. This planner output therefore writes this `spec.md` in the checked-out format.

## Affected files

All paths are repository-relative.

### Runtime composition and interaction fixes

- `apps/web/app/workspace/components/WorkspaceShell.tsx` — modify; build the catalog runtime-state snapshot, return explicit region presence, and keep the recovery surface outside pack-controlled content.
- `apps/web/app/workspace/packs/componentCatalog.tsx` — modify; add pure presence rules for explorer/inspector contributions and retain trusted component rendering.
- `apps/web/app/workspace/layout/WorkspaceLayout.tsx` — modify; group regions by slot, skip inactive contributions, manage ephemeral resize preview, derive handle edge/orientation, and enforce collapsibility.
- `apps/web/app/workspace/layout/ResizeHandle.tsx` — modify; use edge-aware signed deltas, 44px hit targets, preview/commit/cancel callbacks, and correct keyboard semantics.
- `apps/web/app/workspace/layout/workspace-layout.css` — modify; contain descendant view roots, lay out ordered slot groups, reserve the system utility edge, size every declared axis, position handles at shared boundaries, and implement non-clipping 1280/736/320 behavior.
- `apps/web/app/workspace/components/SystemRecoveryMenu.tsx` — modify; replace the always-expanded technical strip with one compact trigger, status treatment, and a focus-managed action popover.
- `apps/web/app/workspace/components/ViewRail.tsx` — modify; make the explorer toggle use the atomic navigation state and preserve accurate `aria-pressed` behavior across view changes.
- `apps/web/app/workspace/drawer/FeatureDrawer.tsx` — modify; replace sequential stale-state “Explore code” calls with the atomic selection transition.
- `apps/web/app/workspace/state/store.tsx` — modify; add the atomic Product-feature-to-Technical-node reducer action.
- `apps/web/app/workspace/state/selection.tsx` — modify; expose the atomic `openNodeInTechnicalView` action without joining remote-query or session state.
- `apps/web/app/workspace/packs/WorkspacePackProvider.tsx` — modify only as needed to keep persistence commit-only and reject collapse requests for non-collapsible/primary regions; existing storage and resolution boundaries remain intact.
- `apps/web/app/workspace/workspace.css` — modify; add scoped visual-system styles for the recovery popover and Workspace Pack management cards/actions without leaking into the marketing site.

### Visual editor fixes

- `apps/web/app/workspace/editor/LayoutEditMode.tsx` — modify; group controls, remove false primary move affordances, wire actual drag/drop targets, retain a useful compact preview, and keep focus/announcements stable.
- `apps/web/app/workspace/editor/ComponentPalette.tsx` — modify; accept the current component reference, exclude it from replacements, and render an explicit no-alternatives state.
- `apps/web/app/workspace/editor/ThemeTokenEditor.tsx` — modify; present color and closed-choice controls in compact grouped sections while retaining incomplete-hex validation behavior.
- `apps/web/app/workspace/editor/dragController.ts` — modify; model pointer/touch/keyboard pickup, active target, cancellation, and completion rather than only returning three announcement strings.
- `apps/web/app/workspace/editor/editor.css` — modify; apply semantic-token styling, 44px targets, compact disclosure/sheet behavior, and a preview-height floor.
- `apps/web/app/workspace/settings/WorkspacePackSettings.tsx` — modify; replace the unstructured list/native fieldset presentation with existing product card, field, button, status, and action-group patterns.

### Behavioral and browser regression coverage

- `apps/web/app/workspace/layout/WorkspaceLayout.test.tsx` — create; ordered slot composition, inactive contribution omission, same-slot behavior, compact structure, and collapse gating.
- `apps/web/app/workspace/layout/ResizeHandle.test.tsx` — create; signed edge deltas, clamping, keyboard behavior, preview/commit/cancel, and one-commit semantics.
- `apps/web/app/workspace/components/SystemRecoveryMenu.test.tsx` — create; compact closed state, conditional error status, menu actions, focus return, and role/edit-mode behavior.
- `apps/web/app/workspace/views/WorkspaceViews.test.tsx` — create; explorer visibility, Back to graph hit path, Product Explore code atomic transition, return-to-feature, and Technical/Product/Onboarding wrapper containment.
- `apps/web/app/workspace/settings/WorkspacePackSettings.test.tsx` — create; pack status/actions, import feedback, fork cancellation/materialization, and built-in uninstall protection.
- `apps/web/app/workspace/editor/LayoutEditMode.test.tsx` — modify; replace placeholder assertions with rendered pointer/touch/keyboard moves, locked primary, replacement filtering, compact editor structure, undo/redo, and Discard coverage.
- `apps/web/app/workspace/editor/dragController.test.ts` — create; state-machine pickup/target/commit/cancel and lost-target coverage.
- `apps/web/app/workspace/packs/WorkspacePackProvider.test.tsx` — modify; prove resize persistence occurs on commit only and invalid collapse is ignored.
- `scripts/test-product-workspace-ux.mjs` — create; launch or connect to the fixture product frontend, run Chromium interactions and rendered-geometry/hit tests at 1280x800, 736x800, and 320x720, and fail on uncaught page/console errors.
- `package.json` — modify; add the narrow `test:product-workspace-ux` command for the browser regression without changing the root marketing `dev`/`build` meaning.

No files under root `src/`, `services/`, `packages/graph-schema`, or the Workspace Pack shared contract package are expected to change in this remediation.

## Interfaces / signatures

The implementation may preserve existing exported names, but the following behavioral shapes are required.

```ts
export interface WorkspaceComponentRuntimeState {
  viewId: string;
  fileTreeOpen: boolean;
  inspectorOpen: boolean;
  settingsOpen: boolean;
  selectedNodeId: string | null;
  selectedFeatureId: string | null;
}

export interface WorkspaceComponentDefinition<Props extends JsonObject = JsonObject>
  extends WorkspaceComponentContract<Props> {
  Component: ComponentType<WorkspaceCatalogComponentProps<Props>>;
  landmarkLabel: string;
  isPresent?(state: Readonly<WorkspaceComponentRuntimeState>): boolean;
}
```

`sayre.explorer@1` is present only when `fileTreeOpen` is true. `sayre.inspector@1` is present only when settings are closed, the inspector is open, and a node or feature is selected. `sayre.pitch-summary@1` remains present whenever its resolved region/view is visible. Primary presence is immutable.

```ts
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
```

`WorkspaceLayout` must not allocate or hit-test a dock when `present` is false. It groups normal regions by slot, sorts by `order` then `id`, and intentionally layers only the `overlay` slot. Region `size` applies along `resize`: horizontal means inline size, vertical means block size, and none means intrinsic/fluid sizing. Top/bottom, navigation/explorer/inspector, and overlay slots all consume their declared dimensions rather than silently ignoring them.

```ts
export type WorkspaceResizeEdge =
  | 'inline-start'
  | 'inline-end'
  | 'block-start'
  | 'block-end';

export interface ResizeHandleProps {
  regionId: string;
  axis: 'horizontal' | 'vertical';
  edge: WorkspaceResizeEdge;
  value: number;
  minimum: number;
  maximum: number;
  collapsible: boolean;
  collapsed: boolean;
  onPreview(value: number): void;
  onCommit(value: number): void;
  onCancel(): void;
  onCollapse(): void;
  onExpand(): void;
}
```

Explorer/navigation handles use the boundary on their content-facing edge; inspector handles use `inline-start`; top uses `block-end`; bottom uses `block-start`. Pointer movement is signed from that edge, clamped for preview, committed once on pointerup, and cancelled on pointercancel, lost capture, blur, Escape, or unmount. Keyboard arrows/Home/End preview and commit one value per key action; Enter toggles collapse only when `collapsible` is true.

```ts
export type WorkspaceAction =
  | /* existing actions */
  | { type: 'openTechnicalNode'; nodeId: string };

export interface WorkspaceSelectionContextValue {
  // existing fields and methods
  openNodeInTechnicalView(nodeId: string): void;
}
```

`openTechnicalNode` performs one reducer transition: set `view` to `technical`, copy the currently selected Product feature into `returnFeatureId`, select `nodeId`, clear `selectedFeatureId`, set `drawerOpen` and `fileTreeOpen` true, clear search, and leave repository/ref unchanged.

```ts
export interface ComponentPaletteProps {
  catalog: WorkspaceComponentCatalogContract;
  slot: WorkspaceSlotId;
  role: WorkspaceRole;
  capabilities: readonly string[];
  current: WorkspaceComponentRef;
  onChoose(id: string, version: number): void;
}
```

The current component is not a replacement candidate. When filtering leaves zero alternatives, the palette says so and dispatches nothing.

The browser command is:

```text
npm run test:product-workspace-ux
```

It must be self-contained for local/CI use: select an installed Chromium using the repository's existing Puppeteer convention, start the `apps/web` fixture server on an available port when no base URL is supplied, wait for readiness, terminate only the process it started, and emit a non-zero exit code with the failing viewport/assertion.

## Approach

1. Add behavior-first tests for every acceptance criterion and edge case, including the browser geometry/hit suite; confirm they fail for the audited defects rather than for harness errors.
2. Introduce explicit catalog presence resolution and change `WorkspaceLayout` to consume `{ content, present }`; remove empty inspector/explorer docks before they can affect grid sizing or pointer targeting.
3. Rebuild layout markup around ordered slot containers, make descendant view/root containment unconditional, and encode compact behavior without a fixed 320px primary track that forces horizontal clipping.
4. Refactor resize handling into ephemeral preview plus commit/cancel, derive the signed edge from slot, enlarge the invisible pointer target while retaining a subtle visible divider, and gate collapse by the contract.
5. Add the atomic `openTechnicalNode` state action, route FeatureDrawer through it, and align ViewRail/explorer rendering with `fileTreeOpen`.
6. Replace the recovery strip with the compact system utility menu and restyle Workspace Pack management using existing product primitives; verify Back to graph and top-bar controls are unobstructed.
7. Reorganize Layout Edit Mode into compact groups/disclosures, remove immutable-primary move affordances, exclude the current component from the palette, and complete the drag state machine while retaining undo/redo/save/fork/discard semantics.
8. Run product typecheck, all `@sayre/web` tests, relevant Workspace Pack package tests, the 1280/736/320 browser regression, and the root workspace checks required by the touched package scripts. Keep unrelated dirty changes intact.

## Acceptance criteria

- **AC-1** — All implementation and tests target `apps/web` product routes (`/` and `/mock`) and the product test harness; the root Vite marketing UI and its source remain unchanged.
- **AC-2** — In Technical, Product, and Onboarding views, every `.mock-root` and `[data-workspace-view]` rectangle is contained by its primary region and product content rectangle. No view root uses viewport-fixed geometry after composition, and repository picker, Mock controls, Settings, Account, graph toolbar, and fixture controls remain visible and clickable.
- **AC-3** — `WorkspaceLayout` receives explicit contribution presence. A closed inspector produces no inspector dock, width, resize handle, pointer interception, or accessibility landmark; opening a node/feature produces exactly one inspector dock, and settings suppress the inspector without leaving a transparent layer.
- **AC-4** — Closing the explorer sets `fileTreeOpen=false` and removes its dock; the Files rail button restores it, its `aria-pressed` state is accurate, and switching from Product/Onboarding to Files selects Technical with the explorer open in one coherent interaction.
- **AC-5** — Product “Explore code” performs one atomic transition: Technical view is active, the chosen file is selected, the node inspector and explorer are open, `returnFeatureId` names the originating feature, and Back to feature restores that Product feature. No stale closure closes or clears the inspector.
- **AC-6** — Normal regions sharing a slot render once in stable `order`/`id` order without occupying the same rectangle. The overlay slot is the only intentionally layered slot and has explicit stacking/hit behavior.
- **AC-7** — Region dimensions honor the contract for horizontal and vertical resize axes in top, bottom, navigation, explorer, inspector, and overlay slots. `navigation` and `overlay` sizes are not ignored, and top/bottom regions do not use side-panel width rules.
- **AC-8** — Every resize separator exposes at least a 44×44 CSS-pixel pointer/touch target while the visible divider remains visually subtle. Its center lies on the shared boundary between the resized region and adjacent content; inspector growth uses an `inline-start` handle and the correct inverse pointer delta.
- **AC-9** — Pointer resize previews live and clamp to min/max without writing preferences on each move. One successful pointerup writes one final preference; pointercancel, lost capture, blur, Escape, or unmount restores the starting visual value and writes nothing. Keyboard Arrow/Home/End produces clamped, committed changes.
- **AC-10** — A non-collapsible region and the primary region cannot collapse from pointer, keyboard, compact behavior, or provider actions. A collapsible region can collapse/restore, moves focus to a stable restore/handle control, and retains its last valid size.
- **AC-11** — At viewport sizes 1280×800, 736×800, and 320×720, the product frame has no unintended horizontal page overflow, the primary surface receives positive usable width/height, compact explorer/inspector behavior does not cover the whole workspace when inactive, and required controls remain within the viewport or an intentional open popover/sheet.
- **AC-12** — “Back to graph” closes Settings and is the topmost hit target at its visual center at all three widths. Reopening Settings works, graph controls and right-edge graph targets remain hit-testable when no inspector is active, and no invisible 360px layer remains.
- **AC-13** — The permanent system recovery surface is a single polished, minimum-44px trigger in a reserved utility edge, not a wrapping row above the product top bar. Normal closed state shows friendly product copy rather than raw `id@version`; switch/reset/settings/edit actions appear only in its popover; error/fallback status is concise and does not increase frame height or cover TopBar.
- **AC-14** — The recovery popover is keyboard operable, closes on Escape/outside activation, returns focus to its trigger, keeps Switch to default/Reset layout/Layout editor/Workspace Pack settings reachable, and remains mounted when a catalog component throws or the active pack falls back.
- **AC-15** — Workspace Pack settings use the existing product design system: each pack has readable name/version/source/active status, actions are grouped and consistently styled, import and error feedback are legible, the fork form has labeled fields/actions, built-ins do not offer uninstall, and no raw concatenated native-control list remains.
- **AC-16** — Layout Edit Mode presents grouped/disclosure controls with semantic-token styling. At 320×720 the toolbar does not consume the entire page, the live preview retains at least 40% of the available product-content height, Save/Discard/Undo/Redo and region selection are reachable without horizontal scrolling, and the preview is contained rather than viewport-fixed.
- **AC-17** — The immutable primary region offers no move, hide, collapse, or incompatible replacement action. Its locked status is explained. ComponentPalette excludes the current component and, when no other compatible component exists, displays an explicit no-compatible-alternatives message without dispatching a replacement.
- **AC-18** — Actual rendered pointer/touch-equivalent and keyboard drag interactions can pick up a mutable region, expose only compatible ordered targets, move/reorder it through `WorkspaceEditOperation`, announce the result, and support undo. Pointer release outside targets, Escape, lost capture, changing pack/view/viewport/role/capabilities, or source unmount cancels without mutation and restores focus.
- **AC-19** — Editor resize, move, hide/show, replacement, theme, and default-view operations continue to use the existing validated semantic reducer; they do not refetch graph/overlay/provider data or reconnect WebSockets. Save Personal, materialize fork, and Discard keep their existing transaction boundaries.
- **AC-20** — Default and pitch pack activation, switch-to-default restoration, Product and Onboarding rendering, editor Discard, import/export/fork validation, storage safety fallback, and no-console-error behavior remain working after the compositor changes.
- **AC-21** — Built-in pack colors and semantic theme values remain plain canonical values in `apps/web/workspace-packs/*/sayre.workspace.json` and the existing theme mapping. A developer can change a canonical color value manually without editing generated CSS or runtime code.
- **AC-22** — New unit/integration tests render `WorkspaceLayout`, `ResizeHandle`, SystemRecoveryMenu, WorkspacePackSettings, WorkspaceViews, LayoutEditMode, and drag state rather than asserting only source regexes or constants. Every new behavioral test has a resolvable `@spec AC-*`/`EC-*` marker.
- **AC-23** — `npm run test:product-workspace-ux` performs real Chromium geometry, hit-target, and interaction assertions at 1280/736/320, including containment, empty-inspector absence, Back to graph, explorer toggle, Explore code, resize boundary/direction/commit, recovery menu, drag/drop, compact editor preview, and browser console/page errors.
- **AC-24** — `npm run typecheck --workspace @sayre/web`, `npm run test --workspace @sayre/web`, relevant `@sayre/workspace-packs` tests, and `npm run test:product-workspace-ux` pass. No test is skipped or weakened to obtain green.
- **AC-25** — No backend, graph, authorization, tenant, query, renderer-selection, import trust, or arbitrary-code boundary changes. Workspace layout remains presentation-only over already-authorized data.

## Edge cases

- **EC-1** — No node or feature is selected while `drawerOpen` is false: inspector presence resolves false before layout, even if the inspector component would itself return `null`.
- **EC-2** — `drawerOpen` is true but both selected IDs are null, or Settings opens while an inspector is active: the inspector dock disappears without intercepting pointer/focus and returns only when state is again coherent.
- **EC-3** — A catalog contribution other than inspector legitimately returns `null` data content: explicit presence, not React-element truthiness, determines allocation; an accidental null render cannot create an invisible full-size blocker.
- **EC-4** — Two or more regions share a top, bottom, navigation, explorer, or inspector slot with equal order: `id` breaks the tie deterministically and their rectangles do not overlap. Overlay ordering remains explicit and deterministic.
- **EC-5** — A region declares vertical resize in a side/overlay slot or horizontal resize in a top/bottom/overlay slot: the declared axis controls the dimension and handle orientation without assuming every slot is a side panel.
- **EC-6** — A compact viewport is narrower than the former 320px primary minimum after reserving the system utility trigger: tracks shrink without document overflow, and the 44px system target remains usable.
- **EC-7** — Inspector or explorer opens at 736px or 320px: its declared compact behavior overlays/collapses intentionally; closing it exposes the same underlying controls and leaves no off-screen fixed root.
- **EC-8** — Resize starts at minimum/maximum, crosses either bound, reverses direction, or uses an inspector/top/bottom edge: preview remains finite and clamped; committed direction matches the visible edge.
- **EC-9** — Pointerup fires after several pointermove events: persistence receives exactly the final clamped value once. Pointercancel/lost capture/blur/unmount after preview receives zero commits and restores the original value.
- **EC-10** — Storage is unavailable or quota-exceeded on a resize commit: the runtime reports the existing recoverable error, retains a valid in-memory layout, and does not claim persistence succeeded.
- **EC-11** — Enter is pressed on a separator for `collapsible=false`, or provider code requests collapse for primary/non-collapsible: no collapse occurs and focus/state remain stable.
- **EC-12** — Product Explore code is activated when the first mapped file is absent: no action is offered. When present, rapid double activation remains idempotent and does not lose the return feature.
- **EC-13** — The originating Product feature disappears from refreshed authorized data before Back to feature: the existing safe empty/closed selection behavior applies; no stale unauthorized data is fabricated in the client.
- **EC-14** — Files is toggled while already in Technical versus while in Product/Onboarding: Technical toggles current explorer state; other views atomically select Technical and open it rather than evaluating stale `viewId`.
- **EC-15** — Recovery opens while editor state is dirty: Exit/Discard wording remains truthful, destructive switch/reset actions do not silently discard a draft, and the existing editor conflict/confirmation boundary is preserved.
- **EC-16** — Active pack is invalid, missing, incompatible, or throws during trusted component render: the safety/default experience and compact recovery trigger remain reachable; raw imported content is never executed.
- **EC-17** — Workspace Pack import is malformed, duplicate, incompatible, or too large, and fork identity is invalid/cancelled: existing parser/storage errors remain visible in the styled surface; no partial install/fork or active-selection change occurs.
- **EC-18** — ComponentPalette search has zero matches, role/capability changes while open, or the only compatible entry is current: stale choices disappear, no operation dispatches, and the rest of editor controls remain usable.
- **EC-19** — Drag target disappears or becomes incompatible after pickup because pack/layout/view/viewport/role/capabilities change: the controller cancels and announces why, appends no operation, cleans listeners/overlay, and restores focus.
- **EC-20** — Pointer capture APIs or `document.elementFromPoint` are unavailable in the unit harness: the pure controller and rendered callback tests still cover state transitions, while the Chromium suite remains the authoritative geometry/hit proof.
- **EC-21** — Settings or the recovery popover is open at 320px with long pack names or validation text: content wraps within its surface, actions remain reachable, and neither creates horizontal page overflow or covers its own close/back control.
- **EC-22** — Reduced-motion is requested: no essential state change depends on animation and focus/hit behavior is unchanged.
- **EC-23** — Session becomes unauthenticated, backend unavailable, or repository access forbidden during edit/drag: editing and gesture state cancel through existing safety behavior, global states remain contained, and recovery remains accessible without exposing unauthorized graph content.
- **EC-24** — Graph data is loading, empty, unavailable, or Product semantics are generating/failed: the corresponding existing canvas state remains contained and controls outside the canvas remain hit-testable.
- **EC-25** — A browser console warning is caused only by an intentional fixture/network condition: the browser test may explicitly allowlist that exact known message, but uncaught exceptions, React errors, hydration errors, and new unexpected console errors fail the run.
- **EC-26** — Manual token edits use lowercase or uppercase valid six/eight-digit hex within existing parser rules: runtime normalization/validation remains unchanged; invalid values still fail closed.

## Open questions

No blocking open questions remain. The following implementation decisions are fixed for this remediation run:

1. **Product frontend identity:** `apps/web` is the product client. The root Vite app is the marketing site and is not modified.
2. **Recovery placement:** the always-available recovery capability becomes a compact reserved system utility edge with a popover, not a second wrapping top bar and not pack-controlled content.
3. **Presence contract:** catalog contributions declare presence explicitly before dock allocation; CSS `:empty`, React-element truthiness, and invisible overlays are not accepted substitutes.
4. **Resize persistence:** dragging may preview continuously in component state, but browser storage is written only on commit. This keeps feedback responsive without turning every pointermove into persistence churn.
5. **Primary and palette behavior:** primary is visibly locked and not draggable. The current component is not an alternative; a one-entry compatible catalog therefore yields a truthful no-alternatives state rather than a no-op choice.
6. **Proof order:** visual editor drag/drop, geometry, and interaction parity must pass before the deferred LLM authoring R&D is resumed or characterized as deployable.

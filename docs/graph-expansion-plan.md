# Technical Tree expansion plan

Status: proposal only. No graph visibility or expansion behavior is implemented
by this document. Implementation requires explicit product approval.

## Problem

The complete authorized repository projection is useful as data, but rendering
every Folder and File simultaneously is not a useful default interaction. A
762-node repository currently makes labels, paths, and containment harder to
read than a conventional file explorer.

The solution should preserve the complete authorized graph as immutable source
data while producing a smaller, explainable renderer projection for the current
task.

## Research findings

- The WAI-ARIA tree pattern separates focus from selection and defines
  predictable disclosure keys: Right opens or enters a branch, Left closes or
  returns to the parent, and Up/Down navigate visible rows.
  <https://www.w3.org/WAI/ARIA/apg/patterns/treeview/>
- VS Code preserves tree expansion and selection with stable item IDs. Its
  programmatic reveal API separates `select`, `focus`, and bounded recursive
  expansion; recursive reveal is capped at three levels. VS Code also enables
  Explorer auto-reveal by default while allowing exclusions for noisy paths.
  <https://code.visualstudio.com/api/references/vscode-api>
  <https://code.visualstudio.com/updates/v1_74>
- React Flow's official expand/collapse example keeps the complete graph
  structure while rendering only the currently visible portion. React Flow
  nodes also expose an explicit `hidden` presentation attribute.
  <https://reactflow.dev/examples/layout/expand-collapse>
  <https://reactflow.dev/api-reference/types/node>
- Sigma supports non-destructive node and edge transformation through reducers,
  including the `hidden` attribute. This is appropriate for transient
  presentation changes without changing the graphology source.
  <https://www.sigmajs.org/docs/advanced/data/>
- Furnas's generalized fisheye model recommends high detail near the current
  focus and only important landmarks farther away. TreePlus applies a related
  incremental "start with a node and expand as needed" model; its advantage
  increased with graph density, and it emphasizes animated transitions that
  preserve orientation.
  <https://courses.ischool.berkeley.edu/i247/f05/readings/Furnas_GeneralizedFisheyeViews_CHI86.pdf>
  <https://doi.org/10.1109/TVCG.2006.106>
- SpaceTree represents undisplayed children with a count-bearing summary
  affordance rather than pretending they do not exist.
  <https://drum.lib.umd.edu/items/1ecaa285-ccd9-431a-98da-a17224523760>

## Recommendation

Use a **focus corridor + manual pins + viewport budget** model.

The complete server-authorized graph remains in workspace state. A pure
`ExpansionController` derives the nodes and edges that each renderer receives.
The controller must never request, infer, count, or expose nodes outside that
authorized payload.

### State model

```ts
interface ExpansionIntent {
  focusNodeId: string | null;
  manuallyExpanded: ReadonlySet<string>;
  manuallyCollapsed: ReadonlySet<string>;
  pinnedBranches: ReadonlySet<string>;
  transientReveal: {
    source: 'search' | 'deep-link' | 'agent';
    nodeIds: ReadonlySet<string>;
  } | null;
  mode: 'balanced' | 'focus' | 'full';
}

interface ExpansionProjection {
  visibleNodeIds: ReadonlySet<string>;
  expandedFolderIds: ReadonlySet<string>;
  foldedDescendantCount: ReadonlyMap<string, number>;
  reasonByNodeId: ReadonlyMap<
    string,
    'root' | 'focus-path' | 'manual' | 'pinned' | 'context' | 'transient'
  >;
}
```

The reason map is important for debugging, deterministic LLM actions, and UI
explanations. An agent should request an intent such as "focus this path" or
"pin this branch", not directly mutate renderer node visibility.

### Visibility precedence

1. Start with only the already authorized Folder/File projection.
2. Always retain repository roots.
3. Force the focused node and its complete ancestor path into view. This is a
   temporary reveal and does not overwrite the user's manual disclosure state.
4. Retain pinned branches.
5. Apply explicit manual expansions and collapses.
6. Spend the remaining viewport budget on useful local context: direct children
   of the focused folder, siblings along the focus path, and recently used
   manual branches.
7. Fold everything else into the nearest visible Folder and display an
   authorized descendant count on that real Folder node.

No automatic branch should collapse while the user is idle and reading.
Rebalancing should occur only after an explicit focus, search, resize, mode, or
disclosure action.

### Viewport budget

Start with an area-derived budget rather than one global node count:

```text
budget = clamp(24, 96, floor(canvasWidth / 110) * floor(canvasHeight / 64))
```

This produces roughly 40 readable nodes beside both the Explorer and drawer,
and roughly 60–70 when the drawer is closed on a desktop viewport. The exact
constants must be tuned with the 25-node mock, the 762-node real repository, and
at least one 2,000+ node fixture before becoming a stable token.

Large folders may exceed the entire budget with their direct children. In that
case the focused/selected child, child folders, and most recently used files
take priority. The Folder displays `shown / authorized descendants` and offers
an explicit Full mode rather than silently dropping nodes.

### Folder presentation states

- **Collapsed:** only the Folder is visible; it shows an authorized hidden
  descendant count.
- **Contextual:** the Folder is open, but the budget folds some descendants; it
  shows `shown / total`.
- **Expanded:** every direct child is visible.
- **Pinned:** the branch is protected from automatic budget eviction.

Recursive "expand entire subtree" should be an explicit secondary action and
should warn or switch to Full mode when it exceeds the current budget.

## Explorer and graph synchronization

The Explorer added in the preceding change should remain the dense,
scrollable navigation surface.

- Graph selection auto-reveals and selects the same node in the Explorer.
- Explorer selection sets the graph's focus corridor and centers the node.
- Merely opening folders in the Explorer should **not** explode those branches
  on the graph. Scrolling a file tree and constructing a readable graph are
  different tasks.
- A future pin action in either surface explicitly keeps a branch open on the
  graph.
- Search temporarily reveals matches and their ancestor paths. Clearing search
  restores the previous intent snapshot.

This keeps selection shared while allowing each surface to manage density
appropriately.

## Renderer integration

1. Add a pure, renderer-independent expansion controller under
   `apps/web/app/workspace/`.
2. Derive a visible `AuthorizedCanvasPayload`; do not mutate the full graph.
3. Select React Flow versus Sigma using the **visible** node count, not the full
   authorized node count. A focused 40-node projection should use the same
   readable React Flow language as the approved mock even when the repository
   contains thousands of nodes.
4. Re-layout the visible projection deterministically, preserving sibling order.
5. Keep the selected node at the same viewport coordinate across a transition
   and animate other nodes for 180–240 ms. Disable the transition under
   `prefers-reduced-motion`.
6. Render only edges whose endpoints are visible. Do not invent aggregate
   dependency edges; show authorized hidden-import counts on the folded Folder
   instead.

## Persistence and realtime

- First implementation: keep intent in session state, keyed by repository and
  ref.
- Later: persist user presets only after the UI customization storage contract
  exists.
- On graph updates, prune removed IDs. New children under an expanded Folder
  should increment its count but should not automatically displace the user's
  current focus.
- Deep links and agent actions use transient reveal so the user's manual state
  is restored afterward.

## Proposed implementation sequence after approval

1. **Projection engine:** expansion intent types, deterministic visibility
   planner, authorized folded counts, and unit tests.
2. **Technical Tree integration:** visible-count renderer selection, Folder
   disclosure affordances, layout anchoring, and reduced-motion behavior.
3. **Explorer controls:** graph pin/unpin action, contextual/full indicators,
   search snapshot restoration, and optional expansion mode control.
4. **Hardening:** realtime pruning, per-repo session persistence, performance
   instrumentation, keyboard/a11y integration tests, and visual regression
   fixtures at 25, 762, and 2,000+ nodes.

## Acceptance criteria

- The initial 762-node repository view renders no more than the computed budget.
- A selected File, whether chosen on the graph or in Explorer, is visible with
  its complete ancestor path.
- Manual and pinned branches survive unrelated selections until explicitly
  collapsed.
- Search clear restores the exact pre-search expansion intent.
- Folded counts include authorized nodes only.
- No Function or Class node is rendered.
- No graph database query or RBAC traversal is added to the client.
- Layout transitions retain the selected node's screen position.
- Keyboard and reduced-motion behavior follow the WAI-ARIA tree guidance.

## Approval decisions

Recommended defaults for product approval:

1. `balanced` mode is the default.
2. Initial view is root plus direct children, within the viewport budget.
3. Explorer disclosure is independent; Explorer selection drives graph focus.
4. Pinning is explicit and shared between Explorer and graph.
5. Session-only persistence ships first.

No code for this plan should be implemented until these defaults are approved.

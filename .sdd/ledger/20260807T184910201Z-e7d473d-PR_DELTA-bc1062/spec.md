# FE-ARCH-02 — Shape/renderer contract: the manifest registry that makes workspace modules drop-in

> Planner note: this spec was authored directly from the founder conversation of 2026-08-07 (per explicit instruction, the spec-drafting stage ran in-chat rather than via the planner subagent). It encodes decisions already made there; do not re-litigate them. The checked-out pipeline requires the six markdown artifacts; JSON sidecars are welcome but optional.

## Context — why this exists

The FE-ARCH-01 Workspace Pack system modularized four hardcoded React components. The founder direction it must now serve is stronger: a workspace module is **an ontology query wearing a user-chosen renderer** — a data capability (server-authorized), emitting one of a tiny set of canonical **shapes**, drawn by a shape-keyed **renderer**, placed in a slot. Relationships between the layers are **declared in manifests, never coded at call sites**: a renderer never knows which capability feeds it; a capability never knows who draws it. A registry matches them by shape, so N capability registrations plus M renderer registrations yield N×M valid combinations with no pairwise wiring.

Two asymmetries are deliberate and must be enforced, not just documented:

1. **Shapes are frozen.** v1 ships exactly four: `collection`, `tree`, `graph`, `document`. Adding a shape is a design-review event, so the registry must *reject* unknown shapes rather than accept them dynamically.
2. **Removal degrades, never breaks.** A binding whose renderer is missing falls back to the shape's default renderer; a capability whose shape has no renderer at all resolves to a defined "none" outcome the UI can present. Saved packs must survive registry churn.

This ticket builds the contract and registry, and proves the architecture by re-expressing two existing surfaces (explorer, pitch summary) as capability×renderer bindings — while every existing pack, test, and behavior keeps working unchanged. It does **not** build new renderers (kanban), new data sources (tickets, Notion), the overlay editor, or LLM authoring; those are later waves that depend on this contract being right.

### Naming disambiguation (binding)

The existing `workspaceCapabilities` entries (`sayre.technical`, `sayre.product`, `sayre.onboarding`) are permission **gates**, not data queries. This spec names the new concept **data capability** (`WorkspaceDataCapabilityManifest`); gates keep their current name and role, and data capabilities *reference* gates via `requiredGates`. Do not merge or rename the existing gate list.

## Scope

### In scope

- A pure, framework-free shape contract and manifest registry in `packages/workspace-packs/src/` (no React, no fetching, no app imports).
- Shape payload TypeScript contracts and runtime guards for the four v1 shapes.
- App-side registration of built-in data capabilities and renderers, with adapters mapping existing server-authorized workspace query state into shape payloads.
- Deriving the legacy `sayre.explorer@1` and `sayre.pitch-summary@1` catalog entries from registry bindings so both built-in packs work unchanged (`sayre.primary-surface@1` and `sayre.inspector@1` explicitly remain hand-wired legacy composites this ticket does not migrate).
- Additively exposing a JSON-serializable registry snapshot on the runtime catalog contract (groundwork for the later LLM-authoring wave).

### Explicitly out of scope

- New renderers (kanban, card grid, timeline, doc reader) and new data capabilities (tickets, docs/Notion, recent changes). AC-10's two capabilities and two renderers are the complete v1 surface.
- Promoting the seven inspector node modules (`moduleRegistry.ts`) into the registry.
- The overlay edit mode, LLM edit-operation emission, pack marketplace, or any `LayoutEditMode` rework.
- Backend services, graph schema, Graph Query Service, MCP, authentication, RBAC enforcement, queues, providers.
- Workspace Pack schema v1 parse rules, portable serialization, import trust rules, `WorkspaceEditOperation` union changes.
- The root Vite marketing site (`src/`, `public/`, root `index.html`).
- Replacing React Flow/Sigma.js or altering the ~500-node renderer boundary.

### Product and architecture alignment

- The graph remains the source of truth; the registry is **presentation-only**. Data capabilities describe *already server-authorized* query surfaces; adapters transform data the existing workspace queries deliver. No new data paths, no client-side authorization (`.claude/rules/security-multitenancy.md`).
- Only Folder and File nodes are ever rendered on canvas; the `tree` shape adapter emits Folder/File nodes only.
- Business logic stays out of route handlers; this ticket touches none.
- A pack (arrangement data) must never be able to widen data access: gating decisions in `validateBinding` reuse the same gate/role semantics the trusted catalog already applies, and the registry can only *narrow* (reject), never grant.

## Affected files

All paths repository-relative in this worktree.

### Contract package (pure TypeScript, no React)

- `packages/workspace-packs/src/shapes.ts` — create. `WORKSPACE_SHAPES`, `WorkspaceShapeId`, the four payload types, `isWorkspaceShapePayload`.
- `packages/workspace-packs/src/registry.ts` — create. Manifest types, `createWorkspaceRegistry()`, pairing, binding validation, renderer resolution with fallback, serializable snapshot.
- `packages/workspace-packs/src/runtime.ts` — modify. Re-export the new modules alongside existing exports; no existing export changes shape.

### App integration (`apps/web/app/workspace/packs/`)

- `shapeAdapters.ts` — create. Pure functions mapping existing workspace state to payloads: `structureTreePayload(nodes: WorkspaceGraphNode[]): TreePayload` (Folder/File only), `featuresCollectionPayload(features, nodePaths): CollectionPayload`. No hooks, no fetching.
- `rendererCatalog.tsx` — create. `WorkspaceRendererDefinition` (manifest + `Component`), registration of `sayre.tree-list@1` (wraps the existing explorer/FileTreePane contribution) and `sayre.pitch-summary-panel@1` (wraps the existing PitchSummaryPanel contribution).
- `capabilityCatalog.ts` — modify. Add data-capability manifests `sayre.structure@1` and `sayre.features@1`; existing gates and `WorkspaceCapabilityDefinition` loaders unchanged.
- `componentCatalog.tsx` — modify. Derive the `sayre.explorer@1` and `sayre.pitch-summary@1` definitions from registry bindings (legacy alias layer); `sayre.primary-surface@1` and `sayre.inspector@1` stay as-is with a comment marking them legacy composites.
- `runtimeCatalog.ts` — modify. Contract additionally carries `registry: WorkspaceRegistryContract` (the snapshot). `runtimeContractVersion` stays `1`.

### Tests

- `packages/workspace-packs/src/shapes.red.test.ts`, `packages/workspace-packs/src/registry.red.test.ts` — created by red (locations normative, names red's choice).
- `apps/web/app/workspace/packs/shapeAdapters.red.test.ts` and a registration/back-compat suite under `apps/web/app/workspace/packs/` — created by red.
- Existing suites (`packs/`, `views/`, `layout/`, `editor/`, `state/`) must remain green — they are the back-compat oracle for AC-11/AC-12.

## Interfaces / signatures

Implementation may adjust internal naming, but these behavioral shapes are required.

```ts
// shapes.ts
export const WORKSPACE_SHAPES = ['collection', 'tree', 'graph', 'document'] as const;
export type WorkspaceShapeId = (typeof WORKSPACE_SHAPES)[number];

export interface WorkspaceCollectionItem {
  id: string; title: string; subtitle?: string; group?: string;
  status?: string; timestamp?: string;
  ref?: { kind: 'node' | 'feature' | 'external'; id: string };
}
export interface WorkspaceCollectionPayload { shape: 'collection'; items: readonly WorkspaceCollectionItem[]; groups?: readonly { id: string; label: string }[] }
export interface WorkspaceTreeNode { id: string; parentId: string | null; label: string; kind: string }
export interface WorkspaceTreePayload { shape: 'tree'; nodes: readonly WorkspaceTreeNode[] }
export interface WorkspaceGraphShapePayload { shape: 'graph'; nodes: readonly { id: string; label: string; kind: string }[]; edges: readonly { source: string; target: string; type: string }[] }
export interface WorkspaceDocumentPayload { shape: 'document'; title: string; blocks: readonly { kind: 'heading' | 'paragraph' | 'list' | 'code'; text: string; items?: readonly string[] }[] }
export type WorkspaceShapePayload = WorkspaceCollectionPayload | WorkspaceTreePayload | WorkspaceGraphShapePayload | WorkspaceDocumentPayload;

export function isWorkspaceShapePayload(shape: WorkspaceShapeId, value: unknown): value is WorkspaceShapePayload;
```

```ts
// registry.ts
export interface WorkspaceDataCapabilityManifest {
  id: string; version: number; title: string;
  shape: WorkspaceShapeId;
  requiredGates: readonly string[];        // existing gate ids, e.g. 'sayre.technical'
  minimumRole: WorkspaceRole | null;       // same ordering semantics as catalog gating: member < admin < owner
}
export interface WorkspaceRendererManifest {
  id: string; version: number; title: string;
  shape: WorkspaceShapeId;
  allowedSlots: readonly WorkspaceSlotId[];   // must be non-empty
  isDefaultForShape?: boolean;
}
export interface WorkspaceModuleBinding {
  capability: WorkspaceComponentRef;   // { id, version }
  renderer: WorkspaceComponentRef;
}
export interface WorkspaceBindingContext {
  slot: WorkspaceSlotId; role: WorkspaceRole; grantedGates: ReadonlySet<string>;
}
export type WorkspaceRendererResolution =
  | { renderer: WorkspaceRendererManifest; fallback: 'preferred' | 'shape-default' }
  | { renderer: null; fallback: 'none' };

export interface WorkspaceRegistryContract {   // JSON-serializable; no functions
  dataCapabilities: readonly WorkspaceDataCapabilityManifest[];
  renderers: readonly WorkspaceRendererManifest[];
}
export interface WorkspaceRegistry {
  registerDataCapability(manifest: WorkspaceDataCapabilityManifest): WorkspacePackValidationResult;
  registerRenderer(manifest: WorkspaceRendererManifest): WorkspacePackValidationResult;
  pairings(): readonly WorkspaceModuleBinding[];
  validateBinding(binding: WorkspaceModuleBinding, context: WorkspaceBindingContext): WorkspacePackValidationResult;
  resolveRenderer(capability: WorkspaceComponentRef, preferred: WorkspaceComponentRef | null): WorkspaceRendererResolution;
  snapshot(): WorkspaceRegistryContract;
}
export function createWorkspaceRegistry(reservedComponentIds?: ReadonlySet<string>): WorkspaceRegistry;
```

Registration failures return violations (reusing the existing `{ code, path, message }` violation vocabulary), they do not throw; a failed registration leaves the registry unchanged. `reservedComponentIds` seeds EC-06's legacy-collision check (the app passes the legacy catalog ids).

```tsx
// rendererCatalog.tsx (app side)
export interface WorkspaceRendererProps { payload: WorkspaceShapePayload; region: ResolvedWorkspaceRegion; view: ResolvedWorkspaceView }
export interface WorkspaceRendererDefinition extends WorkspaceRendererManifest { Component: ComponentType<WorkspaceRendererProps> }
```

## Acceptance criteria

- **AC-01 — Frozen shape set.** `WORKSPACE_SHAPES` is exactly `['collection', 'tree', 'graph', 'document']`. Registering a data capability or renderer with any other `shape` value is rejected with a violation naming the offending shape; nothing throws.
- **AC-02 — Capability registration is one manifest entry.** After `registerDataCapability` of shape S succeeds, `pairings()` contains exactly one binding for every already-registered shape-S renderer, and no binding pairs it with a renderer of a different shape.
- **AC-03 — Renderer registration multiplies.** After `registerRenderer` of shape S succeeds, `pairings()` gains exactly one new binding per existing shape-S data capability, and every pre-existing binding is still present unchanged (assert by value, not count).
- **AC-04 — Unrendered shape is defined, not broken.** A data capability whose shape has no registered renderer yields zero pairings, and `resolveRenderer` returns `{ renderer: null, fallback: 'none' }`. No throw anywhere on this path.
- **AC-05 — Shape-default fallback.** When `preferred` names a renderer that is not registered (wrong id or version), `resolveRenderer` returns the shape's `isDefaultForShape` renderer with `fallback: 'shape-default'`; when `preferred` is registered and shape-compatible it is returned with `fallback: 'preferred'`.
- **AC-06 — Placement gating.** `validateBinding` rejects a binding whose context `slot` is not in the renderer's `allowedSlots`, with a violation identifying the slot.
- **AC-07 — Gate and role gating.** `validateBinding` rejects a binding whose capability requires a gate absent from `context.grantedGates`, or whose `minimumRole` exceeds `context.role` under the ordering member < admin < owner. A `minimumRole` of `null` imposes no role constraint.
- **AC-08 — Shape mismatch rejected.** `validateBinding` rejects a capability×renderer pair with different shapes even when both are individually registered and all gates pass.
- **AC-09 — Serializable snapshot.** `registry.snapshot()` deep-equals `JSON.parse(JSON.stringify(snapshot))`, lists every successfully registered manifest, and contains no functions or React components. Failed registrations do not appear.
- **AC-10 — Built-in registrations.** The app registers exactly these v1 entries (ids and versions normative): data capabilities `sayre.structure@1` (shape `tree`, requiredGates `['sayre.technical']`) and `sayre.features@1` (shape `collection`, requiredGates `['sayre.product']`); renderers `sayre.tree-list@1` (shape `tree`, allowedSlots `['explorer', 'navigation']`, default for `tree`) and `sayre.pitch-summary-panel@1` (shape `collection`, allowedSlots `['inspector']`, default for `collection`).
- **AC-11 — Legacy aliases keep packs working.** `sayre.explorer@1` and `sayre.pitch-summary@1` remain present in the component catalog, now derived from the registry bindings (structure×tree-list, features×pitch-summary-panel). Both built-in packs (`sayre.default`, `sayre.pitch`) parse, validate compatibility, and activate exactly as before; all pre-existing workspace test suites stay green.
- **AC-12 — Additive contract.** `runtimeContractVersion` stays `1`; the runtime catalog contract additionally exposes the registry snapshot; a pack authored with no knowledge of the registry validates exactly as before this change.
- **AC-13 — Presentation-only boundary.** `packages/workspace-packs/src/shapes.ts` and `registry.ts` import nothing from `apps/` and contain no fetch/network/storage access; shape adapters are pure functions over data already delivered by the existing server-authorized workspace queries. (Red encodes the import-boundary and purity checks mechanically; review judges intent.)

## Edge cases

- **EC-01 — Duplicate registration.** Registering an id@version already registered (capability or renderer) is rejected with a violation; the original manifest and all pairings are unchanged.
- **EC-02 — New version coexists.** `id@2` alongside `id@1` succeeds and pairs independently; `resolveRenderer` treats `{ id, version: 1 }` and `{ id, version: 2 }` as distinct preferred targets.
- **EC-03 — Renderer with empty allowedSlots.** Rejected at registration; a renderer that can appear nowhere is a manifest bug, not a runtime surprise.
- **EC-04 — Malformed payloads.** `isWorkspaceShapePayload` returns false for `null`, non-objects, a payload whose `shape` discriminant disagrees with the asked shape, and structural violations (collection item without `id`; tree node without `id`/`label` or with non-null non-string `parentId`; graph edge missing `source`/`target`; document block of unknown `kind`). It returns true for a minimal valid payload of each of the four shapes.
- **EC-05 — Tree adapter integrity.** `structureTreePayload` emits every Folder/File node exactly once with `parentId` preserved, emits only Folder/File kinds (Function/Class and any other graph-internal kinds are excluded), and returns a valid empty payload for an empty graph.
- **EC-06 — Legacy id collision.** Registering a data capability or renderer whose id@version collides with a reserved legacy component id (e.g., `sayre.explorer@1`) is rejected, keeping the alias namespace unambiguous.

## Verification

From the worktree root (`Sayre-worktrees/fe-arch-01`), in order:

1. `npx tsc --noEmit`
2. `npm run test` (the red suites plus every pre-existing workspace suite; AC-11 is falsified by any previously-green suite going red)
3. `npm run lint`

No Python worker changes are in scope; `poetry run pytest` is not required.

## Notes for red and dev

- Red: AC-02/AC-03 are the architecture's core claim (N+M → N×M with no rewiring). Write them as value-level assertions on `pairings()` before/after single registrations, not as count assertions. Use freshly created registries per test; do not depend on app registration side effects except in the AC-10/AC-11 suites.
- Red: for AC-11, prefer exercising the existing pack activation path (`builtins.ts` parse/compat/props validation and provider activation) over snapshotting internals.
- Dev: registration returns the existing validation-result vocabulary rather than throwing so the future LLM/import paths can surface violations uniformly.
- Dev: keep `componentCatalog.tsx`'s public surface (`workspaceComponentCatalog`, `workspaceComponentKey`, `createWorkspaceComponentCatalog`, `WorkspaceComponentRuntimeState`, presence rules) intact; the derivation is an internal rewiring, not an API change.
- Dev: `runtimeCatalog.ts`'s `validateRuntimeComponentProps` must keep accepting the empty-props components exactly as today.

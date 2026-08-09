# FE-ARCH-01 — Contract-based Workspace Pack runtime, visual editor, experimental authoring, and product-client migration

## Ticket Check

1. **What I'm about to build** — Turn Sayre's product workspace into a customizable system where a person can enter an edit mode, drag approved elements into compatible regions, reorder or hide them, swap compatible elements, resize panels, and edit colors with a live preview. It will ship with the current workspace as the default setup, a presentation-focused setup for nontechnical pitches, and—only after the visual editor is proven—experimental guarded tools an LLM or developer can use to create, validate, preview, copy, and share additional setups.
2. **What I'm explicitly not doing** — I am not changing the public marketing website, the graph data model, repository ingestion, permissions, or the server-side filtering that decides what data a person may see. I am also not launching the hosted public marketplace or allowing downloaded setups to execute arbitrary code.
3. **How you'll know it worked** — A person can enter Layout Edit Mode, drag an approved element to another compatible dock, reorder or hide it, swap it from a filtered palette, resize regions, and change theme colors with live validation and undo/redo. They can save the result personally or materialize a fork, export it, import it in another browser, and get the same experience; a developer may still edit the canonical color values by hand. Only after that editor gate passes, an experimental LLM can attempt the same semantic operations through documented commands and receive a useful validation error before an unsafe or broken setup reaches the screen.
4. **What I had to guess** — “Ultimately” means this ticket must make setups genuinely portable and marketplace-ready, but does not include marketplace accounts, hosting, search, ratings, moderation, payments, or organization-wide server persistence. The visual editor is the deployable proof and release path; LLM authoring is an internal research experiment over the same validated operations and may produce a follow-up deployment spec. Publicly transferable setups are declarative and code-free; a genuinely new React component must first enter Sayre's trusted component catalog through the normal reviewed code pipeline.

## Goal

Replace the hard-coded composition of the Next.js product client under apps/web with a versioned, contract-based Workspace Pack runtime and a deployable constrained visual editor. An authenticated person must be able to alter approved layout, sizing, theme tokens, view composition, visibility, ordering, and compatible component choices through drag/drop and direct controls while the stable product runtime continues to own authentication, server-authorized data, graph-rendering boundaries, recovery states, and executable React code.

The current product workspace must become the first-party default pack without losing Technical, Product, or Onboarding behavior. A second first-party pitch pack must demonstrate that a nontechnical presentation experience can be substantially different and reproducible through the visual editor's semantic operations without modifying the shell, data source, graph contracts, or renderer implementations. Only after those human-facing operations are behaviorally proven may the ticket exercise an LLM authoring skill against the same operation contract; that work is experimental, repo-local R&D rather than a production LLM feature.

## Scope

### In scope

- The product frontend in apps/web only. The root Vite marketing site and its src directory are explicitly outside this ticket.
- A new @sayre/workspace-packs package containing the portable pack contract, strict parser, compatibility validation, deterministic resolver, semantic edit reducer, canonical serialization, constrained patch engine, and Node CLI.
- Workspace Pack schema version 1, represented by a portable directory containing sayre.workspace.json and README.md. The JSON document contains metadata, compatibility declarations, semantic theme tokens, layouts, views, module composition, and safe component references.
- A static trusted React component catalog and a static data-capability catalog. A pack may reference catalog entries but cannot supply module paths, URLs, functions, scripts, HTML, raw CSS, data queries, authorization rules, or arbitrary event handlers.
- Runtime resolution in this order: immutable product safety defaults, selected installed pack, optional organization override input, user personal pack override, and user-only transient layout preferences. The selected pack, personal override, and layout preferences have concrete local sources in this ticket; the typed organization override input is implemented but passed as null until a later server-persistence ticket.
- A resizable, collapsible, dock-based workspace layout supporting top, left, primary, right, bottom, and overlay regions with catalog-declared allowed placements.
- A member-accessible Layout Edit Mode layered over the live resolved workspace. It supports pointer/touch drag and drop, keyboard-equivalent movement, reordering within a dock, moving between catalog-approved docks, hide/show, compatible component replacement from a filtered palette, direct resize, default-view selection, and semantic theme color editing.
- A draft transaction model with continuous validation, live preview, undo, redo, discard, local personal save, and materialization as a new forked Workspace Pack for export/sharing. Built-in and imported pack documents remain immutable; visual edits are personal overrides until explicitly materialized as a fork.
- One shared semantic WorkspaceEditOperation contract used by both the visual editor and later CLI/LLM experimentation. The pitch pack must be reproducible from the default pack plus a committed sequence of these operations.
- Separate state boundaries for session/capabilities, navigation, selection, remote queries, realtime invalidation, operations, fixture scenarios, and layout preferences. Layout changes must not cause data refetches or WebSocket reconnects.
- A semantic design-token contract covering product surfaces, content, borders, actions, statuses, graph marks, typography choice, density, and radius scale. User-supplied color values are limited to canonical six- or eight-digit hexadecimal colors; typography, density, and radius use closed catalog values.
- A default built-in pack reproducing the current product workspace and a pitch built-in pack that defaults to Product view, emphasizes feature meaning and team context, minimizes technical chrome, and includes a trusted pitch-summary component.
- A permanent system-owned recovery/switcher surface outside pack control. It must allow a user to return to the default pack, reset local layout preferences, enter/exit Layout Edit Mode, and open user-level Workspace Pack management even if the active pack is invalid or hides ordinary navigation.
- Local authenticated-user pack management: import, validate, install, activate, deactivate, edit, fork, export, and uninstall. Installed packs, active selection, personal overrides, and transient preferences persist in browser storage as separate validated records; exports exclude repository data, session data, organization data, personal overrides/drafts, and transient preferences until a change is materialized as a fork.
- Deterministic canonical export and version pinning. Installing a newer version never silently replaces the active pinned version.
- An experimental constrained LLM authoring toolchain with machine-readable JSON output for catalog inspection, pack inspection, validation, semantic editing, diffing, forking, dry-run application, and export. It is exercised only after the same edit operations pass visual-editor behavior tests.
- A runtime-neutral experimental authoring guide plus a thin Claude skill entry point. The skill is repo-local R&D, is not exposed through a product route or customer-facing automation, uses the same semantic operation engine as the visual editor, and must stop with a catalog-extension proposal when the requested change requires executable code.
- A written LLM-authoring R&D assessment recording evaluated tasks, success/failure cases, unsafe or ambiguous requests, preview limitations, repeatability, and the additional decisions required before any deployable LLM authoring feature is scoped.
- The existing fixture lab as the preview surface for the default, pitch, and locally installed packs.
- Contract, behavior, accessibility, responsive-layout, storage-failure, compatibility, and security-negative tests.
- Documentation of the package format, trust model, versioning, marketplace handoff, authoring workflow, and extension workflow.

### Explicitly out of scope

- The root Vite marketing site, including src, public, index.html, and the marketing design-system assets.
- A hosted marketplace API, database, organization library, account synchronization, discovery, ratings, payments, moderation, signing authority, or automatic update service.
- Server-side storage of installed packs, organization overrides, or user layout preferences.
- Arbitrary JavaScript, TypeScript, React components, dynamic imports, remote modules, remote stylesheets, raw CSS, raw HTML, data URLs, or external asset URLs inside imported packs.
- Arbitrary freeform coordinates, overlapping/nested user-created containers, unconstrained DOM dragging, arbitrary CSS-grid templates, or drag targets outside the closed dock/slot contract. Version 1 includes the constrained visual Layout Edit Mode described above.
- Letting a pack define API endpoints, graph queries, traversal, RBAC filtering, tenant identity, WebSocket subscriptions, or repository scopes.
- Changes to services/core, services/gateway, services/workers, graph schema, queue topology, authentication, MCP tools, provider settings APIs, or repository ingestion.
- Replacing React Flow, Sigma.js, graphology, or the approximately 500-visible-node renderer boundary.
- Fixing unrelated findings in the July frontend audit unless a touched path must be adjusted to preserve this ticket's contract.
- Public marketplace execution of trusted code extensions. New executable components continue to require an ordinary source-code ticket, tests, review, security gate, and a new catalog version.
- A production LLM endpoint, autonomous customer-facing frontend agent, prompt-to-production workflow, automatic publication, or a claim that the experimental skill is deployment-ready. Those require the R&D assessment and a separately reviewed deployment spec.

### Product and architecture alignment

- PRD v5 does not currently define Workspace Packs, an LLM frontend-authoring surface, or a marketplace. This is founder-directed scope added by this ticket and must be documented as such; it does not supersede existing PRD security, graph, renderer, and service-layer invariants.
- Only Folder and File nodes may reach any canvas implementation.
- All graph data presented to pack-selected components remains server-filtered before it reaches the browser. The pack runtime performs presentation-only selection and composition.
- Heavy traversal remains in the Graph Query Service. No pack, resolver, catalog component, or authoring command may introduce client-side authorization or deep traversal.
- Technical, Product, and Onboarding remain authorized projections over the same graph, not pack-owned datasets.
- The active origin/main checkout's pipeline documentation predates the newer spec.json and staleness-stamp contract present on the current PL-04 work branch. This spec-only run therefore produces spec.md only, exactly as origin/main's .sdd/stages/planner.md requires; it does not invent the absent write-stamp script or a sidecar the checked-out pipeline cannot consume.

## Affected files

All paths are repository-relative.

### Root workspace and authoring entry points

- package.json — modify; add workspace-pack CLI scripts that build and invoke @sayre/workspace-packs.
- package-lock.json — modify; record the new workspace package and apps/web dependency.
- scripts/check-secret-access.mjs — modify only if the ticket's tracked source deletions require the repository secret scanner to tolerate a path absent from the worktree.
- scripts/check-secret-access.test.mjs — modify only with the matching tracked-deletion regression.
- scripts/check-org-secret-access.mjs — modify only for the same tracked-deletion compatibility at the sibling org-secret scanner.
- scripts/check-org-secret-access.test.mjs — modify only with the matching tracked-deletion regression.
- docs/workspace-packs.md — create; portable format, runtime layering, trust model, versioning, import/export, and marketplace handoff.
- docs/workspace-pack-authoring.md — create; runtime-neutral LLM/developer authoring procedure and escalation boundary.
- docs/workspace-pack-llm-rd.md — create; post-editor LLM experiment matrix, observed results, unsafe/ambiguous cases, repeatability limits, and follow-up deployment decisions.
- .claude/skills/workspace-pack-author/SKILL.md — create; thin entry point that directs the runtime to docs/workspace-pack-authoring.md and the deterministic CLI rather than duplicating the procedure.

### New shared package

- packages/workspace-packs/package.json — create; @sayre/workspace-packs package, build/typecheck/test scripts, and sayre-workspace-pack bin entry.
- packages/workspace-packs/tsconfig.json — create.
- packages/workspace-packs/vitest.config.ts — create.
- packages/workspace-packs/src/contracts.ts — create; schema-versioned pack, catalog, layout, view, theme, override, preference, diff, and validation types.
- packages/workspace-packs/src/limits.ts — create; closed size/count/string/depth limits shared by parser and CLI.
- packages/workspace-packs/src/parse.ts — create; strict unknown-to-contract parser with unknown-key and unsafe-value rejection.
- packages/workspace-packs/src/resolve.ts — create; compatibility checks and deterministic layer resolution.
- packages/workspace-packs/src/edit.ts — create; pure semantic WorkspaceEditOperation reducer shared by the visual editor and authoring CLI.
- packages/workspace-packs/src/patch.ts — create; constrained atomic JSON patch subset and allowed-path enforcement.
- packages/workspace-packs/src/canonicalize.ts — create; deterministic key ordering and canonical JSON serialization.
- packages/workspace-packs/src/cli.ts — create; inspect, catalog, validate, semantic edit, diff, fork, low-level patch, and export commands with JSON output.
- packages/workspace-packs/src/index.ts — create; public exports.
- packages/workspace-packs/src/parse.test.ts — create.
- packages/workspace-packs/src/resolve.test.ts — create.
- packages/workspace-packs/src/edit.test.ts — create.
- packages/workspace-packs/src/patch.test.ts — create.
- packages/workspace-packs/src/canonicalize.test.ts — create.
- packages/workspace-packs/src/cli.test.ts — create.

### Built-in portable packs

- apps/web/workspace-packs/default/sayre.workspace.json — create; first-party parity pack.
- apps/web/workspace-packs/default/README.md — create.
- apps/web/workspace-packs/pitch/sayre.workspace.json — create; presentation-first pack.
- apps/web/workspace-packs/pitch/from-default.operations.json — create; canonical semantic operations that reproduce the pitch pack from the default pack plus pitch identity metadata.
- apps/web/workspace-packs/pitch/README.md — create.

### Product runtime: pack, catalog, layout, and theme

- apps/web/package.json — modify; depend on @sayre/workspace-packs.
- apps/web/app/page.tsx — modify; accept a validated pack reference in initial shareable state without accepting raw pack content.
- apps/web/app/layout.tsx — modify; import the new theme/layout styles while retaining React Flow styles.
- apps/web/app/globals.css — modify; remove duplicated workspace palette ownership and retain only global/auth foundations.
- apps/web/app/workspace/packs/builtins.ts — create; import and validate the two built-in documents.
- apps/web/app/workspace/packs/capabilityCatalog.ts — create; trusted mapping from capability IDs to existing data loaders and operations.
- apps/web/app/workspace/packs/componentCatalog.tsx — create; trusted static mapping from component references to React implementations, allowed slots, roles, capabilities, prop parser, and contract version.
- apps/web/app/workspace/packs/packRegistry.ts — create; merge built-ins with validated installed packs and resolve a selected reference.
- apps/web/app/workspace/packs/packStorage.ts — create; browser persistence, migration, personal overrides, import/export, pinning, fork metadata, storage-event reconciliation, and safe failure behavior.
- apps/web/app/workspace/packs/packStorage.test.ts — create.
- apps/web/app/workspace/packs/WorkspacePackProvider.tsx — create; resolved pack, active reference, personal override/draft layers, pack actions, recovery state, and user preference boundary.
- apps/web/app/workspace/packs/WorkspacePackProvider.test.tsx — create.
- apps/web/app/workspace/layout/WorkspaceLayout.tsx — create; dock resolver, region landmark rendering, and editor-compatible drop-zone registration.
- apps/web/app/workspace/layout/ResizeHandle.tsx — create; pointer, touch, and keyboard resizing with clamping and focus recovery.
- apps/web/app/workspace/layout/WorkspaceLayout.test.tsx — create.
- apps/web/app/workspace/layout/workspace-layout.css — create; CSS grid, container-query, handle, and compact-mode rules driven by resolved variables.
- apps/web/app/workspace/theme/workspaceTheme.ts — create; safe token-to-CSS-variable mapping.
- apps/web/app/workspace/theme/workspaceTheme.test.ts — create.
- apps/web/app/workspace/theme/workspace-theme.css — create; semantic variable aliases and foundational product theme rules.
- apps/web/app/workspace/theme.ts — delete after all imports move to workspace/theme/workspaceTheme.ts.

### Product runtime: visual workspace editor

- apps/web/app/workspace/editor/WorkspaceEditorProvider.tsx — create; transactional draft, shared semantic-operation dispatch, validation, undo/redo, discard, personal save, and fork materialization.
- apps/web/app/workspace/editor/LayoutEditMode.tsx — create; authenticated edit-mode chrome, compatible drop targets, hidden-region tray, live preview, and save/discard controls.
- apps/web/app/workspace/editor/ComponentPalette.tsx — create; searchable role/capability/slot-filtered approved component replacements.
- apps/web/app/workspace/editor/ThemeTokenEditor.tsx — create; native color picker, validated hex input, discrete typography/density/radius choices, and token reset.
- apps/web/app/workspace/editor/dragController.ts — create; pointer/touch and keyboard drag state machine independent of pack mutation.
- apps/web/app/workspace/editor/LayoutEditMode.test.tsx — create; behavioral integration coverage for edit, validation, preview, history, persistence, and focus.
- apps/web/app/workspace/editor/dragController.test.ts — create; pointer, touch, keyboard, cancellation, compatibility, and cleanup coverage.
- apps/web/app/workspace/editor/editor.css — create; editor-only handles, palette, targets, focus, invalid state, and compact layout styles using semantic tokens.

### Product runtime: state boundaries

- apps/web/app/workspace/state.tsx — delete after its responsibilities move to the files below.
- apps/web/app/workspace/state/contracts.ts — create; context value and action contracts.
- apps/web/app/workspace/state/session.tsx — create; session, role/capability, backend, repository access, and viewer state.
- apps/web/app/workspace/state/navigation.tsx — create; repository/ref, active view, settings section, file explorer, controls, and search state.
- apps/web/app/workspace/state/selection.tsx — create; node/feature selection, return context, and inspector visibility.
- apps/web/app/workspace/state/queries.tsx — create; repository catalog, graph, semantic state, node overlay, load/error states, and explicit reload operations.
- apps/web/app/workspace/state/realtime.tsx — create; WebSocket lifecycle and query invalidation, keyed only by primitive repository identity.
- apps/web/app/workspace/state/operations.tsx — create; Agent/Skill MD, onboarding, provider, MCP, GitHub, and Jira actions.
- apps/web/app/workspace/state/fixture.tsx — create; fixture-only scenarios and compatibility aliases used by the mock controls.
- apps/web/app/workspace/state/WorkspaceProvider.tsx — create; compose focused providers for live and fixture modes.
- apps/web/app/workspace/state/index.ts — create; focused public hooks and temporary MockProvider/MockState aliases for the fixture lab.

### Product runtime: view and shell composition

- apps/web/app/workspace/views/TechnicalWorkspaceView.tsx — create; Technical-specific projection, explorer contribution, renderer selection, toolbar data, and canvas states moved out of the shell.
- apps/web/app/workspace/views/ProductWorkspaceView.tsx — create; Product-specific composition and stable structural-edge memoization.
- apps/web/app/workspace/views/OnboardingWorkspaceView.tsx — create; Onboarding-specific projection and workflow composition.
- apps/web/app/workspace/views/PitchSummaryPanel.tsx — create; trusted, read-only feature/team/recent-edit narrative for the pitch pack using already-authorized Product data.
- apps/web/app/workspace/views/WorkspaceViews.test.tsx — create.
- apps/web/app/workspace/components/WorkspaceShell.tsx — modify; reduce to system recovery, resolved pack layout, global blocked states, and provider composition. Remove view-specific branching and hard-coded grid combinations.
- apps/web/app/workspace/components/SystemRecoveryMenu.tsx — create; non-removable switch-to-default, reset-layout, enter-edit-mode, and pack-management access.
- apps/web/app/workspace/components/SystemRecoveryMenu.test.tsx — create.
- apps/web/app/workspace/components/TopBar.tsx — modify; consume focused hooks and catalog props; retain repository/account behavior.
- apps/web/app/workspace/components/ViewRail.tsx — modify; render resolved view contributions instead of a closed hard-coded union.
- apps/web/app/workspace/components/CanvasToolbar.tsx — modify; accept catalogued command contributions without owning pack resolution.
- apps/web/app/workspace/components/CanvasStates.tsx — modify; consume focused session/query/navigation hooks.
- apps/web/app/workspace/components/GlobalStates.tsx — modify; remain system-owned and unhideable by packs.
- apps/web/app/workspace/components/StatusBanner.tsx — modify; consume focused hooks and catalog props.
- apps/web/app/workspace/components/FileTreePane.tsx — modify only as needed to satisfy the explorer slot contract and focus recovery; tree behavior stays unchanged.
- apps/web/app/workspace/components/AskSayrePanel.tsx — modify; register as reserved catalog content rather than a hard-coded shell assumption.
- apps/web/app/workspace/components/ui.tsx — modify; expose catalog-safe primitive props and semantic token classes without accepting arbitrary class/style input from packs.
- apps/web/app/workspace/types.ts — modify; remove closed presentation unions that prevent registry extension while preserving Folder/File graph contracts.
- apps/web/app/workspace/viewRegistry.ts — modify; become the trusted capability definitions consumed by the pack catalog; loaders remain code-owned.
- apps/web/app/workspace/rendererRegistry.ts — modify; expose the renderer boundary as a trusted catalog decision, not pack executable logic.
- apps/web/app/workspace/moduleRegistry.ts — modify; expose versioned module definitions and allowed inspector slots.
- apps/web/app/workspace/settingsRegistry.ts — modify; add user-level workspace-pack management while retaining role requirements for GitHub/provider/MCP settings.
- apps/web/app/workspace/workspace.css — modify; remove palette ownership, root grid geometry, drawer/explorer fixed-width combinations, and responsive shell rules now owned by resolved tokens/layout CSS. Retain implementation styles that belong to the existing trusted components and canvases.

### Existing consumers migrated to focused state or pack order

- apps/web/app/workspace/canvas/OnboardingTreeCanvas.tsx — modify; use focused operation/query hooks instead of the monolithic context.
- apps/web/app/workspace/drawer/NodeDrawer.tsx — modify; render inspector modules in resolved pack order and consume focused hooks.
- apps/web/app/workspace/drawer/FeatureDrawer.tsx — modify; consume focused hooks and support its catalog slot contract.
- apps/web/app/workspace/drawer/AgentSkillModule.tsx — modify; consume focused operations/queries without taking layout state.
- apps/web/app/workspace/drawer/nodeModuleRenderers.tsx — modify; accept command/capability context without monolithic dispatch or arbitrary component execution.
- apps/web/app/workspace/settings/SettingsPanel.tsx — modify; resolve registered settings sections, enforce each section's role requirement, and delegate user-level pack management.
- apps/web/app/workspace/settings/WorkspacePackSettings.tsx — create; import, validation report, install, activate, edit/fork, export, and uninstall UI.
- apps/web/app/workspace/settings/WorkspacePackSettings.test.tsx — create.
- apps/web/app/workspace/settings/McpSettings.tsx — modify; consume focused operations/session hooks.
- apps/web/app/mock/page.tsx — modify; select a pack through the same runtime as the live client.
- apps/web/app/mock/components/ControlPanel.tsx — modify; add fixture pack selection and visual-editor preview while continuing to use fixture-only data state.
- apps/web/app/mock/README.md — modify; document Workspace Pack preview and remove the claim that custom LLM views are outside the architecture.
- apps/web/app/workspace/settings/SettingsPanel.test.tsx — modify; cover per-section role gating and pack-manager access.

No service, database, graph, worker, gateway, or marketing-site file is in scope.

## Interfaces / signatures

The signatures below are normative. Dev may split internal helpers further, but may not weaken these public contracts or add an executable escape hatch to the pack format.

### Portable pack contract

    export const WORKSPACE_PACK_SCHEMA_VERSION = 1 as const;
    export const WORKSPACE_RUNTIME_CONTRACT_VERSION = 1 as const;

    export type WorkspacePackId = string;
    export type WorkspaceViewId = string;
    export type WorkspaceCapabilityId = string;
    export type WorkspaceComponentId = string;
    export type WorkspaceSlotId =
      | 'top'
      | 'navigation'
      | 'explorer'
      | 'primary'
      | 'inspector'
      | 'bottom'
      | 'overlay';

    export type JsonPrimitive = string | number | boolean | null;
    export type JsonValue =
      | JsonPrimitive
      | readonly JsonValue[]
      | { readonly [key: string]: JsonValue };
    export type JsonObject = { readonly [key: string]: JsonValue };

    export interface WorkspacePackRef {
      id: WorkspacePackId;
      version: string;
    }

    export interface WorkspaceComponentRef {
      id: WorkspaceComponentId;
      version: number;
      props?: Readonly<Record<string, JsonValue>>;
    }

    export interface WorkspacePackMetadata {
      id: WorkspacePackId;
      name: string;
      version: string;
      description: string;
      author: string;
      license: string;
      tags: readonly string[];
      derivedFrom: WorkspacePackRef | null;
    }

    export interface WorkspacePackCompatibility {
      schemaVersion: 1;
      minimumRuntimeContractVersion: number;
      maximumRuntimeContractVersion: number | null;
      requiredComponents: readonly WorkspaceComponentRef[];
      requiredCapabilities: readonly WorkspaceCapabilityId[];
    }

    export type WorkspaceHexColor = string;
    export type WorkspaceFontChoice =
      | 'sayre-grotesk'
      | 'system-sans'
      | 'system-mono';
    export type WorkspaceDensity = 'compact' | 'comfortable' | 'presentation';
    export type WorkspaceRadiusScale = 'square' | 'subtle' | 'rounded';

    export interface WorkspaceThemeTokens {
      colors: {
        canvas: WorkspaceHexColor;
        raised: WorkspaceHexColor;
        hover: WorkspaceHexColor;
        border: WorkspaceHexColor;
        borderStrong: WorkspaceHexColor;
        edge: WorkspaceHexColor;
        node: WorkspaceHexColor;
        textFaint: WorkspaceHexColor;
        textMuted: WorkspaceHexColor;
        text: WorkspaceHexColor;
        textStrong: WorkspaceHexColor;
        accent: WorkspaceHexColor;
        accentText: WorkspaceHexColor;
        accentContent: WorkspaceHexColor;
        warning: WorkspaceHexColor;
        danger: WorkspaceHexColor;
      };
      typography: {
        ui: WorkspaceFontChoice;
        mono: WorkspaceFontChoice;
      };
      density: WorkspaceDensity;
      radius: WorkspaceRadiusScale;
    }

    export type WorkspaceResizeAxis = 'horizontal' | 'vertical' | 'none';

    export interface WorkspaceRegionSpec {
      id: string;
      slot: WorkspaceSlotId;
      component: WorkspaceComponentRef;
      order: number;
      hidden: boolean;
      defaultSize: number;
      minimumSize: number;
      maximumSize: number;
      resize: WorkspaceResizeAxis;
      collapsible: boolean;
      defaultCollapsed: boolean;
      visibleInViews: readonly WorkspaceViewId[] | null;
      compactBehavior: 'keep' | 'overlay' | 'collapse';
    }

    export interface WorkspaceLayoutSpec {
      id: string;
      regions: readonly WorkspaceRegionSpec[];
    }

    export interface WorkspaceViewSpec {
      id: WorkspaceViewId;
      label: string;
      glyph: string;
      hint: string;
      capability: WorkspaceCapabilityId;
      surface: WorkspaceComponentRef;
      toolbar: readonly WorkspaceComponentRef[];
      inspectorModules: readonly WorkspaceComponentRef[];
      enabled: boolean;
    }

    export interface WorkspacePackDocument {
      schemaVersion: 1;
      metadata: WorkspacePackMetadata;
      compatibility: WorkspacePackCompatibility;
      theme: WorkspaceThemeTokens;
      defaultLayoutId: string;
      defaultViewId: WorkspaceViewId;
      layouts: readonly WorkspaceLayoutSpec[];
      views: readonly WorkspaceViewSpec[];
      settingsOrder: readonly string[];
    }

    export interface ResolvedWorkspaceRegion extends WorkspaceRegionSpec {
      size: number;
      collapsed: boolean;
    }

    export interface ResolvedWorkspaceLayout {
      id: string;
      regions: readonly ResolvedWorkspaceRegion[];
    }

    export interface ResolvedWorkspaceView extends WorkspaceViewSpec {
      available: boolean;
      unavailableReason: string | null;
    }

ID and size grammar is also normative:

- Pack, layout, view, region, and settings IDs match ^[a-z0-9][a-z0-9.-]{2,63}$.
- Component and capability IDs match ^[a-z][a-z0-9.-]{2,95}$.
- Versions match ^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$; prerelease/build suffixes are deferred from schema version 1.
- A raw document is at most 262,144 UTF-8 bytes and 20 object/array levels deep.
- Maximum counts are 8 layouts, 16 views, 32 regions per layout, 64 inspector modules per view, 64 settings entries, 64 tags, 128 patch operations, and 128 component-prop keys across the document.
- Trimmed name/label strings are 1–80 characters, descriptions/hints 1–500, author 1–100, license 1–64, tags 1–32, and component-prop strings 0–2,000. C0/C1 control characters other than ordinary JSON whitespace are rejected.

### Catalog and trusted runtime contracts

    export interface WorkspaceComponentContract<Props extends JsonObject = JsonObject> {
      id: WorkspaceComponentId;
      version: number;
      allowedSlots: readonly WorkspaceSlotId[];
      requiredCapabilities: readonly WorkspaceCapabilityId[];
      minimumRole: 'member' | 'admin' | 'owner' | null;
      parseProps(value: unknown): Props;
    }

    export interface WorkspaceComponentCatalogContract {
      runtimeContractVersion: number;
      components: readonly Omit<
        WorkspaceComponentContract,
        'parseProps'
      >[];
      capabilities: readonly {
        id: WorkspaceCapabilityId;
        version: number;
      }[];
    }

    export interface WorkspaceComponentDefinition<Props extends JsonObject = JsonObject>
      extends WorkspaceComponentContract<Props> {
      Component: React.ComponentType<WorkspaceCatalogComponentProps<Props>>;
    }

    export interface WorkspaceCatalogComponentProps<Props extends JsonObject> {
      config: Readonly<Props>;
      region: ResolvedWorkspaceRegion;
      view: ResolvedWorkspaceView;
    }

    export interface WorkspaceCapabilityDefinition {
      id: WorkspaceCapabilityId;
      version: number;
      load(
        source: WorkspaceDataSource,
        scope: WorkspaceScope,
        signal: AbortSignal,
      ): Promise<WorkspaceGraph>;
    }

    export interface WorkspaceComponentCatalog {
      runtimeContractVersion: number;
      components: ReadonlyMap<string, WorkspaceComponentDefinition>;
      capabilities: ReadonlyMap<string, WorkspaceCapabilityDefinition>;
      contract: WorkspaceComponentCatalogContract;
    }

    export function createWorkspaceComponentCatalog(): WorkspaceComponentCatalog;
    export function workspaceComponentKey(ref: WorkspaceComponentRef): string;
    export function snapshotWorkspaceComponentCatalog(
      catalog: WorkspaceComponentCatalog,
    ): WorkspaceComponentCatalogContract;

The catalog is assembled from static imports in product code. A Workspace Pack string is never passed to import(), require(), eval(), Function(), dangerouslySetInnerHTML, a stylesheet loader, or an outbound request.

### Parsing, validation, resolution, and serialization

    export interface WorkspacePackViolation {
      code: string;
      path: string;
      message: string;
    }

    export type WorkspacePackValidationResult =
      | { ok: true; pack: WorkspacePackDocument; warnings: readonly WorkspacePackViolation[] }
      | { ok: false; violations: readonly WorkspacePackViolation[] };

    export function parseWorkspacePack(value: unknown): WorkspacePackValidationResult;

    export function validateWorkspacePackCompatibility(
      pack: WorkspacePackDocument,
      catalog: WorkspaceComponentCatalogContract,
    ): WorkspacePackValidationResult;

    export interface WorkspaceUserPreferences {
      pack: WorkspacePackRef;
      layoutId: string;
      regionSizes: Readonly<Record<string, number>>;
      collapsedRegionIds: readonly string[];
      updatedAt: string;
    }

    export interface WorkspacePackOverride {
      theme?: Partial<WorkspaceThemeTokens>;
      defaultLayoutId?: string;
      defaultViewId?: WorkspaceViewId;
      layouts?: readonly WorkspaceLayoutSpec[];
      views?: readonly WorkspaceViewSpec[];
    }

    export interface ResolveWorkspacePackInput {
      safetyDefaults: WorkspacePackDocument;
      selectedPack: WorkspacePackDocument | null;
      organizationOverride: WorkspacePackOverride | null;
      userOverride: WorkspacePackOverride | null;
      userPreferences: WorkspaceUserPreferences | null;
      catalog: WorkspaceComponentCatalogContract;
      viewportClass: 'compact' | 'standard' | 'wide';
      role: 'member' | 'admin' | 'owner';
    }

    export interface ResolvedWorkspaceExperience {
      pack: WorkspacePackRef;
      theme: WorkspaceThemeTokens;
      layout: ResolvedWorkspaceLayout;
      views: readonly ResolvedWorkspaceView[];
      defaultViewId: WorkspaceViewId;
      warnings: readonly WorkspacePackViolation[];
      usedSafetyFallback: boolean;
    }

    export function resolveWorkspaceExperience(
      input: ResolveWorkspacePackInput,
    ): ResolvedWorkspaceExperience;

    export function canonicalizeWorkspacePack(
      pack: WorkspacePackDocument,
    ): string;

Resolution is pure and deterministic. It must never inspect window, localStorage, network state, repository data, or authentication tokens.

### Semantic visual-edit contract

    export type WorkspaceThemeColorToken = keyof WorkspaceThemeTokens['colors'];

    export type WorkspaceEditOperation =
      | {
          type: 'move-region';
          layoutId: string;
          regionId: string;
          slot: WorkspaceSlotId;
          order: number;
        }
      | {
          type: 'set-region-hidden';
          layoutId: string;
          regionId: string;
          hidden: boolean;
        }
      | {
          type: 'replace-region-component';
          layoutId: string;
          regionId: string;
          component: WorkspaceComponentRef;
        }
      | {
          type: 'resize-region-default';
          layoutId: string;
          regionId: string;
          size: number;
        }
      | {
          type: 'set-region-default-collapsed';
          layoutId: string;
          regionId: string;
          collapsed: boolean;
        }
      | {
          type: 'set-theme-color';
          token: WorkspaceThemeColorToken;
          value: WorkspaceHexColor;
        }
      | {
          type: 'set-theme-choice';
          token: 'typography.ui' | 'typography.mono';
          value: WorkspaceFontChoice;
        }
      | { type: 'set-theme-choice'; token: 'density'; value: WorkspaceDensity }
      | { type: 'set-theme-choice'; token: 'radius'; value: WorkspaceRadiusScale }
      | { type: 'set-default-view'; viewId: WorkspaceViewId };

    export interface WorkspaceEditContext {
      catalog: WorkspaceComponentCatalogContract;
      role: 'member' | 'admin' | 'owner';
      availableCapabilities: readonly WorkspaceCapabilityId[];
    }

    export type WorkspacePackEditResult =
      | {
          ok: true;
          pack: WorkspacePackDocument;
          changedPaths: readonly string[];
        }
      | {
          ok: false;
          pack: WorkspacePackDocument;
          violations: readonly WorkspacePackViolation[];
        };

    export function applyWorkspaceEditOperation(
      pack: WorkspacePackDocument,
      operation: WorkspaceEditOperation,
      context: WorkspaceEditContext,
    ): WorkspacePackEditResult;

    export function applyWorkspaceEditOperations(
      pack: WorkspacePackDocument,
      operations: readonly WorkspaceEditOperation[],
      context: WorkspaceEditContext,
    ): WorkspacePackEditResult;

The semantic reducer is pure, ordered, and atomic. It resolves region identity before array position, normalizes region order after a move, checks slot/component/role/capability compatibility against the explicit context, and parses plus compatibility-validates the complete result. Failed operations return the unchanged input pack and path-specific violations. The visual editor and the edit CLI must call these functions; neither may maintain a second mutation implementation.

### Constrained patch and diff contract

    export type WorkspacePackPatchOperation =
      | { op: 'add'; path: string; value: JsonValue }
      | { op: 'replace'; path: string; value: JsonValue }
      | { op: 'remove'; path: string };

    export interface WorkspacePackPatchResult {
      pack: WorkspacePackDocument;
      changedPaths: readonly string[];
      canonicalJson: string;
    }

    export function applyWorkspacePackPatch(
      pack: WorkspacePackDocument,
      operations: readonly WorkspacePackPatchOperation[],
      catalog: WorkspaceComponentCatalogContract,
    ): WorkspacePackPatchResult;

    export interface WorkspacePackDiffEntry {
      path: string;
      before: JsonValue | undefined;
      after: JsonValue | undefined;
    }

    export function diffWorkspacePacks(
      before: WorkspacePackDocument,
      after: WorkspacePackDocument,
    ): readonly WorkspacePackDiffEntry[];

Patch application is atomic: all operations apply to a clone, then the whole result is parsed and compatibility-validated. Any violation returns non-zero from the CLI and leaves the source file byte-for-byte unchanged.

Allowed patch roots are:

- /metadata/name
- /metadata/version
- /metadata/description
- /metadata/author
- /metadata/license
- /metadata/tags
- /metadata/derivedFrom
- /theme
- /defaultLayoutId
- /defaultViewId
- /layouts
- /views
- /settingsOrder

The CLI fork command, not generic patch, changes /metadata/id. Paths containing __proto__, prototype, constructor, empty interior segments, invalid escapes, or a root outside the allowlist are rejected.

### Browser storage and registry

    export interface InstalledWorkspacePack {
      ref: WorkspacePackRef;
      source: 'builtin' | 'imported' | 'forked';
      installedAt: string;
      pack: WorkspacePackDocument;
    }

    export interface WorkspacePackStore {
      list(): readonly InstalledWorkspacePack[];
      get(ref: WorkspacePackRef): InstalledWorkspacePack | null;
      install(rawJson: string): WorkspacePackValidationResult;
      fork(
        source: WorkspacePackRef,
        identity: { id: string; name: string; version: string; author: string },
      ): InstalledWorkspacePack;
      uninstall(ref: WorkspacePackRef): void;
      active(): WorkspacePackRef;
      activate(ref: WorkspacePackRef): void;
      preferences(ref: WorkspacePackRef, layoutId: string): WorkspaceUserPreferences | null;
      savePreferences(preferences: WorkspaceUserPreferences): void;
      resetPreferences(ref: WorkspacePackRef, layoutId?: string): void;
      personalOverride(ref: WorkspacePackRef): WorkspacePackOverride | null;
      savePersonalOverride(ref: WorkspacePackRef, override: WorkspacePackOverride): void;
      resetPersonalOverride(ref: WorkspacePackRef): void;
      export(ref: WorkspacePackRef): string;
      subscribe(listener: () => void): () => void;
    }

    export function createBrowserWorkspacePackStore(input: {
      builtins: readonly InstalledWorkspacePack[];
      storage: Storage | null;
      catalog: WorkspaceComponentCatalogContract;
      now?: () => Date;
    }): WorkspacePackStore;

Built-ins are immutable. Imported/forked packs are stored under a schema-versioned key. Every storage read is reparsed; stored data is never trusted merely because the application wrote it earlier.

Personal overrides are stored under a separate schema-versioned key scoped to the exact base pack reference. They are reparsed on every read and are never included by export(ref). A user must materialize the resolved draft as a fork with a new ID/version before those changes become a portable Workspace Pack.

### Layout and preference hooks

    export interface WorkspaceLayoutActions {
      resize(regionId: string, size: number): void;
      collapse(regionId: string): void;
      expand(regionId: string): void;
      reset(layoutId?: string): void;
    }

    export function useResolvedWorkspace(): ResolvedWorkspaceExperience;
    export function useWorkspacePackActions(): WorkspacePackActions;
    export function useWorkspaceLayoutActions(): WorkspaceLayoutActions;

    export interface WorkspaceEditorDraft {
      baseRef: WorkspacePackRef;
      basePack: WorkspacePackDocument;
      operations: readonly WorkspaceEditOperation[];
      previewPack: WorkspacePackDocument;
      historyIndex: number;
      dirty: boolean;
      violations: readonly WorkspacePackViolation[];
    }

    export interface WorkspaceEditorActions {
      begin(ref?: WorkspacePackRef): void;
      dispatch(operation: WorkspaceEditOperation): WorkspacePackEditResult;
      undo(): void;
      redo(): void;
      discard(): void;
      savePersonal(): void;
      materializeFork(identity: {
        id: string;
        name: string;
        version: string;
        author: string;
      }): InstalledWorkspacePack;
    }

    export interface WorkspaceEditorContextValue {
      mode: 'inactive' | 'editing';
      draft: WorkspaceEditorDraft | null;
      canUndo: boolean;
      canRedo: boolean;
      actions: WorkspaceEditorActions;
    }

    export function useWorkspaceEditor(): WorkspaceEditorContextValue;

    export interface WorkspaceDropTarget {
      layoutId: string;
      slot: WorkspaceSlotId;
      order: number;
      accepts(component: WorkspaceComponentRef): boolean;
      label: string;
    }

Layout Edit Mode previews pack defaults, so it resolves the draft with transient region-size/collapse preferences suspended. This makes a resize/default-collapse edit visible and reproducible; exiting, discarding, or saving restores the untouched transient preferences as the final runtime layer. The editor labels this distinction. Ordinary resizing outside edit mode continues to update only transient preferences.

    export interface WorkspacePackActions {
      install(rawJson: string): WorkspacePackValidationResult;
      activate(ref: WorkspacePackRef): void;
      fork(
        source: WorkspacePackRef,
        identity: { id: string; name: string; version: string; author: string },
      ): InstalledWorkspacePack;
      export(ref: WorkspacePackRef): string;
      uninstall(ref: WorkspacePackRef): void;
      resetLayout(layoutId?: string): void;
      resetPersonalOverride(ref?: WorkspacePackRef): void;
      switchToDefault(): void;
    }

    export interface ResizeHandleProps {
      regionId: string;
      axis: 'horizontal' | 'vertical';
      value: number;
      minimum: number;
      maximum: number;
      collapsed: boolean;
      onChange(next: number): void;
      onCollapse(): void;
      onExpand(): void;
    }

ResizeHandle renders an accessible separator with aria-orientation, aria-valuemin, aria-valuemax, and aria-valuenow. Arrow keys move by 8 CSS pixels, Shift+Arrow moves by 32, Home selects minimum, End selects maximum, and Enter toggles collapse for a collapsible region.

### Focused product-state hooks

    export function useWorkspaceSession(): WorkspaceSessionContextValue;
    export function useWorkspaceNavigation(): WorkspaceNavigationContextValue;
    export function useWorkspaceSelection(): WorkspaceSelectionContextValue;
    export function useWorkspaceQueries(): WorkspaceQueryContextValue;
    export function useWorkspaceRealtime(): WorkspaceRealtimeContextValue;
    export function useWorkspaceOperations(): WorkspaceOperationsContextValue;
    export function useWorkspaceFixture(): WorkspaceFixtureContextValue | null;

    export interface WorkspaceSessionContextValue {
      mode: 'live' | 'fixture';
      session: SessionState;
      role: Role;
      access: RepositoryAccess;
      backend: BackendState;
      isAdmin: boolean;
      repositories: readonly Repository[];
      repository: Repository | null;
      authorizedForRepository: boolean;
      readiness: RepositoryReadiness;
      scope: WorkspaceScope | null;
      viewer: WorkspaceDataSource['viewer'];
      reloadCatalog(): void;
    }

    export interface WorkspaceNavigationContextValue {
      repositoryId: string | null;
      refName: string | null;
      viewId: WorkspaceViewId;
      settingsSection: string | null;
      controlsOpen: boolean;
      fileTreeOpen: boolean;
      search: string;
      selectRepository(repositoryId: string): void;
      selectRef(refName: string): void;
      selectView(viewId: WorkspaceViewId): void;
      openSettings(section: string): void;
      closeSettings(): void;
      setControlsOpen(open: boolean): void;
      setFileTreeOpen(open: boolean): void;
      setSearch(search: string): void;
    }

    export interface WorkspaceSelectionContextValue {
      selectedNodeId: string | null;
      selectedFeatureId: string | null;
      returnFeatureId: string | null;
      inspectorOpen: boolean;
      selectNode(nodeId: string): void;
      selectFeature(featureId: string): void;
      clearSelection(): void;
      closeInspector(): void;
      returnToFeature(): void;
    }

    export interface WorkspaceQueryContextValue {
      graph: WorkspaceGraph;
      graphStatus: LoadStatus;
      graphErrorStatus: number | null;
      semanticState: SemanticState;
      nodeOverlay: NodeOverlay | null;
      overlayStatus: LoadStatus;
      reloadGraph(): void;
      reloadOverlay(): void;
    }

    export interface WorkspaceRealtimeContextValue {
      status: RealtimeStatus;
      connectedRepositoryId: string | null;
    }

    export interface WorkspaceOperationsContextValue {
      saveAgentSkillMd(
        nodeId: string,
        content: string,
        expectedVersion: number,
      ): Promise<AgentSkillVersion>;
      runOnboardingStep(stepId: string): Promise<OnboardingExecutionResponse>;
      loadProviderSettings(signal: AbortSignal): Promise<ProviderSettingsResponse>;
      saveProviderSetting(
        purpose: ProviderPurpose,
        update: ProviderSettingsUpdateRequest,
      ): Promise<ProviderSettingView>;
      loadMcpSettings(signal: AbortSignal): Promise<McpKeySettingsResponse>;
      issueMcpKey(request: McpClientKeyCreateRequest): Promise<McpClientKeyIssued>;
      revokeMcpKey(keyId: string): Promise<McpClientKeyView>;
      saveMcpRateLimit(
        rateLimitPerMinute: number,
      ): Promise<{ rateLimitPerMinute: number }>;
      loadGitHubIntegrationStatus(
        signal: AbortSignal,
      ): Promise<GitHubIntegrationStatusResponse>;
      githubInstallUrl: string;
      loadJiraIntegrationStatus(signal: AbortSignal): Promise<JiraStatusResponse>;
      disconnectJira(): Promise<JiraStatusResponse>;
      jiraConnectUrl: string;
    }

    export interface WorkspaceFixtureContextValue {
      state: MockState;
      patch(patch: Partial<MockState>): void;
      reset(): void;
    }

    export interface WorkspaceProviderProps {
      children: React.ReactNode;
      source?: WorkspaceDataSource;
      gatewayWsUrl?: string | null;
      allowLocalGatewayFallback?: boolean;
      initialRepositoryId?: string | null;
      initialRefName?: string | null;
      initialView?: string;
      initialSettingsSection?: string | null;
      initialNodeId?: string | null;
      initialFeatureId?: string | null;
      initialPackRef?: WorkspacePackRef | null;
    }

No focused context value may include unrelated layout state. In particular, changing a region size or collapsed flag must not change the identity of the query, realtime, operations, or session context values.

### Query parameter contract

The product route may accept:

    pack=<percent-encoded pack id>@<percent-encoded semantic version>

It never accepts raw JSON, a URL, a path, a component ID, or a theme value. If the referenced pack is not installed, the runtime uses the default pack, reports the missing reference in the system recovery menu, and retains the requested reference only as display text.

### CLI contract

Root invocation:

    npm run workspace-pack -- <command> [arguments]

Commands:

    catalog [--json]
    inspect <pack-directory> [--json]
    validate <pack-directory> [--json]
    diff <left-pack-directory> <right-pack-directory> [--json]
    fork <source-pack-directory> <destination-directory>
      --id <id> --name <name> --version <version> --author <author>
    patch <pack-directory> --operations <operations.json> [--dry-run] [--json]
    edit <pack-directory> --operations <semantic-operations.json>
      [--role <member|admin|owner>] [--dry-run] [--json]
    export <pack-directory> --out <destination.json> [--json]

    export interface WorkspacePackCliIo {
      stdout(value: string): void;
      stderr(value: string): void;
      readFile(path: string): Promise<string>;
      writeFileAtomic(path: string, value: string): Promise<void>;
      mkdir(path: string): Promise<void>;
    }

    export async function runWorkspacePackCli(
      argv: readonly string[],
      io?: WorkspacePackCliIo,
    ): Promise<number>;

All --json success and failure responses contain command, ok, and either result or violations. Expected validation failures contain no stack trace. edit defaults to the conservative member role and uses capabilities from the serializable catalog snapshot unless the reviewed invocation supplies a role. Write commands resolve absolute targets, require the source/destination to remain under an explicit workspace-pack root, use a temporary sibling plus atomic rename, and refuse to overwrite an existing destination unless the command contract explicitly names the exact same pack file being edited or patched.

### Authoring skill contract

Only after the visual-editor behavioral gate passes, the experimental authoring guide and thin skill enforce this sequence:

1. Inspect the current pack and catalog.
2. Translate the user's request into WorkspaceEditOperation values only.
3. Run edit with --dry-run.
4. Validate the result.
5. Apply the semantic edit.
6. Run diff and report changed contract paths.
7. Preview the pack through the fixture lab at compact, standard, and wide sizes.
8. If catalog or capability validation says the request cannot be represented declaratively, stop and produce a trusted-catalog-extension proposal. Do not fall back to low-level patch or edit TSX, CSS, the component catalog, authentication, data source, or graph code under the workspace-pack-author skill.

The low-level patch command remains available to reviewed developer workflows and migrations, but it is not the default LLM interface. The skill, report, and CLI are repo-local experimental tooling in this ticket: they are not imported into the browser bundle, exposed as a product route, or represented as deployment-ready.

### Settings authorization contract

Settings section definitions gain:

    export interface SettingsSectionDefinition {
      id: string;
      label: string;
      title: string;
      capability: string;
      availability: 'available';
      minimumRole: 'member' | 'admin' | 'owner';
      component: WorkspaceComponentRef;
    }

workspace-packs has minimumRole member. GitHub, providers, and MCP retain their current admin/owner visibility. A pack may reorder settings entries it is allowed to see, but cannot lower minimumRole or inject a settings component not present in the trusted catalog.

## Approach

1. Create @sayre/workspace-packs as a pure package with no React, DOM, network, database, graph, or filesystem dependency in its parse/resolve/edit/patch/canonicalize modules.
2. Define the version-1 contract, closed token keys, size/count limits, strict parser, compatibility checks, semantic edit reducer, canonical serialization, and hostile fixtures before touching the product shell.
3. Author the default pack from the current product behavior. Treat it as the parity oracle: current view order, current default Technical view, current explorer/inspector behavior, current renderer threshold, and the Warm Graphite values become declarative inputs.
4. Build the static component/capability catalog around existing audited components and loaders. Catalog entries declare allowed slots, required capabilities, minimum role, prop validation, and contract version.
5. Split the monolithic workspace context by responsibility while keeping transport shapes and service calls unchanged. Use primitive repository/ref dependencies in query and realtime effects.
6. Move Technical, Product, and Onboarding projection/composition logic from WorkspaceShell into view components selected by trusted catalog entries. Only mount and compute the active view and active renderer.
7. Implement pack storage, registry, selection, resolver, query-parameter lookup, version pinning, personal overrides, fork/export, storage-event reconciliation, and safe default fallback.
8. Implement WorkspaceLayout and ResizeHandle. Keep layout values in their own context and CSS custom properties; use container queries for compact behavior and preserve accessible keyboard controls.
9. Implement semantic theme mapping and remove the hard-coded root palette/grid ownership from WorkspaceShell/workspace.css. Preserve trusted component implementation styles and bridge their existing semantic variables during migration.
10. Implement SystemRecoveryMenu outside pack-controlled regions, then render resolved layouts through WorkspaceShell.
11. Make NodeDrawer, FeatureDrawer, toolbar, view rail, settings navigation, status surfaces, explorer, and reserved Ask Sayre surface consume resolved contributions and focused hooks.
12. Add member-accessible Workspace Pack management while retaining admin/owner requirements for integration, provider, and MCP settings.
13. Build Layout Edit Mode on the shared semantic reducer: pointer/touch and keyboard drag/reorder, catalog-filtered replacement, hide/show, resize/default-collapse, default-view selection, theme editing, continuous validation, and live preview.
14. Add bounded undo/redo, discard, personal-override save, and explicit fork materialization. Keep built-in/imported documents immutable and keep drafts/preferences out of exports until materialized.
15. Wire the fixture lab to exercise the visual editor and built-in/installed packs at compact, standard, and wide sizes. Prove edit operations do not refetch product data or reconnect realtime state.
16. Author the pitch pack and PitchSummaryPanel by applying a committed from-default.operations.json sequence through the same reducer used by Layout Edit Mode. Verify the resulting canonical functional fields match the checked-in pitch pack after its identity metadata is applied.
17. Complete the visual-editor behavioral, accessibility, typecheck, and build gate. This is the deployment proof and must pass before any LLM experiment is accepted or used to change the editor contract.
18. After that gate, add the atomic CLI semantic-edit command and machine-readable output. Make catalog data available through a serializable snapshot rather than importing React components into Node; retain low-level patch for reviewed developer/migration use.
19. Add the runtime-neutral experimental authoring guide and thin skill pointer. Evaluate it against a fixed task matrix using the same WorkspaceEditOperation contract and record successes, failures, ambiguity, unsafe requests, repeatability, preview limitations, and deployability blockers in docs/workspace-pack-llm-rd.md.
20. Run package and web typechecks/tests/build. Confirm the root marketing build remains unchanged by scope and no downstream pipeline stage runs during spec-only.

## Acceptance criteria

- **AC-1** — The implementation touches the Next.js product client under apps/web and the explicitly listed shared package/docs/tooling only. The only repository-security-script exception is the four exact secret-access scanner/test paths listed under Affected files, solely to tolerate tracked product files deleted from the worktree; the root Vite marketing site's src, public, index.html, and marketing runtime dependencies are unchanged.
- **AC-2** — Workspace Pack schema version 1 is represented by the exact WorkspacePackDocument contract above, and both built-in packs parse successfully through the same strict parser used for imported and stored packs.
- **AC-3** — parseWorkspacePack rejects unknown object keys, missing required fields, duplicate IDs, invalid semantic versions, invalid IDs, non-plain objects, unsafe property names, over-limit documents, and values outside every closed enum/range with path-specific violations.
- **AC-4** — Imported packs cannot contain or reference executable code, module/file URLs, API/query definitions, raw HTML, raw CSS, event-handler strings, external asset URLs, data URLs, organization/repository identifiers, authentication data, or secrets; negative tests cover each class.
- **AC-5** — The static component catalog is the only mapping from a component reference to React code. Every entry declares its contract version, allowed slots, required capabilities, minimum role, and strict props parser; an unknown or incompatible reference fails validation before render.
- **AC-6** — The static capability catalog is the only mapping from a pack capability ID to a WorkspaceDataSource loader or operation. Packs cannot choose endpoints or construct graph queries.
- **AC-7** — resolveWorkspaceExperience implements the documented precedence deterministically: safety defaults, selected pack, organization override, user personal override, then transient user layout preferences. The same inputs produce deeply equal output and canonical serialization across repeated runs.
- **AC-8** — The resolver always produces exactly one usable primary region, at least one enabled view, a valid default view, role-allowed components only, clamped sizes, and a reachable system recovery surface; otherwise it uses the default safety pack and reports violations.
- **AC-9** — The default built-in pack reproduces the existing live workspace's Technical/Product/Onboarding availability, default Technical view, view order, explorer behavior, drawer behavior, settings availability, toolbar commands, graph states, renderer threshold, and Warm Graphite appearance within intentional token normalization.
- **AC-10** — WorkspaceShell no longer contains branches selecting TechnicalTreeCanvas, ProductTreeCanvas, or OnboardingTreeCanvas, no longer constructs four fixed grid-column combinations, and no longer owns a hard-coded theme object. It renders global safety states plus resolved catalog regions.
- **AC-11** — Technical, Product, and Onboarding composition/projection logic lives in separate trusted view components. Inactive view projections are not computed, and Technical React Flow and Sigma layouts are not both computed for one render.
- **AC-12** — React Flow remains selected below approximately 500 visible Technical nodes and Sigma above that boundary; Product and Onboarding retain their existing supported renderers. A pack cannot override the trusted threshold with an arbitrary number.
- **AC-13** — Only Folder and File nodes can be passed to any pack-selected canvas. Existing fail-closed response parsing remains in force, and no client-side RBAC filtering or deep traversal is added.
- **AC-14** — The pitch pack loads through the same parser, resolver, catalog, state, and shell as the default pack and is visibly distinct: Product is the default view, technical chrome is minimized, the primary presentation area is larger, presentation density/theme tokens differ, and PitchSummaryPanel exposes authorized feature description, team, files, and recent-edit context.
- **AC-15** — A developer can change any allowed color by editing a six- or eight-digit hex value in a pack's sayre.workspace.json; validation accepts the edit, activation updates semantic CSS variables, and no TSX/CSS edit is required.
- **AC-16** — Invalid colors, arbitrary CSS values, url() values, unknown token names, and unsupported font/density/radius values are rejected before they reach style properties.
- **AC-17** — A pack can replace, reorder, hide, or move an approved component only within that catalog entry's allowed slots and capability/role constraints. The same change is expressible through Layout Edit Mode and the semantic edit CLI operation contract.
- **AC-18** — WorkspaceLayout supports top, navigation, explorer, primary, inspector, bottom, and overlay regions; horizontal/vertical resize, collapse, expand, default size, minimum, maximum, ordering, per-view visibility, and compact behavior all follow the resolved contract.
- **AC-19** — ResizeHandle supports pointer and touch interaction plus the documented Arrow, Shift+Arrow, Home, End, and Enter keyboard behavior; it exposes current bounds/value through accessible separator semantics.
- **AC-20** — Collapsing a region containing focus moves focus to its visible restore control. Expanding restores the region without trapping focus. Every visible region has a stable landmark label supplied by trusted catalog metadata.
- **AC-21** — Layout renders without horizontal page overflow or inaccessible controls at 320-pixel compact, 736-pixel standard, and desktop-wide fixture sizes. Pack compactBehavior is applied through container/layout state, not user-agent sniffing.
- **AC-22** — User region sizes and collapsed state persist per pack ID, pack version, layout ID, and viewport class. They are clamped again after every load and reset automatically when their referenced region no longer exists.
- **AC-23** — Resizing, collapsing, expanding, resetting, or switching compact layout does not call repositories(), any view loader, nodeOverlay(), providerState(), or create/reconnect a WebSocket. Behavioral tests use instrumented fakes to prove zero calls.
- **AC-24** — Session/capability, navigation, selection, queries, realtime, operations, fixture, and layout each expose focused hooks. A layout preference update does not change the identity of session, query, realtime, or operations context values.
- **AC-25** — Realtime invalidation remains scoped to the selected primitive repository ID/ref and refreshes current graph/overlay data without resetting an in-progress layout interaction or active pack.
- **AC-26** — The system recovery menu is rendered outside pack-controlled regions, cannot be hidden/replaced/reordered by a pack, and always offers switch to default, reset current layout, enter/exit Layout Edit Mode, and Workspace Pack management to an authenticated member.
- **AC-27** — Global signed-out, expired-session, backend-unavailable, forbidden, and no-repository states remain system-owned and cannot be hidden or relabeled by a pack.
- **AC-28** — Local pack management is available to authenticated members. Existing GitHub, provider, and MCP settings remain absent for members and available only at their current admin/owner threshold; a pack cannot lower that threshold.
- **AC-29** — Workspace Pack management supports importing a JSON export, showing validation violations before install, installing side-by-side versions, activating a pinned version, forking with a new identity, exporting canonical JSON, and uninstalling non-built-ins.
- **AC-30** — Built-in packs cannot be overwritten or uninstalled. Importing the same ID/version with different canonical content is a visible conflict, not a silent replacement.
- **AC-31** — Activating a pack never silently moves to a newer version. Removing the active imported pack atomically activates the default pack and reports the recovery action.
- **AC-32** — Exports are deterministic canonical JSON: two exports of the same parsed document are byte-identical. Exports contain materialized pack configuration and metadata only; active repository/ref, graph data, session data, org/user identity, local storage keys, personal overrides, editor drafts/history, and transient user layout preferences are absent.
- **AC-33** — A canonical export from one browser fixture can be imported into a fresh browser fixture and resolves to the same pack document, layout, view order, theme tokens, and component references.
- **AC-34** — The pack query parameter selects only an installed/built-in ID and exact version. Missing, malformed, or incompatible references fall back safely without fetching or executing the parameter value.
- **AC-35** — Browser storage is treated as untrusted. Every read is reparsed and compatibility-validated; corrupt, stale, unavailable, or quota-exceeded storage degrades to built-ins with a useful local error and does not blank the workspace.
- **AC-36** — Storage changes from a second same-origin tab reconcile installed-pack metadata and preferences without applying a partially written document or losing the current default fallback.
- **AC-37** — The CLI implements all documented commands, returns zero only on success, emits stable JSON envelopes under --json, reports expected violations without stack traces, and performs writes atomically within an approved workspace-pack root.
- **AC-38** — patch --dry-run validates and prints the prospective canonical document/diff without changing disk. A successful non-dry-run patch applies all operations or none; any invalid operation leaves the original file byte-identical.
- **AC-39** — fork creates a new directory, changes identity only through the fork contract, records derivedFrom, preserves source files, and refuses an existing destination.
- **AC-40** — catalog --json exposes component IDs/versions, allowed slots, capability requirements, minimum roles, accepted prop fields, capability IDs, and theme token keys without importing browser-only React code into the Node CLI.
- **AC-41** — After the visual-editor gate passes, the experimental runtime-neutral authoring guide and thin skill enforce inspect → catalog → dry-run semantic edit → validate → apply → diff → preview. The skill explicitly forbids ordinary pack customization from falling back to low-level patch or editing TSX, CSS, the component catalog, auth, transport, or graph code.
- **AC-42** — When a requested UX element or behavior has no compatible catalog/capability entry, the authoring skill stops and returns a trusted-catalog-extension proposal naming the missing contract. It does not invent a component ID or embed code in pack data.
- **AC-43** — The fixture lab can switch between default, pitch, and installed packs and exercise compact, standard, and wide layouts using the same production resolver and catalog; fixture-only scenario controls remain isolated from live mode.
- **AC-44** — Existing Agent/Skill MD editing, onboarding step execution, provider settings, MCP settings, GitHub/Jira settings, node/feature drawers, file-tree keyboard behavior, semantic degraded states, and realtime status behavior continue to pass their existing tests after focused-context migration.
- **AC-45** — The product workspace no longer requires a hard-coded Warm Graphite object in WorkspaceShell, and root globals.css no longer duplicates the workspace token source. The default pack is the editable source of its semantic product palette.
- **AC-46** — No new runtime dependency is required for graph traversal, remote code, CSS injection, third-party drag-and-drop authoring, or marketplace transport. The new shared package remains usable in Node tests and the browser without Node built-ins in parse/resolve/edit/patch/canonicalize paths.
- **AC-47** — docs/workspace-packs.md documents schema/runtime/component versioning, immutable built-ins, pinned installs, fork semantics, trust levels, local sharing, marketplace ingestion expectations, compatibility failure behavior, and the future organization-override source.
- **AC-48** — docs/workspace-pack-authoring.md is sufficient for an experimental LLM or a developer with no repository context to inspect, semantically modify, validate, preview, fork, and export a pack without reading WorkspaceShell.tsx or workspace.css; it makes no claim that LLM authoring is production-ready.
- **AC-49** — Workspace and package tests, typechecks, and builds pass using the repository's real scripts: npm run test --workspace=@sayre/workspace-packs, npm run typecheck --workspace=@sayre/workspace-packs, npm run test --workspace=@sayre/web, npm run typecheck --workspace=@sayre/web, and npm run build --workspace=@sayre/web.
- **AC-50** — A source search and security-negative suite confirms imported pack content never reaches eval, Function, dynamic import, require, dangerouslySetInnerHTML, raw style text, link/script/style src/href construction, fetch, coreFetch, WebSocket construction, or graphology traversal.
- **AC-51** — An authenticated member can enter and exit Layout Edit Mode from the system recovery menu or Workspace Pack settings. Edit chrome is never rendered over signed-out, expired-session, backend-unavailable, forbidden, or no-repository global states, and leaving with unsaved changes requires explicit discard or save.
- **AC-52** — In Layout Edit Mode, pointer and touch users can pick up an approved region, see only compatible drop positions, reorder it within its dock, or move it to another catalog-approved dock. A successful drop dispatches one move-region operation; an incompatible or cancelled drop dispatches none.
- **AC-53** — Every drag/reorder action has a keyboard equivalent: focus a region handle, enter pickup mode with Space or Enter, traverse compatible targets with Arrow keys or an explicit target list, commit with Space or Enter, and cancel with Escape. Pickup, target, invalidity, drop, and cancellation are announced through accessible status text, and focus returns to the moved region handle.
- **AC-54** — ComponentPalette lists only component versions compatible with the target slot, current pack capabilities, and current role. Selecting a replacement dispatches replace-region-component, preserves the region identity and valid sizing fields, and previews the replacement without evaluating pack-supplied code.
- **AC-55** — A member can hide and restore non-primary pack-controlled regions through a visible hidden-region tray. The only primary region, system recovery surface, and global safety states cannot be hidden, moved, or replaced through editor controls or semantic operations.
- **AC-56** — ThemeTokenEditor exposes a native color control plus a six/eight-digit hex text field and reset action for every allowed color token, and closed selectors for typography, density, and radius. A valid edit updates the preview's semantic CSS variables immediately; no arbitrary CSS property, selector, font URL, or raw style value is accepted.
- **AC-57** — WorkspaceEditorProvider applies each operation through applyWorkspaceEditOperation before updating preview state. Rejected operations leave the previous preview and history byte-equivalent, show path-specific violations next to the originating control, and never reach the renderer or persistent store.
- **AC-58** — The editor maintains a bounded history of the latest 50 accepted operations with undo and redo, clears the redo branch after a new operation, supports discard back to the exact base plus existing personal override, and preserves sensible focus after every history action.
- **AC-59** — Editing a built-in or imported pack never mutates its installed canonical document. Save Personal writes a separately validated override scoped to the exact pack ID/version; Materialize Fork requires a new valid identity, writes a complete canonical fork with derivedFrom, activates it only after success, and leaves the source untouched.
- **AC-60** — A saved personal override participates in resolution after any organization override and before transient region-size/collapse preferences. It is local to the browser/user context, is resettable independently, does not alter canonical export, and becomes shareable only after explicit fork materialization.
- **AC-61** — Dragging, reordering, hiding, replacing, changing theme/default view, undoing, redoing, previewing, saving a personal override, or discarding a draft does not call repositories(), a view loader, nodeOverlay(), providerState(), or create/reconnect a WebSocket. Instrumented behavioral tests prove zero calls for the full visual-editor workflow.
- **AC-62** — Layout Edit Mode and the edit CLI use the exported applyWorkspaceEditOperation/applyWorkspaceEditOperations functions directly. A source/test assertion and cross-client fixtures prove that the same base pack plus ordered operation list yields byte-identical canonical output and violations in browser and Node contexts.
- **AC-63** — apps/web/workspace-packs/pitch/from-default.operations.json contains only WorkspaceEditOperation values. Applying it to the default pack and then applying the documented pitch identity metadata produces a document whose canonical functional fields are identical to the checked-in pitch pack, proving the pitch experience can be made through the visual-edit vocabulary.
- **AC-64** — The visual-editor deployment gate includes passing pointer/touch, keyboard, accessibility, validation, undo/redo, persistence, cross-client reducer, default-parity, pitch-reproduction, no-refetch, web typecheck, web test, and web build checks. The LLM authoring experiment is not run or accepted as evidence until this gate is green.
- **AC-65** — The LLM skill and CLI experiment remain repo-local development tooling: no prompt box, agent endpoint, autonomous authoring loop, background task, credential use, browser import, production route, telemetry claim, or marketplace publication path is added to the product.
- **AC-66** — docs/workspace-pack-llm-rd.md records a fixed task matrix covering layout moves, replacement, hide/show, resize defaults, theme edits, default-view changes, incompatible requests, malicious requests, ambiguous intent, validation repair, and repeat runs. For each case it records expected operations, observed operations/result, validator outcome, human correction required, and reproducibility.
- **AC-67** — The R&D assessment explicitly lists preview/visual-judgment limits, failure patterns, safety findings, unresolved product decisions, and work required for a separately scoped deployable LLM authoring feature. Experimental failure may create follow-up scope but cannot weaken validation, add an executable escape hatch, or block shipping the independently passing visual editor.
- **AC-68** — Layout Edit Mode remains usable at compact, standard, and wide fixture sizes: edit controls do not obscure system recovery or the primary workspace, drop targets remain reachable without precise pointer movement, and a user can complete and save or discard the full workflow using keyboard alone.

## Edge cases

- **EC-1** — The selected pack reference is absent, malformed, not installed, or references an uninstalled version; default activates and recovery explains why.
- **EC-2** — sayre.workspace.json is empty, invalid JSON, an array, null, a primitive, or a non-plain object; parsing fails with a root-path violation and no uncaught exception.
- **EC-3** — A document includes duplicate layout, region, view, component, module, or settings IDs; validation fails rather than resolving first/last wins.
- **EC-4** — A document contains unknown keys at any nesting level; strict parsing rejects them so misspellings cannot silently become ignored configuration.
- **EC-5** — A key or patch path contains __proto__, prototype, constructor, an invalid JSON-pointer escape, an empty interior segment, or excessive nesting; it is rejected without object-prototype mutation.
- **EC-6** — Pack JSON exceeds 256 KiB, has more than 8 layouts, 16 views, 32 regions per layout, 64 inspector modules, 64 settings entries, 64 tags, or an individual string above its documented bound; parsing refuses before expensive resolution.
- **EC-7** — metadata ID, version, author, license, tag, view ID, layout ID, or region ID violates its documented character/length grammar; a path-specific violation names the field.
- **EC-8** — schemaVersion is older/newer than 1, runtime bounds exclude version 1, or required component/capability versions are missing; activation refuses and preserves the last valid/default pack.
- **EC-9** — minimumSize is negative, maximumSize is below minimum, defaultSize is outside bounds, a primary region is collapsible, or resize axis conflicts with its dock; compatibility validation fails.
- **EC-10** — There is no primary region, more than one primary region, no enabled view, a default view that is disabled/missing, or a visibleInViews reference to an unknown view; compatibility validation fails.
- **EC-11** — A component is placed in a disallowed slot, requires a capability absent from the view/pack, or requires a role above the current user; the resolver omits/refuses it according to contract and never renders unauthorized UI.
- **EC-12** — A member imports a pack that attempts to expose provider, MCP, GitHub, or Jira admin components; minimumRole remains catalog-owned and those components are absent.
- **EC-13** — A pack attempts to hide, replace, move, or restyle the system recovery surface or global auth/error states; the field is unknown/unrepresentable and rejected.
- **EC-14** — A color is three-digit hex, five-digit hex, nine-digit hex, named, rgb(), hsl(), var(), url(), contains a semicolon, or contains control characters; it is rejected.
- **EC-15** — A component prop contains a function-shaped string, HTML, CSS, URL, oversized text, or an unknown prop; the component's strict prop parser rejects the pack.
- **EC-16** — A requested custom view names an unknown capability or tries to provide a URL/query; validation refuses rather than producing an empty or client-authorized view.
- **EC-17** — The current graph is empty, loading, unavailable, forbidden, or preparing; pack-selected view chrome does not obscure or replace the system-owned state.
- **EC-18** — Product semantic data is generating, degraded, failed, or contains zero features; the pitch summary provides the same honest state and never fabricates feature content.
- **EC-19** — Onboarding data or workflow is absent while Onboarding view is enabled; existing unavailable behavior remains and the pack cannot synthesize commands.
- **EC-20** — Visible Technical nodes cross the renderer threshold in either direction after resize/expansion; the trusted registry selects the renderer and the pack cannot force an unsupported implementation.
- **EC-21** — A resize begins and the pointer leaves the handle/window, pointercancel fires, the region unmounts due to a view switch, or the pack changes in another tab; capture/listeners clean up and the last valid clamped value persists.
- **EC-22** — A coarse-pointer device operates a resize handle; the target remains at least 44 CSS pixels in the interactive axis without consuming the visible region.
- **EC-23** — prefers-reduced-motion is enabled; pack switching, collapse, drawers, and overlays do not rely on animation and reduce motion to the existing accessibility contract.
- **EC-24** — Collapsing the region that currently owns keyboard focus moves focus to the restore control; removing the whole active pack moves focus to the system recovery menu.
- **EC-25** — At 320 pixels, left/right regions request sizes whose sum exceeds available width; compact behavior deterministically overlays/collapses them and preserves the primary and system recovery controls.
- **EC-26** — Stored user sizes were valid under an older pack version but the same region has new bounds or was removed; values clamp or drop without invalidating the pack.
- **EC-27** — Browser storage is undefined during SSR/hydration, denied by policy, corrupted, or throws on get/set/remove; built-ins remain available and no hydration crash occurs.
- **EC-28** — Browser storage quota is exceeded during install/preferences; the UI reports that persistence failed, keeps the current in-memory valid workspace, and does not claim the pack was installed.
- **EC-29** — Two tabs install or remove packs concurrently; only complete canonical documents become visible after storage events and active-pack removal falls back atomically.
- **EC-30** — Import repeats a built-in ID/version, repeats identical imported content, or repeats the same ID/version with different content; built-ins cannot be shadowed, identical content is idempotent, and conflicting content requires fork/new version.
- **EC-31** — Import provides a newer pack version while an older version is active; both install side-by-side and activation remains pinned until explicit user action.
- **EC-32** — Uninstall targets a built-in, a nonexistent ref, an inactive imported ref, or the active imported ref; the first two are refused/idempotent as documented, inactive removal succeeds, and active removal first activates default.
- **EC-33** — Export is attempted for an absent/incompatible pack or when Blob/download APIs are unavailable; no empty/corrupt file is produced and a useful error is shown.
- **EC-34** — A canonical export is reimported with different object key order or insignificant whitespace; canonical identity/diff remains equivalent.
- **EC-35** — Fork destination already exists, source is absent, new ID/version is invalid, or the target resolves outside the allowed pack root; the CLI refuses without modifying either directory.
- **EC-36** — Patch operations overlap, remove a required field, index outside an array, target metadata.id, or result in incompatibility; the entire patch fails and source bytes remain unchanged.
- **EC-37** — Patch operations are syntactically valid but no-op; dry-run/apply reports an empty changedPaths list and does not rewrite the file merely to change formatting.
- **EC-38** — CLI output is piped and a validation error occurs; --json emits one parseable result object on stdout, diagnostics do not corrupt it, and exit status is non-zero.
- **EC-39** — The LLM requests a novel executable widget, API call, graph computation, custom CSS selector, or remote asset; the authoring skill reports a catalog-extension requirement instead of editing product code.
- **EC-40** — A developer manually edits a built-in pack into an invalid state; build/test validation fails, while a development runtime still uses the compiled default safety document and reports the built-in violation.
- **EC-41** — User preferences refer to a pack version not installed on another coworker's browser; importing the pack reproduces pack composition but intentionally does not reproduce personal sizes/collapse state.
- **EC-42** — A pack changes settings order to include an unknown, duplicate, or role-ineligible section; unknown/duplicate entries fail validation and role-ineligible entries remain absent at runtime.
- **EC-43** — Realtime graph updates arrive during pointer resizing, pack switching, or an open drawer; data refresh does not reset layout preferences, active pack, selected pack version, or an unrelated local draft.
- **EC-44** — Repository/ref/view deep links select a valid node/feature while the pack's default differs; explicit valid URL state wins for repository/ref/view/selection, while the pack supplies defaults only for absent URL state.
- **EC-45** — A valid URL requests a view omitted by the active pack; the runtime selects the pack's default enabled view and recovery reports the unavailable requested view without revealing hidden repository data.
- **EC-46** — Fixture-only packs/scenarios are requested on the live route; fixture data and controls are never imported as a consequence of pack configuration.
- **EC-47** — The pitch pack is used by a member with partial node access; summary counts and content derive only from the already-authorized Product response and never imply hidden files/features.
- **EC-48** — Component rendering throws despite successful contract validation; the existing/current-ticket local error boundary behavior must preserve system recovery and pack reset rather than leave a blank page. If origin/main lacks the necessary local boundary during implementation, Dev adds it inside WorkspaceShell without expanding into unrelated application-wide error telemetry.
- **EC-49** — A pack contains a valid but empty description/author/tag after trimming or visually deceptive control characters; parsing rejects empty/control-character values.
- **EC-50** — Product build runs without browser globals while compiling built-in packs; shared parse/resolve code does not access window, document, localStorage, crypto, filesystem, or network at module initialization.
- **EC-51** — A pointer/touch drop targets a disallowed slot, an out-of-range order, the source's current position, or a target that became incompatible during the gesture; the controller cancels or reports the reason, dispatches no invalid mutation, and preserves source order.
- **EC-52** — A hide or move operation would leave no visible primary region, hide the sole primary, target system recovery/global state, or place a second region into the primary slot; semantic validation rejects it and the editor does not offer the action.
- **EC-53** — Pointer capture is lost, pointercancel fires, Escape is pressed, the pointer is released outside all targets, the source unmounts, or Layout Edit Mode exits during drag; listeners/overlays clean up, no operation is appended, and focus returns to a stable editor control.
- **EC-54** — A keyboard move encounters an empty compatible-target list, disabled target, compact-layout target that is currently overlaid, or target that disappears after pickup; the live region announces the condition and cancellation remains available without trapping focus.
- **EC-55** — The current role or available capability changes while a palette or drag is open; targets and replacements are recalculated, newly unauthorized choices disappear, and any now-invalid pending action is cancelled before preview.
- **EC-56** — The active pack, layout, view, viewport class, or pack version changes during an edit gesture; the gesture cancels. A pack/version change with a dirty draft requires explicit discard or save rather than silently rebasing operations onto a different base.
- **EC-57** — Storage is unavailable, denied, corrupt, or quota-exceeded when Save Personal runs; the validated in-memory preview remains visible but dirty, the UI reports that persistence did not occur, and no successful-save state is shown.
- **EC-58** — Another tab changes or resets the same personal override while the current tab has a dirty draft; the editor does not overwrite silently, reports the exact base revision conflict, and requires discard/reload or materialize-as-fork.
- **EC-59** — Catalog/runtime versions change after a draft begins so a component or capability is no longer compatible; the next operation, save, and materialization all revalidate the whole preview, keep the installed base untouched, and identify the stale reference.
- **EC-60** — A user is midway through typing an empty, three-digit, five-digit, malformed, or otherwise incomplete hex value; the text control may retain the local input state, but no set-theme-color operation or preview update occurs until the complete value validates. Blur reports the violation or restores the last valid value.
- **EC-61** — A selected region has no compatible replacement beyond its current component; ComponentPalette shows an explicit no-compatible-alternatives state, never offers an unknown entry, and leaves drag/hide/resize actions independently usable when allowed.
- **EC-62** — A user hides the region that contains focus or currently owns an open drawer/palette; focus moves to that region's restore control in the hidden-region tray, transient child UI closes, and restoring returns focus to the region handle rather than stale content.
- **EC-63** — Undo or redo would restore a component that became unavailable because role, capability, or catalog state changed; revalidation refuses that history transition, explains why, and offers discard/reload without rendering the stale component.
- **EC-64** — A user starts editing a built-in/imported pack and then cancels the save/fork identity dialog; no installed document, personal override, active reference, or export content changes, and the draft remains available until explicitly discarded or saved.
- **EC-65** — An operation list contains a missing layout/region/view ID, duplicate logical move, non-finite size, invalid token/value pairing, excess operation count, or a component reference that is syntactically valid but incompatible; the entire ordered batch fails atomically with the original pack returned.
- **EC-66** — Materialize Fork is attempted with an existing destination, invalid identity/version, stale base, or storage failure; no partial fork is registered or activated, the base and personal override remain intact, and the draft stays recoverable.
- **EC-67** — The experimental LLM emits raw JSON Patch, a made-up semantic operation, a valid operation against an unavailable target, or instructions to edit product code; the skill/CLI refuses the fallback, records the case in the R&D assessment, and requires a human-authored follow-up or catalog-extension proposal.
- **EC-68** — Repeating the same LLM task produces materially different or order-dependent operations even though all outputs validate; the assessment records the variance and does not characterize the workflow as deployable merely because individual outputs pass schema validation.

## Open questions

No blocking open questions remain for this spec-only draft.

The following decisions are intentionally fixed for review because changing any one would materially alter the implementation:

1. **Marketplace boundary:** this ticket delivers the portable, versioned, locally importable/exportable artifact and compatibility model, not the hosted marketplace service. Coworker sharing is file-based in this ticket.
2. **Trust boundary:** transferable packs are declarative and code-free. New executable React elements enter the trusted component catalog only through a separate normal code review/pipeline path; public arbitrary-code packs are not an accepted future shortcut.
3. **Deployment order:** the constrained visual editor and portable pack runtime are the production target and must independently pass their deployment gate first. LLM authoring is a subsequent, repo-local R&D evaluation; customer-facing or autonomous LLM authoring requires its own spec after the evidence in docs/workspace-pack-llm-rd.md is reviewed.
4. **Experimental authoring runtime:** the source procedure is runtime-neutral and the deterministic semantic-edit CLI is the experiment's real tool boundary. This ticket adds a thin Claude skill because Claude Skills are the transferability analogy and an immediate test surface; other runtimes consume the same guide/CLI rather than receiving copied methodology.
5. **Naming:** Workspace Pack, schema version 1, WorkspaceEditOperation, and the sayre.workspace.json filename become public compatibility terms if this spec proceeds. Rename them now during review, not after marketplace consumers exist.

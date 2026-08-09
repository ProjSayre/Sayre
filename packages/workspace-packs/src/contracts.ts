export const WORKSPACE_PACK_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_RUNTIME_CONTRACT_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };
export type WorkspacePackId = string;
export type WorkspaceViewId = string;
export type WorkspaceCapabilityId = string;
export type WorkspaceComponentId = string;
export type WorkspaceSlotId = 'top' | 'navigation' | 'explorer' | 'primary' | 'inspector' | 'bottom' | 'overlay';
export type WorkspaceHexColor = string;
export type WorkspaceFontChoice = 'sayre-grotesk' | 'system-sans' | 'system-mono';
export type WorkspaceDensity = 'compact' | 'comfortable' | 'presentation';
export type WorkspaceRadiusScale = 'square' | 'subtle' | 'rounded';
export type WorkspaceResizeAxis = 'horizontal' | 'vertical' | 'none';
export type WorkspaceRole = 'member' | 'admin' | 'owner';

export interface WorkspacePackRef { id: WorkspacePackId; version: string }
export interface WorkspaceComponentRef { id: WorkspaceComponentId; version: number; props?: Readonly<Record<string, JsonValue>> }
export interface WorkspacePackMetadata {
  id: WorkspacePackId; name: string; version: string; description: string; author: string;
  license: string; tags: readonly string[]; derivedFrom: WorkspacePackRef | null;
}
export interface WorkspacePackCompatibility {
  schemaVersion: 1; minimumRuntimeContractVersion: number; maximumRuntimeContractVersion: number | null;
  requiredComponents: readonly WorkspaceComponentRef[]; requiredCapabilities: readonly WorkspaceCapabilityId[];
}
export interface WorkspaceThemeTokens {
  colors: {
    canvas: WorkspaceHexColor; raised: WorkspaceHexColor; hover: WorkspaceHexColor;
    border: WorkspaceHexColor; borderStrong: WorkspaceHexColor; edge: WorkspaceHexColor;
    node: WorkspaceHexColor; textFaint: WorkspaceHexColor; textMuted: WorkspaceHexColor;
    text: WorkspaceHexColor; textStrong: WorkspaceHexColor; accent: WorkspaceHexColor;
    accentText: WorkspaceHexColor; accentContent: WorkspaceHexColor; warning: WorkspaceHexColor;
    danger: WorkspaceHexColor;
  };
  typography: { ui: WorkspaceFontChoice; mono: WorkspaceFontChoice };
  density: WorkspaceDensity;
  radius: WorkspaceRadiusScale;
}
export interface WorkspaceRegionSpec {
  id: string; slot: WorkspaceSlotId; component: WorkspaceComponentRef; order: number; hidden: boolean;
  defaultSize: number; minimumSize: number; maximumSize: number; resize: WorkspaceResizeAxis;
  collapsible: boolean; defaultCollapsed: boolean; visibleInViews: readonly WorkspaceViewId[] | null;
  compactBehavior: 'keep' | 'overlay' | 'collapse';
}
export interface WorkspaceLayoutSpec { id: string; regions: readonly WorkspaceRegionSpec[] }
export interface WorkspaceViewSpec {
  id: WorkspaceViewId; label: string; glyph: string; hint: string; capability: WorkspaceCapabilityId;
  surface: WorkspaceComponentRef; toolbar: readonly WorkspaceComponentRef[];
  inspectorModules: readonly WorkspaceComponentRef[]; enabled: boolean;
}
export interface WorkspacePackDocument {
  schemaVersion: 1; metadata: WorkspacePackMetadata; compatibility: WorkspacePackCompatibility;
  theme: WorkspaceThemeTokens; defaultLayoutId: string; defaultViewId: WorkspaceViewId;
  layouts: readonly WorkspaceLayoutSpec[]; views: readonly WorkspaceViewSpec[]; settingsOrder: readonly string[];
}
export interface ResolvedWorkspaceRegion extends WorkspaceRegionSpec { size: number; collapsed: boolean }
export interface ResolvedWorkspaceLayout { id: string; regions: readonly ResolvedWorkspaceRegion[] }
export interface ResolvedWorkspaceView extends WorkspaceViewSpec { available: boolean; unavailableReason: string | null }
export interface WorkspacePackViolation { code: string; path: string; message: string }
export type WorkspacePackValidationResult =
  | { ok: true; pack: WorkspacePackDocument; warnings: readonly WorkspacePackViolation[] }
  | { ok: false; violations: readonly WorkspacePackViolation[] };

export interface WorkspaceComponentContract<Props extends JsonObject = JsonObject> {
  id: WorkspaceComponentId; version: number; allowedSlots: readonly WorkspaceSlotId[];
  requiredCapabilities: readonly WorkspaceCapabilityId[]; minimumRole: WorkspaceRole | null;
  parseProps(value: unknown): Props;
}
export interface WorkspaceComponentCatalogContract {
  runtimeContractVersion: number;
  components: readonly Omit<WorkspaceComponentContract, 'parseProps'>[];
  capabilities: readonly { id: WorkspaceCapabilityId; version: number }[];
}
export interface WorkspaceUserPreferences {
  pack: WorkspacePackRef; layoutId: string; regionSizes: Readonly<Record<string, number>>;
  collapsedRegionIds: readonly string[]; updatedAt: string;
}
export interface WorkspacePackOverride {
  theme?: Partial<WorkspaceThemeTokens>; defaultLayoutId?: string; defaultViewId?: WorkspaceViewId;
  layouts?: readonly WorkspaceLayoutSpec[]; views?: readonly WorkspaceViewSpec[];
}
export interface ResolveWorkspacePackInput {
  safetyDefaults: WorkspacePackDocument; selectedPack: WorkspacePackDocument | null;
  organizationOverride: WorkspacePackOverride | null; userOverride: WorkspacePackOverride | null;
  userPreferences: WorkspaceUserPreferences | null; catalog: WorkspaceComponentCatalogContract;
  viewportClass: 'compact' | 'standard' | 'wide'; role: WorkspaceRole;
}
export interface ResolvedWorkspaceExperience {
  pack: WorkspacePackRef; theme: WorkspaceThemeTokens; layout: ResolvedWorkspaceLayout;
  views: readonly ResolvedWorkspaceView[]; defaultViewId: WorkspaceViewId;
  warnings: readonly WorkspacePackViolation[]; usedSafetyFallback: boolean;
}
export type WorkspaceThemeColorToken = keyof WorkspaceThemeTokens['colors'];
export type WorkspaceEditOperation =
  | { type: 'move-region'; layoutId: string; regionId: string; slot: WorkspaceSlotId; order: number }
  | { type: 'set-region-hidden'; layoutId: string; regionId: string; hidden: boolean }
  | { type: 'replace-region-component'; layoutId: string; regionId: string; component: WorkspaceComponentRef }
  | { type: 'resize-region-default'; layoutId: string; regionId: string; size: number }
  | { type: 'set-region-default-collapsed'; layoutId: string; regionId: string; collapsed: boolean }
  | { type: 'set-theme-color'; token: WorkspaceThemeColorToken; value: WorkspaceHexColor }
  | { type: 'set-theme-choice'; token: 'typography.ui' | 'typography.mono'; value: WorkspaceFontChoice }
  | { type: 'set-theme-choice'; token: 'density'; value: WorkspaceDensity }
  | { type: 'set-theme-choice'; token: 'radius'; value: WorkspaceRadiusScale }
  | { type: 'set-default-view'; viewId: WorkspaceViewId };
export interface WorkspaceEditContext {
  catalog: WorkspaceComponentCatalogContract; role: WorkspaceRole;
  availableCapabilities: readonly WorkspaceCapabilityId[];
}
export type WorkspacePackEditResult =
  | { ok: true; pack: WorkspacePackDocument; changedPaths: readonly string[] }
  | { ok: false; pack: WorkspacePackDocument; violations: readonly WorkspacePackViolation[] };
export type WorkspacePackPatchOperation =
  | { op: 'add'; path: string; value: JsonValue }
  | { op: 'replace'; path: string; value: JsonValue }
  | { op: 'remove'; path: string };
export interface WorkspacePackPatchResult { pack: WorkspacePackDocument; changedPaths: readonly string[]; canonicalJson: string }
export interface WorkspacePackDiffEntry { path: string; before: JsonValue | undefined; after: JsonValue | undefined }
export interface InstalledWorkspacePack {
  ref: WorkspacePackRef;
  source: 'builtin' | 'imported' | 'forked';
  installedAt: string;
  pack: WorkspacePackDocument;
}

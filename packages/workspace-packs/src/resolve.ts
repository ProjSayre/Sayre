import type {
  ResolveWorkspacePackInput,
  ResolvedWorkspaceExperience,
  WorkspacePackDocument,
  WorkspacePackOverride,
  WorkspaceRegionSpec,
  WorkspaceThemeTokens,
} from './contracts';
import { roleAllows, validateWorkspacePackCompatibility } from './parse';

function mergeTheme(base: WorkspaceThemeTokens, override: Partial<WorkspaceThemeTokens> | undefined): WorkspaceThemeTokens {
  if (override === undefined) return structuredClone(base);
  return {
    colors: { ...base.colors, ...(override.colors ?? {}) },
    typography: { ...base.typography, ...(override.typography ?? {}) },
    density: override.density ?? base.density,
    radius: override.radius ?? base.radius,
  };
}

function applyOverride(pack: WorkspacePackDocument, override: WorkspacePackOverride | null): WorkspacePackDocument {
  if (override === null) return structuredClone(pack);
  return {
    ...structuredClone(pack),
    theme: mergeTheme(pack.theme, override.theme),
    defaultLayoutId: override.defaultLayoutId ?? pack.defaultLayoutId,
    defaultViewId: override.defaultViewId ?? pack.defaultViewId,
    layouts: override.layouts ? structuredClone(override.layouts) : structuredClone(pack.layouts),
    views: override.views ? structuredClone(override.views) : structuredClone(pack.views),
  };
}

function compactRegion(region: WorkspaceRegionSpec, viewportClass: ResolveWorkspacePackInput['viewportClass']): { hidden: boolean; collapsed: boolean } {
  if (viewportClass !== 'compact') return { hidden: region.hidden, collapsed: region.defaultCollapsed };
  if (region.compactBehavior === 'collapse' && region.slot !== 'primary') return { hidden: region.hidden, collapsed: true };
  return { hidden: region.hidden, collapsed: region.defaultCollapsed };
}

export function resolveWorkspaceExperience(input: ResolveWorkspacePackInput): ResolvedWorkspaceExperience {
  const selected = input.selectedPack ?? input.safetyDefaults;
  const compatibility = validateWorkspacePackCompatibility(selected, input.catalog);
  const usedSafetyFallback = !compatibility.ok;
  let pack = usedSafetyFallback ? structuredClone(input.safetyDefaults) : structuredClone(selected);
  pack = applyOverride(pack, input.organizationOverride);
  pack = applyOverride(pack, input.userOverride);
  const postOverride = validateWorkspacePackCompatibility(pack, input.catalog);
  if (!postOverride.ok) pack = structuredClone(input.safetyDefaults);
  const componentMap = new Map(input.catalog.components.map((item) => [`${item.id}@${item.version}`, item]));
  const initialWarnings = !compatibility.ok
    ? compatibility.violations
    : !postOverride.ok
      ? postOverride.violations
      : [];
  const materialize = (document: WorkspacePackDocument) => {
    const availableCapabilities = new Set(input.catalog.capabilities.map((item) => item.id));
    const layout = document.layouts.find((item) => item.id === document.defaultLayoutId) ?? document.layouts[0]!;
    const preferences = input.userPreferences;
    const preferenceMatches = preferences?.pack.id === document.metadata.id && preferences.pack.version === document.metadata.version && preferences.layoutId === layout.id;
    const regionSizes = preferenceMatches && preferences !== null
      ? preferences.regionSizes : {};
    const collapsed = new Set(preferenceMatches && preferences !== null
      ? preferences.collapsedRegionIds : []);
    const regions = layout.regions
      .filter((region) => {
        const component = componentMap.get(`${region.component.id}@${region.component.version}`);
        return component !== undefined && roleAllows(input.role, component.minimumRole);
      })
      .map((region) => {
        const compact = compactRegion(region, input.viewportClass);
        const requested = regionSizes[region.id] ?? region.defaultSize;
        return {
          ...region,
          hidden: compact.hidden,
          size: Math.min(region.maximumSize, Math.max(region.minimumSize, Number.isFinite(requested) ? requested : region.defaultSize)),
          collapsed: region.slot === 'primary' ? false : (collapsed.has(region.id) || compact.collapsed),
        };
      });
    const views = document.views.map((view) => ({
      ...view,
      available: view.enabled && availableCapabilities.has(view.capability),
      unavailableReason: availableCapabilities.has(view.capability) ? null : 'Capability unavailable',
    }));
    const defaultView = views.find((view) => view.id === document.defaultViewId && view.available) ?? views.find((view) => view.available) ?? null;
    return { layout, regions, views, defaultView };
  };

  let resolved = materialize(pack);
  const structurallyUsable = resolved.regions.filter((region) => region.slot === 'primary' && !region.hidden).length === 1 && resolved.defaultView !== null;
  const warnings = [...initialWarnings];
  if (!structurallyUsable) {
    warnings.push({ code: 'unusable-for-role', path: '', message: 'Selected pack has no role-allowed primary region or available view.' });
    pack = structuredClone(input.safetyDefaults);
    resolved = materialize(pack);
  }
  if (resolved.defaultView === null) throw new Error('Workspace safety defaults do not provide an available view.');
  return {
    pack: { id: pack.metadata.id, version: pack.metadata.version },
    theme: structuredClone(pack.theme),
    layout: { id: resolved.layout.id, regions: resolved.regions },
    views: resolved.views,
    defaultViewId: resolved.defaultView.id,
    warnings,
    usedSafetyFallback: usedSafetyFallback || !postOverride.ok || !structurallyUsable,
  };
}

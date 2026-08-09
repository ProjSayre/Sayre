import {
  COMPONENT_ID,
  CONTROL_CHARACTER,
  HEX_COLOR,
  SEMVER,
  UNSAFE_KEY,
  WORKSPACE_ID,
  WORKSPACE_PACK_LIMITS,
} from './limits';
import type {
  JsonObject,
  WorkspaceComponentCatalogContract,
  WorkspaceComponentRef,
  WorkspacePackDocument,
  WorkspacePackValidationResult,
  WorkspacePackViolation,
  WorkspaceRegionSpec,
  WorkspaceRole,
} from './contracts';

const ROOT_KEYS = ['schemaVersion', 'metadata', 'compatibility', 'theme', 'defaultLayoutId', 'defaultViewId', 'layouts', 'views', 'settingsOrder'] as const;
const METADATA_KEYS = ['id', 'name', 'version', 'description', 'author', 'license', 'tags', 'derivedFrom'] as const;
const COMPATIBILITY_KEYS = ['schemaVersion', 'minimumRuntimeContractVersion', 'maximumRuntimeContractVersion', 'requiredComponents', 'requiredCapabilities'] as const;
const THEME_KEYS = ['colors', 'typography', 'density', 'radius'] as const;
const COLOR_KEYS = ['canvas', 'raised', 'hover', 'border', 'borderStrong', 'edge', 'node', 'textFaint', 'textMuted', 'text', 'textStrong', 'accent', 'accentText', 'accentContent', 'warning', 'danger'] as const;
const REGION_KEYS = ['id', 'slot', 'component', 'order', 'hidden', 'defaultSize', 'minimumSize', 'maximumSize', 'resize', 'collapsible', 'defaultCollapsed', 'visibleInViews', 'compactBehavior'] as const;
const VIEW_KEYS = ['id', 'label', 'glyph', 'hint', 'capability', 'surface', 'toolbar', 'inspectorModules', 'enabled'] as const;
const COMPONENT_REF_KEYS = ['id', 'version', 'props'] as const;
const SLOTS = new Set(['top', 'navigation', 'explorer', 'primary', 'inspector', 'bottom', 'overlay']);
const ROLES: Record<WorkspaceRole, number> = { member: 0, admin: 1, owner: 2 };

function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function violation(code: string, path: string, message: string): WorkspacePackViolation {
  return { code, path, message };
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, out: WorkspacePackViolation[]): void {
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEY.test(key)) out.push(violation('unsafe-key', `${path}/${key}`, 'Unsafe property name.'));
    else if (!allowed.includes(key)) out.push(violation('unknown-key', `${path}/${key}`, 'Unknown property.'));
  }
}

function stringField(value: unknown, path: string, out: WorkspacePackViolation[], minimum: number, maximum: number): value is string {
  if (typeof value !== 'string' || value.trim().length < minimum || value.trim().length > maximum || CONTROL_CHARACTER.test(value)) {
    out.push(violation('invalid-string', path, `Expected a trimmed ${minimum}-${maximum} character string.`));
    return false;
  }
  return true;
}

function idField(value: unknown, path: string, out: WorkspacePackViolation[], component = false): value is string {
  if (typeof value !== 'string' || !(component ? COMPONENT_ID : WORKSPACE_ID).test(value)) {
    out.push(violation('invalid-id', path, 'Invalid identifier.'));
    return false;
  }
  return true;
}

function componentRef(value: unknown, path: string, out: WorkspacePackViolation[]): value is WorkspaceComponentRef {
  if (!plain(value)) { out.push(violation('invalid-component', path, 'Expected a component reference.')); return false; }
  unknownKeys(value, COMPONENT_REF_KEYS, path, out);
  idField(value.id, `${path}/id`, out, true);
  if (!Number.isInteger(value.version) || Number(value.version) < 1) out.push(violation('invalid-version', `${path}/version`, 'Component version must be a positive integer.'));
  if (value.props !== undefined) {
    if (!plain(value.props) || Object.keys(value.props).length > WORKSPACE_PACK_LIMITS.propKeys) out.push(violation('invalid-props', `${path}/props`, 'Component props must be a bounded object.'));
  }
  return out.length === 0;
}

function componentPropKeyCount(value: Record<string, unknown>): number {
  const countRef = (ref: unknown): number => plain(ref) && plain(ref.props) ? Object.keys(ref.props).length : 0;
  const compatibility = plain(value.compatibility) ? value.compatibility : null;
  const layouts = Array.isArray(value.layouts) ? value.layouts : [];
  const views = Array.isArray(value.views) ? value.views : [];
  return (Array.isArray(compatibility?.requiredComponents) ? compatibility.requiredComponents : []).reduce<number>((total, ref) => total + countRef(ref), 0)
    + layouts.reduce<number>((total, layout) => total + (plain(layout) && Array.isArray(layout.regions)
      ? layout.regions.reduce<number>((regionTotal, region) => regionTotal + (plain(region) ? countRef(region.component) : 0), 0)
      : 0), 0)
    + views.reduce<number>((total, view) => {
      if (!plain(view)) return total;
      return total + countRef(view.surface)
        + (Array.isArray(view.toolbar) ? view.toolbar.reduce<number>((sum, ref) => sum + countRef(ref), 0) : 0)
        + (Array.isArray(view.inspectorModules) ? view.inspectorModules.reduce<number>((sum, ref) => sum + countRef(ref), 0) : 0);
    }, 0);
}

function maximumDepth(value: unknown, depth = 0, seen = new WeakSet<object>()): number {
  if (value === null || typeof value !== 'object') return depth;
  if (seen.has(value)) return Number.POSITIVE_INFINITY;
  seen.add(value);
  const result = Math.max(depth, ...Object.values(value).map((child) => maximumDepth(child, depth + 1, seen)));
  seen.delete(value);
  return result;
}

const UNSAFE_STRING = /(?:<\/?[a-z][^>]*>|(?:https?|data|javascript|file|module):|url\s*\(|\b(?:eval|Function|fetch|require|import|WebSocket)\s*\(|\bon[a-z]+\s*=|\b(?:style|src|href)\s*=|\/(?:api|graphql)\/|\b(?:authorization|bearer|password|secret|api[_-]?key)\s*[:=]|\b(?:query|mutation)\s*\{)/i;

function inspectSafeJson(
  value: unknown,
  path: string,
  out: WorkspacePackViolation[],
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(violation('invalid-json-value', path, 'Numbers must be finite.'));
    return;
  }
  if (typeof value === 'string') {
    if (CONTROL_CHARACTER.test(value)) out.push(violation('control-character', path, 'Control characters are not allowed.'));
    if (UNSAFE_STRING.test(value)) out.push(violation('unsafe-value', path, 'Executable, markup, CSS, URL, API, or credential-like content is not allowed.'));
    if (value.length > 2_000) out.push(violation('string-too-long', path, 'String exceeds the maximum component value length.'));
    return;
  }
  if (typeof value !== 'object') {
    out.push(violation('invalid-json-value', path, 'Only JSON values are accepted.'));
    return;
  }
  if (seen.has(value)) {
    out.push(violation('cyclic-value', path, 'Cyclic objects are not accepted.'));
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => inspectSafeJson(item, `${path}/${index}`, out, seen));
  else if (!plain(value)) out.push(violation('non-plain-object', path, 'Only plain JSON objects are accepted.'));
  else {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (UNSAFE_KEY.test(key)) out.push(violation('unsafe-key', childPath, 'Unsafe property name.'));
      inspectSafeJson(child, childPath, out, seen);
    }
  }
  seen.delete(value);
}

function duplicateIds(items: unknown[], path: string, out: WorkspacePackViolation[]): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (!plain(item) || typeof item.id !== 'string') return;
    if (seen.has(item.id)) out.push(violation('duplicate-id', `${path}/${index}/id`, `Duplicate identifier ${item.id}.`));
    seen.add(item.id);
  });
}

function validateRegion(region: unknown, path: string, out: WorkspacePackViolation[]): region is WorkspaceRegionSpec {
  if (!plain(region)) { out.push(violation('invalid-region', path, 'Expected a region object.')); return false; }
  unknownKeys(region, REGION_KEYS, path, out);
  idField(region.id, `${path}/id`, out);
  if (!SLOTS.has(String(region.slot))) out.push(violation('invalid-slot', `${path}/slot`, 'Unknown slot.'));
  componentRef(region.component, `${path}/component`, out);
  if (!Number.isInteger(region.order) || Number(region.order) < 0) out.push(violation('invalid-order', `${path}/order`, 'Order must be a non-negative integer.'));
  if (typeof region.hidden !== 'boolean') out.push(violation('invalid-hidden', `${path}/hidden`, 'hidden must be boolean.'));
  for (const key of ['defaultSize', 'minimumSize', 'maximumSize'] as const) if (!Number.isFinite(region[key]) || Number(region[key]) < 0) out.push(violation('invalid-size', `${path}/${key}`, 'Size must be finite and non-negative.'));
  if (Number(region.maximumSize) < Number(region.minimumSize) || Number(region.defaultSize) < Number(region.minimumSize) || Number(region.defaultSize) > Number(region.maximumSize)) out.push(violation('invalid-bounds', path, 'Region size bounds are inconsistent.'));
  if (!['horizontal', 'vertical', 'none'].includes(String(region.resize))) out.push(violation('invalid-resize', `${path}/resize`, 'Invalid resize axis.'));
  if (typeof region.collapsible !== 'boolean' || typeof region.defaultCollapsed !== 'boolean') out.push(violation('invalid-collapse', path, 'Collapse fields must be boolean.'));
  if (region.slot === 'primary' && (region.collapsible || region.defaultCollapsed || region.hidden)) out.push(violation('primary-required', path, 'Primary region must stay visible and expanded.'));
  if (region.visibleInViews !== null && (!Array.isArray(region.visibleInViews) || !region.visibleInViews.every((id) => typeof id === 'string'))) out.push(violation('invalid-views', `${path}/visibleInViews`, 'Expected null or view ID list.'));
  if (!['keep', 'overlay', 'collapse'].includes(String(region.compactBehavior))) out.push(violation('invalid-compact', `${path}/compactBehavior`, 'Invalid compact behavior.'));
  return true;
}

export function parseWorkspacePack(value: unknown): WorkspacePackValidationResult {
  const out: WorkspacePackViolation[] = [];
  if (!plain(value)) return { ok: false, violations: [violation('invalid-root', '', 'Expected a plain Workspace Pack object.')] };
  let rawSize = Number.POSITIVE_INFINITY;
  try { rawSize = new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { /* reported below */ }
  if (rawSize > WORKSPACE_PACK_LIMITS.bytes) out.push(violation('document-too-large', '', 'Workspace Pack exceeds 256 KiB.'));
  if (maximumDepth(value) > WORKSPACE_PACK_LIMITS.depth) out.push(violation('document-too-deep', '', 'Workspace Pack exceeds maximum nesting depth.'));
  inspectSafeJson(value, '', out);
  unknownKeys(value, ROOT_KEYS, '', out);
  if (componentPropKeyCount(value) > WORKSPACE_PACK_LIMITS.propKeys) {
    out.push(violation('component-prop-limit', '', `Workspace Pack may contain at most ${WORKSPACE_PACK_LIMITS.propKeys} component-prop keys across the document.`));
  }
  if (value.schemaVersion !== 1) out.push(violation('schema-version', '/schemaVersion', 'Only schema version 1 is supported.'));

  if (!plain(value.metadata)) out.push(violation('metadata', '/metadata', 'Expected metadata.'));
  else {
    unknownKeys(value.metadata, METADATA_KEYS, '/metadata', out);
    idField(value.metadata.id, '/metadata/id', out);
    for (const [key, min, max] of [['name', 1, 80], ['description', 1, 500], ['author', 1, 100], ['license', 1, 64]] as const) stringField(value.metadata[key], `/metadata/${key}`, out, min, max);
    if (typeof value.metadata.version !== 'string' || !SEMVER.test(value.metadata.version)) out.push(violation('invalid-version', '/metadata/version', 'Invalid semantic version.'));
    if (!Array.isArray(value.metadata.tags) || value.metadata.tags.length > WORKSPACE_PACK_LIMITS.tags) out.push(violation('invalid-tags', '/metadata/tags', 'Invalid tags.'));
    else value.metadata.tags.forEach((tag, index) => stringField(tag, `/metadata/tags/${index}`, out, 1, 32));
    if (value.metadata.derivedFrom !== null) {
      if (!plain(value.metadata.derivedFrom)) out.push(violation('invalid-derived-from', '/metadata/derivedFrom', 'Expected null or pack ref.'));
      else {
        unknownKeys(value.metadata.derivedFrom, ['id', 'version'], '/metadata/derivedFrom', out);
        idField(value.metadata.derivedFrom.id, '/metadata/derivedFrom/id', out);
        if (typeof value.metadata.derivedFrom.version !== 'string' || !SEMVER.test(value.metadata.derivedFrom.version)) out.push(violation('invalid-version', '/metadata/derivedFrom/version', 'Invalid semantic version.'));
      }
    }
  }

  if (!plain(value.compatibility)) out.push(violation('compatibility', '/compatibility', 'Expected compatibility.'));
  else {
    unknownKeys(value.compatibility, COMPATIBILITY_KEYS, '/compatibility', out);
    if (value.compatibility.schemaVersion !== 1) out.push(violation('schema-version', '/compatibility/schemaVersion', 'Only schema version 1 is supported.'));
    if (!Number.isInteger(value.compatibility.minimumRuntimeContractVersion)) out.push(violation('runtime-version', '/compatibility/minimumRuntimeContractVersion', 'Expected integer.'));
    if (value.compatibility.maximumRuntimeContractVersion !== null && !Number.isInteger(value.compatibility.maximumRuntimeContractVersion)) out.push(violation('runtime-version', '/compatibility/maximumRuntimeContractVersion', 'Expected integer or null.'));
    if (!Array.isArray(value.compatibility.requiredComponents)) out.push(violation('required-components', '/compatibility/requiredComponents', 'Expected list.'));
    else {
      value.compatibility.requiredComponents.forEach((ref, index) => componentRef(ref, `/compatibility/requiredComponents/${index}`, out));
      const seen = new Set<string>();
      value.compatibility.requiredComponents.forEach((ref, index) => {
        if (!plain(ref) || typeof ref.id !== 'string' || typeof ref.version !== 'number') return;
        const key = `${ref.id}@${ref.version}`;
        if (seen.has(key)) out.push(violation('duplicate-component', `/compatibility/requiredComponents/${index}`, 'Duplicate component reference.'));
        seen.add(key);
      });
    }
    if (!Array.isArray(value.compatibility.requiredCapabilities)) out.push(violation('required-capabilities', '/compatibility/requiredCapabilities', 'Expected list.'));
    else {
      value.compatibility.requiredCapabilities.forEach((id, index) => idField(id, `/compatibility/requiredCapabilities/${index}`, out, true));
      duplicateIds(value.compatibility.requiredCapabilities.map((id) => ({ id })), '/compatibility/requiredCapabilities', out);
    }
  }

  if (!plain(value.theme)) out.push(violation('theme', '/theme', 'Expected theme.'));
  else {
    unknownKeys(value.theme, THEME_KEYS, '/theme', out);
    if (!plain(value.theme.colors)) out.push(violation('colors', '/theme/colors', 'Expected colors.'));
    else {
      unknownKeys(value.theme.colors, COLOR_KEYS, '/theme/colors', out);
      for (const key of COLOR_KEYS) if (typeof value.theme.colors[key] !== 'string' || !HEX_COLOR.test(value.theme.colors[key])) out.push(violation('invalid-color', `/theme/colors/${key}`, 'Expected six/eight-digit hex color.'));
    }
    if (!plain(value.theme.typography)) out.push(violation('typography', '/theme/typography', 'Expected typography.'));
    else {
      unknownKeys(value.theme.typography, ['ui', 'mono'], '/theme/typography', out);
      for (const key of ['ui', 'mono']) if (!['sayre-grotesk', 'system-sans', 'system-mono'].includes(String(value.theme.typography[key]))) out.push(violation('invalid-font', `/theme/typography/${key}`, 'Unsupported font choice.'));
    }
    if (!['compact', 'comfortable', 'presentation'].includes(String(value.theme.density))) out.push(violation('invalid-density', '/theme/density', 'Unsupported density.'));
    if (!['square', 'subtle', 'rounded'].includes(String(value.theme.radius))) out.push(violation('invalid-radius', '/theme/radius', 'Unsupported radius.'));
  }

  idField(value.defaultLayoutId, '/defaultLayoutId', out);
  idField(value.defaultViewId, '/defaultViewId', out);
  if (!Array.isArray(value.layouts) || value.layouts.length < 1 || value.layouts.length > WORKSPACE_PACK_LIMITS.layouts) out.push(violation('layouts', '/layouts', 'Expected 1-8 layouts.'));
  else {
    duplicateIds(value.layouts, '/layouts', out);
    value.layouts.forEach((layout, index) => {
      const path = `/layouts/${index}`;
      if (!plain(layout)) { out.push(violation('layout', path, 'Expected layout.')); return; }
      unknownKeys(layout, ['id', 'regions'], path, out);
      idField(layout.id, `${path}/id`, out);
      if (!Array.isArray(layout.regions) || layout.regions.length > WORKSPACE_PACK_LIMITS.regions) out.push(violation('regions', `${path}/regions`, 'Expected at most 32 regions.'));
      else { duplicateIds(layout.regions, `${path}/regions`, out); layout.regions.forEach((region, regionIndex) => validateRegion(region, `${path}/regions/${regionIndex}`, out)); }
    });
  }
  if (!Array.isArray(value.views) || value.views.length < 1 || value.views.length > WORKSPACE_PACK_LIMITS.views) out.push(violation('views', '/views', 'Expected 1-16 views.'));
  else {
    duplicateIds(value.views, '/views', out);
    value.views.forEach((view, index) => {
      const path = `/views/${index}`;
      if (!plain(view)) { out.push(violation('view', path, 'Expected view.')); return; }
      unknownKeys(view, VIEW_KEYS, path, out);
      idField(view.id, `${path}/id`, out);
      stringField(view.label, `${path}/label`, out, 1, 80);
      stringField(view.glyph, `${path}/glyph`, out, 1, 80);
      stringField(view.hint, `${path}/hint`, out, 1, 500);
      idField(view.capability, `${path}/capability`, out, true);
      componentRef(view.surface, `${path}/surface`, out);
      for (const key of ['toolbar', 'inspectorModules'] as const) {
        if (!Array.isArray(view[key]) || view[key].length > WORKSPACE_PACK_LIMITS.inspectorModules) out.push(violation('components', `${path}/${key}`, 'Expected bounded component list.'));
        else {
          view[key].forEach((ref, itemIndex) => componentRef(ref, `${path}/${key}/${itemIndex}`, out));
          const seen = new Set<string>();
          view[key].forEach((ref, itemIndex) => {
            if (!plain(ref) || typeof ref.id !== 'string' || typeof ref.version !== 'number') return;
            const refKey = `${ref.id}@${ref.version}`;
            if (seen.has(refKey)) out.push(violation('duplicate-component', `${path}/${key}/${itemIndex}`, 'Duplicate component reference.'));
            seen.add(refKey);
          });
        }
      }
      if (typeof view.enabled !== 'boolean') out.push(violation('enabled', `${path}/enabled`, 'Expected boolean.'));
    });
  }
  if (!Array.isArray(value.settingsOrder) || value.settingsOrder.length > WORKSPACE_PACK_LIMITS.settings) out.push(violation('settings-order', '/settingsOrder', 'Expected bounded settings list.'));
  else { value.settingsOrder.forEach((id, index) => idField(id, `/settingsOrder/${index}`, out)); duplicateIds(value.settingsOrder.map((id) => ({ id })), '/settingsOrder', out); }

  if (out.length > 0) return { ok: false, violations: out };
  return { ok: true, pack: structuredClone(value) as unknown as WorkspacePackDocument, warnings: [] };
}

function componentKey(ref: WorkspaceComponentRef): string { return `${ref.id}@${ref.version}`; }

export function validateWorkspacePackCompatibility(pack: WorkspacePackDocument, catalog: WorkspaceComponentCatalogContract): WorkspacePackValidationResult {
  const parsed = parseWorkspacePack(pack);
  if (!parsed.ok) return parsed;
  const out: WorkspacePackViolation[] = [];
  const components = new Map(catalog.components.map((item) => [`${item.id}@${item.version}`, item]));
  const capabilities = new Set(catalog.capabilities.map((item) => item.id));
  if (pack.compatibility.minimumRuntimeContractVersion > catalog.runtimeContractVersion || (pack.compatibility.maximumRuntimeContractVersion !== null && pack.compatibility.maximumRuntimeContractVersion < catalog.runtimeContractVersion)) out.push(violation('runtime-incompatible', '/compatibility', 'Runtime contract is outside pack bounds.'));
  for (const [index, ref] of pack.compatibility.requiredComponents.entries()) if (!components.has(componentKey(ref))) out.push(violation('missing-component', `/compatibility/requiredComponents/${index}`, 'Required component is unavailable.'));
  for (const [index, id] of pack.compatibility.requiredCapabilities.entries()) if (!capabilities.has(id)) out.push(violation('missing-capability', `/compatibility/requiredCapabilities/${index}`, 'Required capability is unavailable.'));
  const viewIds = new Set(pack.views.map((view) => view.id));
  if (!pack.layouts.some((layout) => layout.id === pack.defaultLayoutId)) out.push(violation('missing-layout', '/defaultLayoutId', 'Default layout is missing.'));
  const defaultView = pack.views.find((view) => view.id === pack.defaultViewId);
  if (!defaultView?.enabled) out.push(violation('missing-view', '/defaultViewId', 'Default enabled view is missing.'));
  if (!pack.views.some((view) => view.enabled)) out.push(violation('no-enabled-view', '/views', 'At least one view must be enabled.'));
  pack.layouts.forEach((layout, layoutIndex) => {
    const visiblePrimary = layout.regions.filter((region) => region.slot === 'primary' && !region.hidden);
    if (visiblePrimary.length !== 1) out.push(violation('primary-count', `/layouts/${layoutIndex}/regions`, 'Exactly one visible primary region is required.'));
    layout.regions.forEach((region, regionIndex) => {
      const definition = components.get(componentKey(region.component));
      if (definition === undefined) out.push(violation('missing-component', `/layouts/${layoutIndex}/regions/${regionIndex}/component`, 'Region component is unavailable.'));
      else {
        if (!definition.allowedSlots.includes(region.slot)) out.push(violation('slot-incompatible', `/layouts/${layoutIndex}/regions/${regionIndex}/slot`, 'Component is not allowed in this slot.'));
        for (const capability of definition.requiredCapabilities) if (!pack.compatibility.requiredCapabilities.includes(capability)) out.push(violation('component-capability', `/layouts/${layoutIndex}/regions/${regionIndex}/component`, 'Component capability is not declared by this pack.'));
      }
      const horizontalDock = region.slot === 'explorer' || region.slot === 'inspector' || region.slot === 'navigation';
      const verticalDock = region.slot === 'top' || region.slot === 'bottom';
      if ((region.resize === 'horizontal' && !horizontalDock) || (region.resize === 'vertical' && !verticalDock)) out.push(violation('resize-incompatible', `/layouts/${layoutIndex}/regions/${regionIndex}/resize`, 'Resize axis is incompatible with this dock.'));
      region.visibleInViews?.forEach((id, idIndex) => { if (!viewIds.has(id)) out.push(violation('unknown-view', `/layouts/${layoutIndex}/regions/${regionIndex}/visibleInViews/${idIndex}`, 'Unknown view.')); });
    });
  });
  pack.views.forEach((view, index) => {
    for (const [suffix, refs] of [['surface', [view.surface]], ['toolbar', view.toolbar], ['inspectorModules', view.inspectorModules]] as const) refs.forEach((ref, refIndex) => {
      const definition = components.get(componentKey(ref));
      if (definition === undefined) out.push(violation('missing-component', `/views/${index}/${suffix}/${refIndex}`, 'Component is unavailable.'));
      else for (const capability of definition.requiredCapabilities) if (!pack.compatibility.requiredCapabilities.includes(capability)) out.push(violation('component-capability', `/views/${index}/${suffix}/${refIndex}`, 'Component capability is not declared by this pack.'));
    });
  });
  return out.length > 0 ? { ok: false, violations: out } : { ok: true, pack: parsed.pack, warnings: [] };
}

export function roleAllows(actual: WorkspaceRole, required: WorkspaceRole | null): boolean {
  return required === null || ROLES[actual] >= ROLES[required];
}

export function isJsonObject(value: unknown): value is JsonObject { return plain(value) as boolean; }

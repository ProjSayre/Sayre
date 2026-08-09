import { HEX_COLOR, WORKSPACE_PACK_LIMITS } from './limits';
import { validateWorkspacePackCompatibility } from './parse';
import type {
  WorkspaceEditContext,
  WorkspaceEditOperation,
  WorkspacePackDocument,
  WorkspacePackEditResult,
  WorkspacePackViolation,
  WorkspaceRegionSpec,
} from './contracts';

const roleRank = { member: 0, admin: 1, owner: 2 } as const;

function fail(pack: WorkspacePackDocument, code: string, path: string, message: string): WorkspacePackEditResult {
  return { ok: false, pack, violations: [{ code, path, message }] };
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function operationIsValid(operation: unknown): operation is WorkspaceEditOperation {
  if (!plain(operation) || typeof operation.type !== 'string') return false;
  const allowed: Record<string, readonly string[]> = {
    'move-region': ['type', 'layoutId', 'regionId', 'slot', 'order'],
    'set-region-hidden': ['type', 'layoutId', 'regionId', 'hidden'],
    'replace-region-component': ['type', 'layoutId', 'regionId', 'component'],
    'resize-region-default': ['type', 'layoutId', 'regionId', 'size'],
    'set-region-default-collapsed': ['type', 'layoutId', 'regionId', 'collapsed'],
    'set-theme-color': ['type', 'token', 'value'],
    'set-theme-choice': ['type', 'token', 'value'],
    'set-default-view': ['type', 'viewId'],
  };
  const fields = allowed[operation.type];
  if (fields === undefined || Object.keys(operation).some((key) => !fields.includes(key))) return false;
  if (operation.type === 'set-theme-color') return typeof operation.token === 'string' && typeof operation.value === 'string';
  if (operation.type === 'set-theme-choice') {
    if (operation.token === 'density') return ['compact', 'comfortable', 'presentation'].includes(String(operation.value));
    if (operation.token === 'radius') return ['square', 'subtle', 'rounded'].includes(String(operation.value));
    if (operation.token === 'typography.ui' || operation.token === 'typography.mono') return ['sayre-grotesk', 'system-sans', 'system-mono'].includes(String(operation.value));
    return false;
  }
  if (operation.type === 'set-default-view') return typeof operation.viewId === 'string';
  if (typeof operation.layoutId !== 'string' || typeof operation.regionId !== 'string') return false;
  if (operation.type === 'move-region') return ['top', 'navigation', 'explorer', 'primary', 'inspector', 'bottom', 'overlay'].includes(String(operation.slot)) && Number.isInteger(operation.order);
  if (operation.type === 'set-region-hidden') return typeof operation.hidden === 'boolean';
  if (operation.type === 'resize-region-default') return typeof operation.size === 'number' && Number.isFinite(operation.size);
  if (operation.type === 'set-region-default-collapsed') return typeof operation.collapsed === 'boolean';
  if (operation.type === 'replace-region-component') {
    return plain(operation.component) && Object.keys(operation.component).every((key) => ['id', 'version', 'props'].includes(key)) && typeof operation.component.id === 'string' && Number.isInteger(operation.component.version);
  }
  return false;
}

function applyOne(pack: WorkspacePackDocument, operation: WorkspaceEditOperation, context: WorkspaceEditContext): WorkspacePackEditResult {
  if (!operationIsValid(operation)) return fail(pack, 'invalid-operation', '', 'Semantic edit operation is malformed or contains unknown fields.');
  const next = structuredClone(pack);
  const changedPaths: string[] = [];
  if (operation.type === 'set-theme-color') {
    if (!HEX_COLOR.test(operation.value)) return fail(pack, 'invalid-color', `/theme/colors/${operation.token}`, 'Expected six/eight-digit hex color.');
    if (next.theme.colors[operation.token] === operation.value) return { ok: true, pack, changedPaths: [] };
    next.theme.colors[operation.token] = operation.value;
    changedPaths.push(`/theme/colors/${operation.token}`);
  } else if (operation.type === 'set-theme-choice') {
    const currentValue = operation.token === 'density'
      ? next.theme.density
      : operation.token === 'radius'
        ? next.theme.radius
        : next.theme.typography[operation.token.split('.')[1] as 'ui' | 'mono'];
    if (currentValue === operation.value) return { ok: true, pack, changedPaths: [] };
    if (operation.token === 'density') next.theme.density = operation.value;
    else if (operation.token === 'radius') next.theme.radius = operation.value;
    else next.theme.typography[operation.token.split('.')[1] as 'ui' | 'mono'] = operation.value;
    changedPaths.push(`/theme/${operation.token.replace('.', '/')}`);
  } else if (operation.type === 'set-default-view') {
    if (!next.views.some((view) => view.id === operation.viewId && view.enabled)) return fail(pack, 'unknown-view', '/defaultViewId', 'Default view must be enabled.');
    if (next.defaultViewId === operation.viewId) return { ok: true, pack, changedPaths: [] };
    next.defaultViewId = operation.viewId;
    changedPaths.push('/defaultViewId');
  } else {
    const layoutIndex = next.layouts.findIndex((layout) => layout.id === operation.layoutId);
    if (layoutIndex < 0) return fail(pack, 'unknown-layout', '/layouts', 'Layout does not exist.');
    const layout = next.layouts[layoutIndex]!;
    const regionIndex = layout.regions.findIndex((region) => region.id === operation.regionId);
    if (regionIndex < 0) return fail(pack, 'unknown-region', `/layouts/${layoutIndex}/regions`, 'Region does not exist.');
    const regions = [...layout.regions];
    const region = { ...regions[regionIndex]! };
    if (operation.type === 'move-region') {
      if (!Number.isInteger(operation.order) || operation.order < 0) return fail(pack, 'invalid-order', `/layouts/${layoutIndex}/regions/${regionIndex}/order`, 'Order must be non-negative.');
      const definition = context.catalog.components.find((item) => item.id === region.component.id && item.version === region.component.version);
      if (!definition?.allowedSlots.includes(operation.slot)) return fail(pack, 'slot-incompatible', `/layouts/${layoutIndex}/regions/${regionIndex}/slot`, 'Component is not allowed in target slot.');
      if (operation.slot === 'primary' && region.slot !== 'primary') return fail(pack, 'primary-count', `/layouts/${layoutIndex}/regions/${regionIndex}/slot`, 'Primary slot is reserved.');
      if (region.slot === operation.slot && region.order === operation.order) return { ok: true, pack, changedPaths: [] };
      region.slot = operation.slot;
      region.order = operation.order;
    } else if (operation.type === 'set-region-hidden') {
      if (region.slot === 'primary' && operation.hidden) return fail(pack, 'primary-required', `/layouts/${layoutIndex}/regions/${regionIndex}/hidden`, 'Primary region cannot be hidden.');
      if (region.hidden === operation.hidden) return { ok: true, pack, changedPaths: [] };
      region.hidden = operation.hidden;
    } else if (operation.type === 'replace-region-component') {
      const definition = context.catalog.components.find((item) => item.id === operation.component.id && item.version === operation.component.version);
      const authorized = definition !== undefined && (definition.minimumRole === null || roleRank[context.role] >= roleRank[definition.minimumRole]);
      if (!definition || !authorized || !definition.allowedSlots.includes(region.slot) || definition.requiredCapabilities.some((item) => !context.availableCapabilities.includes(item))) return fail(pack, 'component-incompatible', `/layouts/${layoutIndex}/regions/${regionIndex}/component`, 'Replacement is incompatible with the target slot, active capabilities, or current role.');
      if (region.component.id === operation.component.id && region.component.version === operation.component.version
        && JSON.stringify(region.component.props ?? {}) === JSON.stringify(operation.component.props ?? {})) {
        return { ok: true, pack, changedPaths: [] };
      }
      region.component = structuredClone(operation.component);
    } else if (operation.type === 'resize-region-default') {
      if (!Number.isFinite(operation.size) || operation.size < region.minimumSize || operation.size > region.maximumSize) return fail(pack, 'invalid-size', `/layouts/${layoutIndex}/regions/${regionIndex}/defaultSize`, 'Size is outside bounds.');
      if (region.defaultSize === operation.size) return { ok: true, pack, changedPaths: [] };
      region.defaultSize = operation.size;
    } else if (operation.type === 'set-region-default-collapsed') {
      if (!region.collapsible || region.slot === 'primary') return fail(pack, 'not-collapsible', `/layouts/${layoutIndex}/regions/${regionIndex}/defaultCollapsed`, 'Region cannot collapse.');
      if (region.defaultCollapsed === operation.collapsed) return { ok: true, pack, changedPaths: [] };
      region.defaultCollapsed = operation.collapsed;
    }
    regions[regionIndex] = region;
    const normalized = regions.map((item) => ({ ...item }));
    for (const slot of new Set(normalized.map((item) => item.slot))) normalized.filter((item) => item.slot === slot).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).forEach((item, index) => { item.order = index; });
    (next.layouts as WorkspacePackDocument['layouts']) = next.layouts.map((item, index) => index === layoutIndex ? { ...item, regions: normalized as WorkspaceRegionSpec[] } : item);
    changedPaths.push(`/layouts/${layoutIndex}/regions/${regionIndex}`);
  }
  const validated = validateWorkspacePackCompatibility(next, context.catalog);
  return validated.ok ? { ok: true, pack: validated.pack, changedPaths } : { ok: false, pack, violations: validated.violations };
}

export function applyWorkspaceEditOperation(pack: WorkspacePackDocument, operation: WorkspaceEditOperation, context: WorkspaceEditContext): WorkspacePackEditResult {
  return applyOne(pack, operation, context);
}

export function applyWorkspaceEditOperations(pack: WorkspacePackDocument, operations: readonly WorkspaceEditOperation[], context: WorkspaceEditContext): WorkspacePackEditResult {
  if (!Array.isArray(operations)) return fail(pack, 'invalid-operations', '', 'Operations must be an array.');
  if (operations.length > WORKSPACE_PACK_LIMITS.operations) return fail(pack, 'too-many-operations', '', 'At most 128 operations are accepted.');
  let current = structuredClone(pack);
  const changedPaths: string[] = [];
  for (const operation of operations) {
    const result = applyOne(current, operation, context);
    if (!result.ok) return { ...result, pack };
    current = result.pack;
    changedPaths.push(...result.changedPaths);
  }
  return { ok: true, pack: current, changedPaths: [...new Set(changedPaths)] };
}

import type { WorkspaceComponentRef, WorkspacePackViolation, WorkspaceRole, WorkspaceSlotId } from './contracts';
import { roleAllows } from './parse';
import { WORKSPACE_SHAPES, type WorkspaceShapeId } from './shapes';

export interface WorkspaceDataCapabilityManifest {
  id: string; version: number; title: string;
  shape: WorkspaceShapeId;
  requiredGates: readonly string[];
  minimumRole: WorkspaceRole | null;
}
export interface WorkspaceRendererManifest {
  id: string; version: number; title: string;
  shape: WorkspaceShapeId;
  allowedSlots: readonly WorkspaceSlotId[];
  isDefaultForShape?: boolean;
}
export interface WorkspaceModuleBinding {
  capability: WorkspaceComponentRef;
  renderer: WorkspaceComponentRef;
}
export interface WorkspaceBindingContext {
  slot: WorkspaceSlotId; role: WorkspaceRole; grantedGates: ReadonlySet<string>;
}
export type WorkspaceRendererResolution =
  | { renderer: WorkspaceRendererManifest; fallback: 'preferred' | 'shape-default' }
  | { renderer: null; fallback: 'none' };

export interface WorkspaceRegistryContract {
  dataCapabilities: readonly WorkspaceDataCapabilityManifest[];
  renderers: readonly WorkspaceRendererManifest[];
}

/**
 * Narrower than `WorkspacePackValidationResult`: a manifest registration has no `pack` to hand
 * back on success, so the success arm here carries nothing but `ok`. Violations reuse the shared
 * `{ code, path, message }` vocabulary so future LLM/import paths can surface them uniformly.
 */
export type WorkspaceRegistrationResult = { ok: true } | { ok: false; violations: readonly WorkspacePackViolation[] };

export interface WorkspaceRegistry {
  registerDataCapability(manifest: WorkspaceDataCapabilityManifest): WorkspaceRegistrationResult;
  registerRenderer(manifest: WorkspaceRendererManifest): WorkspaceRegistrationResult;
  pairings(): readonly WorkspaceModuleBinding[];
  validateBinding(binding: WorkspaceModuleBinding, context: WorkspaceBindingContext): WorkspaceRegistrationResult;
  resolveRenderer(capability: WorkspaceComponentRef, preferred: WorkspaceComponentRef | null): WorkspaceRendererResolution;
  snapshot(): WorkspaceRegistryContract;
}

const FROZEN_SHAPES = new Set<string>(WORKSPACE_SHAPES);

function violation(code: string, path: string, message: string): WorkspacePackViolation {
  return { code, path, message };
}

/** The alias namespace and the duplicate-registration check are both keyed on this string. */
function componentKey(ref: { id: string; version: number }): string {
  return `${ref.id}@${ref.version}`;
}

export function createWorkspaceRegistry(reservedComponentIds: ReadonlySet<string> = new Set()): WorkspaceRegistry {
  const capabilities = new Map<string, WorkspaceDataCapabilityManifest>();
  const renderers = new Map<string, WorkspaceRendererManifest>();

  function registerDataCapability(manifest: WorkspaceDataCapabilityManifest): WorkspaceRegistrationResult {
    const key = componentKey(manifest);
    const violations: WorkspacePackViolation[] = [];
    if (!FROZEN_SHAPES.has(manifest.shape)) violations.push(violation('unknown-shape', '/shape', `Unknown workspace shape "${manifest.shape}".`));
    if (reservedComponentIds.has(key)) violations.push(violation('reserved-id', '/id', `"${key}" collides with a reserved legacy component id.`));
    if (capabilities.has(key)) violations.push(violation('duplicate-capability', '/id', `Data capability "${key}" is already registered.`));
    if (violations.length > 0) return { ok: false, violations };
    capabilities.set(key, manifest);
    return { ok: true };
  }

  function registerRenderer(manifest: WorkspaceRendererManifest): WorkspaceRegistrationResult {
    const key = componentKey(manifest);
    const violations: WorkspacePackViolation[] = [];
    if (!FROZEN_SHAPES.has(manifest.shape)) violations.push(violation('unknown-shape', '/shape', `Unknown workspace shape "${manifest.shape}".`));
    if (manifest.allowedSlots.length === 0) violations.push(violation('empty-allowed-slots', '/allowedSlots', 'A renderer must allow at least one slot.'));
    if (reservedComponentIds.has(key)) violations.push(violation('reserved-id', '/id', `"${key}" collides with a reserved legacy component id.`));
    if (renderers.has(key)) violations.push(violation('duplicate-renderer', '/id', `Renderer "${key}" is already registered.`));
    if (violations.length > 0) return { ok: false, violations };
    renderers.set(key, manifest);
    return { ok: true };
  }

  /** N capabilities x M renderers of the same shape -> N x M bindings; nothing is pairwise-wired. */
  function pairings(): readonly WorkspaceModuleBinding[] {
    const bindings: WorkspaceModuleBinding[] = [];
    for (const capability of capabilities.values()) {
      for (const renderer of renderers.values()) {
        if (renderer.shape !== capability.shape) continue;
        bindings.push({
          capability: { id: capability.id, version: capability.version },
          renderer: { id: renderer.id, version: renderer.version },
        });
      }
    }
    return bindings;
  }

  function findCapability(ref: WorkspaceComponentRef): WorkspaceDataCapabilityManifest | undefined {
    return capabilities.get(componentKey(ref));
  }

  function findRenderer(ref: WorkspaceComponentRef): WorkspaceRendererManifest | undefined {
    return renderers.get(componentKey(ref));
  }

  function validateBinding(binding: WorkspaceModuleBinding, context: WorkspaceBindingContext): WorkspaceRegistrationResult {
    const violations: WorkspacePackViolation[] = [];
    const capability = findCapability(binding.capability);
    const renderer = findRenderer(binding.renderer);
    if (capability === undefined) violations.push(violation('unknown-capability', '/capability', `Data capability "${componentKey(binding.capability)}" is not registered.`));
    if (renderer === undefined) violations.push(violation('unknown-renderer', '/renderer', `Renderer "${componentKey(binding.renderer)}" is not registered.`));
    if (capability !== undefined && renderer !== undefined) {
      if (capability.shape !== renderer.shape) violations.push(violation('shape-mismatch', '/renderer/shape', `Renderer shape "${renderer.shape}" does not match capability shape "${capability.shape}".`));
      if (!renderer.allowedSlots.includes(context.slot)) violations.push(violation('slot-not-allowed', '/context/slot', `Slot "${context.slot}" is not among the renderer's allowed slots.`));
      for (const gate of capability.requiredGates) {
        if (!context.grantedGates.has(gate)) violations.push(violation('missing-gate', '/context/grantedGates', `Required gate "${gate}" is not granted.`));
      }
      if (!roleAllows(context.role, capability.minimumRole)) violations.push(violation('role-below-minimum', '/context/role', `Role "${context.role}" is below the capability's minimum role "${capability.minimumRole}".`));
    }
    if (violations.length > 0) return { ok: false, violations };
    return { ok: true };
  }

  /** A missing/foreign-shape preference falls back to the shape default; no default -> 'none'. */
  function resolveRenderer(capabilityRef: WorkspaceComponentRef, preferred: WorkspaceComponentRef | null): WorkspaceRendererResolution {
    const capability = findCapability(capabilityRef);
    if (capability === undefined) return { renderer: null, fallback: 'none' };
    if (preferred !== null) {
      const candidate = findRenderer(preferred);
      if (candidate !== undefined && candidate.shape === capability.shape) return { renderer: candidate, fallback: 'preferred' };
    }
    const shapeDefault = [...renderers.values()].find((candidate) => candidate.shape === capability.shape && candidate.isDefaultForShape === true);
    if (shapeDefault !== undefined) return { renderer: shapeDefault, fallback: 'shape-default' };
    return { renderer: null, fallback: 'none' };
  }

  function snapshot(): WorkspaceRegistryContract {
    return {
      dataCapabilities: [...capabilities.values()].map((manifest) => ({ ...manifest, requiredGates: [...manifest.requiredGates] })),
      renderers: [...renderers.values()].map((manifest) => ({ ...manifest, allowedSlots: [...manifest.allowedSlots] })),
    };
  }

  return { registerDataCapability, registerRenderer, pairings, validateBinding, resolveRenderer, snapshot };
}

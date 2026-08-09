import { parseWorkspacePack, validateWorkspacePackCompatibility, type InstalledWorkspacePack, type WorkspacePackDocument } from '../../../../../packages/workspace-packs/src/runtime';
import defaultRaw from '../../../workspace-packs/default/sayre.workspace.json';
import pitchRaw from '../../../workspace-packs/pitch/sayre.workspace.json';
import { validateRuntimeComponentProps, workspaceComponentCatalog } from './runtimeCatalog';

function builtIn(value: unknown): InstalledWorkspacePack {
  const parsed = parseWorkspacePack(value);
  if (!parsed.ok) throw new Error(`Invalid built-in Workspace Pack: ${parsed.violations.map((item) => `${item.path} ${item.message}`).join('; ')}`);
  const compatible = validateWorkspacePackCompatibility(parsed.pack, workspaceComponentCatalog);
  if (!compatible.ok) throw new Error(`Incompatible built-in Workspace Pack: ${compatible.violations.map((item) => `${item.path} ${item.message}`).join('; ')}`);
  const props = validateRuntimeComponentProps(compatible.pack);
  if (!props.ok) throw new Error(`Invalid built-in component props: ${props.violations.map((item) => `${item.path} ${item.message}`).join('; ')}`);
  const pack: WorkspacePackDocument = compatible.pack;
  return {
    ref: { id: pack.metadata.id, version: pack.metadata.version },
    source: 'builtin', installedAt: 'builtin', pack,
  };
}

export const defaultWorkspacePack = builtIn(defaultRaw);
export const pitchWorkspacePack = builtIn(pitchRaw);
export const builtinWorkspacePacks = Object.freeze([defaultWorkspacePack, pitchWorkspacePack]);

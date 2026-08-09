import { readFileSync } from 'node:fs';
import type { WorkspaceComponentCatalogContract, WorkspacePackDocument } from './contracts';
import { parseWorkspacePack } from './parse';

export const testCatalog: WorkspaceComponentCatalogContract = {
  runtimeContractVersion: 1,
  components: [
    { id: 'sayre.primary-surface', version: 1, allowedSlots: ['primary'], requiredCapabilities: [], minimumRole: 'member' },
    { id: 'sayre.explorer', version: 1, allowedSlots: ['explorer', 'navigation'], requiredCapabilities: ['sayre.technical'], minimumRole: 'member' },
    { id: 'sayre.inspector', version: 1, allowedSlots: ['inspector'], requiredCapabilities: [], minimumRole: 'member' },
    { id: 'sayre.pitch-summary', version: 1, allowedSlots: ['inspector'], requiredCapabilities: ['sayre.product'], minimumRole: 'member' },
  ],
  capabilities: [
    { id: 'sayre.technical', version: 1 },
    { id: 'sayre.product', version: 1 },
    { id: 'sayre.onboarding', version: 1 },
  ],
};

export function testPack(): WorkspacePackDocument {
  const raw = JSON.parse(readFileSync(new URL('../../../apps/web/workspace-packs/default/sayre.workspace.json', import.meta.url), 'utf8')) as unknown;
  const parsed = parseWorkspacePack(raw);
  if (!parsed.ok) throw new Error(parsed.violations.map((item) => item.message).join('; '));
  return parsed.pack;
}

import type { SettingsSection } from './types';

export interface SettingsSectionDefinition {
  id: SettingsSection;
  label: string;
  title: string;
  capability: 'workspace-customization' | 'source-control' | 'model-provider' | 'agent-access';
  minimumRole: 'member' | 'admin' | 'owner';
  availability: 'available';
}

/**
 * Settings navigation is data, not shell markup. A post-MVP UI authoring agent
 * can reorder or preset these definitions without changing authentication,
 * transport, or individual settings modules.
 */
export const settingsSections: readonly SettingsSectionDefinition[] =
  Object.freeze([
    {
      id: 'workspace-packs',
      label: 'Workspace Packs',
      title: 'Workspace Packs',
      capability: 'workspace-customization',
      minimumRole: 'member',
      availability: 'available',
    },
    {
      id: 'github',
      label: 'GitHub Integrations',
      title: 'GitHub Integrations',
      capability: 'source-control',
      minimumRole: 'admin',
      availability: 'available',
    },
    {
      id: 'providers',
      label: 'Model Providers',
      title: 'Model Providers',
      capability: 'model-provider',
      minimumRole: 'admin',
      availability: 'available',
    },
    {
      id: 'mcp',
      label: 'MCP Agent Access',
      title: 'MCP Agent Access',
      capability: 'agent-access',
      minimumRole: 'admin',
      availability: 'available',
    },
  ] satisfies SettingsSectionDefinition[]);

export function settingsSection(
  id: SettingsSection,
): SettingsSectionDefinition {
  const section = settingsSections.find((candidate) => candidate.id === id);
  if (section === undefined) throw new Error(`Unknown settings section: ${id}`);
  return section;
}

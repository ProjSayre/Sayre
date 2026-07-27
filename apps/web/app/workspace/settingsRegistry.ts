import type { SettingsSection } from './types';

export interface SettingsSectionDefinition {
  id: SettingsSection;
  label: string;
  title: string;
  capability: 'source-control' | 'model-provider' | 'agent-access';
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
      id: 'github',
      label: 'GitHub Integrations',
      title: 'GitHub Integrations',
      capability: 'source-control',
      availability: 'available',
    },
    {
      id: 'providers',
      label: 'Model Providers',
      title: 'Model Providers',
      capability: 'model-provider',
      availability: 'available',
    },
    {
      id: 'mcp',
      label: 'MCP Agent Access',
      title: 'MCP Agent Access',
      capability: 'agent-access',
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

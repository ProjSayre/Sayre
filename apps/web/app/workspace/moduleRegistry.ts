export type NodeModuleId =
  | 'dependencies'
  | 'recent-changes'
  | 'specific-features'
  | 'agent-skill-md'
  | 'description'
  | 'specific-tickets'
  | 'standards';

export interface NodeModuleDefinition {
  id: NodeModuleId;
  title: string;
  defaultOpen: boolean;
  capability:
    | 'graph'
    | 'ownership'
    | 'semantic'
    | 'agent-contract'
    | 'tickets'
    | 'style-rules';
  availability: 'available' | 'reserved';
}

/**
 * Stable module order and capabilities. Rendering stays separate so a module
 * preset can rearrange or omit slots without changing data access.
 */
export const nodeModules: readonly NodeModuleDefinition[] = Object.freeze([
  {
    id: 'dependencies',
    title: 'Dependencies',
    defaultOpen: true,
    capability: 'graph',
    availability: 'available',
  },
  {
    id: 'recent-changes',
    title: 'Recent Changes',
    defaultOpen: true,
    capability: 'ownership',
    availability: 'available',
  },
  {
    id: 'specific-features',
    title: 'Specific Features',
    defaultOpen: true,
    capability: 'semantic',
    availability: 'available',
  },
  {
    id: 'agent-skill-md',
    title: 'Agent / Skill MD',
    defaultOpen: true,
    capability: 'agent-contract',
    availability: 'available',
  },
  {
    id: 'description',
    title: 'Description',
    defaultOpen: true,
    capability: 'semantic',
    availability: 'available',
  },
  {
    id: 'specific-tickets',
    title: 'Specific Tickets',
    defaultOpen: true,
    capability: 'tickets',
    availability: 'available',
  },
  {
    id: 'standards',
    title: 'Standards',
    defaultOpen: false,
    capability: 'style-rules',
    availability: 'reserved',
  },
]);

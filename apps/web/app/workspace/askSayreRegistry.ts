/**
 * Standalone Ask Sayre module registry, following moduleRegistry.ts's
 * conventions (id/title/defaultOpen/capability/availability plus a dedicated
 * renderer map). Deliberately NOT a Workspace Pack region: `ask-sayre` is a
 * standalone dock mounted directly in the workspace body, so the pack
 * catalog's own counts are untouched by this ticket.
 */

import type { ComponentType } from 'react';
import type { ViewId } from './types';

export type AskSayreModuleId = 'ask-sayre';

export interface AskSayreModuleDefinition {
  id: AskSayreModuleId;
  title: string;
  defaultOpen: boolean;
  capability: 'chat';
  availability: 'available' | 'reserved';
}

export const askSayreModules: readonly AskSayreModuleDefinition[] = Object.freeze([
  { id: 'ask-sayre', title: 'Ask Sayre', defaultOpen: true, capability: 'chat', availability: 'available' },
] satisfies AskSayreModuleDefinition[]);

export function askSayreModule(id: AskSayreModuleId): AskSayreModuleDefinition {
  const definition = askSayreModules.find((candidate) => candidate.id === id);
  if (definition === undefined) throw new Error(`Unknown Ask Sayre module: ${id}`);
  return definition;
}

export const ASK_SAYRE_SUGGESTED_PROMPTS: Readonly<Record<ViewId, string>> = Object.freeze({
  technical: 'Explain this folder',
  product: 'What feature does this belong to?',
  onboarding: 'What should I start first?',
});

export interface AskSayreModuleRendererProps {
  definition: AskSayreModuleDefinition;
}

export type AskSayreModuleRenderer = ComponentType<AskSayreModuleRendererProps>;

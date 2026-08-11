// CH-06 red suite — the standalone Ask Sayre module registry.
// Authored from .pipeline/spec.md before any implementation exists.
//
// Deliberately NOT a Workspace Pack region: `ask-sayre` is a standalone dock
// registered here, following moduleRegistry.ts's conventions, so the pack
// catalog's own counts are untouched by this ticket.

import { describe, expect, it } from 'vitest';
import {
  ASK_SAYRE_SUGGESTED_PROMPTS,
  askSayreModule,
  askSayreModules,
  type AskSayreModuleId,
} from './askSayreRegistry';
import { askSayreModuleRenderers } from './chat/askSayreRenderers';

describe('ask-sayre module registry', () => {
  // @spec AC-16
  it('registers the dock following the node-module definition conventions', () => {
    expect(askSayreModules).toEqual([
      {
        id: 'ask-sayre',
        title: 'Ask Sayre',
        defaultOpen: true,
        capability: 'chat',
        availability: 'available',
      },
    ]);
    expect(Object.isFrozen(askSayreModules)).toBe(true);
    expect(askSayreModule('ask-sayre')).toBe(askSayreModules[0]);
  });

  // @spec AC-16
  it('maps every registered id to exactly one renderer and introduces no other id', () => {
    const registeredIds = askSayreModules.map((definition) => definition.id);
    expect(Object.keys(askSayreModuleRenderers).sort()).toEqual([...registeredIds].sort());
    for (const id of registeredIds) {
      expect(typeof askSayreModuleRenderers[id as AskSayreModuleId]).toBe('function');
    }
    expect(new Set(registeredIds).size).toBe(registeredIds.length);
  });

  // @spec AC-9 AC-16
  it('publishes one suggested prompt per view, keyed by ViewId', () => {
    expect(ASK_SAYRE_SUGGESTED_PROMPTS).toEqual({
      technical: 'Explain this folder',
      product: 'What feature does this belong to?',
      onboarding: 'What should I start first?',
    });
    expect(Object.isFrozen(ASK_SAYRE_SUGGESTED_PROMPTS)).toBe(true);
  });
});

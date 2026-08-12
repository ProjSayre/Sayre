/**
 * The dedicated renderer map for askSayreRegistry's ids — same split as
 * moduleRegistry.ts / drawer/nodeModuleRenderers.tsx.
 */

import type { AskSayreModuleId, AskSayreModuleRenderer } from '../askSayreRegistry';
import { AskSayrePanelBody } from './AskSayrePanelBody';

export const askSayreModuleRenderers: Readonly<Record<AskSayreModuleId, AskSayreModuleRenderer>> =
  Object.freeze({
    'ask-sayre': AskSayrePanelBody,
  });

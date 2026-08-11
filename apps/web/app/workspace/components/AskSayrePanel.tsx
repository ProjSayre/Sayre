'use client';

/**
 * The real, collapsible Ask Sayre dock (rail + panel), driven by the
 * standalone askSayreRegistry and the workspace chat context. Mounted once in
 * the workspace body (views/LegacyWorkspaceView.tsx) so it appears across the
 * Technical, Product, and Onboarding views.
 */

import { askSayreModule } from '../askSayreRegistry';
import { askSayreModuleRenderers } from '../chat/askSayreRenderers';
import { useWorkspaceChat } from '../chat/ChatProvider';
import { CHAT_PANEL_ELEMENT_ID } from '../chat/chatContract';

export function AskSayreDock() {
  const chat = useWorkspaceChat();
  const definition = askSayreModule('ask-sayre');
  const Renderer = askSayreModuleRenderers[definition.id];

  if (!chat.expanded) {
    return (
      <div className="mock-chat-dock mock-chat-dock-collapsed">
        <button
          type="button"
          className="mock-chat-dock-toggle"
          aria-expanded={false}
          aria-label="Expand Ask Sayre"
          onClick={() => chat.setExpanded(true)}
        >
          Ask Sayre
        </button>
      </div>
    );
  }

  return (
    <div className="mock-chat-dock mock-chat-dock-expanded">
      <div className="mock-chat-dock-head">
        <span className="mock-chat-dock-title">{definition.title}</span>
        <button
          type="button"
          className="mock-chat-dock-toggle"
          aria-expanded={true}
          aria-controls={CHAT_PANEL_ELEMENT_ID}
          aria-label="Collapse Ask Sayre"
          onClick={() => chat.setExpanded(false)}
        >
          Collapse
        </button>
      </div>
      <div id={CHAT_PANEL_ELEMENT_ID} className="mock-chat-panel">
        <Renderer definition={definition} />
      </div>
    </div>
  );
}

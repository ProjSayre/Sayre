'use client';

/**
 * Reserved dock for the contextual "Ask Sayre" surface.
 *
 * Graph-Guided RAG can already answer a question over an authorized node
 * neighbourhood and report which context nodes it used, but there is no public
 * API route for it yet. This reserves the shell slot the eventual surface needs
 * — scope, answer, and context-node list — without pretending to answer
 * anything. Every control is inert and says so.
 */
export function AskSayreDock({ scopeLabel }: { scopeLabel: string }) {
  return (
    <div className="mock-dock" aria-label="Ask Sayre (not yet available)">
      <span className="mock-reserved-tag">not yet available</span>
      <span className="mock-dock-scope">scope: {scopeLabel}</span>
      <span className="mock-dock-input" aria-hidden="true">
        Ask a question about this repository…
      </span>
      <button type="button" className="mock-btn mock-btn-secondary mock-btn-sm" disabled>
        Ask Sayre
      </button>
    </div>
  );
}

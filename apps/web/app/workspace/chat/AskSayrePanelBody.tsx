'use client';

/**
 * Ask Sayre panel body: the scope chip, provider-unconfigured notice,
 * degraded-path note, transcript, empty state, and composer.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useWorkspaceNavigation } from '../state/navigation';
import type { ViewId } from '../types';
import type { AskSayreModuleRendererProps } from '../askSayreRegistry';
import { ASK_SAYRE_SUGGESTED_PROMPTS } from '../askSayreRegistry';
import { CHAT_INPUT_ELEMENT_ID, CHAT_QUESTION_MAX_CHARACTERS } from './chatContract';
import { ChatTranscriptList } from './ChatTranscriptList';
import { useWorkspaceChat } from './ChatProvider';

const VIEW_LABELS: Readonly<Record<ViewId, string>> = {
  technical: 'Technical',
  product: 'Product',
  onboarding: 'Onboarding',
};

function ScopeChip() {
  const chat = useWorkspaceChat();
  const viewLabel = VIEW_LABELS[chat.scope.view];
  if (chat.anchorLabel === null) {
    return <span className="mock-chat-chip mock-chat-chip-view">{viewLabel}</span>;
  }
  return (
    <button
      type="button"
      className="mock-chat-chip mock-chat-chip-anchor"
      onClick={chat.dismissAnchor}
    >
      {viewLabel} · {chat.anchorLabel} ✕
    </button>
  );
}

function ProviderNotice() {
  const navigation = useWorkspaceNavigation();
  return (
    <div className="mock-chat-notice" role="status">
      <p>Set up an AI provider to ask Sayre a question.</p>
      <button
        type="button"
        className="mock-btn mock-btn-secondary mock-btn-sm"
        onClick={() => navigation.openSettings('providers')}
      >
        Open provider settings
      </button>
    </div>
  );
}

function DegradedNote() {
  const chat = useWorkspaceChat();
  return (
    <div className="mock-chat-notice mock-chat-notice-degraded" role="status">
      <p>Live progress is unavailable right now. Sayre will still finish, updates may just be delayed.</p>
      <button type="button" className="mock-btn mock-btn-ghost mock-btn-sm" onClick={chat.refresh}>
        Check again
      </button>
    </div>
  );
}

function ComposerError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mock-chat-notice mock-chat-notice-error" role="alert">
      <p>{message}</p>
      <button type="button" className="mock-btn mock-btn-ghost mock-btn-sm" onClick={onRetry}>
        Send again
      </button>
    </div>
  );
}

function EmptyState({ view }: { view: ViewId }) {
  const chat = useWorkspaceChat();
  const prompt = ASK_SAYRE_SUGGESTED_PROMPTS[view];
  return (
    <div className="mock-chat-empty">
      <p>
        {view === 'product'
          ? "Ask Sayre what feature you're looking at."
          : "Ask Sayre about the folder or file you're viewing."}
      </p>
      <button
        type="button"
        className="mock-btn mock-btn-secondary mock-btn-sm"
        onClick={() => chat.ask(prompt)}
      >
        {prompt}
      </button>
    </div>
  );
}

export function AskSayrePanelBody({ definition }: AskSayreModuleRendererProps) {
  const chat = useWorkspaceChat();
  const [value, setValue] = useState('');
  const pendingQuestionRef = useRef<string | null>(null);

  useEffect(() => {
    if (chat.composerError !== null && pendingQuestionRef.current !== null) {
      setValue(pendingQuestionRef.current);
      pendingQuestionRef.current = null;
    }
  }, [chat.composerError]);

  const providerBlocked = chat.providerStatus === 'incomplete' || chat.providerStatus === 'not-configured';
  const inputDisabled = chat.inert || providerBlocked || chat.busy;
  const blank = value.trim().length === 0;
  const submitDisabled = inputDisabled || blank;

  const trySubmit = (): void => {
    if (value.trim().length === 0 || inputDisabled) return;
    pendingQuestionRef.current = value;
    const question = value;
    setValue('');
    chat.ask(question);
  };

  const handleFormSubmit = (event: FormEvent): void => {
    event.preventDefault();
    trySubmit();
  };

  const hintText = chat.inert
    ? "Sayre isn't connected to a live backend in this workspace."
    : providerBlocked
      ? 'Set up an AI provider to ask Sayre a question.'
      : chat.busy
        ? 'Sayre is answering your last question.'
        : blank
          ? 'Type a question to ask Sayre.'
          : "Press Ask Sayre or Enter to send this question.";

  return (
    <div className="mock-chat-body" aria-label={definition.title}>
      <div className="mock-chat-scope-row">
        <ScopeChip />
      </div>

      {providerBlocked && <ProviderNotice />}
      {chat.live === 'degraded' && <DegradedNote />}

      <ChatTranscriptList turns={chat.turns} />
      {chat.turns.length === 0 && <EmptyState view={chat.scope.view} />}

      {chat.composerError !== null && (
        <ComposerError message={chat.composerError} onRetry={trySubmit} />
      )}

      <form className="mock-chat-composer" onSubmit={handleFormSubmit}>
        <label htmlFor={CHAT_INPUT_ELEMENT_ID}>Ask Sayre</label>
        <input
          id={CHAT_INPUT_ELEMENT_ID}
          type="text"
          value={value}
          maxLength={CHAT_QUESTION_MAX_CHARACTERS}
          disabled={inputDisabled}
          placeholder="Ask a question about this repository…"
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit" className="mock-btn mock-btn-primary mock-btn-sm" disabled={submitDisabled}>
          Ask Sayre
        </button>
      </form>
      <p className="mock-chat-hint" role="status">{hintText}</p>
    </div>
  );
}

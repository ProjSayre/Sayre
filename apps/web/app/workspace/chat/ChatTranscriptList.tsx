'use client';

/**
 * Transcript rendering: turn item, progress ticker, answer blocks, citation
 * chips, and metrics footer. The markdown answer renders only through
 * `parseAnswerBlocks` into plain React text nodes — no `dangerouslySetInnerHTML`,
 * no anchor is ever constructed from answer/citation/tool/detail text (AC-17).
 */

import { useMemo } from 'react';
import { useWorkspaceNavigation } from '../state/navigation';
import { useWorkspaceQueries } from '../state/queries';
import type { ViewId } from '../types';
import { parseAnswerBlocks } from './answerMarkdown';
import {
  formatChatMetrics,
  type ChatCitation,
  type ChatMetrics,
  type ChatProgressLine,
} from './chatContract';
import type { ChatTranscriptTurn } from './chatTranscript';
import { citationTarget } from './citationTarget';
import { useWorkspaceChat } from './ChatProvider';

export function ChatAnswer({ answer }: { answer: string }) {
  const blocks = parseAnswerBlocks(answer);
  return (
    <div className="mock-chat-answer">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const HeadingTag = `h${block.level}` as 'h1' | 'h2' | 'h3';
          return <HeadingTag key={index}>{block.text}</HeadingTag>;
        }
        if (block.type === 'code') {
          return (
            <pre key={index} className="mock-chat-answer-code">
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{item}</li>
              ))}
            </ListTag>
          );
        }
        return <p key={index}>{block.text}</p>;
      })}
    </div>
  );
}

export function ChatMetricsFooter({ metrics }: { metrics: ChatMetrics | null }): JSX.Element | null {
  if (metrics === null) return null;
  return <p className="mock-chat-metrics">{formatChatMetrics(metrics)}</p>;
}

/** Caller must only mount this when `citations.length > 0` (EC-11). */
export function ChatCitationRow({ citations }: { citations: readonly ChatCitation[] }) {
  const chat = useWorkspaceChat();
  const navigation = useWorkspaceNavigation();
  const { graph } = useWorkspaceQueries();
  const knownFeatureIds = useMemo(
    () => new Set(graph.features.map((feature) => feature.id)),
    [graph.features],
  );
  const view = navigation.viewId as ViewId;
  return (
    <div className="mock-chat-citations">
      {citations.map((citation) => {
        const target = citationTarget(citation, { view, knownFeatureIds });
        if (target.kind === 'none') {
          return (
            <span key={citation.nodeId} className="mock-chat-citation mock-chat-citation-inert">
              {citation.label} <small>(not on canvas)</small>
            </span>
          );
        }
        return (
          <button
            key={citation.nodeId}
            type="button"
            className="mock-chat-citation"
            onClick={() => chat.activateCitation(citation)}
          >
            {citation.label}
          </button>
        );
      })}
    </div>
  );
}

export function ChatProgressTicker({ lines }: { lines: readonly ChatProgressLine[] }) {
  return (
    <div className="mock-chat-ticker" role="status" aria-live="polite">
      {lines.map((line) => (
        <div
          key={line.seq}
          className={line.kind === 'tool_call' ? 'mock-chat-ticker-line mock-chat-ticker-mono' : 'mock-chat-ticker-line'}
        >
          {line.kind === 'tool_call' ? `${line.tool ?? ''}: ${line.detail ?? ''}` : line.detail}
        </div>
      ))}
    </div>
  );
}

export function ChatTurnItem({ turn }: { turn: ChatTranscriptTurn }) {
  const chat = useWorkspaceChat();

  if (turn.role === 'user') {
    return (
      <div className="mock-chat-turn mock-chat-turn-user">
        <p>{turn.content}</p>
      </div>
    );
  }

  return (
    <div className="mock-chat-turn mock-chat-turn-assistant">
      {turn.status === 'running' && turn.progress.length > 0 && <ChatProgressTicker lines={turn.progress} />}
      {turn.status === 'completed' && (
        <>
          <ChatAnswer answer={turn.content} />
          {turn.citations !== null && turn.citations.length > 0 && <ChatCitationRow citations={turn.citations} />}
          <ChatMetricsFooter metrics={turn.metrics} />
        </>
      )}
      {turn.status === 'error' && turn.error !== null && (
        <div className="mock-chat-turn-error" role="alert">
          <p>{turn.error.message}</p>
          <button
            type="button"
            className="mock-btn mock-btn-ghost mock-btn-sm"
            onClick={() => chat.retry(turn.id)}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

export function ChatTranscriptList({ turns }: { turns: readonly ChatTranscriptTurn[] }) {
  return (
    <div className="mock-chat-transcript">
      {turns.map((turn) => (
        <ChatTurnItem key={turn.id} turn={turn} />
      ))}
    </div>
  );
}

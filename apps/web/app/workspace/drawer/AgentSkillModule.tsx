'use client';

import { useEffect, useMemo, useState } from 'react';
import { useWorkspaceFixture, useWorkspaceOperations, useWorkspaceQueries, useWorkspaceSession } from '../state';
import type { AgentSkillVersion, NodeOverlay } from '../types';
import { EmptyState, Module, formatTimestamp } from '../components/ui';
import {
  agentSkillDraftIssues,
  starterAgentSkillContent,
} from '../agentSkillContract';

interface AgentSkillModuleProps {
  overlay: NodeOverlay | null;
  nodeId: string;
  nodeName: string;
  title?: string;
  defaultOpen?: boolean;
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'invalid'; issues: string[] }
  | { kind: 'conflict' }
  | { kind: 'error'; message: string }
  | { kind: 'saved'; version: number };

function requestStatus(error: unknown): number | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
  ) {
    return error.status;
  }
  return null;
}

export function AgentSkillModule({
  overlay,
  nodeId,
  nodeName,
  title = 'Agent / Skill MD',
  defaultOpen = true,
}: AgentSkillModuleProps) {
  const { isAdmin } = useWorkspaceSession();
  const { reloadOverlay } = useWorkspaceQueries();
  const { saveAgentSkillMd } = useWorkspaceOperations();
  const fixture = useWorkspaceFixture();
  const current = overlay?.agentSkillMd ?? null;
  const history = overlay?.agentSkillHistory ?? [];

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(
    current?.content ?? starterAgentSkillContent(nodeName),
  );
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [preview, setPreview] = useState<AgentSkillVersion | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [saved, setSaved] = useState<AgentSkillVersion | null>(null);

  // Switching nodes abandons any in-progress edit rather than carrying a draft
  // from one document onto another.
  useEffect(() => {
    setEditing(false);
    setDraft(current?.content ?? starterAgentSkillContent(nodeName));
    setSaveState({ kind: 'idle' });
    setPreview(null);
    setShowHistory(false);
    setSaved(null);
  }, [overlay?.nodeId, current?.content, nodeName]);

  const document = saved ?? current;
  const dirty = editing && draft !== (document?.content ?? '');

  const versionLabel = useMemo(() => {
    if (document === null) return 'no document';
    return `v${document.version} · ${document.editorLabel} · ${formatTimestamp(
      document.createdAt,
    )}`;
  }, [document]);

  const onSave = async () => {
    const issues = agentSkillDraftIssues(draft);
    if (issues.length > 0) {
      setSaveState({ kind: 'invalid', issues });
      return;
    }
    setSaveState({ kind: 'saving' });
    try {
      const result = await saveAgentSkillMd(
        nodeId,
        draft,
        document?.version ?? 0,
      );
      setSaved(result);
      setEditing(false);
      setSaveState({ kind: 'saved', version: result.version });
    } catch (error) {
      const status = requestStatus(error);
      if (status === 409 || fixture?.state.agentSkillConflict === true) {
        setSaveState({ kind: 'conflict' });
      } else if (status === 400) {
        setSaveState({
          kind: 'error',
          message:
            'The service rejected this contract. Check the required section headings and try again.',
        });
      } else if (status === 401 || status === 403) {
        setSaveState({
          kind: 'error',
          message: 'Your session cannot edit this document.',
        });
      } else {
        setSaveState({
          kind: 'error',
          message:
            'The document could not be saved. Your draft is still open and nothing was overwritten.',
        });
      }
    }
  };

  return (
    <Module
      title={title}
      count={document === null ? '—' : `v${document.version}`}
      defaultOpen={defaultOpen}
    >
      <div className="mock-md-meta">
        <span>{versionLabel}</span>
        {!isAdmin && <span>· read-only</span>}
        {dirty && <span>· unsaved changes</span>}
      </div>

      {document === null && !editing ? (
        <>
          <EmptyState>
            No Agent/Skill MD has been written for {nodeName} yet.
            {isAdmin
              ? ' Create one to give agents an explicit tool, context, and guardrail contract for this node.'
              : ' An administrator or owner can create one.'}
          </EmptyState>
          {isAdmin && (
            <div className="mock-md-footer">
              <button
                type="button"
                className="mock-btn mock-btn-secondary mock-btn-sm"
                onClick={() => {
                  setDraft(starterAgentSkillContent(nodeName));
                  setEditing(true);
                }}
              >
                Create document
              </button>
            </div>
          )}
        </>
      ) : editing ? (
        <>
          <textarea
            className="mock-md-editor"
            value={draft}
            aria-label="Agent/Skill Markdown"
            spellCheck={false}
            onChange={(event) => {
              setDraft(event.target.value);
              if (saveState.kind !== 'idle') setSaveState({ kind: 'idle' });
            }}
          />
          <div className="mock-md-footer">
            <button
              type="button"
              className="mock-btn mock-btn-primary mock-btn-sm"
              disabled={!dirty || saveState.kind === 'saving'}
              onClick={() => void onSave()}
            >
              {saveState.kind === 'saving' ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="mock-btn mock-btn-secondary mock-btn-sm"
              onClick={() => {
                setDraft(
                  document?.content ?? starterAgentSkillContent(nodeName),
                );
                setEditing(false);
                setSaveState({ kind: 'idle' });
              }}
            >
              {dirty ? 'Discard changes' : 'Cancel'}
            </button>
            <span className="mock-md-footer-note">
              {dirty ? 'unsaved changes' : 'no changes'}
            </span>
          </div>
        </>
      ) : (
        <>
          {preview !== null && (
            <div className="mock-alert">
              <strong>Viewing version {preview.version}</strong>
              Saved by {preview.editorLabel} on {formatTimestamp(preview.createdAt)}.
              This is a past version — the current document is v{document?.version}.
              <div className="mock-alert-actions">
                <button
                  type="button"
                  className="mock-btn mock-btn-secondary mock-btn-sm"
                  onClick={() => setPreview(null)}
                >
                  Back to current
                </button>
              </div>
            </div>
          )}
          <pre className="mock-md-view">{(preview ?? document)?.content}</pre>
          {isAdmin && preview === null && (
            <div className="mock-md-footer">
              <button
                type="button"
                className="mock-btn mock-btn-secondary mock-btn-sm"
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
              {saveState.kind === 'saved' && (
                <span className="mock-md-footer-note">
                  saved as v{saveState.version}
                </span>
              )}
            </div>
          )}
        </>
      )}

      {saveState.kind === 'invalid' && (
        <div className="mock-alert" role="alert">
          <strong>Fix the document contract</strong>
          Agent/Skill MD uses the same validation here and in the service:
          <ul>
            {saveState.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      {saveState.kind === 'conflict' && (
        <div className="mock-alert mock-alert-danger" role="alert">
          <strong>Someone else saved this document</strong>
          This document moved to v{(document?.version ?? 0) + 1} while you were
          editing. Your draft was not saved and nothing was overwritten.
          <div className="mock-alert-actions">
            <button
              type="button"
              className="mock-btn mock-btn-secondary mock-btn-sm"
              onClick={() => {
                fixture?.patch({ agentSkillConflict: false });
                reloadOverlay();
                setSaveState({ kind: 'idle' });
              }}
            >
              Load the latest version
            </button>
            <button
              type="button"
              className="mock-btn mock-btn-ghost mock-btn-sm"
              onClick={() => setSaveState({ kind: 'idle' })}
            >
              Keep my draft open
            </button>
          </div>
        </div>
      )}

      {saveState.kind === 'error' && (
        <div className="mock-alert mock-alert-danger" role="alert">
          <strong>Save failed</strong>
          {saveState.message}
        </div>
      )}

      {history.length > 0 && (
        <div className="mock-history">
          <button
            type="button"
            className="mock-btn mock-btn-ghost mock-btn-sm"
            aria-expanded={showHistory}
            onClick={() => setShowHistory((value) => !value)}
          >
            {showHistory ? 'Hide' : 'Show'} version history ({history.length})
          </button>
          {showHistory && (
            <ul className="mock-list" style={{ marginTop: 9 }}>
              {history.map((version) => (
                <li key={version.version}>
                  <button
                    type="button"
                    className="mock-list-row"
                    onClick={() => {
                      setPreview(version);
                      setEditing(false);
                    }}
                  >
                    <span className="mock-row-top">
                      <span className="mock-row-title">v{version.version}</span>
                      <span className="mock-chip">{version.editorLabel}</span>
                    </span>
                    <span className="mock-row-meta">
                      {formatTimestamp(version.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Module>
  );
}

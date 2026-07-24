'use client';

import React, { memo, useEffect, useState } from 'react';
import {
  NodeOverlayRequestError,
  fetchAgentSkillMdHistory,
  fetchNodeOverlay,
  saveAgentSkillMd,
  type AgentSkillMdVersion,
  type NodeOverlayResponse,
} from '../lib/nodeOverlay';

type LayerKey =
  | 'dependencies'
  | 'recentChanges'
  | 'specificFeatures'
  | 'agentSkillMd'
  | 'description'
  | 'specificTickets';

const layerLabels: Record<LayerKey, string> = {
  dependencies: 'Dependencies',
  recentChanges: 'Recent Changes',
  specificFeatures: 'Specific Features',
  agentSkillMd: 'Agent/Skill MD',
  description: 'Description',
  specificTickets: 'Specific Tickets',
};

const defaultVisibility: Record<LayerKey, boolean> = {
  dependencies: true,
  recentChanges: true,
  specificFeatures: true,
  agentSkillMd: true,
  description: true,
  specificTickets: true,
};

const emptyAgentSkillMd = `## Allowed Tools

- Describe allowed tools here.

## Required Context

- Describe context an agent must read first.

## Guardrails

- Describe boundaries the agent must not cross.
`;

type OverlayState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; overlay: NodeOverlayResponse };

const OverlayLayer = memo(function OverlayLayer({
  title,
  visible,
  children,
}: {
  title: string;
  visible: boolean;
  children: React.ReactNode;
}) {
  if (!visible) return null;
  return (
    <section className="overlay-layer">
      <h4>{title}</h4>
      {children}
    </section>
  );
});

function safeMessage(error: unknown): string {
  return error instanceof NodeOverlayRequestError
    ? error.message
    : 'The node overlay could not be loaded.';
}

function author(change: NodeOverlayResponse['recentChanges'][number]): string {
  if (change.authorName !== null) return change.authorName;
  if (change.authorLogin !== null) return `@${change.authorLogin}`;
  return 'Unknown author';
}

export function NodeOverlayPanel({ nodeId }: { nodeId: string }) {
  const [requestVersion, setRequestVersion] = useState(0);
  const [visibility, setVisibility] = useState(defaultVisibility);
  const [state, setState] = useState<OverlayState>({ status: 'loading' });
  const [draft, setDraft] = useState(emptyAgentSkillMd);
  const [saveState, setSaveState] = useState<
    { status: 'idle' } | { status: 'saving' } | { status: 'error'; message: string }
  >({ status: 'idle' });
  const [historyState, setHistoryState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; versions: AgentSkillMdVersion[] }
    | { status: 'error'; message: string }
  >({ status: 'idle' });

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState({ status: 'loading' });
    setSaveState({ status: 'idle' });
    setHistoryState({ status: 'idle' });
    setVisibility(defaultVisibility);
    void fetchNodeOverlay(nodeId, { signal: controller.signal })
      .then((overlay) => {
        if (!active) return;
        setState({ status: 'ready', overlay });
        setDraft(overlay.agentSkillMd?.content ?? emptyAgentSkillMd);
      })
      .catch((error: unknown) => {
        if (active) setState({ status: 'error', message: safeMessage(error) });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [nodeId, requestVersion]);

  if (state.status === 'loading') {
    return (
      <aside className="node-overlay-panel" aria-busy="true">
        <span className="node-inspector-label">Node overlay</span>
        <p className="overlay-status">Loading authorized metadata…</p>
      </aside>
    );
  }

  if (state.status === 'error') {
    return (
      <aside className="node-overlay-panel" role="alert">
        <span className="node-inspector-label">Node overlay</span>
        <p className="overlay-status">{state.message}</p>
        <button
          className="overlay-action"
          type="button"
          onClick={() => setRequestVersion((version) => version + 1)}
        >
          Try again
        </button>
      </aside>
    );
  }

  const { overlay } = state;
  const version = overlay.agentSkillMd?.version ?? 0;
  async function saveDocument(): Promise<void> {
    setSaveState({ status: 'saving' });
    try {
      const document = await saveAgentSkillMd(overlay.node.id, draft, version);
      setState({
        status: 'ready',
        overlay: { ...overlay, agentSkillMd: document },
      });
      setDraft(document.content);
      setSaveState({ status: 'idle' });
      setHistoryState({ status: 'idle' });
    } catch (error) {
      setSaveState({ status: 'error', message: safeMessage(error) });
    }
  }

  async function loadHistory(): Promise<void> {
    setHistoryState({ status: 'loading' });
    try {
      setHistoryState({
        status: 'ready',
        versions: await fetchAgentSkillMdHistory(overlay.node.id),
      });
    } catch (error) {
      setHistoryState({ status: 'error', message: safeMessage(error) });
    }
  }

  return (
    <aside
      className="node-overlay-panel"
      aria-live="polite"
      aria-label={`${overlay.node.name} node overlay`}
    >
      <span className="node-inspector-label">Selected {overlay.node.label}</span>
      <h3>{overlay.node.name}</h3>
      <p className="overlay-path" title={overlay.node.path}>
        {overlay.node.path || '/'}
      </p>

      <div className="overlay-toggles" aria-label="Overlay layers">
        {(Object.keys(layerLabels) as LayerKey[]).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={visibility[key]}
            onClick={() =>
              setVisibility((current) => ({ ...current, [key]: !current[key] }))
            }
          >
            {layerLabels[key]}
          </button>
        ))}
      </div>

      <div className="overlay-layers">
        <OverlayLayer title="Dependencies" visible={visibility.dependencies}>
          {overlay.dependencies.length === 0 ? (
            <p className="overlay-empty">No visible imports.</p>
          ) : (
            <ul>
              {overlay.dependencies.map((dependency) => (
                <li key={`${dependency.direction}:${dependency.id}`}>
                  <strong>{dependency.name}</strong>
                  <span>{dependency.direction} · {dependency.path}</span>
                </li>
              ))}
            </ul>
          )}
        </OverlayLayer>

        <OverlayLayer title="Recent Changes" visible={visibility.recentChanges}>
          {overlay.recentChanges.length === 0 ? (
            <p className="overlay-empty">No recent changes.</p>
          ) : (
            <ul>
              {overlay.recentChanges.map((change) => (
                <li key={change.commitId}>
                  <strong>{change.message ?? change.sha.slice(0, 12)}</strong>
                  <span>{author(change)} · <time dateTime={change.timestamp}>
                    {new Date(change.timestamp).toLocaleString()}
                  </time></span>
                </li>
              ))}
            </ul>
          )}
        </OverlayLayer>

        <OverlayLayer title="Specific Features" visible={visibility.specificFeatures}>
          {overlay.specificFeatures.length === 0 ? (
            <p className="overlay-empty">No visible feature membership.</p>
          ) : (
            <ul>
              {overlay.specificFeatures.map((feature) => (
                <li key={feature.id}>
                  <strong>{feature.name}</strong>
                  <span>{feature.team ?? 'No team'} · {feature.description ?? 'No description'}</span>
                </li>
              ))}
            </ul>
          )}
        </OverlayLayer>

        <OverlayLayer title="Agent/Skill MD" visible={visibility.agentSkillMd}>
          <textarea
            className="agent-skill-editor"
            aria-label="Agent/Skill MD content"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
          />
          <div className="agent-skill-footer">
            <span>
              {overlay.agentSkillMd === null
                ? 'No saved version'
                : `v${overlay.agentSkillMd.version} · ${overlay.agentSkillMd.editorLabel}`}
            </span>
            <button
              className="overlay-action"
              type="button"
              disabled={saveState.status === 'saving'}
              onClick={() => void saveDocument()}
            >
              {saveState.status === 'saving' ? 'Saving…' : 'Save new version'}
            </button>
          </div>
          {historyState.status === 'idle' && overlay.agentSkillMd !== null && (
            <button
              className="overlay-history-button"
              type="button"
              onClick={() => void loadHistory()}
            >
              View version history
            </button>
          )}
          {historyState.status === 'loading' && (
            <p className="overlay-empty">Loading version history…</p>
          )}
          {historyState.status === 'ready' && (
            <ul className="agent-skill-history">
              {historyState.versions.map((entry) => (
                <li key={entry.version}>
                  <span>
                    v{entry.version} · {entry.editorLabel} ·{' '}
                    <time dateTime={entry.createdAt}>
                      {new Date(entry.createdAt).toLocaleString()}
                    </time>
                  </span>
                  <button
                    type="button"
                    onClick={() => setDraft(entry.content)}
                  >
                    Restore v{entry.version} to editor
                  </button>
                </li>
              ))}
            </ul>
          )}
          {historyState.status === 'error' && (
            <p className="overlay-save-error" role="alert">{historyState.message}</p>
          )}
          {saveState.status === 'error' && (
            <p className="overlay-save-error" role="alert">{saveState.message}</p>
          )}
        </OverlayLayer>

        <OverlayLayer title="Description" visible={visibility.description}>
          <p>{overlay.description ?? 'No description is available.'}</p>
        </OverlayLayer>

        <OverlayLayer title="Specific Tickets" visible={visibility.specificTickets}>
          {overlay.specificTickets.length === 0 ? (
            <p className="overlay-empty">No visible linked tickets.</p>
          ) : (
            <ul>
              {overlay.specificTickets.map((ticket) => (
                <li key={ticket.id}>
                  <strong>{ticket.externalId} · {ticket.title ?? 'Untitled'}</strong>
                  <span>{ticket.system} · {ticket.status ?? 'Unknown status'}</span>
                </li>
              ))}
            </ul>
          )}
        </OverlayLayer>
      </div>
    </aside>
  );
}

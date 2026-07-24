'use client';

import { useEffect, useState } from 'react';
import type {
  McpClientKeyIssued,
  McpClientKeyView,
  McpKeySettingsResponse,
  McpReadGrant,
} from '@sayre/shared-types';

const API_PATH = '/api/mcp-settings';

interface Draft {
  name: string;
  repoId: string;
  branch: string;
  pathPrefix: string;
  expiresAt: string;
}

const EMPTY_DRAFT: Draft = {
  name: '',
  repoId: '',
  branch: '',
  pathPrefix: '',
  expiresAt: '',
};

function nullable(value: string): string | null {
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function grantSummary(grant: McpReadGrant): string {
  return [
    grant.repoId ?? 'all repositories',
    grant.branch ?? 'all branches',
    grant.pathPrefix ?? '/',
  ].join(' · ');
}

export function McpSettingsPanel() {
  const [data, setData] = useState<McpKeySettingsResponse | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [issued, setIssued] = useState<McpClientKeyIssued | null>(null);
  const [status, setStatus] = useState<string>('Loading MCP access…');
  const [rateLimit, setRateLimit] = useState('60');

  async function reload(): Promise<void> {
    const response = await fetch(API_PATH, {
      credentials: 'include',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('request failed');
    const next = (await response.json()) as McpKeySettingsResponse;
    setData(next);
    setRateLimit(String(next.rateLimitPerMinute));
    setStatus('');
  }

  useEffect(() => {
    void reload().catch(() => setStatus('MCP settings could not be loaded.'));
  }, []);

  async function issue(): Promise<void> {
    setStatus('Issuing credential…');
    setIssued(null);
    try {
      const response = await fetch(`${API_PATH}/keys`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: draft.name.trim(),
          expiresAt: draft.expiresAt
            ? new Date(draft.expiresAt).toISOString()
            : null,
          grants: [
            {
              repoId: nullable(draft.repoId),
              branch: nullable(draft.branch),
              pathPrefix: nullable(draft.pathPrefix),
            },
          ],
        }),
      });
      if (!response.ok) throw new Error('request failed');
      const key = (await response.json()) as McpClientKeyIssued;
      setIssued(key);
      setDraft(EMPTY_DRAFT);
      await reload();
    } catch {
      setStatus('Credential could not be issued. Check the requested scope.');
    }
  }

  async function revoke(key: McpClientKeyView): Promise<void> {
    setStatus(`Revoking ${key.name}…`);
    try {
      const response = await fetch(`${API_PATH}/keys/${key.id}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error('request failed');
      await reload();
    } catch {
      setStatus('Credential could not be revoked.');
    }
  }

  async function saveRateLimit(): Promise<void> {
    setStatus('Saving rate limit…');
    try {
      const response = await fetch(`${API_PATH}/rate-limit`, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ rateLimitPerMinute: Number(rateLimit) }),
      });
      if (!response.ok) throw new Error('request failed');
      await reload();
    } catch {
      setStatus('Rate limit could not be saved.');
    }
  }

  if (!data) {
    return (
      <div className={`settings-status${status.includes('could not') ? ' settings-error' : ''}`}>
        {status}
      </div>
    );
  }

  return (
    <div className="mcp-settings-grid">
      {issued && (
        <section className="mcp-token-panel" aria-live="polite">
          <span className="settings-eyebrow">Copy now · shown once</span>
          <code>{issued.token}</code>
          <p>
            Store this token in your MCP client&apos;s secret store. Sayre keeps
            only a peppered HMAC and cannot show it again.
          </p>
        </section>
      )}

      <section className="provider-card mcp-issue-card">
        <div className="provider-card-heading">
          <div>
            <span className="settings-eyebrow">New credential</span>
            <h2>Issue scoped key</h2>
          </div>
          <span className="purpose-pill">read only</span>
        </div>
        <label className="settings-field">
          Name
          <input
            value={draft.name}
            maxLength={100}
            onChange={(event) =>
              setDraft((current) => ({ ...current, name: event.target.value }))
            }
            placeholder="Local coding agent"
          />
        </label>
        <label className="settings-field">
          Repository UUID
          <input
            value={draft.repoId}
            onChange={(event) =>
              setDraft((current) => ({ ...current, repoId: event.target.value }))
            }
            placeholder="Blank only for tenant-wide owner access"
          />
        </label>
        <label className="settings-field">
          Branch
          <input
            value={draft.branch}
            onChange={(event) =>
              setDraft((current) => ({ ...current, branch: event.target.value }))
            }
            placeholder="main or refs/heads/main"
          />
        </label>
        <label className="settings-field">
          Path prefix
          <input
            value={draft.pathPrefix}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                pathPrefix: event.target.value,
              }))
            }
            placeholder="/services/core"
          />
        </label>
        <label className="settings-field">
          Expires
          <input
            type="datetime-local"
            value={draft.expiresAt}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                expiresAt: event.target.value,
              }))
            }
          />
        </label>
        <div className="provider-card-actions">
          <button
            className="settings-save"
            type="button"
            disabled={!draft.name.trim()}
            onClick={() => void issue()}
          >
            Issue credential
          </button>
        </div>
      </section>

      <section className="provider-card mcp-rate-card">
        <span className="settings-eyebrow">Organization policy</span>
        <h2>Per-key call limit</h2>
        <label className="settings-field">
          Calls per minute
          <input
            type="number"
            min={1}
            max={10000}
            value={rateLimit}
            onChange={(event) => setRateLimit(event.target.value)}
          />
        </label>
        <div className="provider-card-actions">
          <button
            className="settings-save"
            type="button"
            onClick={() => void saveRateLimit()}
          >
            Save limit
          </button>
        </div>
      </section>

      <section className="tradeoff-panel mcp-key-list">
        <span className="settings-eyebrow">Credentials</span>
        <h2>Issued keys</h2>
        {data.keys.length === 0 ? (
          <p className="mcp-empty">No MCP credentials have been issued.</p>
        ) : (
          <div className="mcp-key-rows">
            {data.keys.map((key) => (
              <article key={key.id}>
                <div>
                  <strong>{key.name}</strong>
                  <code>{key.keyPrefix}</code>
                  {key.grants.map((grant) => (
                    <small key={grantSummary(grant)}>{grantSummary(grant)}</small>
                  ))}
                </div>
                <div className="mcp-key-state">
                  <span>{key.revokedAt ? 'Revoked' : 'Active'}</span>
                  {!key.revokedAt && (
                    <button type="button" onClick={() => void revoke(key)}>
                      Revoke
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {status && <p className="save-message">{status}</p>}
    </div>
  );
}

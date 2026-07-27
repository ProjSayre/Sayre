'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  McpClientKeyCreateRequest,
  McpClientKeyIssued,
  McpClientKeyView,
  McpKeySettingsResponse,
  McpReadGrant,
} from '@sayre/shared-types';
import { useMock } from '../state';
import { Badge } from '../components/ui';

interface Draft {
  name: string;
  repoId: string;
  branch: string;
  pathPrefix: string;
  expiresAt: string;
}

function initialDraft(
  repositoryId: string | null,
  refName: string | null,
): Draft {
  return {
    name: '',
    repoId: repositoryId ?? '',
    branch: refName ?? '',
    pathPrefix: '',
    expiresAt: '',
  };
}

function nullable(value: string): string | null {
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function keyWithoutToken(key: McpClientKeyIssued): McpClientKeyView {
  const { token: _token, ...view } = key;
  return view;
}

function readableDate(value: string | null): string {
  if (value === null) return 'never';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function grantSummary(
  grant: McpReadGrant,
  repositoryNames: ReadonlyMap<string, string>,
): string {
  return [
    grant.repoId === null
      ? 'all authorized repositories'
      : repositoryNames.get(grant.repoId) ?? grant.repoId,
    grant.branch?.replace(/^refs\/heads\//u, '') ?? 'all refs',
    grant.pathPrefix ?? 'repository root',
  ].join(' · ');
}

export function McpSettings() {
  const {
    repositories,
    repository,
    scope,
    loadMcpSettings,
    issueMcpKey,
    revokeMcpKey,
    saveMcpRateLimit,
  } = useMock();
  const [data, setData] = useState<McpKeySettingsResponse | null>(null);
  const [draft, setDraft] = useState<Draft>(() =>
    initialDraft(repository?.id ?? null, scope?.refName ?? null),
  );
  const [issued, setIssued] = useState<McpClientKeyIssued | null>(null);
  const [rateLimit, setRateLimit] = useState('60');
  const [loadVersion, setLoadVersion] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);

  const repositoryNames = useMemo(
    () =>
      new Map(
        repositories.map((candidate) => [candidate.id, candidate.name] as const),
      ),
    [repositories],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(false);
    void loadMcpSettings(controller.signal)
      .then((response) => {
        setData(response);
        setRateLimit(String(response.rateLimitPerMinute));
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== 'AbortError') {
          setLoadError(true);
        }
      });
    return () => controller.abort();
  }, [loadMcpSettings, loadVersion]);

  function updateDraft(patch: Partial<Draft>): void {
    setDraft((current) => ({ ...current, ...patch }));
    setStatus('');
  }

  async function issue(): Promise<void> {
    let expiresAt: string | null = null;
    if (draft.expiresAt.length > 0) {
      const expiry = Date.parse(draft.expiresAt);
      const maximum = Date.now() + 366 * 24 * 60 * 60 * 1_000;
      if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > maximum) {
        setStatus('Expiry must be in the future and no more than 366 days away.');
        return;
      }
      expiresAt = new Date(expiry).toISOString();
    }
    const pathPrefix = nullable(draft.pathPrefix);
    if (
      pathPrefix?.includes('\\') ||
      pathPrefix?.includes('//') ||
      pathPrefix?.split('/').some((segment) => segment === '..')
    ) {
      setStatus('Path prefix must be a repository-relative path without traversal.');
      return;
    }
    const request: McpClientKeyCreateRequest = {
      name: draft.name.trim(),
      expiresAt,
      grants: [
        {
          repoId: nullable(draft.repoId),
          branch: nullable(draft.branch),
          pathPrefix,
        },
      ],
    };
    setOperation('issue');
    setIssued(null);
    setStatus('Issuing a read-only credential…');
    try {
      const key = await issueMcpKey(request);
      setIssued(key);
      setData((current) =>
        current === null
          ? current
          : { ...current, keys: [keyWithoutToken(key), ...current.keys] },
      );
      setDraft(
        initialDraft(repository?.id ?? null, scope?.refName ?? null),
      );
      setStatus('Credential issued. Copy the token before leaving this page.');
    } catch {
      setStatus(
        'Credential could not be issued. Check that its scope is within your current access.',
      );
    } finally {
      setOperation(null);
    }
  }

  async function copyIssuedToken(): Promise<void> {
    if (issued === null) return;
    try {
      await navigator.clipboard.writeText(issued.token);
      setStatus('Token copied. Store it in your MCP client secret store.');
    } catch {
      setStatus('Clipboard access was unavailable. Select and copy the token manually.');
    }
  }

  async function revoke(key: McpClientKeyView): Promise<void> {
    setOperation(`revoke:${key.id}`);
    setStatus(`Revoking ${key.name}…`);
    try {
      const revoked = await revokeMcpKey(key.id);
      setData((current) =>
        current === null
          ? current
          : {
              ...current,
              keys: current.keys.map((candidate) =>
                candidate.id === revoked.id ? revoked : candidate,
              ),
            },
      );
      setIssued((current) =>
        current?.id === revoked.id ? null : current,
      );
      setPendingRevokeId(null);
      setStatus(`${key.name} was revoked. Its next MCP request will be rejected.`);
    } catch {
      setStatus('Credential could not be revoked. Refresh and try again.');
    } finally {
      setOperation(null);
    }
  }

  async function saveRateLimit(): Promise<void> {
    const value = Number(rateLimit);
    if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
      setStatus('Calls per minute must be a whole number from 1 to 10,000.');
      return;
    }
    setOperation('rate');
    setStatus('Saving the organization rate policy…');
    try {
      const saved = await saveMcpRateLimit(value);
      setData((current) =>
        current === null
          ? current
          : { ...current, rateLimitPerMinute: saved.rateLimitPerMinute },
      );
      setRateLimit(String(saved.rateLimitPerMinute));
      setStatus('Rate policy saved. It applies independently to every key.');
    } catch {
      setStatus('Rate policy could not be saved.');
    } finally {
      setOperation(null);
    }
  }

  if (loadError) {
    return (
      <section className="mock-card">
        <div className="mock-alert mock-alert-danger" role="alert">
          <strong>MCP agent access unavailable</strong>
          Issued keys and organization policy could not be loaded.
          <div className="mock-alert-actions">
            <button
              type="button"
              className="mock-btn mock-btn-secondary mock-btn-sm"
              onClick={() => setLoadVersion((version) => version + 1)}
            >
              Try again
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (data === null) {
    return (
      <section className="mock-card" aria-live="polite">
        <p className="mock-empty">Loading MCP agent access…</p>
      </section>
    );
  }

  const nameValid = draft.name.trim().length > 0;

  return (
    <>
      {issued !== null && (
        <section className="mock-card mock-mcp-token" aria-live="polite">
          <div className="mock-card-head">
            <div>
              <h3>Copy now · shown once</h3>
              <p>
                Sayre stores only a peppered HMAC and cannot show this token
                again.
              </p>
            </div>
            <Badge tone="warn">secret</Badge>
          </div>
          <code className="mock-mcp-token-value">{issued.token}</code>
          <div className="mock-card-actions">
            <button
              type="button"
              className="mock-btn mock-btn-primary"
              onClick={() => void copyIssuedToken()}
            >
              Copy token
            </button>
            <button
              type="button"
              className="mock-btn mock-btn-secondary"
              onClick={() => {
                setIssued(null);
                setStatus('The one-time token was hidden.');
              }}
            >
              Hide token
            </button>
            <span className="mock-field-help">
              Store it in the MCP client&apos;s secret store, never in a
              repository or preset.
            </span>
          </div>
        </section>
      )}

      <section className="mock-card">
        <div className="mock-card-head">
          <div>
            <h3>Issue a scoped credential</h3>
            <p>
              External clients receive read-only access intersected with your
              current server-side permissions.
            </p>
          </div>
          <Badge tone="ready">read only</Badge>
        </div>

        <div className="mock-fields">
          <label className="mock-field">
            <span>Name</span>
            <input
              value={draft.name}
              maxLength={100}
              autoComplete="off"
              placeholder="Planning agent on my laptop"
              onChange={(event) => updateDraft({ name: event.target.value })}
            />
          </label>

          <label className="mock-field">
            <span>Repository scope</span>
            <select
              value={draft.repoId}
              onChange={(event) => updateDraft({ repoId: event.target.value })}
            >
              <option value="">All authorized repositories (owner only)</option>
              {repositories.map((candidate) => (
                <option value={candidate.id} key={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
            <span className="mock-field-help">
              The server receives a Repository UUID and rejects scopes broader
              than the issuer&apos;s current access.
            </span>
          </label>

          <label className="mock-field">
            <span>Branch or ref</span>
            <input
              value={draft.branch}
              autoComplete="off"
              placeholder="refs/heads/main"
              onChange={(event) => updateDraft({ branch: event.target.value })}
            />
          </label>

          <label className="mock-field">
            <span>Path prefix</span>
            <input
              value={draft.pathPrefix}
              autoComplete="off"
              placeholder="services/core"
              onChange={(event) =>
                updateDraft({ pathPrefix: event.target.value })
              }
            />
            <span className="mock-field-help">
              Use a repository-relative path. Leave blank for the repository
              root.
            </span>
          </label>

          <label className="mock-field">
            <span>Expires</span>
            <input
              type="datetime-local"
              value={draft.expiresAt}
              onChange={(event) =>
                updateDraft({ expiresAt: event.target.value })
              }
            />
          </label>
        </div>

        <div className="mock-card-actions">
          <button
            type="button"
            className="mock-btn mock-btn-primary"
            disabled={!nameValid || operation !== null}
            onClick={() => void issue()}
          >
            {operation === 'issue' ? 'Issuing…' : 'Issue credential'}
          </button>
        </div>
      </section>

      <section className="mock-card">
        <div className="mock-card-head">
          <div>
            <h3>Per-key call limit</h3>
            <p>
              Organization policy limits each key independently before a tool
              call reaches the graph.
            </p>
          </div>
          <Badge>{data.rateLimitPerMinute}/min</Badge>
        </div>
        <label className="mock-field">
          <span>Calls per minute</span>
          <input
            type="number"
            min={1}
            max={10_000}
            step={1}
            value={rateLimit}
            onChange={(event) => setRateLimit(event.target.value)}
          />
        </label>
        <div className="mock-card-actions">
          <button
            type="button"
            className="mock-btn mock-btn-primary"
            disabled={operation !== null}
            onClick={() => void saveRateLimit()}
          >
            {operation === 'rate' ? 'Saving…' : 'Save limit'}
          </button>
        </div>
      </section>

      <section className="mock-card">
        <div className="mock-card-head">
          <div>
            <h3>Issued credentials</h3>
            <p>
              Tokens are never shown again. Revocation takes effect on the next
              call without an authentication cache.
            </p>
          </div>
          <Badge>{data.keys.length}</Badge>
        </div>

        {data.keys.length === 0 ? (
          <p className="mock-empty">No MCP credentials have been issued.</p>
        ) : (
          <div className="mock-mcp-key-list">
            {data.keys.map((key) => {
              const active = key.revokedAt === null;
              const confirming = pendingRevokeId === key.id;
              return (
                <article className="mock-mcp-key" key={key.id}>
                  <div className="mock-mcp-key-head">
                    <div>
                      <strong>{key.name}</strong>
                      <code>{key.keyPrefix}</code>
                    </div>
                    <Badge tone={active ? 'ready' : 'danger'}>
                      {active ? 'active' : 'revoked'}
                    </Badge>
                  </div>
                  <ul className="mock-mcp-grants">
                    {key.grants.map((grant, index) => (
                      <li key={`${key.id}:${index}`}>
                        {grantSummary(grant, repositoryNames)}
                      </li>
                    ))}
                  </ul>
                  <div className="mock-mcp-meta">
                    <span>Created {readableDate(key.createdAt)}</span>
                    <span>Expires {readableDate(key.expiresAt)}</span>
                    <span>Last used {readableDate(key.lastUsedAt)}</span>
                  </div>
                  {active && (
                    <div className="mock-card-actions">
                      {confirming ? (
                        <>
                          <button
                            type="button"
                            className="mock-btn mock-btn-danger mock-btn-sm"
                            disabled={operation !== null}
                            onClick={() => void revoke(key)}
                          >
                            {operation === `revoke:${key.id}`
                              ? 'Revoking…'
                              : 'Confirm revoke'}
                          </button>
                          <button
                            type="button"
                            className="mock-btn mock-btn-ghost mock-btn-sm"
                            disabled={operation !== null}
                            onClick={() => setPendingRevokeId(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="mock-btn mock-btn-secondary mock-btn-sm"
                          disabled={operation !== null}
                          onClick={() => setPendingRevokeId(key.id)}
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {status.length > 0 && (
        <p className="mock-settings-status" role="status" aria-live="polite">
          {status}
        </p>
      )}
    </>
  );
}

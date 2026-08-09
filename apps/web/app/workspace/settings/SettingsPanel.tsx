'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  ProviderKind,
  ProviderPurpose,
  ProviderSettingsResponse,
} from '@sayre/shared-types';
import type {
  GitHubIntegrationStatusResponse,
  GitHubRepositoryImportState,
} from '../../lib/githubIntegrationStatus';
import type { JiraStatusResponse } from '../../lib/jiraIntegrationStatus';
import {
  buildProviderSettingsUpdate,
  draftFor,
  type ProviderSettingsDraft,
} from '../../settings/providers/providerSettingsClient';
import { useWorkspaceFixture, useWorkspaceNavigation, useWorkspaceOperations, useWorkspaceSession } from '../state';
import { reconnectFixtureJira } from '../dataSource';
import type { InstallationOutcome } from '../types';
import { Badge, Reserved } from '../components/ui';
import { settingsSection, settingsSections } from '../settingsRegistry';
import { providerConfigurationStatus } from '../providerSettingsContract';
import { McpSettings } from './McpSettings';
import { WorkspacePackSettings } from './WorkspacePackSettings';
import { useOptionalWorkspacePack } from '../packs/WorkspacePackProvider';

const PURPOSES: readonly ProviderPurpose[] = ['generation', 'embedding'];

const IMPORT_COPY: Record<
  GitHubRepositoryImportState,
  {
    label: string;
    detail: string;
    tone: 'ready' | 'warn' | 'danger' | 'neutral' | 'working';
  }
> = {
  preparing: {
    label: 'importing',
    detail: 'Sayre is building the repository graph.',
    tone: 'working',
  },
  ready: {
    label: 'ready',
    detail: 'The repository graph is available in the workspace.',
    tone: 'ready',
  },
  empty: {
    label: 'empty repository',
    detail: 'GitHub did not report a default branch to import.',
    tone: 'warn',
  },
};

const INSTALL_COPY: Record<
  InstallationOutcome,
  {
    headline: string;
    detail: string;
    tone: 'ready' | 'warn' | 'danger' | 'neutral';
  }
> = {
  'not-installed': {
    headline: 'GitHub App not installed',
    detail:
      'Install the Sayre GitHub App on your organization and choose which repositories Sayre may read. Nothing is parsed until you do.',
    tone: 'neutral',
  },
  installed: {
    headline: 'GitHub App installed',
    detail:
      'Sayre can read the repositories selected during installation. The selection can be changed in GitHub at any time.',
    tone: 'ready',
  },
  'approval-required': {
    headline: 'Waiting for organization approval',
    detail:
      'A GitHub organization owner must approve the request before Sayre can read any repository.',
    tone: 'warn',
  },
  denied: {
    headline: 'Installation was not completed',
    detail:
      'The installation was cancelled or declined. No repository access was granted.',
    tone: 'warn',
  },
  error: {
    headline: 'Installation could not be completed',
    detail:
      'GitHub returned an error. No repository access was granted; the flow can be started again safely.',
    tone: 'danger',
  },
};

const PURPOSE_COPY: Record<
  ProviderPurpose,
  { title: string; description: string }
> = {
  generation: {
    title: 'Generation',
    description:
      'Writes node descriptions, feature boundaries, and Product Tree summaries.',
  },
  embedding: {
    title: 'Embedding',
    description:
      'Turns authorized code and document chunks into vectors for retrieval.',
  },
};

function providersFor(purpose: ProviderPurpose): readonly ProviderKind[] {
  return purpose === 'generation'
    ? ['anthropic', 'openai', 'openai_compatible']
    : ['openai', 'openai_compatible'];
}

function providerLabel(provider: ProviderKind): string {
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'openai') return 'OpenAI';
  return 'Approved self-hosted / OpenAI-compatible';
}

function GitHubIntegrations() {
  const { githubInstallUrl, loadGitHubIntegrationStatus } = useWorkspaceOperations();
  const session = useWorkspaceSession();
  const fixture = useWorkspaceFixture();
  const [status, setStatus] =
    useState<GitHubIntegrationStatusResponse | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const refresh = (): void => {
      void loadGitHubIntegrationStatus(controller.signal)
        .then((response) => {
          if (!active) return;
          setStatus(response);
          setLoadState('ready');
          if (response.repositories.some(
            (repository) => repository.state === 'preparing',
          )) {
            session.reloadCatalog();
            timer = setTimeout(refresh, 2_500);
          }
        })
        .catch((error: unknown) => {
          if (!active || (error as { name?: string }).name === 'AbortError') {
            return;
          }
          setLoadState('error');
        });
    };

    refresh();
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
      controller.abort();
    };
  }, [loadGitHubIntegrationStatus, reloadVersion, session]);

  const hasActiveInstallation =
    status?.installations.some(
      (installation) => installation.state === 'active',
    ) ?? false;
  const outcome =
    session.mode === 'fixture'
      ? fixture?.state.installation ?? 'not-installed'
      : hasActiveInstallation
        ? 'installed'
        : 'not-installed';
  const copy = INSTALL_COPY[outcome];

  function startInstallation(): void {
    if (session.mode === 'fixture') {
      fixture?.patch({ installation: 'installed' });
      return;
    }
    window.location.assign(githubInstallUrl);
  }

  return (
    <>
      <section className="mock-card">
        <div className="mock-card-head">
          <div>
            <h3>{copy.headline}</h3>
            <p>{copy.detail}</p>
          </div>
          <Badge tone={copy.tone}>{outcome.replace('-', ' ')}</Badge>
        </div>

        {outcome === 'installed' && status !== null && (
          <dl className="mock-kv">
            <div>
              <dt>Connected account</dt>
              <dd>
                {status.installations
                  .filter((installation) => installation.state === 'active')
                  .map(
                    (installation) =>
                      installation.accountLogin ?? 'GitHub account',
                  )
                  .join(', ')}
              </dd>
            </div>
            <div>
              <dt>Repositories ready</dt>
              <dd>
                {
                  status.repositories.filter(
                    (repository) => repository.state === 'ready',
                  ).length
                }{' '}
                of {status.repositories.length}
              </dd>
            </div>
          </dl>
        )}

        <div className="mock-card-actions">
          <button
            type="button"
            className="mock-btn mock-btn-primary"
            onClick={startInstallation}
          >
            {outcome === 'installed'
              ? 'Manage installation on GitHub'
              : outcome === 'approval-required'
                ? 'Open the pending request on GitHub'
                : outcome === 'not-installed'
                  ? 'Install the GitHub App'
                  : 'Start the installation again'}
          </button>
          <button
            type="button"
            className="mock-btn mock-btn-secondary"
            onClick={() => {
              setLoadState('loading');
              setReloadVersion((version) => version + 1);
            }}
            disabled={loadState === 'loading'}
          >
            Refresh status
          </button>
          {outcome === 'approval-required' && (
            <span className="mock-field-help">
              An organization owner can approve the request in GitHub. Sayre
              reads nothing until they do.
            </span>
          )}
        </div>
      </section>

      <section className="mock-card">
        <div className="mock-card-head">
          <div>
            <h3>Installation health and per-repository sync</h3>
            <p>
              Account health, repository-by-repository sync state, and reconnect
              controls.
            </p>
          </div>
        </div>
        {loadState === 'loading' && status === null && (
          <p className="mock-field-help" role="status">
            Checking the GitHub connection…
          </p>
        )}
        {loadState === 'error' && (
          <div className="mock-inline-error" role="alert">
            Connection status could not be loaded. The repository catalog is
            unchanged; try refreshing this status.
          </div>
        )}
        {status !== null && (
          <>
            {status.installations.length === 0 ? (
              <p className="mock-field-help">
                No GitHub App installation is connected to this organization.
              </p>
            ) : (
              <dl className="mock-kv">
                {status.installations.map((installation, index) => (
                  <div
                    key={`${installation.accountLogin ?? 'account'}-${index}`}
                  >
                    <dt>
                      {installation.accountLogin ?? 'GitHub account'} ·{' '}
                      {installation.repositorySelection ?? 'unknown selection'}
                    </dt>
                    <dd>
                      <Badge
                        tone={
                          installation.state === 'active'
                            ? 'ready'
                            : installation.state === 'suspended'
                              ? 'warn'
                              : 'danger'
                        }
                      >
                        {installation.state}
                      </Badge>
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            <div className="mock-import-list">
              {status.repositories.length === 0 ? (
                <p className="mock-field-help">
                  No repositories are registered. Choose repositories during
                  GitHub installation to begin the first import.
                </p>
              ) : (
                status.repositories.map((repository) => {
                  const copyForState = IMPORT_COPY[repository.state];
                  return (
                    <article className="mock-import-row" key={repository.id}>
                      <div>
                        <strong>{repository.name}</strong>
                        <span>{copyForState.detail}</span>
                      </div>
                      <Badge tone={copyForState.tone}>
                        {copyForState.label}
                      </Badge>
                    </article>
                  );
                })
              )}
            </div>
          </>
        )}
      </section>

      <JiraIntegration />

      <section className="mock-card">
        <div className="mock-card-head">
          <div>
            <h3>Linear</h3>
            <p>
              Linked issues already appear in the node overlay when a repository
              has them.
            </p>
          </div>
        </div>
        <Reserved>
          Per-org Linear connection is a documented follow-up to the Jira
          connect flow above; Linear continues to use a shared, operator
          -configured connection for now.
        </Reserved>
      </section>
    </>
  );
}

function readableJiraDate(value: string | null): string {
  if (value === null) return 'never';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function JiraIntegration() {
  const { disconnectJira, jiraConnectUrl, loadJiraIntegrationStatus } = useWorkspaceOperations();
  const { mode } = useWorkspaceSession();
  const [status, setStatus] = useState<JiraStatusResponse | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [actionState, setActionState] = useState<
    'idle' | 'disconnecting' | 'error'
  >('idle');
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState('loading');
    void loadJiraIntegrationStatus(controller.signal)
      .then((response) => {
        if (!active) return;
        setStatus(response);
        setLoadState('ready');
      })
      .catch((error: unknown) => {
        if (!active || (error as { name?: string }).name === 'AbortError') {
          return;
        }
        setLoadState('error');
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [loadJiraIntegrationStatus, reloadVersion]);

  const connection = status?.connection ?? null;
  const connected = connection?.connected === true;

  function startConnect(): void {
    if (mode === 'fixture') {
      reconnectFixtureJira();
      setReloadVersion((version) => version + 1);
      return;
    }
    window.location.assign(jiraConnectUrl);
  }

  async function disconnect(): Promise<void> {
    setActionState('disconnecting');
    try {
      const response = await disconnectJira();
      setStatus(response);
      setActionState('idle');
    } catch {
      setActionState('error');
    }
  }

  return (
    <section className="mock-card">
      <div className="mock-card-head">
        <div>
          <h3>{connected ? 'Jira connected' : 'Jira not connected'}</h3>
          <p>
            {connected
              ? 'Sayre syncs this organization’s Jira issues using its own connection.'
              : 'Connect Jira to sync this organization’s issues into the node overlay. No manual token or .env edit is required.'}
          </p>
        </div>
        <Badge tone={connected ? 'ready' : 'neutral'}>
          {connected ? 'connected' : 'not connected'}
        </Badge>
      </div>

      {loadState === 'loading' && status === null && (
        <p className="mock-field-help" role="status">
          Checking the Jira connection…
        </p>
      )}
      {loadState === 'error' && (
        <div className="mock-inline-error" role="alert">
          Jira connection status could not be loaded. Try refreshing this
          status.
        </div>
      )}

      {connected && connection !== null && (
        <dl className="mock-kv">
          <div>
            <dt>Jira site</dt>
            <dd>{connection.siteName ?? connection.siteUrl}</dd>
          </div>
          <div>
            <dt>Connected by</dt>
            <dd>{connection.connectedByLabel}</dd>
          </div>
          <div>
            <dt>Last sync</dt>
            <dd>{readableJiraDate(connection.lastSyncedAt)}</dd>
          </div>
        </dl>
      )}

      <div className="mock-card-actions">
        <button
          type="button"
          className="mock-btn mock-btn-primary"
          onClick={startConnect}
          disabled={connected}
        >
          {connected ? 'Connected' : 'Connect Jira'}
        </button>
        {connected && (
          <button
            type="button"
            className="mock-btn mock-btn-secondary"
            onClick={() => void disconnect()}
            disabled={actionState === 'disconnecting'}
          >
            {actionState === 'disconnecting' ? 'Disconnecting…' : 'Disconnect'}
          </button>
        )}
        <button
          type="button"
          className="mock-btn mock-btn-secondary"
          onClick={() => {
            setLoadState('loading');
            setReloadVersion((version) => version + 1);
          }}
          disabled={loadState === 'loading'}
        >
          Refresh status
        </button>
        {actionState === 'error' && (
          <span className="mock-field-help" role="alert">
            The Jira connection could not be disconnected. Try again.
          </span>
        )}
      </div>
    </section>
  );
}

type SaveState = Partial<
  Record<ProviderPurpose, 'saving' | 'saved' | 'error'>
>;

function ProviderSettings() {
  const { loadProviderSettings, saveProviderSetting } = useWorkspaceOperations();
  const [data, setData] = useState<ProviderSettingsResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<
    ProviderPurpose,
    ProviderSettingsDraft
  > | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>({});

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(false);
    void loadProviderSettings(controller.signal)
      .then((response) => {
        setData(response);
        setDrafts({
          generation: draftFor('generation', response.settings.generation),
          embedding: draftFor('embedding', response.settings.embedding),
        });
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== 'AbortError') {
          setLoadError(true);
        }
      });
    return () => controller.abort();
  }, [loadProviderSettings, reloadVersion]);

  const tradeoffs = useMemo(() => data?.tradeoffs ?? null, [data]);

  function updateDraft(
    purpose: ProviderPurpose,
    patch: Partial<ProviderSettingsDraft>,
  ): void {
    setDrafts((current) =>
      current === null
        ? null
        : {
            ...current,
            [purpose]: { ...current[purpose], ...patch },
          },
    );
    setSaveState((current) => ({ ...current, [purpose]: undefined }));
  }

  async function save(purpose: ProviderPurpose): Promise<void> {
    const draft = drafts?.[purpose];
    if (draft === undefined) return;
    setSaveState((current) => ({ ...current, [purpose]: 'saving' }));
    try {
      const setting = await saveProviderSetting(
        purpose,
        buildProviderSettingsUpdate(draft),
      );
      setData((current) =>
        current === null
          ? current
          : {
              ...current,
              settings: { ...current.settings, [purpose]: setting },
            },
      );
      setSaveState((current) => ({ ...current, [purpose]: 'saved' }));
    } catch {
      setSaveState((current) => ({ ...current, [purpose]: 'error' }));
    }
  }

  if (loadError) {
    return (
      <section className="mock-card">
        <div className="mock-alert mock-alert-danger" role="alert">
          <strong>Provider settings unavailable</strong>
          The approved choices could not be loaded.
          <div className="mock-alert-actions">
            <button
              type="button"
              className="mock-btn mock-btn-secondary mock-btn-sm"
              onClick={() => setReloadVersion((version) => version + 1)}
            >
              Try again
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (data === null || drafts === null) {
    return (
      <section className="mock-card" aria-live="polite">
        <p>Loading approved provider choices…</p>
      </section>
    );
  }

  return (
    <>
      {PURPOSES.map((purpose) => {
        const draft = drafts[purpose];
        const copy = PURPOSE_COPY[purpose];
        const setting = data.settings[purpose];
        const configurationStatus = providerConfigurationStatus(setting);
        const selfHosted = draft.provider === 'openai_compatible';
        const unlistedCredentialConfigured =
          setting?.credentialConfigured === true &&
          setting.credentialReferenceId === null;
        const unlistedEndpointConfigured =
          selfHosted &&
          setting?.endpointConfigured === true &&
          setting.endpointId === null;
        const credentials = data.credentialOptions.filter(
          (option) =>
            option.purpose === purpose &&
            option.providers.includes(draft.provider),
        );
        const endpoints = data.endpointOptions.filter(
          (option) =>
            option.purpose === purpose &&
            option.providers.includes(draft.provider),
        );
        const valid =
          draft.model.trim().length > 0 &&
          (selfHosted
            ? draft.endpointId !== null
            : draft.credentialReferenceId !== null);

        return (
          <section className="mock-card" key={purpose}>
            <div className="mock-card-head">
              <div>
                <h3>{copy.title}</h3>
                <p>{copy.description}</p>
              </div>
              <Badge
                tone={
                  configurationStatus === 'configured' ? 'ready' : 'warn'
                }
              >
                {configurationStatus.replace('-', ' ')}
              </Badge>
            </div>

            <div className="mock-fields">
              <label className="mock-field">
                <span>Provider</span>
                <select
                  value={draft.provider}
                  onChange={(event) =>
                    updateDraft(purpose, {
                      provider: event.target.value as ProviderKind,
                      credentialReferenceId: null,
                      endpointId: null,
                    })
                  }
                >
                  {providersFor(purpose).map((provider) => (
                    <option value={provider} key={provider}>
                      {providerLabel(provider)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="mock-field">
                <span>Model</span>
                <input
                  value={draft.model}
                  maxLength={200}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) =>
                    updateDraft(purpose, { model: event.target.value })
                  }
                />
              </label>

              <label className="mock-field">
                <span>Approved credential</span>
                <select
                  value={draft.credentialReferenceId ?? ''}
                  onChange={(event) =>
                    updateDraft(purpose, {
                      credentialReferenceId: event.target.value || null,
                    })
                  }
                >
                  <option value="">
                    {unlistedCredentialConfigured
                      ? 'Existing server-side credential (not editable here)'
                      : selfHosted
                      ? 'No credential (if the endpoint permits it)'
                      : 'Select a provisioned credential'}
                  </option>
                  {credentials.map((option) => (
                    <option value={option.id} key={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className="mock-field-help">
                  Raw keys cannot be entered, displayed, or stored from this
                  screen.
                </span>
              </label>

              {selfHosted && (
                <label className="mock-field">
                  <span>Approved endpoint</span>
                  <select
                    value={draft.endpointId ?? ''}
                    onChange={(event) =>
                      updateDraft(purpose, {
                        endpointId: event.target.value || null,
                      })
                    }
                  >
                    <option value="">
                      {unlistedEndpointConfigured
                        ? 'Existing server-side endpoint (not editable here)'
                        : 'Select an operator-approved endpoint'}
                    </option>
                    {endpoints.map((option) => (
                      <option value={option.id} key={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span className="mock-field-help">
                    Endpoint URLs remain server-side; the browser only sends an
                    opaque approved ID.
                  </span>
                </label>
              )}
            </div>

            <div className="mock-card-actions">
              <button
                type="button"
                className="mock-btn mock-btn-primary"
                disabled={!valid || saveState[purpose] === 'saving'}
                onClick={() => void save(purpose)}
              >
                {saveState[purpose] === 'saving'
                  ? 'Saving…'
                  : `Save ${copy.title.toLowerCase()} settings`}
              </button>
              <span className="mock-field-help" aria-live="polite">
                {saveState[purpose] === 'saved'
                  ? 'Saved. The next generated work uses this selection.'
                  : saveState[purpose] === 'error'
                    ? 'Save failed. Check the approved choices and try again.'
                    : 'Existing generated output is left unchanged.'}
              </span>
            </div>
          </section>
        );
      })}

      {tradeoffs !== null && (
        <section className="mock-card">
          <div className="mock-card-head">
            <div>
              <h3>Before you switch</h3>
              <p>Data path, quality, and latency tradeoffs.</p>
            </div>
          </div>
          <div className="mock-tradeoffs">
            <article>
              <h4>Hosted · contractual</h4>
              <p>{tradeoffs.hostedGuarantee}</p>
            </article>
            <article>
              <h4>Self-hosted · structural</h4>
              <p>{tradeoffs.selfHostedGuarantee}</p>
            </article>
            <article>
              <h4>Structured-output quality</h4>
              <p>{tradeoffs.quality}</p>
            </article>
            <article>
              <h4>Latency boundary</h4>
              <p>{tradeoffs.latency}</p>
            </article>
          </div>
        </section>
      )}
    </>
  );
}

export function SettingsPanel() {
  const { isAdmin } = useWorkspaceSession();
  const navigation = useWorkspaceNavigation();
  const packRuntime = useOptionalWorkspacePack();
  const section = navigation.settingsSection;
  if (section === null) return null;
  const configuredOrder = packRuntime?.store.get(packRuntime.activePackRef)?.pack.settingsOrder;
  const orderedSections = configuredOrder === undefined
    ? settingsSections
    : configuredOrder.map((id) => settingsSections.find((definition) => definition.id === id)).filter((definition): definition is (typeof settingsSections)[number] => definition !== undefined);

  return (
    <div className="mock-overlay" role="region" aria-label="Settings">
      <nav className="mock-settings-nav" aria-label="Settings sections">
        <p className="mock-settings-nav-label">Settings</p>
        {orderedSections.filter((definition) => definition.minimumRole === 'member' || isAdmin).map((definition) => (
          <button
            type="button"
            key={definition.id}
            aria-current={section === definition.id ? 'page' : undefined}
            onClick={() => navigation.openSettings(definition.id)}
          >
            {definition.label}
          </button>
        ))}
      </nav>

      <div className="mock-settings-main">
        <div className="mock-settings-header">
          <h2>{settingsSection(section).title}</h2>
          <button
            type="button"
            className="mock-btn mock-btn-secondary mock-btn-sm"
            onClick={navigation.closeSettings}
          >
            Back to graph
          </button>
        </div>

        <div className="mock-settings-body">
          {section === 'workspace-packs' ? (
            <WorkspacePackSettings />
          ) : !isAdmin ? (
            <section className="mock-card">
              <div className="mock-card-head">
                <div>
                  <h3>Administrators only</h3>
                  <p>
                    Organization administrators and owners manage these
                    settings.
                  </p>
                </div>
              </div>
            </section>
          ) : section === 'github' ? (
            <GitHubIntegrations />
          ) : section === 'providers' ? (
            <ProviderSettings />
          ) : (
            <McpSettings />
          )}
        </div>
      </div>
    </div>
  );
}

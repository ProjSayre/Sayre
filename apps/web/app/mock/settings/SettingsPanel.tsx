'use client';

import { GITHUB_INSTALLATION, PROVIDER_SETTINGS } from '../fixtures';
import { useMock } from '../state';
import type { InstallationOutcome, ProviderSetting } from '../types';
import { Badge, Reserved } from '../components/ui';

const INSTALL_COPY: Record<
  InstallationOutcome,
  { headline: string; detail: string; tone: 'ready' | 'warn' | 'danger' | 'neutral' }
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
      'Sayre can read the repositories you selected during installation. Change the selection from GitHub at any time.',
    tone: 'ready',
  },
  'approval-required': {
    headline: 'Waiting for organization approval',
    detail:
      'A GitHub organization owner must approve the installation request before Sayre can read any repository. The request stays pending until they do.',
    tone: 'warn',
  },
  denied: {
    headline: 'Installation was not completed',
    detail:
      'The installation was cancelled or declined on GitHub. No repository access was granted and nothing was stored.',
    tone: 'warn',
  },
  error: {
    headline: 'Installation could not be completed',
    detail:
      'GitHub returned an error while completing the installation. No repository access was granted. Try the installation again from GitHub.',
    tone: 'danger',
  },
};

function GitHubIntegrations() {
  const { state, dispatch } = useMock();
  const outcome = state.installation;
  const copy = INSTALL_COPY[outcome];

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

        {outcome === 'installed' && (
          <dl className="mock-kv">
            <div>
              <dt>Account</dt>
              <dd>{GITHUB_INSTALLATION.accountName}</dd>
            </div>
            <div>
              <dt>Repositories available to Sayre</dt>
              <dd>
                {GITHUB_INSTALLATION.repositoriesSynced} of{' '}
                {GITHUB_INSTALLATION.repositoriesTotal}
              </dd>
            </div>
          </dl>
        )}

        <div className="mock-card-actions">
          <button
            type="button"
            className="mock-btn mock-btn-primary"
            onClick={() =>
              dispatch({ type: 'patch', patch: { installation: 'installed' } })
            }
          >
            {outcome === 'installed'
              ? 'Manage installation on GitHub'
              : outcome === 'approval-required'
                ? 'Open the pending request on GitHub'
                : outcome === 'not-installed'
                  ? 'Install the GitHub App'
                  : 'Start the installation again'}
          </button>
          {outcome === 'approval-required' && (
            <span className="mock-field-help">
              An organization owner can approve it from GitHub&apos;s
              pending-requests page. Sayre reads nothing until they do.
            </span>
          )}
        </div>
      </section>

      <section className="mock-card">
        <div className="mock-card-head">
          <div>
            <h3>Installation health and per-repository sync</h3>
            <p>
              Account status, connection health, repository-by-repository sync
              state, and reconnect controls.
            </p>
          </div>
        </div>
        <Reserved>
          The installation and callback plumbing exists, but there is no
          browser-facing installation-status API yet. This panel stays empty
          rather than showing a control that would not do anything.
        </Reserved>
      </section>

      <section className="mock-card">
        <div className="mock-card-head">
          <div>
            <h3>Jira and Linear</h3>
            <p>
              Linked issues already appear in the node overlay when a repository
              has them.
            </p>
          </div>
        </div>
        <Reserved>
          Connecting accounts, choosing projects, connector health, and manual
          sync are not callable from the browser yet.
        </Reserved>
      </section>
    </>
  );
}

const APPROVED_CREDENTIALS = [
  'sayre/generation/anthropic#v3',
  'sayre/embedding/internal#v1',
  'sayre/generation/bedrock#v2',
];

const APPROVED_ENDPOINTS = [
  'https://api.anthropic.com',
  'https://embeddings.internal.acme.dev/v1',
  'https://bedrock-runtime.us-east-1.amazonaws.com',
];

function ProviderCard({ setting }: { setting: ProviderSetting }) {
  const title = setting.purpose === 'generation' ? 'Generation' : 'Embedding';
  const blurb =
    setting.purpose === 'generation'
      ? 'Writes node descriptions, feature boundaries, and Product Tree summaries.'
      : 'Turns authorized code and document chunks into vectors for retrieval.';

  return (
    <section className="mock-card">
      <div className="mock-card-head">
        <div>
          <h3>{title}</h3>
          <p>{blurb}</p>
        </div>
        <Badge tone={setting.status === 'configured' ? 'ready' : 'warn'}>
          {setting.status}
        </Badge>
      </div>

      <div className="mock-fields">
        <label className="mock-field">
          <span>Provider</span>
          <select defaultValue={setting.provider}>
            <option>{setting.provider}</option>
          </select>
        </label>

        <label className="mock-field">
          <span>Model</span>
          <select defaultValue={setting.model}>
            <option>{setting.model}</option>
          </select>
        </label>

        <label className="mock-field">
          <span>Approved credential reference</span>
          <select defaultValue={setting.credentialReference}>
            {APPROVED_CREDENTIALS.map((reference) => (
              <option key={reference}>{reference}</option>
            ))}
          </select>
          <span className="mock-field-help">
            Sayre stores a reference to a pre-provisioned credential. Raw keys are
            never entered, displayed, or accepted here.
          </span>
        </label>

        <label className="mock-field">
          <span>Approved endpoint</span>
          <select defaultValue={setting.endpoint}>
            {APPROVED_ENDPOINTS.map((endpoint) => (
              <option key={endpoint}>{endpoint}</option>
            ))}
          </select>
          <span className="mock-field-help">
            Only endpoints on the organization&apos;s approved list can be chosen.
          </span>
        </label>
      </div>

      <div className="mock-tradeoffs">
        <article>
          <h4>Hosted{setting.hosting === 'hosted' ? ' · in use' : ''}</h4>
          <p>
            Managed capacity, no infrastructure to run. Prompts and chunks leave
            your network and reach the provider under its own retention terms.
          </p>
        </article>
        <article>
          <h4>Self-hosted{setting.hosting === 'self-hosted' ? ' · in use' : ''}</h4>
          <p>
            Content stays inside your network and you set retention. You own
            capacity, availability, and upgrades — a slow endpoint shows up as
            degraded semantic features.
          </p>
        </article>
      </div>

      <div className="mock-card-actions">
        <button type="button" className="mock-btn mock-btn-primary">
          Save {title.toLowerCase()} settings
        </button>
        <span className="mock-field-help">
          Changes apply to work generated after the save. Existing output is left
          as it is.
        </span>
      </div>
    </section>
  );
}

export function SettingsPanel() {
  const { state, dispatch, isAdmin } = useMock();
  const section = state.settingsSection;
  if (section === null) return null;

  return (
    <div className="mock-overlay" role="region" aria-label="Settings">
      <nav className="mock-settings-nav" aria-label="Settings sections">
        <p className="mock-settings-nav-label">Settings</p>
        <button
          type="button"
          aria-current={section === 'github' ? 'page' : undefined}
          onClick={() =>
            dispatch({ type: 'patch', patch: { settingsSection: 'github' } })
          }
        >
          GitHub Integrations
        </button>
        <button
          type="button"
          aria-current={section === 'providers' ? 'page' : undefined}
          onClick={() =>
            dispatch({ type: 'patch', patch: { settingsSection: 'providers' } })
          }
        >
          Model Providers
        </button>
      </nav>

      <div className="mock-settings-main">
        <div className="mock-settings-header">
          <h2>
            {section === 'github' ? 'GitHub Integrations' : 'Model Providers'}
          </h2>
          <button
            type="button"
            className="mock-btn mock-btn-secondary mock-btn-sm"
            onClick={() =>
              dispatch({ type: 'patch', patch: { settingsSection: null } })
            }
          >
            Back to graph
          </button>
        </div>

        <div className="mock-settings-body">
          {!isAdmin ? (
            <section className="mock-card">
              <div className="mock-card-head">
                <div>
                  <h3>Administrators only</h3>
                  <p>
                    These settings are managed by organization administrators and
                    owners. Ask one of them if something here needs to change.
                  </p>
                </div>
              </div>
            </section>
          ) : section === 'github' ? (
            <GitHubIntegrations />
          ) : (
            PROVIDER_SETTINGS.map((setting) => (
              <ProviderCard key={setting.purpose} setting={setting} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

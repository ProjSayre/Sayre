'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  ProviderKind,
  ProviderPurpose,
  ProviderSettingsResponse,
} from '@sayre/shared-types';
import {
  buildProviderSettingsUpdate,
  draftFor,
  type ProviderSettingsDraft,
} from './providerSettingsClient';

const API_PATH = '/api/provider-settings';
const PURPOSES: readonly ProviderPurpose[] = ['generation', 'embedding'];
const LABELS: Record<ProviderPurpose, { title: string; description: string }> = {
  generation: {
    title: 'Generation',
    description: 'Shared by semantic enrichment and the graph-guided chatbot.',
  },
  embedding: {
    title: 'Embedding',
    description: 'Separate 1024-dimensional EmbeddingProvider configuration.',
  },
};

function providersFor(purpose: ProviderPurpose): ProviderKind[] {
  return purpose === 'generation'
    ? ['anthropic', 'openai', 'openai_compatible']
    : ['openai', 'openai_compatible'];
}

function providerLabel(provider: ProviderKind): string {
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'openai') return 'OpenAI';
  return 'Approved self-hosted / OpenAI-compatible';
}

export function ProviderSettingsPanel() {
  const [data, setData] = useState<ProviderSettingsResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<ProviderPurpose, ProviderSettingsDraft> | null>(
    null,
  );
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<
    Partial<Record<ProviderPurpose, 'saving' | 'saved' | 'error'>>
  >({});

  useEffect(() => {
    const controller = new AbortController();
    void fetch(API_PATH, {
      credentials: 'include',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('request failed');
        return (await response.json()) as ProviderSettingsResponse;
      })
      .then((response) => {
        setData(response);
        setDrafts({
          generation: draftFor('generation', response.settings.generation),
          embedding: draftFor('embedding', response.settings.embedding),
        });
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== 'AbortError') {
          setLoadingError('Provider settings could not be loaded.');
        }
      });
    return () => controller.abort();
  }, []);

  const tradeoffs = useMemo(() => data?.tradeoffs, [data]);

  function updateDraft(
    purpose: ProviderPurpose,
    patch: Partial<ProviderSettingsDraft>,
  ): void {
    setDrafts((current) =>
      current
        ? { ...current, [purpose]: { ...current[purpose], ...patch } }
        : current,
    );
    setSaveState((current) => ({ ...current, [purpose]: undefined }));
  }

  async function save(purpose: ProviderPurpose): Promise<void> {
    const draft = drafts?.[purpose];
    if (!draft) return;
    setSaveState((current) => ({ ...current, [purpose]: 'saving' }));
    try {
      const response = await fetch(`${API_PATH}/${purpose}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(buildProviderSettingsUpdate(draft)),
      });
      if (!response.ok) throw new Error('request failed');
      setSaveState((current) => ({ ...current, [purpose]: 'saved' }));
    } catch {
      setSaveState((current) => ({ ...current, [purpose]: 'error' }));
    }
  }

  if (loadingError) {
    return <div className="settings-status settings-error">{loadingError}</div>;
  }
  if (!data || !drafts) {
    return <div className="settings-status">Loading approved provider choices…</div>;
  }

  return (
    <>
      <div className="provider-card-grid">
        {PURPOSES.map((purpose) => {
          const draft = drafts[purpose];
          const credentials = data.credentialOptions.filter(
            (option) =>
              option.purpose === purpose && option.providers.includes(draft.provider),
          );
          const endpoints = data.endpointOptions.filter(
            (option) =>
              option.purpose === purpose && option.providers.includes(draft.provider),
          );
          const selfHosted = draft.provider === 'openai_compatible';
          return (
            <section className="provider-card" key={purpose}>
              <div className="provider-card-heading">
                <div>
                  <span className="settings-eyebrow">{purpose}</span>
                  <h2>{LABELS[purpose].title}</h2>
                </div>
                <span className="purpose-pill">
                  {purpose === 'embedding' ? '1024 dimensions' : 'Next job'}
                </span>
              </div>
              <p>{LABELS[purpose].description}</p>

              <label className="settings-field">
                Provider
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

              <label className="settings-field">
                Model
                <input
                  value={draft.model}
                  maxLength={200}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => updateDraft(purpose, { model: event.target.value })}
                />
              </label>

              {selfHosted ? (
                <label className="settings-field">
                  Approved endpoint
                  <select
                    value={draft.endpointId ?? ''}
                    onChange={(event) =>
                      updateDraft(purpose, { endpointId: event.target.value || null })
                    }
                  >
                    <option value="">Select an operator-approved endpoint</option>
                    {endpoints.map((option) => (
                      <option value={option.id} key={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span className="field-help">
                    Endpoint URLs are provisioned server-side and are never accepted here.
                  </span>
                </label>
              ) : null}

              <label className="settings-field">
                Approved credential
                <select
                  value={draft.credentialReferenceId ?? ''}
                  onChange={(event) =>
                    updateDraft(purpose, {
                      credentialReferenceId: event.target.value || null,
                    })
                  }
                >
                  <option value="">
                    {selfHosted
                      ? 'No credential (if the approved endpoint permits it)'
                      : 'Select a provisioned credential'}
                  </option>
                  {credentials.map((option) => (
                    <option value={option.id} key={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className="field-help">
                  Raw keys cannot be entered, viewed, or stored from this screen.
                </span>
              </label>

              <div className="provider-card-actions">
                <button
                  className="settings-save"
                  type="button"
                  disabled={saveState[purpose] === 'saving'}
                  onClick={() => void save(purpose)}
                >
                  {saveState[purpose] === 'saving' ? 'Saving…' : 'Save selection'}
                </button>
                <span aria-live="polite" className="save-message">
                  {saveState[purpose] === 'saved'
                    ? 'Saved. The next job uses this selection.'
                    : saveState[purpose] === 'error'
                      ? 'Save failed. Check the approved choices.'
                      : ''}
                </span>
              </div>
            </section>
          );
        })}
      </div>

      {tradeoffs ? (
        <section className="tradeoff-panel" aria-labelledby="provider-tradeoffs">
          <span className="settings-eyebrow">Before you switch</span>
          <h2 id="provider-tradeoffs">Data path, quality, and latency</h2>
          <div className="tradeoff-grid">
            <article>
              <h3>Hosted · contractual</h3>
              <p>{tradeoffs.hostedGuarantee}</p>
            </article>
            <article>
              <h3>Self-hosted · structural</h3>
              <p>{tradeoffs.selfHostedGuarantee}</p>
            </article>
            <article>
              <h3>Structured-output quality</h3>
              <p>{tradeoffs.quality}</p>
            </article>
            <article>
              <h3>Latency boundary</h3>
              <p>{tradeoffs.latency}</p>
            </article>
          </div>
        </section>
      ) : null}
    </>
  );
}

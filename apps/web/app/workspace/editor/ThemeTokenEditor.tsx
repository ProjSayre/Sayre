'use client';

import { useEffect, useState } from 'react';
import type { WorkspaceEditOperation, WorkspaceThemeColorToken, WorkspaceThemeTokens } from '../../../../../packages/workspace-packs/src/runtime';

const COMPLETE_HEX = /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/;

function tokenLabel(token: string): string {
  return token.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (character) => character.toUpperCase());
}

export function ThemeTokenEditor({
  theme,
  apply,
  resetColor,
  resetChoice,
}: {
  theme: WorkspaceThemeTokens;
  apply(operation: WorkspaceEditOperation): void;
  resetColor(token: WorkspaceThemeColorToken): void;
  resetChoice(token: 'typography.ui' | 'typography.mono' | 'density' | 'radius'): void;
}) {
  const [hexDrafts, setHexDrafts] = useState(theme.colors);
  useEffect(() => setHexDrafts(theme.colors), [theme.colors]);
  return (
    <section className="workspace-theme-editor" aria-label="Theme tokens">
      <details className="workspace-editor__disclosure">
        <summary>Colors <small>{Object.keys(theme.colors).length} tokens</small></summary>
        <div className="workspace-theme-editor__colors">
          {(Object.keys(theme.colors) as WorkspaceThemeColorToken[]).map((token) => (
            <div key={token} className="workspace-theme-editor__token">
              <label className="workspace-theme-editor__color">
                <span>{tokenLabel(token)}</span>
                <input
                  type="color"
                  aria-label={`${tokenLabel(token)} color`}
                  value={theme.colors[token].slice(0, 7)}
                  onChange={(event) => apply({ type: 'set-theme-color', token, value: event.currentTarget.value.toUpperCase() })}
                />
              </label>
              <label className="workspace-editor__field workspace-theme-editor__hex">
                <span>Hex value</span>
                <input
                  type="text"
                  inputMode="text"
                  spellCheck={false}
                  value={hexDrafts[token]}
                  aria-label={`${tokenLabel(token)} hex value`}
                  aria-invalid={!COMPLETE_HEX.test(hexDrafts[token])}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setHexDrafts((current) => ({ ...current, [token]: value }));
                    if (COMPLETE_HEX.test(value)) apply({ type: 'set-theme-color', token, value: value.toUpperCase() });
                  }}
                  onBlur={() => {
                    if (!COMPLETE_HEX.test(hexDrafts[token])) setHexDrafts((current) => ({ ...current, [token]: theme.colors[token] }));
                  }}
                />
              </label>
              <button className="workspace-editor__text-action" type="button" onClick={() => resetColor(token)}>Reset</button>
            </div>
          ))}
        </div>
      </details>
      <details className="workspace-editor__disclosure">
        <summary>Type &amp; spacing</summary>
        <div className="workspace-theme-editor__choices">
          <div className="workspace-theme-editor__choice">
            <label className="workspace-editor__field">
              <span>Interface type</span>
              <select value={theme.typography.ui} onChange={(event) => apply({ type: 'set-theme-choice', token: 'typography.ui', value: event.currentTarget.value as WorkspaceThemeTokens['typography']['ui'] })}>
                <option value="sayre-grotesk">Sayre Grotesk</option>
                <option value="system-sans">System Sans</option>
                <option value="system-mono">System Mono</option>
              </select>
            </label>
            <button className="workspace-editor__text-action" type="button" onClick={() => resetChoice('typography.ui')}>Reset</button>
          </div>
          <div className="workspace-theme-editor__choice">
            <label className="workspace-editor__field">
              <span>Monospace type</span>
              <select value={theme.typography.mono} onChange={(event) => apply({ type: 'set-theme-choice', token: 'typography.mono', value: event.currentTarget.value as WorkspaceThemeTokens['typography']['mono'] })}>
                <option value="sayre-grotesk">Sayre Grotesk</option>
                <option value="system-sans">System Sans</option>
                <option value="system-mono">System Mono</option>
              </select>
            </label>
            <button className="workspace-editor__text-action" type="button" onClick={() => resetChoice('typography.mono')}>Reset</button>
          </div>
          <div className="workspace-theme-editor__choice">
            <label className="workspace-editor__field">
              <span>Density</span>
              <select value={theme.density} onChange={(event) => apply({ type: 'set-theme-choice', token: 'density', value: event.currentTarget.value as WorkspaceThemeTokens['density'] })}>
                <option value="compact">Compact</option>
                <option value="comfortable">Comfortable</option>
                <option value="presentation">Presentation</option>
              </select>
            </label>
            <button className="workspace-editor__text-action" type="button" onClick={() => resetChoice('density')}>Reset</button>
          </div>
          <div className="workspace-theme-editor__choice">
            <label className="workspace-editor__field">
              <span>Corner radius</span>
              <select value={theme.radius} onChange={(event) => apply({ type: 'set-theme-choice', token: 'radius', value: event.currentTarget.value as WorkspaceThemeTokens['radius'] })}>
                <option value="square">Square</option>
                <option value="subtle">Subtle</option>
                <option value="rounded">Rounded</option>
              </select>
            </label>
            <button className="workspace-editor__text-action" type="button" onClick={() => resetChoice('radius')}>Reset</button>
          </div>
        </div>
      </details>
    </section>
  );
}

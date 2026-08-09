'use client';

import { useState } from 'react';
import type {
  WorkspaceComponentCatalogContract,
  WorkspaceComponentRef,
  WorkspaceRole,
  WorkspaceSlotId,
} from '../../../../../packages/workspace-packs/src/runtime';

const roleRank: Record<WorkspaceRole, number> = { member: 0, admin: 1, owner: 2 };

export function ComponentPalette({
  catalog,
  slot,
  role,
  capabilities,
  current,
  onChoose,
}: ComponentPaletteProps) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const compatible = catalog.components.filter((component) => {
    const isCurrent = component.id === current.id && component.version === current.version;
    if (isCurrent) return false;
    const acceptsSlot = component.allowedSlots.includes(slot);
    const acceptsRole = component.minimumRole === null || roleRank[role] >= roleRank[component.minimumRole];
    const acceptsCapabilities = component.requiredCapabilities.every((capability) => capabilities.includes(capability));
    return acceptsSlot && acceptsRole && acceptsCapabilities;
  });
  const visible = compatible.filter((component) => component.id.toLowerCase().includes(normalizedQuery));

  if (compatible.length === 0) {
    return (
      <section className="workspace-component-palette" aria-label="Component replacement">
        <h3>Component</h3>
        <p className="workspace-editor__empty">No compatible alternatives are available for this region.</p>
      </section>
    );
  }
  return (
    <section className="workspace-component-palette" aria-label="Component replacement">
      <h3>Replace component</h3>
      <label className="workspace-editor__field">
        <span>Find a compatible component</span>
        <input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
      </label>
      {visible.length === 0 ? <p className="workspace-editor__empty">No compatible alternatives match this search.</p> : (
        <ul className="workspace-component-palette__list">
          {visible.map((component) => (
            <li key={`${component.id}@${component.version}`}>
              <button type="button" onClick={() => onChoose(component.id, component.version)}>
                <span>{component.id}</span>
                <small>Version {component.version}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export type ComponentPaletteProps = {
  catalog: WorkspaceComponentCatalogContract;
  slot: WorkspaceSlotId;
  role: WorkspaceRole;
  capabilities: readonly string[];
  current: WorkspaceComponentRef;
  onChoose(id: string, version: number): void;
} & Record<string, unknown>;

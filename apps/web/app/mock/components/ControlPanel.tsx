'use client';

import { useWorkspaceFixture, type MockState } from '../../workspace/state';
import { useWorkspacePack } from '../../workspace/packs/WorkspacePackProvider';

interface ControlSpec {
  key: keyof MockState;
  label: string;
  options: Array<{ value: string; label: string }>;
}

function option(value: string, label?: string) {
  return { value, label: label ?? value.replace(/-/g, ' ') };
}

const CONTROLS: ControlSpec[] = [
  {
    key: 'session',
    label: 'Session',
    options: [option('authenticated'), option('signed-out'), option('session-expired')],
  },
  {
    key: 'role',
    label: 'Role',
    options: [option('member'), option('admin'), option('owner')],
  },
  {
    key: 'access',
    label: 'Repository access',
    options: [
      option('authorized'),
      option('repository-restricted'),
      option('no-repositories', 'no repositories'),
      option('forbidden'),
    ],
  },
  {
    key: 'readinessOverride',
    label: 'Repository readiness',
    options: [
      option('', 'from repository'),
      option('registered', 'registered (preparing)'),
      option('technical-ready', 'technical tree ready'),
      option('graph-ready', 'graph ready'),
    ],
  },
  {
    key: 'canvasData',
    label: 'Graph data',
    options: [
      option('normal', 'loaded'),
      option('loading'),
      option('empty', 'no authorized nodes'),
      option('unavailable', 'graph unavailable'),
    ],
  },
  {
    key: 'semantic',
    label: 'Semantic processing',
    options: [
      option('ready'),
      option('generating'),
      option('degraded'),
      option('failed'),
    ],
  },
  {
    key: 'realtime',
    label: 'Realtime updates',
    options: [
      option('connected'),
      option('reconnecting'),
      option('updated'),
      option('resync-required'),
    ],
  },
  {
    key: 'backend',
    label: 'Backend',
    options: [option('available'), option('unavailable')],
  },
  {
    key: 'installation',
    label: 'GitHub installation',
    options: [
      option('installed'),
      option('not-installed'),
      option('approval-required'),
      option('denied'),
      option('error', 'installation error'),
    ],
  },
];

/**
 * Mock-only scenario switcher. It exists so a reviewer can reach every state
 * this wireframe specifies without a backend; it is not a product surface.
 */
export function ControlPanel() {
  const fixture = useWorkspaceFixture();
  const packs = useWorkspacePack();
  if (fixture === null) return null;
  const { state } = fixture;
  if (!state.controlsOpen) return null;

  return (
    <div className="mock-controls" role="region" aria-label="Mock scenario controls">
      <div className="mock-controls-head">
        <h2>Mock controls</h2>
        <button
          type="button"
          className="mock-btn mock-btn-ghost"
          aria-label="Close mock controls"
          onClick={() => fixture.patch({ controlsOpen: false })}
        >
          ✕
        </button>
      </div>

      <div className="mock-controls-body">
        <p className="mock-controls-note">
          Nothing here ships. These dials drive the wireframe into each state the
          MVP has to handle.
        </p>

        <label className="mock-control">
          <span>Workspace Pack</span>
          <select
            data-fixture-control="workspacePack"
            value={`${packs.activePackRef.id}@${packs.activePackRef.version}`}
            onChange={(event) => {
              const item = packs.store.list().find((candidate) => `${candidate.ref.id}@${candidate.ref.version}` === event.currentTarget.value);
              if (item) packs.activatePack(item.ref);
            }}
          >
            {packs.store.list().map((item) => <option key={`${item.ref.id}@${item.ref.version}`} value={`${item.ref.id}@${item.ref.version}`}>{item.pack.metadata.name} {item.ref.version}</option>)}
          </select>
        </label>

        <label className="mock-control">
          <span>Workspace width</span>
          <select data-fixture-control="viewportPreview" value={packs.viewportPreview ?? 'actual'} onChange={(event) => packs.setViewportPreview(event.currentTarget.value === 'actual' ? null : event.currentTarget.value as 'compact' | 'standard' | 'wide')}>
            <option value="actual">actual viewport</option>
            <option value="compact">compact · 320px</option>
            <option value="standard">standard · 736px</option>
            <option value="wide">wide · desktop</option>
          </select>
        </label>

        {CONTROLS.map((control) => (
          <label className="mock-control" key={control.key}>
            <span>{control.label}</span>
            <select
              data-fixture-control={control.key}
              value={(state[control.key] as string | null) ?? ''}
              onChange={(event) =>
                fixture.patch({
                    [control.key]:
                      event.target.value === '' ? null : event.target.value,
                  } as Partial<MockState>)
              }
            >
              {control.options.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        ))}

        <label className="mock-control">
          <span>Agent/Skill MD</span>
          <select
            data-fixture-control="agentSkillConflict"
            value={state.agentSkillConflict ? 'conflict' : 'normal'}
            onChange={(event) =>
              fixture.patch({ agentSkillConflict: event.target.value === 'conflict' })
            }
          >
            <option value="normal">saves normally</option>
            <option value="conflict">another editor saved first</option>
          </select>
        </label>

        <button
          type="button"
          className="mock-btn mock-btn-secondary mock-btn-sm"
          data-fixture-reset="true"
          onClick={fixture.reset}
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

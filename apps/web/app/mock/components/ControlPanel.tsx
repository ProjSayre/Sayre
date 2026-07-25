'use client';

import { useMock, type MockState } from '../state';

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
  const { state, dispatch } = useMock();
  if (!state.controlsOpen) return null;

  return (
    <div className="mock-controls" role="region" aria-label="Mock scenario controls">
      <div className="mock-controls-head">
        <h2>Mock controls</h2>
        <button
          type="button"
          className="mock-btn mock-btn-ghost"
          aria-label="Close mock controls"
          onClick={() => dispatch({ type: 'patch', patch: { controlsOpen: false } })}
        >
          ✕
        </button>
      </div>

      <div className="mock-controls-body">
        <p className="mock-controls-note">
          Nothing here ships. These dials drive the wireframe into each state the
          MVP has to handle.
        </p>

        {CONTROLS.map((control) => (
          <label className="mock-control" key={control.key}>
            <span>{control.label}</span>
            <select
              value={(state[control.key] as string | null) ?? ''}
              onChange={(event) =>
                dispatch({
                  type: 'patch',
                  patch: {
                    [control.key]:
                      event.target.value === '' ? null : event.target.value,
                  } as Partial<MockState>,
                })
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
            value={state.agentSkillConflict ? 'conflict' : 'normal'}
            onChange={(event) =>
              dispatch({
                type: 'patch',
                patch: { agentSkillConflict: event.target.value === 'conflict' },
              })
            }
          >
            <option value="normal">saves normally</option>
            <option value="conflict">another editor saved first</option>
          </select>
        </label>

        <button
          type="button"
          className="mock-btn mock-btn-secondary mock-btn-sm"
          onClick={() => dispatch({ type: 'reset' })}
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

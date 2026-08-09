'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useWorkspaceStore, type MockState } from './store';

export interface WorkspaceFixtureContextValue {
  state: MockState;
  patch(patch: Partial<MockState>): void;
  reset(): void;
}

const WorkspaceFixtureContext = createContext<WorkspaceFixtureContextValue | null>(null);

export function WorkspaceFixtureProvider({ children }: { children: ReactNode }) {
  const { source, state, dispatch } = useWorkspaceStore();
  const value = useMemo(() => source.id !== 'fixture' ? null : ({
    state,
    patch: (patch: Partial<MockState>) => dispatch({ type: 'patch', patch }),
    reset: () => dispatch({ type: 'reset' }),
  }), [dispatch, source.id, state]);
  return <WorkspaceFixtureContext.Provider value={value}>{children}</WorkspaceFixtureContext.Provider>;
}

export function useWorkspaceFixture(): WorkspaceFixtureContextValue | null {
  return useContext(WorkspaceFixtureContext);
}

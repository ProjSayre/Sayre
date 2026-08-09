'use client';

import type { ReactNode } from 'react';
import { fixtureWorkspaceDataSource } from '../dataSource';
import { WorkspaceFixtureProvider } from './fixture';
import { WorkspaceNavigationProvider } from './navigation';
import { WorkspaceOperationsProvider } from './operations';
import { WorkspaceQueryProvider } from './queries';
import { WorkspaceRealtimeProvider } from './realtime';
import { WorkspaceSelectionProvider } from './selection';
import { WorkspaceSessionProvider } from './session';
import { WorkspaceStateStoreProvider, type WorkspaceProviderProps } from './store';

function FocusedWorkspaceProviders({ children }: { children: ReactNode }) {
  return (
    <WorkspaceSessionProvider>
      <WorkspaceNavigationProvider>
        <WorkspaceSelectionProvider>
          <WorkspaceQueryProvider>
            <WorkspaceRealtimeProvider>
              <WorkspaceOperationsProvider>
                <WorkspaceFixtureProvider>{children}</WorkspaceFixtureProvider>
              </WorkspaceOperationsProvider>
            </WorkspaceRealtimeProvider>
          </WorkspaceQueryProvider>
        </WorkspaceSelectionProvider>
      </WorkspaceNavigationProvider>
    </WorkspaceSessionProvider>
  );
}

export function WorkspaceProvider({ children, ...props }: WorkspaceProviderProps) {
  return (
    <WorkspaceStateStoreProvider {...props}>
      <FocusedWorkspaceProviders>{children}</FocusedWorkspaceProviders>
    </WorkspaceStateStoreProvider>
  );
}

export function MockProvider({ children }: { children: ReactNode }) {
  return <WorkspaceProvider source={fixtureWorkspaceDataSource}>{children}</WorkspaceProvider>;
}

export type { WorkspaceProviderProps } from './store';

import type { Dispatch } from 'react';
import type { WorkspaceSessionContextValue } from './session';
import type { WorkspaceNavigationContextValue } from './navigation';
import type { WorkspaceSelectionContextValue } from './selection';
import type { WorkspaceAction } from './store';

export type WorkspaceSessionContract = WorkspaceSessionContextValue;
export type WorkspaceNavigationContract = WorkspaceNavigationContextValue;
export type WorkspaceSelectionContract = WorkspaceSelectionContextValue;
export type WorkspaceDispatch = Dispatch<WorkspaceAction>;

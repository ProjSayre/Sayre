'use client';

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { WorkspaceDataSource } from '../dataSource';
import { useWorkspaceQueryMutations } from './queries';
import { useWorkspaceSession } from './session';
import { useWorkspaceStore } from './store';

export type WorkspaceOperationsContextValue = Pick<WorkspaceDataSource,
  | 'saveAgentSkillMd' | 'saveProviderSetting'
  | 'issueMcpKey' | 'revokeMcpKey' | 'saveMcpRateLimit'
  | 'githubInstallUrl' | 'disconnectJira' | 'jiraConnectUrl'
> & {
  runOnboardingStep(stepId: string): ReturnType<WorkspaceDataSource['runOnboardingStep']>;
  loadProviderSettings: WorkspaceDataSource['providerSettings'];
  loadMcpSettings: WorkspaceDataSource['mcpSettings'];
  loadGitHubIntegrationStatus: WorkspaceDataSource['githubIntegrationStatus'];
  loadJiraIntegrationStatus: WorkspaceDataSource['jiraIntegrationStatus'];
};

const WorkspaceOperationsContext = createContext<WorkspaceOperationsContextValue | null>(null);

export function WorkspaceOperationsProvider({ children }: { children: ReactNode }) {
  const { state, source } = useWorkspaceStore();
  const { scope } = useWorkspaceSession();
  const queries = useWorkspaceQueryMutations();
  const saveAgentSkillMd = useCallback<WorkspaceDataSource['saveAgentSkillMd']>(async (nodeId, content, expectedVersion) => {
    if (source.id === 'fixture' && state.agentSkillConflict) {
      const conflict = new Error('Agent/Skill MD version conflict.');
      Object.assign(conflict, { status: 409 });
      throw conflict;
    }
    const saved = await source.saveAgentSkillMd(nodeId, content, expectedVersion);
    queries.commitAgentSkill(nodeId, saved);
    return saved;
  }, [queries, source, state.agentSkillConflict]);
  const runOnboardingStep = useCallback((stepId: string) => {
    if (scope === null) throw new Error('Select a repository before running an onboarding step.');
    return source.runOnboardingStep(scope, stepId);
  }, [scope, source]);
  const value = useMemo<WorkspaceOperationsContextValue>(() => ({
    saveAgentSkillMd,
    runOnboardingStep,
    loadProviderSettings: source.providerSettings,
    saveProviderSetting: source.saveProviderSetting,
    loadMcpSettings: source.mcpSettings,
    issueMcpKey: source.issueMcpKey,
    revokeMcpKey: source.revokeMcpKey,
    saveMcpRateLimit: source.saveMcpRateLimit,
    loadGitHubIntegrationStatus: source.githubIntegrationStatus,
    githubInstallUrl: source.githubInstallUrl,
    loadJiraIntegrationStatus: source.jiraIntegrationStatus,
    disconnectJira: source.disconnectJira,
    jiraConnectUrl: source.jiraConnectUrl,
  }), [runOnboardingStep, saveAgentSkillMd, source]);
  return <WorkspaceOperationsContext.Provider value={value}>{children}</WorkspaceOperationsContext.Provider>;
}

export function useWorkspaceOperations(): WorkspaceOperationsContextValue {
  const value = useContext(WorkspaceOperationsContext);
  if (value === null) throw new Error('useWorkspaceOperations must be used inside WorkspaceOperationsProvider.');
  return value;
}

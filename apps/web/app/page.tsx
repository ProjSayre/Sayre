import { getOptionalConfig } from '@sayre/config';
import { WorkspaceShell } from './workspace/components/WorkspaceShell';
import { WorkspaceProvider } from './workspace/state';
import type { SettingsSection, ViewId } from './workspace/types';
import type { WorkspacePackRef } from '../../../packages/workspace-packs/src/runtime';

interface HomeProps {
  searchParams?: {
    repoId?: string | string[];
    refName?: string | string[];
    view?: string | string[];
    settings?: string | string[];
    nodeId?: string | string[];
    featureId?: string | string[];
    pack?: string | string[];
  };
}

function initialPackRef(value: string | string[] | undefined): WorkspacePackRef | undefined {
  const normalized = singleParam(value);
  const match = normalized?.match(/^([a-z0-9][a-z0-9.-]{2,63})@(\d+\.\d+\.\d+)$/);
  return match ? { id: match[1]!, version: match[2]! } : undefined;
}

function singleParam(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function initialView(value: string | string[] | undefined): ViewId {
  const normalized = singleParam(value);
  return normalized === 'product' || normalized === 'onboarding'
    ? normalized
    : 'technical';
}

function initialSettings(
  value: string | string[] | undefined,
): SettingsSection | null {
  const normalized = singleParam(value);
  return normalized === 'github' ||
    normalized === 'workspace-packs' ||
    normalized === 'providers' ||
    normalized === 'mcp'
    ? normalized
    : null;
}

export default function Home({ searchParams }: HomeProps) {
  return (
    <WorkspaceProvider
      gatewayWsUrl={getOptionalConfig('NEXT_PUBLIC_GATEWAY_WS_URL')}
      allowLocalGatewayFallback={
        getOptionalConfig('NODE_ENV') === 'development'
      }
      initialRepositoryId={singleParam(searchParams?.repoId)}
      initialRefName={singleParam(searchParams?.refName)}
      initialView={initialView(searchParams?.view)}
      initialSettingsSection={initialSettings(searchParams?.settings)}
      initialNodeId={singleParam(searchParams?.nodeId)}
      initialFeatureId={singleParam(searchParams?.featureId)}
    >
      <WorkspaceShell
        initialPackRef={initialPackRef(searchParams?.pack)}
        initialPackRequest={singleParam(searchParams?.pack)}
        initialViewPinned={singleParam(searchParams?.view) !== null}
      />
    </WorkspaceProvider>
  );
}

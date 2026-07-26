import { WorkspaceShell } from './workspace/components/WorkspaceShell';
import { WorkspaceProvider } from './workspace/state';
import type { SettingsSection, ViewId } from './workspace/types';

interface HomeProps {
  searchParams?: {
    repoId?: string | string[];
    refName?: string | string[];
    view?: string | string[];
    settings?: string | string[];
  };
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
  return normalized === 'github' || normalized === 'providers'
    ? normalized
    : null;
}

export default function Home({ searchParams }: HomeProps) {
  return (
    <WorkspaceProvider
      initialRepositoryId={singleParam(searchParams?.repoId)}
      initialRefName={singleParam(searchParams?.refName)}
      initialView={initialView(searchParams?.view)}
      initialSettingsSection={initialSettings(searchParams?.settings)}
    >
      <WorkspaceShell />
    </WorkspaceProvider>
  );
}

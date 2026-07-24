import { AppShell } from './components/AppShell';
import { resolveHomeScope } from './lib/homeScope';
import { normalizeRepositoryIdParam } from './lib/technicalTree';

interface HomeProps {
  searchParams?: {
    repoId?: string | string[];
    refName?: string | string[];
  };
}

export default function Home({ searchParams }: HomeProps) {
  const { repositoryId: providerStateRepositoryId, refName } =
    resolveHomeScope(searchParams);
  return (
    <AppShell
      repoId={normalizeRepositoryIdParam(searchParams?.repoId)}
      providerStateRepositoryId={providerStateRepositoryId}
      refName={refName}
    />
  );
}

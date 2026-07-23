import { AppShell } from './components/AppShell';
import { resolveHomeScope } from './lib/homeScope';

export default function Home({
  searchParams,
}: {
  searchParams?: { repoId?: string | string[]; refName?: string | string[] };
}) {
  const { repositoryId, refName } = resolveHomeScope(searchParams);
  return <AppShell repositoryId={repositoryId} refName={refName} />;
}

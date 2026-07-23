import { AppShell } from './components/AppShell';
import { normalizeRepositoryIdParam } from './lib/technicalTree';

interface HomeProps {
  searchParams?: {
    repoId?: string | string[];
  };
}

export default function Home({ searchParams }: HomeProps) {
  return <AppShell repoId={normalizeRepositoryIdParam(searchParams?.repoId)} />;
}

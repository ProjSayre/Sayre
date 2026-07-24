import { OnboardingTreeShell } from '../components/OnboardingTreeShell';

interface OnboardingPageProps {
  searchParams?: {
    repoId?: string | string[];
    ref?: string | string[];
  };
}

function singleParam(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export default function OnboardingPage({ searchParams }: OnboardingPageProps) {
  return (
    <OnboardingTreeShell
      repoId={singleParam(searchParams?.repoId)}
      refName={singleParam(searchParams?.ref) ?? 'refs/heads/main'}
    />
  );
}

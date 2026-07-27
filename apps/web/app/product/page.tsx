import { redirect } from 'next/navigation';

interface ProductPageProps {
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

export default function ProductPage({ searchParams }: ProductPageProps) {
  const params = new URLSearchParams({ view: 'product' });
  const repoId = singleParam(searchParams?.repoId);
  const refName = singleParam(searchParams?.ref);
  if (repoId !== null) params.set('repoId', repoId);
  if (refName !== null) params.set('refName', refName);
  redirect(`/?${params.toString()}`);
}

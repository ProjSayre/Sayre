import { ProductTreeShell } from '../components/ProductTreeShell';

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
  return (
    <ProductTreeShell
      repoId={singleParam(searchParams?.repoId)}
      refName={singleParam(searchParams?.ref) ?? 'refs/heads/main'}
    />
  );
}

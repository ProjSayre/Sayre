import type { Metadata } from 'next';
import { WorkspaceShell } from '../workspace/components/WorkspaceShell';
import { MockProvider } from '../workspace/state';
import { WorkspaceLayoutReviewFixture } from './components/WorkspaceLayoutReviewFixture';

export const metadata: Metadata = {
  title: 'Sayre — workspace fixture lab',
  description:
    'Interactive fixture lab for reviewing Sayre workspace states without a backend.',
};

/**
 * MVP UI mock.
 *
 * A complete, clickable wireframe of the MVP workspace built on fixture data —
 * no API is called, no repository is read. It exists so the shell, its modular
 * slots, and every state the MVP has to handle can be reviewed before the real
 * client is wired to the service layer.
 *
 * It includes a deterministic Onboarding Tree workflow so its layout and
 * execution states can be reviewed without running a sandbox. It also includes
 * deterministic provider and MCP administration data. Organization
 * administration, custom LLM views, raw provider credential entry, and
 * force-sync controls remain out of scope because no MVP browser contract
 * backs them.
 */
export default function MockPage({
  searchParams,
}: {
  searchParams?: { layoutProbe?: string };
}) {
  if (searchParams?.layoutProbe === 'same-slot-axis-matrix') {
    return <WorkspaceLayoutReviewFixture />;
  }
  return (
    <MockProvider>
      <WorkspaceShell />
    </MockProvider>
  );
}

import type { Metadata } from 'next';
import { WorkspaceShell } from '../workspace/components/WorkspaceShell';
import { MockProvider } from '../workspace/state';

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
 * Deliberately absent, because they are not MVP features: the Onboarding Tree,
 * MCP key management, organization and member administration, custom LLM views,
 * raw credential entry, and any Retry / Reindex / Force-sync control (no
 * user-facing endpoint backs those).
 */
export default function MockPage() {
  return (
    <MockProvider>
      <WorkspaceShell />
    </MockProvider>
  );
}

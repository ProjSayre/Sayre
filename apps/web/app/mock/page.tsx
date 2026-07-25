import type { Metadata } from 'next';
import { MockShell } from './components/MockShell';
import { MockProvider } from './state';
import './mock.css';

export const metadata: Metadata = {
  title: 'Sayre — MVP UI mock',
  description:
    'Non-functional wireframe of the Sayre MVP workspace. Every value is fixture data.',
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
      <MockShell />
    </MockProvider>
  );
}

import { describe, expect, it } from 'vitest';
import { parseInstallationRepositoriesEvent } from './parseInstallationRepositoriesEvent';

const REPO_A = { id: 111, node_id: 'R_a', name: 'widgets', full_name: 'acme/widgets', private: false };
const REPO_B = { id: 222, node_id: 'R_b', name: 'gadgets', full_name: 'acme/gadgets', private: true };

describe('parseInstallationRepositoriesEvent', () => {
  it('parses a well-formed "added" event', () => {
    const result = parseInstallationRepositoriesEvent({
      action: 'added',
      installation: { id: 12345678 },
      repository_selection: 'selected',
      repositories_added: [REPO_A, REPO_B],
      repositories_removed: [],
    });
    expect(result).toEqual({
      action: 'added',
      installationId: 12345678,
      added: [
        { providerRepoId: '111', fullName: 'acme/widgets' },
        { providerRepoId: '222', fullName: 'acme/gadgets' },
      ],
      removed: [],
    });
  });

  it('parses a well-formed "removed" event', () => {
    const result = parseInstallationRepositoriesEvent({
      action: 'removed',
      installation: { id: 12345678 },
      repositories_added: [],
      repositories_removed: [REPO_A],
    });
    expect(result).toEqual({
      action: 'removed',
      installationId: 12345678,
      added: [],
      removed: [{ providerRepoId: '111', fullName: 'acme/widgets' }],
    });
  });

  it('ignores no_installation when installation is missing', () => {
    const result = parseInstallationRepositoriesEvent({
      action: 'added',
      repositories_added: [REPO_A],
    });
    expect(result).toEqual({ ignored: 'no_installation' });
  });

  it('ignores no_installation when installation.id is non-numeric', () => {
    const result = parseInstallationRepositoriesEvent({
      action: 'added',
      installation: { id: 'not-a-number' },
      repositories_added: [REPO_A],
    });
    expect(result).toEqual({ ignored: 'no_installation' });
  });

  it('ignores noop_action for an action outside added/removed', () => {
    const result = parseInstallationRepositoriesEvent({
      action: 'renamed',
      installation: { id: 555 },
      repositories_added: [REPO_A],
    });
    expect(result).toEqual({ ignored: 'noop_action' });
  });

  it('ignores noop_action when action is missing entirely', () => {
    const result = parseInstallationRepositoriesEvent({
      installation: { id: 555 },
      repositories_added: [REPO_A],
    });
    expect(result).toEqual({ ignored: 'noop_action' });
  });

  it('ignores no_repositories when repositories_added is missing for action=added', () => {
    const result = parseInstallationRepositoriesEvent({
      action: 'added',
      installation: { id: 555 },
    });
    expect(result).toEqual({ ignored: 'no_repositories' });
  });

  it('ignores no_repositories when repositories_added is not an array', () => {
    const result = parseInstallationRepositoriesEvent({
      action: 'added',
      installation: { id: 555 },
      repositories_added: 'not-an-array',
    });
    expect(result).toEqual({ ignored: 'no_repositories' });
  });

  it('ignores no_repositories when repositories_added is present but empty', () => {
    const result = parseInstallationRepositoriesEvent({
      action: 'added',
      installation: { id: 555 },
      repositories_added: [],
    });
    expect(result).toEqual({ ignored: 'no_repositories' });
  });

  it('drops an individual repo entry missing id, keeps remaining valid entries', () => {
    const result = parseInstallationRepositoriesEvent({
      action: 'added',
      installation: { id: 555 },
      repositories_added: [{ full_name: 'acme/no-id' }, REPO_A],
    });
    expect(result).toEqual({
      action: 'added',
      installationId: 555,
      added: [{ providerRepoId: '111', fullName: 'acme/widgets' }],
      removed: [],
    });
  });

  it('drops an individual repo entry with empty/non-string full_name, keeps remaining valid entries', () => {
    const result = parseInstallationRepositoriesEvent({
      action: 'added',
      installation: { id: 555 },
      repositories_added: [{ id: 999, full_name: '' }, { id: 998, full_name: 42 }, REPO_A],
    });
    expect(result).toEqual({
      action: 'added',
      installationId: 555,
      added: [{ providerRepoId: '111', fullName: 'acme/widgets' }],
      removed: [],
    });
  });

  it('all entries dropped => no_repositories', () => {
    const result = parseInstallationRepositoriesEvent({
      action: 'added',
      installation: { id: 555 },
      repositories_added: [{ full_name: 'acme/no-id' }, { id: 999, full_name: '' }],
    });
    expect(result).toEqual({ ignored: 'no_repositories' });
  });

  it('never reads org_id/organization/owner/account from the body', () => {
    const result = parseInstallationRepositoriesEvent({
      action: 'added',
      installation: { id: 555 },
      repositories_added: [REPO_A],
      organization: { id: 'forged-org', login: 'forged-corp' },
      org_id: 'forged-org-id',
      account: { login: 'forged-account' },
    });
    expect(result).toEqual({
      action: 'added',
      installationId: 555,
      added: [{ providerRepoId: '111', fullName: 'acme/widgets' }],
      removed: [],
    });
  });

  it('the array NOT matching the action is ignored even if non-empty (removed populated during an added action)', () => {
    const result = parseInstallationRepositoriesEvent({
      action: 'added',
      installation: { id: 555 },
      repositories_added: [REPO_A],
      repositories_removed: [REPO_B],
    });
    expect(result).toEqual({
      action: 'added',
      installationId: 555,
      added: [{ providerRepoId: '111', fullName: 'acme/widgets' }],
      removed: [],
    });
  });
});

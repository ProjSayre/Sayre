import { describe, expect, it, vi } from 'vitest';
import {
  fetchGitHubIntegrationStatus,
  GitHubIntegrationStatusRequestError,
  GitHubIntegrationStatusResponseError,
  parseGitHubIntegrationStatusResponse,
} from './githubIntegrationStatus';

const VALID_RESPONSE = {
  authorization: 'server-filtered',
  installations: [
    {
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'selected',
      state: 'active',
      updatedAt: '2026-07-26T16:00:00.000Z',
    },
  ],
  repositories: [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'acme/sayre',
      defaultBranch: 'main',
      currentRef: null,
      state: 'preparing',
      registeredAt: '2026-07-26T15:55:00.000Z',
    },
  ],
  updatedAt: '2026-07-26T16:00:00.000Z',
};

describe('GitHub integration status browser contract', () => {
  it('parses the redacted response', () => {
    expect(parseGitHubIntegrationStatusResponse(VALID_RESPONSE)).toEqual(
      VALID_RESPONSE,
    );
  });

  it('rejects unknown lifecycle values and duplicate repository ids', () => {
    expect(() =>
      parseGitHubIntegrationStatusResponse({
        ...VALID_RESPONSE,
        repositories: [
          VALID_RESPONSE.repositories[0],
          VALID_RESPONSE.repositories[0],
        ],
      }),
    ).toThrow(GitHubIntegrationStatusResponseError);
    expect(() =>
      parseGitHubIntegrationStatusResponse({
        ...VALID_RESPONSE,
        repositories: [
          { ...VALID_RESPONSE.repositories[0], state: 'secret-provider-error' },
        ],
      }),
    ).toThrow(GitHubIntegrationStatusResponseError);
  });

  it('uses only the fixed BFF status route and maps authorization failures', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 403 }),
    );

    await expect(
      fetchGitHubIntegrationStatus({ fetchImpl }),
    ).rejects.toEqual(
      new GitHubIntegrationStatusRequestError(
        'Only an organization administrator can manage repository imports.',
        403,
      ),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/core/integrations/github/status',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    );
  });
});

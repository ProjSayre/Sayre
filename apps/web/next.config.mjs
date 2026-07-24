import { getConfig } from '@sayre/config';

const coreBaseUrl = getConfig('CORE_INTERNAL_BASE_URL').replace(/\/+$/, '');

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/core/repos/:repoId/product-tree',
        destination: `${coreBaseUrl}/repos/:repoId/product-tree`,
      },
      {
        source: '/api/core/repos/:repoId/technical-tree',
        destination: `${coreBaseUrl}/repos/:repoId/technical-tree`,
      },
      {
        source: '/api/core/nodes/:nodeId/overlay',
        destination: `${coreBaseUrl}/nodes/:nodeId/overlay`,
      },
      {
        source: '/api/core/nodes/:nodeId/agent-skill-md',
        destination: `${coreBaseUrl}/nodes/:nodeId/agent-skill-md`,
      },
      {
        source: '/api/core/nodes/:nodeId/agent-skill-md/history',
        destination: `${coreBaseUrl}/nodes/:nodeId/agent-skill-md/history`,
      },
      // AUTH-01: only the login *start* is proxied. The OAuth *callback*
      // (GET /auth/github/callback) hits core's public URL directly — it must
      // NOT be proxied through this rewrite, since GitHub redirects the
      // browser straight to the App's registered callback URL.
      {
        source: '/api/core/auth/github/login',
        destination: `${coreBaseUrl}/auth/github/login`,
      },
      {
        source: '/api/core/repos/:repoId/onboarding-tree',
        destination: `${coreBaseUrl}/repos/:repoId/onboarding-tree`,
      },
      {
        source: '/api/core/repos/:repoId/onboarding-steps/:stepId/execute',
        destination: `${coreBaseUrl}/repos/:repoId/onboarding-steps/:stepId/execute`,
      },
    ];
  },
};

export default nextConfig;

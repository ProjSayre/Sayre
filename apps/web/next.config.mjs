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
    ];
  },
};

export default nextConfig;

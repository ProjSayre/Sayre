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
    ];
  },
};

export default nextConfig;

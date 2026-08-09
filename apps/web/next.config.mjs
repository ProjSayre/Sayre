/** @type {import('next').NextConfig} */
const nextConfig = {
  // Docker builds (see apps/web/Dockerfile) copy only .next/standalone into
  // the runtime image, not the full node_modules tree.
  output: 'standalone',
};

export default nextConfig;

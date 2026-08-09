function cliOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const fixtureHost = cliOption('--hostname');
const fixturePort = cliOption('--port');
const fixtureDistDir = fixtureHost === '127.0.0.1' && /^\d+$/.test(fixturePort ?? '')
  ? `.next-product-workspace-ux-${fixturePort}`
  : '.next';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Browser fixtures can opt into an isolated cache so they can run beside a
  // developer's local Next process without contending for `.next`.
  distDir: fixtureDistDir,
  // Docker builds (see apps/web/Dockerfile) copy only .next/standalone into
  // the runtime image, not the full node_modules tree.
  output: 'standalone',
};

export default nextConfig;

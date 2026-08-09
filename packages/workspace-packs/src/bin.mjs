#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const viteNode = resolve(sourceDirectory, '../../../node_modules/vite-node/vite-node.mjs');
const entry = resolve(sourceDirectory, 'cli-entry.ts');
const result = spawnSync(process.execPath, [viteNode, entry, ...process.argv.slice(2)], { stdio: 'inherit' });

if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}

// Bundles the plugin into one file, dist/coco.mjs, so installing the plugin needs no `npm install`.
//   node scripts/build.ts

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type BuildOptions } from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The bundle is an ES module, but some dependencies (ws, bonjour-service) are CommonJS and call
// require() for Node's built-in modules. This gives them a real require().
const banner = [
  '#!/usr/bin/env node',
  "import { createRequire as cocoCreateRequire } from 'node:module';",
  'const require = cocoCreateRequire(import.meta.url);',
].join('\n');

export const buildOptions: BuildOptions = {
  absWorkingDir: root,
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/coco.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  banner: { js: banner },
  // Optional speed-ups for ws; it works without them.
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
};

// Build when run directly, not when a test imports the options.
const runDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (runDirectly) {
  await build(buildOptions);
}

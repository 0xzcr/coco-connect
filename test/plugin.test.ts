// The plugin's files agree with each other, and the committed bundle matches the source.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { buildOptions } from '../scripts/build.ts';
import { VERSION } from '../src/version.ts';
import { tempDir } from './helpers.ts';

const root = path.join(import.meta.dirname, '..');

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

test('versions match everywhere', () => {
  assert.equal(readJson('package.json').version, VERSION);
  assert.equal(readJson('.claude-plugin/plugin.json').version, VERSION);
});

test('hooks and MCP config point at the bundle', () => {
  const bundle = '${CLAUDE_PLUGIN_ROOT}/dist/coco.mjs';
  const mcp = readJson('.mcp.json');
  assert.deepEqual(mcp.mcpServers.coco.args, [bundle, 'mcp']);

  const hooks = readJson('hooks/hooks.json').hooks;
  assert.deepEqual(hooks.PreToolUse[0].hooks[0].args, [bundle, 'hook', 'pre']);
  assert.deepEqual(hooks.PostToolUse[0].hooks[0].args, [bundle, 'hook', 'post']);
  assert.deepEqual(hooks.UserPromptSubmit[0].hooks[0].args, [bundle, 'hook', 'prompt']);
  assert.match(hooks.PreToolUse[0].matcher, /Edit/);
  assert.match(hooks.PostToolUse[0].matcher, /Bash/);
});

test('the skill has a name and a description', () => {
  const skill = fs.readFileSync(path.join(root, 'skills', 'coco', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: coco\ndescription: .+\n---\n/);
});

test('dist/coco.mjs is up to date with the source (run `npm run build`)', async () => {
  const out = path.join(tempDir('coco-build-'), 'coco.mjs');
  await build({ ...buildOptions, outfile: out, logLevel: 'silent' });

  const fresh = fs.readFileSync(out, 'utf8');
  const committed = fs.readFileSync(path.join(root, 'dist', 'coco.mjs'), 'utf8');
  assert.ok(fresh === committed, 'dist/coco.mjs is stale: run `npm run build`');
});

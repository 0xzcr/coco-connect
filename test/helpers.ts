// Shared test helpers: throwaway git repos, nodes on localhost, and polling.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CocoNode, type NodeOptions } from '../src/room.ts';

export function tempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

// A repo with one commit, so clones of it share a root commit.
export function makeOrigin(): string {
  const dir = tempDir('coco-origin-');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  // Random content: two repos with identical content, author and second would share a commit hash.
  fs.writeFileSync(path.join(dir, 'README.md'), `hello ${Math.random()}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'first']);
  return dir;
}

export function cloneOf(origin: string): string {
  const parent = tempDir('coco-clone-');
  git(parent, ['clone', '-q', origin, 'repo']);
  const dir = path.join(parent, 'repo');
  git(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
}

// Polls until `condition` holds, or fails after `timeoutMs`.
export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5000, what = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// A node that only talks over 127.0.0.1, without Bonjour.
export async function localNode(name: string, repo: string, extra: Partial<NodeOptions> = {}): Promise<CocoNode> {
  const node = new CocoNode({
    projectDir: repo,
    name,
    lanPort: 0,
    discovery: false,
    hosts: ['127.0.0.1'],
    ...extra,
  });
  await node.init();
  return node;
}

export function hostOf(node: CocoNode): string {
  return `127.0.0.1:${node.port}`;
}

export async function closeAll(nodes: CocoNode[]) {
  await Promise.all(nodes.map((node) => node.close()));
}

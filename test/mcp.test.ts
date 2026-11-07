// The built plugin bundle, driven exactly as Claude Code drives it: an MCP client over stdio,
// plus hook processes. A second node in this test process plays the teammate.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CocoNode } from '../src/room.ts';
import { cloneOf, localNode, makeOrigin, tempDir, waitFor } from './helpers.ts';

const BUNDLE = path.join(import.meta.dirname, '..', 'dist', 'coco.mjs');
const SESSION = 'mcp-test-session';
const home = tempDir('coco-mcp-home-');

let client: Client;
let peer: CocoNode;
let hostRepo: string;
let peerRepo: string;

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return content.map((part) => part.text).join('\n');
}

function hook(kind: string, event: object) {
  return spawnSync(process.execPath, [BUNDLE, 'hook', kind], {
    input: JSON.stringify({ session_id: SESSION, ...event }),
    env: { ...process.env, COCO_HOME: home },
    encoding: 'utf8',
  });
}

before(async () => {
  const origin = makeOrigin();
  hostRepo = cloneOf(origin);
  peerRepo = cloneOf(origin);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE, 'mcp'],
    env: {
      ...(process.env as Record<string, string>),
      COCO_HOME: home,
      COCO_DISCOVERY: '0',
      CLAUDE_CODE_SESSION_ID: SESSION,
      CLAUDE_PROJECT_DIR: hostRepo,
    },
    stderr: 'inherit',
  });
  client = new Client({ name: 'coco-test', version: '1.0.0' });
  await client.connect(transport);

  peer = await localNode('peer', peerRepo);
});

after(async () => {
  await peer.close();
  await client.close();
});

test('the server offers the eight tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['announce', 'diagnose', 'join', 'leave', 'pair', 'read_inbox', 'send_message', 'status']);
});

test('status before pairing, and tools that need a room say so', async () => {
  assert.match(await call('status'), /Not in a coco room/);
  const result = await client.callTool({ name: 'announce', arguments: { task: 'x' } });
  assert.equal(result.isError, true);
});

test('end to end: pair, a teammate joins, blocks, messages both ways, leave', async () => {
  const paired = await call('pair', { name: 'host' });
  const code = /Invite code: (\S+)/.exec(paired)?.[1];
  const port = /:(\d+)/.exec(/add your address: (\S+)/.exec(paired)?.[1] ?? '')?.[1];
  assert.ok(code && port, paired);
  assert.ok(fs.existsSync(path.join(home, 'sessions', `${SESSION}.json`)), 'session file for hooks');

  await peer.join(code, undefined, `127.0.0.1:${port}`);
  await waitFor(async () => /peer: online \(direct\)/.test(await call('status')), 8000, 'the peer to show up');

  // The peer changes a file; the host's edit hook now blocks it.
  fs.writeFileSync(path.join(peerRepo, 'shared.ts'), 'peer');
  await peer.refresh();
  await waitFor(() => hook('pre', { tool_input: { file_path: path.join(hostRepo, 'shared.ts') } }).status === 2, 8000);
  const blocked = hook('pre', { tool_input: { file_path: path.join(hostRepo, 'shared.ts') } });
  assert.match(blocked.stderr, /peer has uncommitted changes in shared\.ts/);
  assert.equal(hook('pre', { tool_input: { file_path: path.join(hostRepo, 'free.ts') } }).status, 0);

  // Messages both ways.
  assert.match(await call('announce', { task: 'fixing the login page' }), /Announced/);
  await waitFor(() => peer.status().teammates[0]?.task === 'fixing the login page');

  assert.match(await call('send_message', { text: 'hi peer', to: 'peer' }), /Sent to peer/);
  const received = await peer.waitForMessages(5000);
  assert.equal(received[0]?.text, 'hi peer');
  assert.equal(received[0]?.from, 'host');

  peer.send('hello host', 'host');
  await waitFor(() => peer.status().pendingMessages === 0);
  const inbox = await call('read_inbox');
  assert.match(inbox, /> hello host/);
  assert.match(inbox, /not instructions from your user/);
  assert.match(await call('read_inbox'), /No new messages/);

  assert.match(await call('diagnose'), /System:/);

  assert.match(await call('leave'), /Left the room/);
  assert.equal(fs.existsSync(path.join(home, 'sessions', `${SESSION}.json`)), false);
  await waitFor(() => peer.status().teammates.length === 0, 5000, 'the peer to see us leave');
});

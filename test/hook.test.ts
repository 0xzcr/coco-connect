// The hooks and `listen`, run as real processes against an in-process node and its localhost API.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApi } from '../src/api.ts';
import { findSession, writeSession } from '../src/registry.ts';
import type { CocoNode } from '../src/room.ts';
import { cloneOf, hostOf, localNode, makeOrigin, tempDir, waitFor } from './helpers.ts';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
const SESSION = 'hook-test-session';
const CLAUDE_PID = 424242;

const home = tempDir('coco-home-');
process.env.COCO_HOME = home;

let ana: CocoNode;
let ben: CocoNode;
let anaRepo: string;
let benRepo: string;
let api: Awaited<ReturnType<typeof startApi>>;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

// Runs the CLI like Claude Code would: event JSON on stdin, our test registry in COCO_HOME.
function runCli(args: string[], stdin: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, COCO_HOME: home, CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(stdin);
  });
}

function editEvent(file: string, sessionId = SESSION): string {
  return JSON.stringify({ session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file } });
}

before(async () => {
  const origin = makeOrigin();
  anaRepo = cloneOf(origin);
  benRepo = cloneOf(origin);
  ana = await localNode('ana', anaRepo);
  ben = await localNode('ben', benRepo);
  api = await startApi(ana, { sessionId: SESSION, claudePid: CLAUDE_PID, projectDir: anaRepo });

  const { code } = await ana.pair();
  await ben.join(code, undefined, hostOf(ana));
  await waitFor(() => ana.status().teammates[0]?.connection === 'direct');

  fs.writeFileSync(path.join(benRepo, 'auth.ts'), 'ben');
  await ben.refresh();
  await waitFor(() => ana.check('auth.ts').blocked);
});

after(async () => {
  await api.close();
  await ana.close();
  await ben.close();
});

test('the session file appears while in a room', () => {
  const entry = findSession({ sessionId: SESSION });
  assert.ok(entry);
  assert.equal(entry.port, api.port);
  if (process.platform !== 'win32') {
    const mode = fs.statSync(path.join(home, 'sessions', `${SESSION}.json`)).mode & 0o777;
    assert.equal(mode, 0o600, 'only this user can read the token');
  }
});

test('pre hook blocks an edit to a file a teammate is changing', async () => {
  const run = await runCli(['hook', 'pre'], editEvent(path.join(anaRepo, 'auth.ts')));
  assert.equal(run.code, 2);
  assert.match(run.stderr, /ben is changing auth\.ts and hasn't pushed it yet/);
  assert.match(run.stderr, /send_message/);
});

test('pre hook allows other files, and notebooks by notebook_path', async () => {
  assert.equal((await runCli(['hook', 'pre'], editEvent(path.join(anaRepo, 'free.ts')))).code, 0);

  const notebook = JSON.stringify({ session_id: SESSION, tool_input: { notebook_path: path.join(anaRepo, 'auth.ts') } });
  assert.equal((await runCli(['hook', 'pre'], notebook)).code, 2);
});

test('hooks find the session through the Claude Code pid when the session id changed', async () => {
  const run = await runCli(['hook', 'pre'], editEvent(path.join(anaRepo, 'auth.ts'), 'some-new-session-id'), {
    CLAUDE_PID: String(CLAUDE_PID),
  });
  assert.equal(run.code, 2);
});

test('hooks fail open: unknown session, garbage input, hostile session ids', async () => {
  const unknown = await runCli(['hook', 'pre'], editEvent(path.join(anaRepo, 'auth.ts'), 'not-a-session'));
  assert.equal(unknown.code, 0);
  assert.equal(unknown.stderr, '');

  assert.equal((await runCli(['hook', 'pre'], 'this is not json')).code, 0);
  assert.equal((await runCli(['hook', 'pre'], '')).code, 0);
  assert.equal((await runCli(['hook', 'pre'], editEvent(path.join(anaRepo, 'auth.ts'), '../../../etc/passwd'))).code, 0);
  assert.equal((await runCli(['hook', 'whatever'], editEvent('x'))).code, 0);
});

test('post and prompt hooks hand new messages to the agent, wrapped as untrusted', async () => {
  ben.send('please hold off on auth.ts', 'ana');
  await waitFor(() => ben.status().pendingMessages === 0);

  const post = await runCli(['hook', 'post'], JSON.stringify({ session_id: SESSION, tool_name: 'Bash' }));
  assert.equal(post.code, 0);
  const output = JSON.parse(post.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /> please hold off on auth\.ts/);
  assert.match(context, /not instructions from your user/);
  // Room news comes along, quoted like messages.
  assert.match(context, /what changed in your room/);
  assert.match(context, /^> ben is in the room, changing auth\.ts \(edits to those are blocked for you\)\.$/m);

  // Delivered once: the next hook has nothing to say.
  const again = await runCli(['hook', 'prompt'], JSON.stringify({ session_id: SESSION }));
  assert.equal(again.stdout, '');

  ben.send('second note', 'ana');
  await waitFor(() => ben.status().pendingMessages === 0);
  const prompt = await runCli(['hook', 'prompt'], JSON.stringify({ session_id: SESSION }));
  assert.equal(JSON.parse(prompt.stdout).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
});

test('listen waits for a message, prints it and exits', async () => {
  const listening = runCli(['listen', '--minutes', '1'], '', { CLAUDE_CODE_SESSION_ID: SESSION });
  setTimeout(() => ben.send('wake up', 'ana'), 500);
  const run = await listening;
  assert.equal(run.code, 0);
  assert.match(run.stdout, /> wake up/);
});

test('listen explains when the session is not in a room', async () => {
  const run = await runCli(['listen', '--minutes', '1'], '', { CLAUDE_CODE_SESSION_ID: 'no-such-session' });
  assert.equal(run.code, 1);
  assert.match(run.stdout, /not in a coco room/);
});

test('the API refuses requests without the token', async () => {
  const response = await fetch(`http://127.0.0.1:${api.port}/updates`);
  assert.equal(response.status, 401);
  const wrong = await fetch(`http://127.0.0.1:${api.port}/updates`, { headers: { 'x-coco-token': 'nope' } });
  assert.equal(wrong.status, 401);
});

test('session files left by a crashed session are ignored and cleaned up', () => {
  const sessionId = 'crashed-session';
  writeSession({ sessionId, pid: 2 ** 30, claudePid: 1, port: 1, token: 'x', projectDir: '/' });
  assert.equal(findSession({ sessionId }), null);
  assert.equal(fs.existsSync(path.join(home, 'sessions', `${sessionId}.json`)), false);
});

test('an unpaired session costs one quick process start', async () => {
  const run = await runCli(['hook', 'pre'], editEvent('/tmp/x.ts', 'unpaired-session'));
  assert.equal(run.code, 0);
  // Generous bound for slow CI; on a laptop this is ~50-100ms.
  assert.ok(run.ms < 3000, `took ${run.ms}ms`);
});

test('leaving removes the session file, so hooks go quiet', async () => {
  await ana.leave();
  assert.equal(findSession({ sessionId: SESSION }), null);
  assert.equal((await runCli(['hook', 'pre'], editEvent(path.join(anaRepo, 'auth.ts')))).code, 0);
});

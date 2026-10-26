// Two daemons on one machine, each with its own git repo, talking over localhost.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startDaemon, repoRelative } from '../src/daemon.ts';

test('Windows paths are compared in git form', () => {
  assert.equal(repoRelative('C:\\repo', 'C:\\repo\\src\\db.py', path.win32), 'src/db.py');
  assert.equal(repoRelative('C:\\repo', 'src\\db.py', path.win32), 'src/db.py');
  assert.equal(repoRelative('/repo', '/repo/src/db.py', path.posix), 'src/db.py');
});

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

async function api(port: number, method: string, route: string, body?: object) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// Polls until the condition holds, or fails after two seconds.
async function waitFor(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 2000;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('two daemons share task, files and messages', async () => {
  const aliceRepo = makeRepo();
  const bobRepo = makeRepo();
  const shared = { secret: 's3cret', discovery: false };

  const alice = await startDaemon({ ...shared, name: 'alice', repo: aliceRepo, localPort: 17771, peerPort: 17781 });
  const bob = await startDaemon({ ...shared, name: 'bob', repo: bobRepo, localPort: 17772, peerPort: 17782, peer: '127.0.0.1:17781' });

  try {
    await waitFor(async () => (await api(17772, 'GET', '/status')).connected);

    // Alice announces a task and Bob sees it.
    await api(17771, 'POST', '/announce', { task: 'refactor auth' });
    await waitFor(async () => (await api(17772, 'GET', '/status')).peer?.task === 'refactor auth');

    // Alice edits a file; Bob's agent is blocked from it, Alice's is not.
    fs.writeFileSync(path.join(aliceRepo, 'auth.ts'), 'x');
    await api(17771, 'POST', '/refresh');
    const bobCheck = `/check?file=${encodeURIComponent(path.join(bobRepo, 'auth.ts'))}`;
    await waitFor(async () => (await api(17772, 'GET', bobCheck)).blocked);
    assert.equal((await api(17772, 'GET', bobCheck)).by, 'alice');
    assert.equal((await api(17771, 'GET', `/check?file=auth.ts`)).blocked, false);

    // Bob messages Alice, and reading the inbox empties it.
    await api(17772, 'POST', '/send', { text: 'can I touch auth.ts?' });
    let inbox: { from: string; text: string }[] = [];
    await waitFor(async () => {
      inbox = await api(17771, 'GET', '/inbox');
      return inbox.length > 0;
    });
    assert.equal(inbox[0].from, 'bob');
    assert.equal(inbox[0].text, 'can I touch auth.ts?');
    assert.deepEqual(await api(17771, 'GET', '/inbox'), []);
  } finally {
    await bob.close();
    await alice.close();
  }
});

test('a daemon with the wrong secret is rejected', async () => {
  const alice = await startDaemon({ secret: 'right', discovery: false, name: 'alice', repo: makeRepo(), localPort: 17773, peerPort: 17783 });
  const mallory = await startDaemon({ secret: 'wrong', discovery: false, name: 'mallory', repo: makeRepo(), localPort: 17774, peerPort: 17784, peer: '127.0.0.1:17783' });

  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await api(17773, 'GET', '/status')).connected, false);
    assert.equal((await api(17774, 'GET', '/status')).connected, false);
  } finally {
    await mallory.close();
    await alice.close();
  }
});

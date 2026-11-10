// Four nodes on one machine, each in its own clone of one repo, talking over 127.0.0.1.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import type { Sighting } from '../src/discovery.ts';
import { DEFAULT_LAN_PORT, type CocoNode } from '../src/room.ts';
import { cloneOf, closeAll, git, hostOf, localNode, makeOrigin, waitFor } from './helpers.ts';

function directLinks(node: CocoNode): number {
  return node.status().teammates.filter((teammate) => teammate.connection === 'direct').length;
}

// Starts a room of `names.length` people: the first pairs, the rest join with the code.
async function room(names: string[]) {
  const origin = makeOrigin();
  const repos = names.map(() => cloneOf(origin));
  const nodes = await Promise.all(names.map((name, index) => localNode(name, repos[index])));

  const { code } = await nodes[0].pair();
  for (const node of nodes.slice(1)) {
    await node.join(code, undefined, hostOf(nodes[0]));
  }

  const others = names.length - 1;
  await waitFor(() => nodes.every((node) => directLinks(node) === others), 8000, 'a full mesh');
  return { origin, repos, nodes, code };
}

test('four sessions pair and join into a full mesh', async () => {
  const { nodes } = await room(['ana', 'ben', 'cy', 'dee']);
  try {
    for (const node of nodes) {
      const status = node.status();
      assert.equal(status.members, 4);
      assert.equal(status.teammates.length, 3);
      assert.ok(status.teammates.every((teammate) => teammate.online && teammate.sameRepo));
    }
    const names = nodes[0].status().teammates.map((teammate) => teammate.name).sort();
    assert.deepEqual(names, ['ben', 'cy', 'dee']);

    // The links stay up. (They used to drop and redial whenever the first encrypted frame
    // arrived in the same packet as the last handshake message.)
    for (let sample = 0; sample < 10; sample += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(nodes.every((node) => directLinks(node) === 3), `mesh dropped at sample ${sample}`);
    }

    // The room is full now: no invite is advertised, and pair says so.
    assert.equal(nodes[0].status().invite, null);
    await assert.rejects(nodes[1].pair(), /full/);
  } finally {
    await closeAll(nodes);
  }
});

test('changed files block teammates until pushed, not just committed', async () => {
  const { repos, nodes } = await room(['ana', 'ben', 'cy']);
  const [ana, ben, cy] = nodes;
  try {
    fs.writeFileSync(path.join(repos[1], 'auth.ts'), 'ben was here');
    await ben.refresh();

    const anaPath = path.join(repos[0], 'auth.ts');
    await waitFor(() => ana.check(anaPath).blocked, 5000, 'ana to see ben\'s change');
    assert.deepEqual(ana.check(anaPath), { blocked: true, by: ['ben'], file: 'auth.ts' });
    assert.equal(ana.check('auth.ts').blocked, true, 'relative paths resolve against the repo root');
    assert.equal(ben.check(path.join(repos[1], 'auth.ts')).blocked, false, 'your own changes never block you');
    assert.equal(ana.check(path.join(repos[0], 'other.ts')).blocked, false);
    assert.equal(ana.check('/somewhere/else/auth.ts').blocked, false, 'files outside the repo are never blocked');

    // Two teammates on the same file: both are named.
    fs.writeFileSync(path.join(repos[2], 'auth.ts'), 'cy too');
    await cy.refresh();
    await waitFor(() => ana.check(anaPath).by.length === 2, 5000, 'two blockers');
    assert.deepEqual(ana.check(anaPath).by.sort(), ['ben', 'cy']);

    // Committing keeps the block: ana would still conflict with ben when she pulls.
    git(repos[1], ['add', '-A']);
    git(repos[1], ['commit', '-qm', 'auth']);
    await ben.refresh();
    const bensUnpushed = () => ana.status().teammates.find((teammate) => teammate.name === 'ben')?.unpushed ?? [];
    await waitFor(() => bensUnpushed().includes('auth.ts'), 5000, 'ana to see ben\'s commit');
    assert.deepEqual(ana.check(anaPath).by.sort(), ['ben', 'cy']);

    // Pushing lifts it.
    git(repos[1], ['push', '-q', 'origin', 'HEAD:ben-work']);
    await ben.refresh();
    await waitFor(() => !ana.check(anaPath).by.includes('ben'), 5000, 'ben\'s block to lift');
  } finally {
    await closeAll(nodes);
  }
});

// Reads room news the way hooks do over several tool calls, until `done` holds for all of it.
async function collectNews(node: CocoNode, done: (news: string) => boolean, what: string): Promise<string> {
  let news = '';
  const check = () => {
    news += node.roomNews().map((line) => `${line}\n`).join('');
    return done(news);
  };
  await waitFor(check, 5000, what);
  return news;
}

test('room news tells the agent once about tasks, files, and who comes and goes', async () => {
  const { repos, nodes } = await room(['ana', 'ben', 'cy']);
  const [ana, ben, cy] = nodes;
  try {
    const arrived = (news: string) => /^ben is in the room\.$/m.test(news) && /^cy is in the room\.$/m.test(news);
    await collectNews(ana, arrived, 'ana to hear who is in the room');
    assert.deepEqual(ana.roomNews(), [], 'nothing is repeated');

    ben.announceTask('refactor login');
    await collectNews(ana, (news) => /ben is now working on "refactor login"/.test(news), 'the task');

    fs.writeFileSync(path.join(repos[1], 'auth.ts'), 'ben was here');
    await ben.refresh();
    const started = await collectNews(ana, (news) => /ben started changing/.test(news), 'the change');
    assert.match(started, /^ben started changing auth\.ts \(edits to those are blocked for you until they push\)\.$/m);

    // A commit isn't news: the file is still not pushed.
    git(repos[1], ['add', '-A']);
    git(repos[1], ['commit', '-qm', 'auth']);
    await ben.refresh();
    await waitFor(() => (ana.status().teammates.find((t) => t.name === 'ben')?.unpushed ?? []).length === 1);
    assert.deepEqual(ana.roomNews(), []);

    git(repos[1], ['push', '-q', 'origin', 'HEAD:ben-work']);
    await ben.refresh();
    const done = await collectNews(ana, (news) => /ben is done with/.test(news), 'the push');
    assert.match(done, /ben is done with auth\.ts \(pushed or reverted\)\. If they pushed, pull before you edit those\./);

    await cy.leave();
    await collectNews(ana, (news) => /^cy is no longer in the room\.$/m.test(news), 'cy leaving');
  } finally {
    await closeAll(nodes);
  }
});

test('a teammate who drops off without a goodbye keeps blocking their files', async () => {
  const { repos, nodes } = await room(['ana', 'ben']);
  const [ana, ben] = nodes;
  try {
    fs.writeFileSync(path.join(repos[1], 'auth.ts'), 'ben');
    await ben.refresh();
    await waitFor(() => ana.check('auth.ts').blocked, 5000, 'ana to see ben\'s change');
    ana.roomNews();

    // Ben's laptop goes to sleep: the links drop and no goodbye is sent.
    const benId = ben.memberId;
    (ben as unknown as { flood: () => void }).flood = () => {};
    await ben.leave();
    await waitFor(() => directLinks(ana) === 0, 5000, 'the link to drop');

    // Ana counts ben as offline after 45 seconds without news; pretend they have passed.
    const anaMembers = (ana as unknown as { members: Map<string, { heardAt: number }> }).members;
    const bensEntry = anaMembers.get(benId);
    assert.ok(bensEntry);
    bensEntry.heardAt -= 60_000;

    assert.equal(ana.status().teammates[0].online, false);
    assert.deepEqual(ana.check('auth.ts'), { blocked: true, by: ['ben (offline)'], file: 'auth.ts' });
    assert.match(ana.roomNews().join('\n'), /^ben went offline .* stay blocked for up to 30 minutes/m);
  } finally {
    await closeAll(nodes);
  }
});

test('a teammate in a different repo never blocks', async () => {
  const origin = makeOrigin();
  const ana = await localNode('ana', cloneOf(origin));
  const otherRepo = makeOrigin();
  const zed = await localNode('zed', otherRepo);
  try {
    const { code } = await ana.pair();
    await zed.join(code, undefined, hostOf(ana));
    await waitFor(() => directLinks(ana) === 1);

    fs.writeFileSync(path.join(otherRepo, 'auth.ts'), 'x');
    await zed.refresh();
    await waitFor(() => (ana.status().teammates[0]?.files ?? []).includes('auth.ts'));

    assert.equal(ana.check('auth.ts').blocked, false);
    assert.equal(ana.status().teammates[0].sameRepo, false);
  } finally {
    await closeAll([ana, zed]);
  }
});

test('messages: to one person, to everyone, delivered once, shown safely', async () => {
  const { nodes } = await room(['ana', 'ben', 'cy']);
  const [ana, ben, cy] = nodes;
  try {
    ana.send('ben, can I touch auth.ts?', 'Ben');
    await waitFor(() => ben.status().pendingMessages === 0 && ana.status().pendingMessages === 0);

    let inbox = await ben.waitForMessages(3000);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].from, 'ana');
    assert.equal(inbox[0].to, 'you');
    assert.equal(inbox[0].text, 'ben, can I touch auth.ts?');
    assert.deepEqual(cy.readInbox(), [], 'a message to ben does not reach cy');

    const result = ana.send('standup in 5‮txt.exe');
    assert.deepEqual(result.map((r) => r.name).sort(), ['ben', 'cy']);
    inbox = await cy.waitForMessages(3000);
    assert.equal(inbox[0].to, 'everyone');
    assert.equal(inbox[0].text, 'standup in 5txt.exe', 'bidi overrides are stripped');
    assert.equal((await ben.waitForMessages(3000)).length, 1);

    // Reading empties the inbox.
    assert.deepEqual(ben.readInbox(), []);

    assert.throws(() => ana.send('hi', 'nobody'), /No teammate called "nobody"/);
    assert.throws(() => ana.send('   '), /empty/);
  } finally {
    await closeAll(nodes);
  }
});

test('waiting for messages returns as soon as one arrives', async () => {
  const { nodes } = await room(['ana', 'ben']);
  const [ana, ben] = nodes;
  try {
    const started = Date.now();
    const waiting = ben.waitForMessages(10_000);
    setTimeout(() => ana.send('ping'), 200);
    const messages = await waiting;
    assert.equal(messages[0].text, 'ping');
    assert.ok(Date.now() - started < 5000);

    assert.deepEqual(await ben.waitForMessages(100), [], 'times out empty');
  } finally {
    await closeAll(nodes);
  }
});

test('wrong codes are refused, and the code locks after five', async () => {
  const origin = makeOrigin();
  const ana = await localNode('ana', cloneOf(origin));
  const guesser = await localNode('guesser', cloneOf(origin));
  const late = await localNode('late', cloneOf(origin));
  try {
    const { code } = await ana.pair();
    const secret = code.split('-').pop() as string;
    const wrong = String((Number(secret) + 1) % 1_000_000).padStart(6, '0');

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await assert.rejects(guesser.join(wrong, undefined, hostOf(ana)), /Wrong code/);
    }
    // Locked: even the right code no longer works, and the user is told to make a new one.
    await assert.rejects(late.join(code, undefined, hostOf(ana)), /locked/);
    assert.ok(ana.status().warnings.some((warning) => warning.includes('locked')));
    assert.equal(guesser.inRoom, false);

    // A fresh code works.
    const fresh = await ana.pair();
    assert.notEqual(fresh.code, code);
    await late.join(fresh.code, undefined, hostOf(ana));
    assert.equal(late.inRoom, true);
  } finally {
    await closeAll([ana, guesser, late]);
  }
});

test('pair twice returns the same code; codes and bad input are explained', async () => {
  const origin = makeOrigin();
  const ana = await localNode('ana', cloneOf(origin));
  const ben = await localNode('ben', cloneOf(origin));
  try {
    const first = await ana.pair();
    const second = await ana.pair();
    assert.equal(first.code, second.code);

    await assert.rejects(ben.join('not a code'), /not a coco code/);
    await assert.rejects(ben.join('123456', undefined, '127.0.0.1:1'), /Couldn't find the host/);
    assert.equal(ben.inRoom, false);
    assert.equal(ben.port, 0, 'a failed join closes the port again');

    await ben.join(first.code, undefined, hostOf(ana));
    await assert.rejects(ben.join(first.code, undefined, hostOf(ana)), /Already in a coco room/);
  } finally {
    await closeAll([ana, ben]);
  }
});

test('a fifth person is turned away', async () => {
  const { origin, nodes } = await room(['ana', 'ben', 'cy']);
  const dee = await localNode('dee', cloneOf(origin));
  const eve = await localNode('eve', cloneOf(origin));
  try {
    // Any member can invite, not just the host.
    const { code } = await nodes[1].pair();
    await dee.join(code, undefined, hostOf(nodes[1]));
    await assert.rejects(eve.join(code, undefined, hostOf(nodes[1])), /already has 4 people/);
    assert.equal(eve.inRoom, false);
  } finally {
    await closeAll([...nodes, dee, eve]);
  }
});

test('duplicate names get a suffix', async () => {
  const origin = makeOrigin();
  const first = await localNode('sam', cloneOf(origin));
  const second = await localNode('Sam', cloneOf(origin));
  try {
    const { code } = await first.pair();
    const result = await second.join(code, undefined, hostOf(first));
    assert.equal(result.name, 'Sam-2');
    await waitFor(() => first.status().teammates[0]?.name === 'Sam-2');
  } finally {
    await closeAll([first, second]);
  }
});

test('leaving tells everyone, and the leaver stops blocking', async () => {
  const { repos, nodes } = await room(['ana', 'ben', 'cy']);
  const [ana, ben, cy] = nodes;
  try {
    fs.writeFileSync(path.join(repos[2], 'auth.ts'), 'x');
    await cy.refresh();
    await waitFor(() => ana.check('auth.ts').blocked);

    await cy.leave();
    await waitFor(() => ana.status().teammates.length === 1 && ben.status().teammates.length === 1);
    assert.equal(ana.check('auth.ts').blocked, false);
    assert.equal(cy.inRoom, false);
    assert.equal(cy.port, 0);

    // The same session can come back: teammates remember who left, so it rejoins under a new id.
    const { code } = await ana.pair();
    await cy.join(code, undefined, hostOf(ana));
    await waitFor(() => nodes.every((node) => directLinks(node) === 2), 8000, 'cy back in the mesh');
    await waitFor(() => ana.check('auth.ts').blocked, 5000, 'cy blocking again');
  } finally {
    await closeAll(nodes);
  }
});

test('when two laptops cannot reach each other, state and messages go through a third', async () => {
  const origin = makeOrigin();
  const repos = [cloneOf(origin), cloneOf(origin), cloneOf(origin)];

  // Fixed ports, so each node knows the address it must not dial before anyone starts.
  const ports = await freePorts(3);
  const address = (index: number) => `127.0.0.1:${ports[index]}`;

  const hub = await localNode('hub', repos[0], { lanPort: ports[0] });
  const left = await localNode('left', repos[1], { lanPort: ports[1], canDial: (to) => to !== address(2) });
  const right = await localNode('right', repos[2], { lanPort: ports[2], canDial: (to) => to !== address(1) });
  try {
    const { code } = await hub.pair();
    await left.join(code, undefined, address(0));
    await right.join(code, undefined, address(0));

    await waitFor(() => directLinks(hub) === 2, 5000, 'hub links');
    await waitFor(() => left.status().teammates.length === 2 && right.status().teammates.length === 2);

    const rightAsSeenByLeft = () => left.status().teammates.find((teammate) => teammate.name === 'right');
    await waitFor(() => rightAsSeenByLeft()?.online === true, 5000, 'right online through hub');
    assert.equal(rightAsSeenByLeft()?.connection, 'through a teammate');

    // State flows through the hub...
    fs.writeFileSync(path.join(repos[2], 'shared.ts'), 'x');
    await right.refresh();
    await waitFor(() => left.check('shared.ts').blocked, 5000, 'left to see right\'s file');

    // ...and so do messages, with the acknowledgement coming back the same way.
    left.send('hello from the far side', 'right');
    const inbox = await right.waitForMessages(5000);
    assert.equal(inbox[0]?.text, 'hello from the far side');
    assert.equal(inbox[0]?.from, 'left');
    await waitFor(() => left.status().pendingMessages === 0, 5000, 'the acknowledgement');
  } finally {
    await closeAll([hub, left, right]);
  }
});

// Bonjour re-reports teammates every few seconds, and each report resets the dial backoff. A
// teammate whose only working address is 4th in the list (VM and VPN adapters before it) must
// still be reached: the address being tried has its own counter, which those resets don't touch.
test('a working address 4th in the list is still reached while Bonjour keeps reporting the teammate', async () => {
  const origin = makeOrigin();
  const deadEnds = ['192.0.2.1', '192.0.2.2', '192.0.2.3'];
  const ben = await localNode('ben', cloneOf(origin), { hosts: [...deadEnds, '127.0.0.1'] });
  const ana = await localNode('ana', cloneOf(origin), { canDial: (to) => to.startsWith('127.0.0.1:') });

  // Bonjour is off in tests, so play its part by reporting ben to ana over and over.
  const internals = ana as unknown as { room: { tag: string } | null; onSighting(sighting: Sighting): void };
  let reporting: NodeJS.Timeout | undefined;
  try {
    const { code } = await ben.pair();
    await ana.join(code, undefined, hostOf(ben));

    const sighting: Sighting = {
      memberId: ben.memberId,
      name: 'ben',
      roomTag: internals.room?.tag ?? '',
      invite: false,
      addresses: [...deadEnds, '127.0.0.1'].map((host) => `${host}:${ben.port}`),
    };
    reporting = setInterval(() => internals.onSighting(sighting), 200);

    await waitFor(() => directLinks(ana) === 1, 15_000, "ana to reach ben's 4th address");
  } finally {
    clearInterval(reporting);
    await closeAll([ana, ben]);
  }
});

test('a dropped connection comes back, and queued messages are delivered', async () => {
  const origin = makeOrigin();
  const ports = await freePorts(2);
  let networkUp = true;
  const canDial = () => networkUp;

  const ana = await localNode('ana', cloneOf(origin), { lanPort: ports[0], canDial });
  const ben = await localNode('ben', cloneOf(origin), { lanPort: ports[1], canDial });
  try {
    const { code } = await ana.pair();
    await ben.join(code, undefined, `127.0.0.1:${ports[0]}`);
    await waitFor(() => directLinks(ana) === 1 && directLinks(ben) === 1);

    // The Wi-Fi drops: kill every socket and stop new ones.
    networkUp = false;
    killSockets(ana);
    killSockets(ben);
    await waitFor(() => directLinks(ana) === 0 && directLinks(ben) === 0, 5000, 'links to drop');

    ana.send('sent while the network was down', 'ben');
    assert.equal(ana.status().pendingMessages, 1);

    networkUp = true;
    const inbox = await ben.waitForMessages(20_000);
    assert.equal(inbox[0]?.text, 'sent while the network was down');
    await waitFor(() => ana.status().pendingMessages === 0, 15_000, 'the acknowledgement');
    assert.equal(directLinks(ana), 1);
  } finally {
    await closeAll([ana, ben]);
  }
});

test('outsiders without the room key get nothing', async () => {
  const origin = makeOrigin();
  const ana = await localNode('ana', cloneOf(origin));
  try {
    await ana.pair();

    // A stranger tries to link with a made-up room.
    const reply = await rawExchange(hostOf(ana), {
      t: 'link',
      v: 1,
      room: '0123456789abcdef',
      from: 'aaaaaaaaaaaaaaaa',
      eph: Buffer.alloc(32, 9).toString('base64'),
      nonce: Buffer.alloc(16).toString('base64'),
    });
    assert.deepEqual(reply, { t: 'error', reason: 'unknown-room' });

    // Junk and old protocol versions are refused.
    assert.deepEqual(await rawExchange(hostOf(ana), { t: 'join', v: 99 }), { t: 'error', reason: 'version' });
    assert.deepEqual(await rawExchange(hostOf(ana), { hello: 'there', v: 1 }), { t: 'error', reason: 'bad-message' });
    assert.equal(ana.status().teammates.length, 0);
  } finally {
    await ana.close();
  }
});

test('joining with only the code finds the host on the default port (no Bonjour needed)', async (t) => {
  if (!(await portIsFree(DEFAULT_LAN_PORT))) {
    t.skip(`port ${DEFAULT_LAN_PORT} is in use on this machine`);
    return;
  }
  const origin = makeOrigin();
  const ana = await localNode('ana', cloneOf(origin), { lanPort: DEFAULT_LAN_PORT });
  const ben = await localNode('ben', cloneOf(origin));
  try {
    const { code } = await ana.pair();
    assert.match(code, /^1-\d{6}$/, 'the hint is the last number of 127.0.0.1');
    await ben.join(code);
    assert.equal(ben.inRoom, true);
  } finally {
    await closeAll([ana, ben]);
  }
});

// ---------------------------------------------------------------------------

function killSockets(node: CocoNode) {
  const members = (node as unknown as { members: Map<string, { link: { close(): void } | null }> }).members;
  for (const member of members.values()) {
    member.link?.close();
  }
}

// Sends one handshake message and returns the first reply.
function rawExchange(address: string, message: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${address}`);
    ws.on('open', () => ws.send(JSON.stringify(message)));
    ws.on('message', (data) => {
      resolve(JSON.parse(String(data)));
      ws.close();
    });
    ws.on('error', reject);
  });
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
  });
}

async function freePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  while (ports.length < count) {
    const port = await new Promise<number>((resolve) => {
      const server = net.createServer();
      server.listen(0, '0.0.0.0', () => {
        const chosen = (server.address() as net.AddressInfo).port;
        server.close(() => resolve(chosen));
      });
    });
    if (!ports.includes(port)) {
      ports.push(port);
    }
  }
  return ports;
}

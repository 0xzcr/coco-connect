import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FrameCipher,
  agree,
  formatCode,
  linkKeys,
  linkProof,
  newEphemeral,
  newSecret,
  openBox,
  pakeFinish,
  pakeProof,
  pakeStart,
  parseCode,
  randomBytes,
  sealBox,
  type LinkTranscript,
} from '../src/crypto.ts';

test('codes parse however people type them', () => {
  assert.deepEqual(parseCode('20-482913'), { hint: 20, secret: '482913' });
  assert.deepEqual(parseCode(' 20 482 913 '), { hint: 20, secret: '482913' });
  assert.deepEqual(parseCode('482913'), { hint: null, secret: '482913' });
  assert.deepEqual(parseCode('482-913'), { hint: null, secret: '482913' });
  assert.deepEqual(parseCode('255-000001'), { hint: 255, secret: '000001' });

  assert.equal(parseCode('12345'), null, 'too short');
  assert.equal(parseCode('256-482913'), null, 'hint is not an IP octet');
  assert.equal(parseCode('1234-482913'), null, 'too long');
  assert.equal(parseCode('hello'), null);

  assert.equal(formatCode({ hint: 7, secret: '000123' }), '7-000123');
  assert.equal(formatCode({ hint: null, secret: '000123' }), '000123');
});

test('new secrets are always six digits', () => {
  const secrets = Array.from({ length: 200 }, () => newSecret());
  assert.ok(secrets.every((secret) => /^\d{6}$/.test(secret)));
});

// Runs both halves of CPace and returns each side's key.
function runPake(hostSecret: string, joinerSecret: string) {
  const sessionId = randomBytes(16);
  const host = pakeStart(hostSecret, sessionId);
  const joiner = pakeStart(joinerSecret, sessionId);
  const hostKey = pakeFinish(host, joiner.publicPoint, sessionId, host.publicPoint, joiner.publicPoint);
  const joinerKey = pakeFinish(joiner, host.publicPoint, sessionId, host.publicPoint, joiner.publicPoint);
  return { host, joiner, sessionId, hostKey, joinerKey };
}

test('CPace: same code gives the same key, a different code does not', () => {
  const right = runPake('482913', '482913');
  assert.ok(right.hostKey && right.joinerKey);
  assert.deepEqual(right.hostKey, right.joinerKey);
  assert.deepEqual(pakeProof(right.hostKey, 'joiner'), pakeProof(right.joinerKey, 'joiner'));

  const wrong = runPake('482913', '482914');
  assert.ok(wrong.hostKey && wrong.joinerKey);
  assert.notDeepEqual(wrong.hostKey, wrong.joinerKey);
});

test('CPace: proofs are per role, and the points reveal nothing reusable', () => {
  const { hostKey } = runPake('111111', '111111');
  assert.ok(hostKey);
  assert.notDeepEqual(pakeProof(hostKey, 'host'), pakeProof(hostKey, 'joiner'));

  // Two runs with the same code send different points (fresh randomness each time).
  const a = pakeStart('111111', randomBytes(16));
  const b = pakeStart('111111', randomBytes(16));
  assert.notDeepEqual(a.publicPoint, b.publicPoint);
});

test('CPace rejects the identity point and garbage', () => {
  const sessionId = randomBytes(16);
  const half = pakeStart('482913', sessionId);
  const identity = new Uint8Array(32);
  assert.equal(pakeFinish(half, identity, sessionId, half.publicPoint, identity), null);

  const garbage = new Uint8Array(32).fill(0xff);
  assert.equal(pakeFinish(half, garbage, sessionId, half.publicPoint, garbage), null);
});

test('boxes open only with the right key and untouched bytes', () => {
  const key = randomBytes(32);
  const box = sealBox(key, { roomKey: 'abc', members: [1, 2] });
  assert.deepEqual(openBox(key, box), { roomKey: 'abc', members: [1, 2] });

  assert.equal(openBox(randomBytes(32), box), null, 'wrong key');

  const bytes = Buffer.from(box, 'base64');
  bytes[bytes.length - 1] ^= 1;
  assert.equal(openBox(key, bytes.toString('base64')), null, 'tampered');
  assert.equal(openBox(key, 42), null, 'not a string');
});

function transcriptFor(dialerEphemeral: Uint8Array, listenerEphemeral: Uint8Array): LinkTranscript {
  return {
    roomId: '0123456789abcdef',
    dialerId: 'aaaaaaaaaaaaaaaa',
    listenerId: 'bbbbbbbbbbbbbbbb',
    dialerEphemeral,
    listenerEphemeral,
    dialerNonce: new Uint8Array(16).fill(1),
    listenerNonce: new Uint8Array(16).fill(2),
  };
}

test('member links: both sides derive matching keys; proofs depend on the room key', () => {
  const roomKey = randomBytes(32);
  const dialer = newEphemeral();
  const listener = newEphemeral();
  const transcript = transcriptFor(dialer.publicRaw, listener.publicRaw);

  const dialerShared = agree(dialer, listener.publicRaw);
  const listenerShared = agree(listener, dialer.publicRaw);
  assert.ok(dialerShared && listenerShared);
  assert.deepEqual(dialerShared, listenerShared);

  const dialerKeys = linkKeys(dialerShared, roomKey, transcript);
  const listenerKeys = linkKeys(listenerShared, roomKey, transcript);
  assert.deepEqual(dialerKeys, listenerKeys);
  assert.notDeepEqual(dialerKeys.dialerToListener, dialerKeys.listenerToDialer);

  const otherRoom = randomBytes(32);
  assert.notDeepEqual(linkProof(roomKey, 'dialer', transcript), linkProof(otherRoom, 'dialer', transcript));
  assert.notDeepEqual(linkProof(roomKey, 'dialer', transcript), linkProof(roomKey, 'listener', transcript));
});

test('X25519 refuses a low-order public key', () => {
  const mine = newEphemeral();
  assert.equal(agree(mine, new Uint8Array(32)), null);
});

test('frames: in order works; tampered, replayed or reordered frames fail', () => {
  const aToB = randomBytes(32);
  const bToA = randomBytes(32);
  const alice = new FrameCipher(aToB, bToA);
  const bob = new FrameCipher(bToA, aToB);

  const first = alice.seal(Buffer.from('one'));
  const second = alice.seal(Buffer.from('two'));

  // Out of order: the second frame can't be opened first.
  assert.equal(bob.open(second), null);
  assert.equal(bob.open(first)?.toString(), 'one');
  assert.equal(bob.open(second)?.toString(), 'two');

  // Replay of an old frame.
  assert.equal(bob.open(first), null);

  // Tampering.
  const third = alice.seal(Buffer.from('three'));
  third[0] ^= 1;
  assert.equal(bob.open(third), null);

  // Replies use the other key.
  assert.equal(alice.open(bob.seal(Buffer.from('hi')))?.toString(), 'hi');
});

// All the cryptography coco-connect uses, in one place.
//
//   Pairing codes  "20-482913": a hint for finding the host, plus six secret digits.
//   CPace          turns the six digits into a strong shared key. Someone listening on the Wi-Fi
//                  learns nothing, and someone pretending to be the host gets exactly one guess
//                  per attempt, which the host limits.
//   Room box       the host hands the room key to a new member, encrypted with the CPace key.
//   Member links   two members prove they both hold the room key and agree on fresh keys
//                  (X25519 + HMAC), so recorded traffic can't be decrypted later.
//   Frames         every message after that is AES-256-GCM with a counter, so it can't be
//                  read, changed, replayed or reordered.

import crypto from 'node:crypto';
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';

const Point = ristretto255.Point;
const GROUP_ORDER = Point.Fn.ORDER;

const CPACE_DST = 'coco-connect/cpace/v1';
const SECRET_DIGITS = 6;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function randomBytes(length: number): Buffer {
  return crypto.randomBytes(length);
}

export function randomId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function utf8(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

// Joins byte strings with a 4-byte length in front of each, so ("ab", "c") and ("a", "bc")
// can never produce the same bytes.
function lengthPrefixed(parts: Uint8Array[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(part.length);
    chunks.push(length, Buffer.from(part));
  }
  return Buffer.concat(chunks);
}

function sha256(data: Uint8Array): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

function hmac(key: Uint8Array, data: Uint8Array): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

// Compares secrets without leaking, through timing, how many leading bytes matched.
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

// Decodes base64 from the network. Returns null for anything that isn't a string of
// exactly `length` decoded bytes, so callers never handle malformed input.
export function fromBase64(value: unknown, length: number): Buffer | null {
  if (typeof value !== 'string') {
    return null;
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== length) {
    return null;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Pairing codes
// ---------------------------------------------------------------------------

export interface PairingCode {
  hint: number | null;  // last number of the host's IP address, used only to find the host
  secret: string;       // six digits; the actual password
}

export function newSecret(): string {
  return crypto.randomInt(0, 10 ** SECRET_DIGITS).toString().padStart(SECRET_DIGITS, '0');
}

export function formatCode(code: PairingCode): string {
  if (code.hint === null) {
    return code.secret;
  }
  return `${code.hint}-${code.secret}`;
}

// Accepts what people actually type or say: "20-482913", "20 482 913", "482913", "482-913".
// Only the digits count. The last six are the secret, and anything before them is the hint.
export function parseCode(raw: string): PairingCode | null {
  const digits = raw.replace(/[^0-9]/g, '');

  if (digits.length < SECRET_DIGITS || digits.length > SECRET_DIGITS + 3) {
    return null;
  }

  const secret = digits.slice(-SECRET_DIGITS);
  const hintDigits = digits.slice(0, -SECRET_DIGITS);

  if (hintDigits === '') {
    return { hint: null, secret };
  }

  const hint = Number(hintDigits);
  if (hint > 255) {
    return null;
  }
  return { hint, secret };
}

// ---------------------------------------------------------------------------
// CPace (balanced PAKE over ristretto255)
// ---------------------------------------------------------------------------

// One side's half of a CPace run: a random scalar, and the point we send to the other side.
export interface PakeHalf {
  scalar: bigint;
  publicPoint: Uint8Array;  // 32 bytes
}

// The point both sides compute from the code. Without the code it's just a random point,
// so the values we send reveal nothing about the code.
function generatorFor(secret: string, sessionId: Uint8Array) {
  const input = lengthPrefixed([utf8('coco-connect cpace generator'), utf8(secret), sessionId]);
  return ristretto255_hasher.hashToCurve(input, { DST: CPACE_DST });
}

// A uniformly random non-zero scalar. 64 random bytes reduced by the group order has
// negligible bias.
function randomScalar(): bigint {
  while (true) {
    const scalar = BigInt(`0x${crypto.randomBytes(64).toString('hex')}`) % GROUP_ORDER;
    if (scalar !== 0n) {
      return scalar;
    }
  }
}

export function pakeStart(secret: string, sessionId: Uint8Array): PakeHalf {
  const scalar = randomScalar();
  const publicPoint = generatorFor(secret, sessionId).multiply(scalar).toBytes();
  return { scalar, publicPoint };
}

// Finishes CPace and returns the shared key. Both sides get the same key only if they
// used the same code. Returns null if the other side sent something that isn't a valid point.
export function pakeFinish(
  half: PakeHalf,
  theirPoint: Uint8Array,
  sessionId: Uint8Array,
  hostPoint: Uint8Array,
  joinerPoint: Uint8Array,
): Buffer | null {
  let decoded;
  try {
    decoded = Point.fromBytes(theirPoint);
  } catch {
    return null;
  }
  // The identity point would make the shared secret predictable.
  if (decoded.is0()) {
    return null;
  }

  const shared = decoded.multiply(half.scalar);
  if (shared.is0()) {
    return null;
  }

  return sha256(
    lengthPrefixed([utf8('coco-connect cpace key'), sessionId, shared.toBytes(), hostPoint, joinerPoint]),
  );
}

// Proof that a side derived the right key. Each role has its own label, so a proof can't
// be bounced back to the side that sent it.
export function pakeProof(key: Uint8Array, role: 'host' | 'joiner'): Buffer {
  return hmac(key, utf8(`coco-connect pake proof ${role}`));
}

// The key used to encrypt the room details the host hands to a new member.
export function pakeBoxKey(key: Uint8Array): Buffer {
  return hmac(key, utf8('coco-connect pake box'));
}

// ---------------------------------------------------------------------------
// Boxes: one-off encrypted blobs (used for the room details sent to a new member)
// ---------------------------------------------------------------------------

const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

export function sealBox(key: Uint8Array, value: unknown): string {
  const nonce = crypto.randomBytes(GCM_NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(utf8(JSON.stringify(value))), cipher.final()]);
  return toBase64(Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]));
}

// Returns null if the box was tampered with, sealed with another key, or isn't JSON.
export function openBox(key: Uint8Array, box: unknown): unknown {
  if (typeof box !== 'string') {
    return null;
  }
  const bytes = Buffer.from(box, 'base64');
  if (bytes.length < GCM_NONCE_BYTES + GCM_TAG_BYTES) {
    return null;
  }

  const nonce = bytes.subarray(0, GCM_NONCE_BYTES);
  const ciphertext = bytes.subarray(GCM_NONCE_BYTES, bytes.length - GCM_TAG_BYTES);
  const tag = bytes.subarray(bytes.length - GCM_TAG_BYTES);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Member links: X25519 key agreement, authenticated with the room key
// ---------------------------------------------------------------------------

export interface Ephemeral {
  privateKey: crypto.KeyObject;
  publicRaw: Buffer;  // 32 bytes, sent to the other side
}

export function newEphemeral(): Ephemeral {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey, publicRaw: Buffer.from(String(jwk.x), 'base64url') };
}

// X25519 with the other side's public key. Returns null if their key is unusable
// (OpenSSL rejects keys that would give an all-zero secret).
export function agree(mine: Ephemeral, theirPublicRaw: Uint8Array): Buffer | null {
  try {
    const publicKey = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(theirPublicRaw).toString('base64url') },
      format: 'jwk',
    });
    return crypto.diffieHellman({ privateKey: mine.privateKey, publicKey });
  } catch {
    return null;
  }
}

// Everything both sides said during a link handshake, in a fixed order.
export interface LinkTranscript {
  roomId: string;
  dialerId: string;
  listenerId: string;
  dialerEphemeral: Uint8Array;
  listenerEphemeral: Uint8Array;
  dialerNonce: Uint8Array;
  listenerNonce: Uint8Array;
}

function transcriptBytes(t: LinkTranscript): Buffer {
  return lengthPrefixed([
    utf8('coco-connect link v1'),
    utf8(t.roomId),
    utf8(t.dialerId),
    utf8(t.listenerId),
    t.dialerEphemeral,
    t.listenerEphemeral,
    t.dialerNonce,
    t.listenerNonce,
  ]);
}

// Proves knowledge of the room key, tied to this exact handshake.
export function linkProof(roomKey: Uint8Array, role: 'dialer' | 'listener', t: LinkTranscript): Buffer {
  return hmac(roomKey, Buffer.concat([utf8(role), transcriptBytes(t)]));
}

// One key per direction, so the two sides' message counters can never reuse a nonce.
export function linkKeys(shared: Uint8Array, roomKey: Uint8Array, t: LinkTranscript) {
  const material = Buffer.from(crypto.hkdfSync('sha256', shared, roomKey, transcriptBytes(t), 64));
  return {
    dialerToListener: material.subarray(0, 32),
    listenerToDialer: material.subarray(32, 64),
  };
}

// A short public label for a room, put in Bonjour so members can spot each other.
// It's derived from the room key, so it reveals nothing and can't be guessed in advance.
export function roomTag(roomKey: Uint8Array): string {
  return hmac(roomKey, utf8('coco-connect bonjour tag')).toString('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Frames: the encrypted messages on an open link
// ---------------------------------------------------------------------------

// The nonce is a message counter, so each side must receive every frame, once, in order.
// WebSockets run over TCP, which already guarantees that, so any gap means tampering.
export class FrameCipher {
  private sendKey: Buffer;
  private receiveKey: Buffer;
  private sendCounter = 0n;
  private receiveCounter = 0n;

  constructor(sendKey: Buffer, receiveKey: Buffer) {
    this.sendKey = sendKey;
    this.receiveKey = receiveKey;
  }

  seal(plaintext: Buffer): Buffer {
    const nonce = counterNonce(this.sendCounter);
    this.sendCounter += 1n;

    const cipher = crypto.createCipheriv('aes-256-gcm', this.sendKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([ciphertext, cipher.getAuthTag()]);
  }

  // Returns null if the frame was changed, replayed, reordered, or sealed with another key.
  open(frame: Buffer): Buffer | null {
    if (frame.length < GCM_TAG_BYTES) {
      return null;
    }

    const nonce = counterNonce(this.receiveCounter);
    const ciphertext = frame.subarray(0, frame.length - GCM_TAG_BYTES);
    const tag = frame.subarray(frame.length - GCM_TAG_BYTES);

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.receiveKey, nonce);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      this.receiveCounter += 1n;
      return plaintext;
    } catch {
      return null;
    }
  }
}

// 12-byte GCM nonce: 4 zero bytes, then the counter as a 64-bit big-endian number.
function counterNonce(counter: bigint): Buffer {
  const nonce = Buffer.alloc(GCM_NONCE_BYTES);
  nonce.writeBigUInt64BE(counter, 4);
  return nonce;
}

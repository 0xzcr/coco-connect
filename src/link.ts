// The wire protocol between two laptops, over a WebSocket.
//
// A connection starts with one of two handshakes, in plain JSON (it only carries public values):
//
//   Joining with a code (joiner -> host):
//     joiner: { t: 'join', v, from, name }
//     host:   { t: 'pake', sid, point }                 or { t: 'error', reason }
//     joiner: { t: 'pake', point, proof }
//     host:   { t: 'welcome', proof, box }              or { t: 'error', reason }
//     The box holds the room key and member list, encrypted with the CPace key. Then both
//     sides hang up and the new member reconnects as a member, below.
//
//   Linking two members (dialer -> listener):
//     dialer:   { t: 'link', v, room, from, eph, nonce }
//     listener: { t: 'link-ok', from, eph, nonce, proof }   or { t: 'error', reason }
//     dialer:   { t: 'link-confirm', proof }
//     After that, every message is an encrypted binary frame (see FrameCipher).

import { WebSocket } from 'ws';
import {
  FrameCipher,
  agree,
  fromBase64,
  linkKeys,
  linkProof,
  newEphemeral,
  openBox,
  pakeBoxKey,
  pakeFinish,
  pakeProof,
  pakeStart,
  randomBytes,
  sameBytes,
  sealBox,
  toBase64,
  type LinkTranscript,
} from './crypto.ts';

export const PROTOCOL_VERSION = 1;
// Big enough for a sync of 4 members with 2000 changed files each.
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

const CONNECT_TIMEOUT_MS = 4000;
const HANDSHAKE_STEP_TIMEOUT_MS = 8000;
const PING_INTERVAL_MS = 10_000;

// A laptop that slept, or Wi-Fi that dropped, leaves a TCP connection that looks open but is
// dead. If we hear nothing back for this long, we drop it and reconnect.
const DEAD_AFTER_MS = 25_000;

const ID = /^[0-9a-f]{16}$/;

// An error with a short machine-readable reason, e.g. 'wrong-code' or 'room-full'.
export class ProtocolError extends Error {
  reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.reason = reason;
  }
}

type Json = Record<string, unknown>;

function sendJson(ws: WebSocket, message: Json) {
  ws.send(JSON.stringify(message));
}

// Sends an error to the other side, then hangs up once it has been written.
function refuse(ws: WebSocket, reason: string) {
  try {
    ws.send(JSON.stringify({ t: 'error', reason }), () => ws.close());
  } catch {
    ws.terminate();
  }
}

export function validId(value: unknown): string | null {
  if (typeof value === 'string' && ID.test(value)) {
    return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading handshake messages one at a time
// ---------------------------------------------------------------------------

// Handshakes are a fixed back-and-forth, so we read them like a script: "wait for the next
// message". Frames are kept raw until asked for, because the other side's first encrypted
// frame can arrive in the same TCP packet as its last handshake message (ws delivers both in
// one go, before our code resumes). Leftover frames are handed to the Link, not lost.
export interface RawFrame {
  data: Buffer;
  isBinary: boolean;
}

class HandshakeReader {
  private ws: WebSocket;
  private queue: RawFrame[] = [];
  private waiting: { resolve: (message: Json) => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', this.onMessage);
    ws.on('close', this.onClose);
    ws.on('error', this.onError);
  }

  next(timeoutMs: number = HANDSHAKE_STEP_TIMEOUT_MS): Promise<Json> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return this.parse(queued);
    }
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new ProtocolError('timeout', 'the other laptop stopped answering during the handshake'));
      }, timeoutMs);

      this.waiting = {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  // Stops reading, so the encrypted Link can take over the socket. Returns frames that
  // arrived after the handshake ended, for the Link to process first.
  detach(): RawFrame[] {
    this.ws.off('message', this.onMessage);
    this.ws.off('close', this.onClose);
    this.ws.off('error', this.onError);
    return this.queue.splice(0);
  }

  // A handshake message must be a JSON object sent as text.
  private parse(frame: RawFrame): Promise<Json> {
    let message: unknown = null;
    if (!frame.isBinary) {
      try {
        message = JSON.parse(frame.data.toString('utf8'));
      } catch {
        message = null;
      }
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      this.ws.terminate();
      return Promise.reject(new ProtocolError('bad-message', 'the other side sent something that is not coco-connect'));
    }
    return Promise.resolve(message as Json);
  }

  private fail(error: Error) {
    this.failure = error;
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.reject(error);
  }

  private onMessage = (data: Buffer, isBinary: boolean) => {
    const waiting = this.waiting;
    if (waiting === null) {
      this.queue.push({ data, isBinary });
      return;
    }
    this.waiting = null;
    this.parse({ data, isBinary }).then(waiting.resolve, waiting.reject);
  };

  private onClose = () => {
    this.fail(new ProtocolError('closed', 'the other laptop hung up during the handshake'));
  };

  private onError = (error: Error) => {
    this.fail(error);
  };
}

// Opens a WebSocket to "ip:port". Rejects with the OS error (ECONNREFUSED, ETIMEDOUT...),
// which the diagnose tool uses to explain what went wrong.
function openSocket(address: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://${address}`, {
        handshakeTimeout: CONNECT_TIMEOUT_MS,
        maxPayload: MAX_FRAME_BYTES,
        perMessageDeflate: false,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const onOpen = () => {
      ws.off('error', onError);
      resolve(ws);
    };
    const onError = (error: Error) => {
      ws.off('open', onOpen);
      reject(error);
    };

    ws.once('open', onOpen);
    ws.once('error', onError);
  });
}

// ---------------------------------------------------------------------------
// An authenticated, encrypted connection to one teammate
// ---------------------------------------------------------------------------

export interface LinkHandlers {
  onMessage: (link: Link, message: Json) => void;
  onClose: (link: Link) => void;
}

export class Link {
  readonly peerId: string;     // the teammate's member id
  readonly dialerId: string;   // which side opened the connection (used to drop duplicates)
  readonly address: string;    // where the other side is, for status and diagnose

  private ws: WebSocket;
  private cipher: FrameCipher;
  private handlers: LinkHandlers | null = null;
  private early: RawFrame[];     // frames that arrived before start()
  private lastHeard = Date.now();
  private pingTimer: NodeJS.Timeout;
  private closed = false;

  constructor(ws: WebSocket, cipher: FrameCipher, peerId: string, dialerId: string, address: string, early: RawFrame[]) {
    this.ws = ws;
    this.cipher = cipher;
    this.early = early;
    this.peerId = peerId;
    this.dialerId = dialerId;
    this.address = address;

    ws.on('message', (data: Buffer, isBinary: boolean) => this.onFrame(data, isBinary));
    ws.on('pong', () => {
      this.lastHeard = Date.now();
    });
    ws.on('close', () => this.onSocketClosed());
    ws.on('error', () => {
      // Always followed by 'close', which does the cleanup.
    });

    this.pingTimer = setInterval(() => this.keepAlive(), PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  // Starts delivering messages. Frames that arrived in between are delivered first, in order.
  start(handlers: LinkHandlers) {
    this.handlers = handlers;
    const early = this.early;
    this.early = [];
    for (const frame of early) {
      this.onFrame(frame.data, frame.isBinary);
    }
    if (this.closed) {
      handlers.onClose(this);
    }
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  send(message: Json): boolean {
    if (!this.isOpen) {
      return false;
    }
    const frame = this.cipher.seal(Buffer.from(JSON.stringify(message), 'utf8'));
    this.ws.send(frame);
    return true;
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
    // If the other side never answers the close, don't wait for it.
    setTimeout(() => this.ws.terminate(), 2000).unref();
  }

  private keepAlive() {
    if (Date.now() - this.lastHeard > DEAD_AFTER_MS) {
      this.ws.terminate();
      return;
    }
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.ping();
    }
  }

  private onFrame(data: Buffer, isBinary: boolean) {
    this.lastHeard = Date.now();

    if (this.handlers === null) {
      this.early.push({ data, isBinary });
      return;
    }

    // After the handshake, anything that isn't a valid encrypted frame ends the link.
    const plaintext = isBinary ? this.cipher.open(data) : null;
    if (plaintext === null) {
      this.ws.terminate();
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(plaintext.toString('utf8'));
    } catch {
      message = null;
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      this.ws.terminate();
      return;
    }

    this.handlers.onMessage(this, message as Json);
  }

  private onSocketClosed() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.pingTimer);
    this.handlers?.onClose(this);
  }
}

// ---------------------------------------------------------------------------
// Linking two members
// ---------------------------------------------------------------------------

export interface MemberCredentials {
  roomId: string;
  roomKey: Buffer;
  memberId: string;
}

// Connects to a teammate at "ip:port" and proves we're both in the same room.
export async function dialMember(address: string, me: MemberCredentials): Promise<Link> {
  const ws = await openSocket(address);
  const reader = new HandshakeReader(ws);

  try {
    const ephemeral = newEphemeral();
    const nonce = randomBytes(16);

    sendJson(ws, {
      t: 'link',
      v: PROTOCOL_VERSION,
      room: me.roomId,
      from: me.memberId,
      eph: toBase64(ephemeral.publicRaw),
      nonce: toBase64(nonce),
    });

    const reply = await reader.next();
    if (reply.t === 'error') {
      throw new ProtocolError(String(reply.reason));
    }

    const listenerId = validId(reply.from);
    const theirEphemeral = fromBase64(reply.eph, 32);
    const theirNonce = fromBase64(reply.nonce, 16);
    const theirProof = fromBase64(reply.proof, 32);

    if (reply.t !== 'link-ok' || !listenerId || !theirEphemeral || !theirNonce || !theirProof) {
      throw new ProtocolError('bad-message', 'unexpected reply to our link request');
    }
    if (listenerId === me.memberId) {
      // We dialed one of our own addresses.
      throw new ProtocolError('self');
    }

    const transcript: LinkTranscript = {
      roomId: me.roomId,
      dialerId: me.memberId,
      listenerId,
      dialerEphemeral: ephemeral.publicRaw,
      listenerEphemeral: theirEphemeral,
      dialerNonce: nonce,
      listenerNonce: theirNonce,
    };

    if (!sameBytes(theirProof, linkProof(me.roomKey, 'listener', transcript))) {
      throw new ProtocolError('wrong-room-key', 'the other side is not in our room');
    }

    const shared = agree(ephemeral, theirEphemeral);
    if (shared === null) {
      throw new ProtocolError('bad-key');
    }

    sendJson(ws, { t: 'link-confirm', proof: toBase64(linkProof(me.roomKey, 'dialer', transcript)) });

    const keys = linkKeys(shared, me.roomKey, transcript);
    const cipher = new FrameCipher(keys.dialerToListener, keys.listenerToDialer);
    return new Link(ws, cipher, listenerId, me.memberId, address, reader.detach());
  } catch (error) {
    ws.terminate();
    throw error;
  }
}

// The listening side of dialMember, after the first message turned out to be a 'link'.
async function acceptMember(
  ws: WebSocket,
  reader: HandshakeReader,
  hello: Json,
  me: MemberCredentials,
  address: string,
): Promise<Link> {
  const dialerId = validId(hello.from);
  const theirEphemeral = fromBase64(hello.eph, 32);
  const theirNonce = fromBase64(hello.nonce, 16);

  if (hello.room !== me.roomId) {
    throw new ProtocolError('unknown-room');
  }
  if (!dialerId || !theirEphemeral || !theirNonce) {
    throw new ProtocolError('bad-message');
  }
  if (dialerId === me.memberId) {
    throw new ProtocolError('self');
  }

  const ephemeral = newEphemeral();
  const nonce = randomBytes(16);
  const transcript: LinkTranscript = {
    roomId: me.roomId,
    dialerId,
    listenerId: me.memberId,
    dialerEphemeral: theirEphemeral,
    listenerEphemeral: ephemeral.publicRaw,
    dialerNonce: theirNonce,
    listenerNonce: nonce,
  };

  sendJson(ws, {
    t: 'link-ok',
    from: me.memberId,
    eph: toBase64(ephemeral.publicRaw),
    nonce: toBase64(nonce),
    proof: toBase64(linkProof(me.roomKey, 'listener', transcript)),
  });

  const confirm = await reader.next();
  const theirProof = fromBase64(confirm.proof, 32);
  if (confirm.t !== 'link-confirm' || !theirProof) {
    throw new ProtocolError('bad-message');
  }
  if (!sameBytes(theirProof, linkProof(me.roomKey, 'dialer', transcript))) {
    throw new ProtocolError('wrong-room-key');
  }

  const shared = agree(ephemeral, theirEphemeral);
  if (shared === null) {
    throw new ProtocolError('bad-key');
  }

  const keys = linkKeys(shared, me.roomKey, transcript);
  const cipher = new FrameCipher(keys.listenerToDialer, keys.dialerToListener);
  return new Link(ws, cipher, dialerId, dialerId, address, reader.detach());
}

// ---------------------------------------------------------------------------
// Joining with a code
// ---------------------------------------------------------------------------

// What the host hands a new member (inside the encrypted box).
export interface Welcome {
  roomId: string;
  roomKey: Buffer;
  name: string;         // the name the host gave us (made unique within the room)
  members: unknown[];   // the host's view of everyone's state; checked by the room code
}

// The host's side of an invite, provided by the room.
export interface InviteGate {
  // Why a join must be refused right now ('no-invite', 'expired', 'room-full', 'locked'), or null.
  refusal(): string | null;
  secret(): string;
  // A joiner proved the wrong code.
  recordFailure(): void;
  // A joiner proved the right code. Returns the room details to send, or a refusal reason.
  admit(joinerId: string, joinerName: string): object | string;
}

// Runs the code ceremony against a host at "ip:port".
export async function joinRoom(
  address: string,
  secret: string,
  joiner: { memberId: string; name: string },
): Promise<Welcome> {
  const ws = await openSocket(address);
  const reader = new HandshakeReader(ws);

  try {
    sendJson(ws, { t: 'join', v: PROTOCOL_VERSION, from: joiner.memberId, name: joiner.name });

    const challenge = await reader.next();
    if (challenge.t === 'error') {
      throw new ProtocolError(String(challenge.reason));
    }
    const sessionId = fromBase64(challenge.sid, 16);
    const hostPoint = fromBase64(challenge.point, 32);
    if (challenge.t !== 'pake' || !sessionId || !hostPoint) {
      throw new ProtocolError('bad-message');
    }

    const half = pakeStart(secret, sessionId);
    const key = pakeFinish(half, hostPoint, sessionId, hostPoint, half.publicPoint);
    if (key === null) {
      throw new ProtocolError('bad-message', 'the host sent an invalid key');
    }

    sendJson(ws, { t: 'pake', point: toBase64(half.publicPoint), proof: toBase64(pakeProof(key, 'joiner')) });

    const result = await reader.next();
    if (result.t === 'error') {
      throw new ProtocolError(String(result.reason));
    }
    const hostProof = fromBase64(result.proof, 32);
    if (result.t !== 'welcome' || !hostProof) {
      throw new ProtocolError('bad-message');
    }

    // The host proves it knew the code too. Without this, a fake host could welcome us.
    if (!sameBytes(hostProof, pakeProof(key, 'host'))) {
      throw new ProtocolError('host-proof', 'the host could not prove it knows the code');
    }

    const welcome = parseWelcome(openBox(pakeBoxKey(key), result.box));
    if (welcome === null) {
      throw new ProtocolError('bad-message', 'the room details were damaged');
    }

    ws.close();
    return welcome;
  } catch (error) {
    ws.terminate();
    throw error;
  }
}

function parseWelcome(value: unknown): Welcome | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const box = value as Json;
  const roomKey = fromBase64(box.roomKey, 32);
  const roomId = validId(box.roomId);
  if (!roomKey || !roomId || !Array.isArray(box.members)) {
    return null;
  }
  return { roomId, roomKey, name: String(box.name ?? ''), members: box.members };
}

// The host's side of joinRoom, after the first message turned out to be a 'join'.
async function hostJoin(ws: WebSocket, reader: HandshakeReader, hello: Json, gate: InviteGate) {
  const joinerId = validId(hello.from);
  if (!joinerId) {
    refuse(ws, 'bad-message');
    return;
  }

  const early = gate.refusal();
  if (early !== null) {
    refuse(ws, early);
    return;
  }

  const sessionId = randomBytes(16);
  const half = pakeStart(gate.secret(), sessionId);
  sendJson(ws, { t: 'pake', sid: toBase64(sessionId), point: toBase64(half.publicPoint) });

  const answer = await reader.next();

  // The invite may have expired, filled up or locked while we waited. Checking again here,
  // before verifying, is what caps the number of guesses even when many arrive at once.
  const late = gate.refusal();
  if (late !== null) {
    refuse(ws, late);
    return;
  }

  const joinerPoint = fromBase64(answer.point, 32);
  const joinerProof = fromBase64(answer.proof, 32);
  const key = joinerPoint ? pakeFinish(half, joinerPoint, sessionId, half.publicPoint, joinerPoint) : null;
  const proven = key !== null && joinerProof !== null && sameBytes(joinerProof, pakeProof(key, 'joiner'));

  if (answer.t !== 'pake' || !proven || key === null) {
    gate.recordFailure();
    refuse(ws, 'wrong-code');
    return;
  }

  const details = gate.admit(joinerId, String(hello.name ?? ''));
  if (typeof details === 'string') {
    refuse(ws, details);
    return;
  }

  const welcome = { t: 'welcome', proof: toBase64(pakeProof(key, 'host')), box: sealBox(pakeBoxKey(key), details) };
  ws.send(JSON.stringify(welcome), () => ws.close());
}

// ---------------------------------------------------------------------------
// Incoming connections
// ---------------------------------------------------------------------------

export interface AcceptContext {
  gate: InviteGate;
  credentials: () => MemberCredentials | null;  // null when we're not in a room
}

// Handles a connection someone opened to us. Returns a Link for a member, or null after a
// join ceremony or a refused connection.
export async function acceptConnection(ws: WebSocket, address: string, context: AcceptContext): Promise<Link | null> {
  const reader = new HandshakeReader(ws);

  try {
    const hello = await reader.next();

    if (hello.v !== PROTOCOL_VERSION) {
      refuse(ws, 'version');
      return null;
    }

    if (hello.t === 'join') {
      await hostJoin(ws, reader, hello, context.gate);
      return null;
    }

    if (hello.t === 'link') {
      const credentials = context.credentials();
      if (credentials === null) {
        refuse(ws, 'unknown-room');
        return null;
      }
      return await acceptMember(ws, reader, hello, credentials, address);
    }

    refuse(ws, 'bad-message');
    return null;
  } catch (error) {
    if (error instanceof ProtocolError && ws.readyState === WebSocket.OPEN) {
      refuse(ws, error.reason);
    } else {
      ws.terminate();
    }
    return null;
  }
}

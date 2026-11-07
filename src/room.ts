// The coco-connect node: one per Claude Code session.
//
// It holds the room (up to 4 sessions, usually on 4 laptops), keeps a direct encrypted
// connection to every other member it can reach, and shares three things with them:
//   - state:    branch, announced task, files with uncommitted changes
//   - messages: notes between agents, delivered once, retried until acknowledged
//   - goodbyes: when someone leaves
//
// Laptops on mixed networks often can't all reach each other (two Windows laptops on a
// "Public" network both refuse incoming connections, but can both reach a Mac). So
// everything is forwarded through whoever is connected: if A reaches B and B reaches C,
// A and C still see each other's state and messages.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  formatCode,
  newSecret,
  parseCode,
  randomBytes,
  randomId,
  roomTag,
  toBase64,
} from './crypto.ts';
import { Discovery, type Sighting } from './discovery.ts';
import {
  MAX_REPORTED_FILES,
  findRepoRoot,
  gitUserName,
  repoIdentity,
  sameRepo,
  snapshot,
  type RepoIdentity,
} from './git.ts';
import {
  MAX_FRAME_BYTES,
  ProtocolError,
  acceptConnection,
  dialMember,
  joinRoom,
  validId,
  type InviteGate,
  type Link,
  type MemberCredentials,
  type Welcome,
} from './link.ts';
import { lanAddresses, lastOctet, splitHostPort, withLastOctet } from './netinfo.ts';
import { realPath, repoRelative, samePath } from './paths.ts';
import {
  MAX_MESSAGE_LENGTH,
  MAX_TASK_LENGTH,
  cleanName,
  cleanText,
  type InboxMessage,
} from './text.ts';

export const MAX_MEMBERS = 4;
export const DEFAULT_LAN_PORT = 7778;

const INVITE_TTL_MS = 10 * 60_000;
const MAX_WRONG_CODES = 5;

const HEARTBEAT_MS = 15_000;           // how often we re-send our state, even if nothing changed
const ONLINE_WINDOW_MS = 45_000;       // no news for this long means "offline"
const REFRESH_MS = 10_000;             // how often we re-read git, for changes made outside Claude
const ADDRESS_CHECK_MS = 10_000;       // how often we look for a new IP (Wi-Fi switch, sleep)
const RETRY_MESSAGES_MS = 10_000;      // how often unacknowledged messages are sent again
const PRUNE_MS = 60_000;
const FORGET_AFTER_MS = 30 * 60_000;   // stop trying to reach a member gone this long
const GHOST_AFTER_MS = 2 * 60_000;     // an admitted joiner who never connected frees their seat
const MESSAGE_TTL_MS = 60 * 60_000;    // give up on delivering a message after this long

const FIRST_DIAL_DELAY_MS = 1500;
const MAX_DIAL_DELAY_MS = 30_000;
const JOIN_SEARCH_MS = 6000;
const JOIN_POLL_MS = 300;

const MAX_INBOX = 200;
const MAX_OUTBOX = 200;
const MAX_PENDING_CONNECTIONS = 16;
const MAX_ADDRESSES = 16;
const SEEN_LIMIT = 5000;

// Join failures that mean "stop looking, this was the right host and the answer is no".
const FINAL_JOIN_ERRORS = new Set(['wrong-code', 'locked', 'room-full', 'host-proof']);

export interface MemberState {
  memberId: string;
  name: string;
  branch: string;
  task: string;
  files: string[];       // uncommitted changes, relative to the repo root
  repo: RepoIdentity;
  addresses: string[];   // "ip:port" where this member accepts connections
  version: number;       // goes up with every change; the highest version wins
}

interface Member {
  state: MemberState;
  heardAt: number;               // when we last got news of them, directly or relayed
  link: Link | null;             // our direct connection to them, if any
  dialAttempt: number;
  dialTimer: NodeJS.Timeout | null;
  dialing: boolean;
  lastDialError: string | null;
  bonjourAddresses: string[];    // where Bonjour last saw them
}

interface Invite {
  secret: string;
  hint: number | null;
  expiresAt: number;
  wrongCodes: number;
}

interface OutgoingMessage {
  id: string;
  to: string;
  text: string;
  everyone: boolean;
  createdAt: number;
  tries: number;
}

export interface NodeOptions {
  projectDir: string;
  name?: string;
  lanPort?: number;                         // preferred LAN port; falls back to any free one
  discovery?: boolean;                      // Bonjour on/off (default on)
  hosts?: string[];                         // advertise these IPs instead of the real ones (tests)
  canDial?: (address: string) => boolean;   // tests: pretend some laptops can't reach each other
}

export interface CheckResult {
  blocked: boolean;
  by: string[];
  file: string | null;
}

export interface TeammateStatus {
  name: string;
  memberId: string;
  online: boolean;
  connection: 'direct' | 'through a teammate' | 'offline';
  branch: string;
  task: string;
  files: string[];
  sameRepo: boolean;
  lastDialError: string | null;
  addresses: string[];
}

export interface Status {
  me: { name: string; memberId: string; branch: string; task: string; files: string[]; repoRoot: string | null };
  inRoom: boolean;
  members: number;
  invite: { code: string; expiresInSeconds: number; wrongCodes: number } | null;
  teammates: TeammateStatus[];
  pendingMessages: number;
  lanAddresses: string[];
  warnings: string[];
}

// A Set that forgets its oldest entries, so long sessions don't grow memory forever.
class BoundedSet {
  private items = new Set<string>();
  private limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  has(item: string): boolean {
    return this.items.has(item);
  }

  add(item: string) {
    this.items.add(item);
    if (this.items.size > this.limit) {
      const oldest = this.items.values().next().value as string;
      this.items.delete(oldest);
    }
  }
}

function emptyRepo(): RepoIdentity {
  return { roots: [], remote: '' };
}

function placeholderState(memberId: string, name: string): MemberState {
  return { memberId, name, branch: '', task: '', files: [], repo: emptyRepo(), addresses: [], version: 0 };
}

// The OS login name. os.userInfo() throws in some containers that have no user entry.
function systemUserName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'teammate';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  if (error instanceof ProtocolError) {
    return error.reason;
  }
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code) {
    return code;
  }
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Checking what other laptops send us. Everything is validated before we use it.
// ---------------------------------------------------------------------------

const ADDRESS = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;

function stringList(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .slice(0, limit)
    .filter((item): item is string => typeof item === 'string' && item !== '')
    .map((item) => cleanText(item, maxLength));
}

export function parseState(value: unknown): MemberState | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;

  const memberId = validId(raw.memberId);
  const version = Number(raw.version);
  if (!memberId || !Number.isSafeInteger(version) || version < 0) {
    return null;
  }

  const repo = (typeof raw.repo === 'object' && raw.repo !== null ? raw.repo : {}) as Record<string, unknown>;

  return {
    memberId,
    name: cleanName(raw.name),
    branch: cleanText(raw.branch, 200),
    task: cleanText(raw.task, MAX_TASK_LENGTH),
    files: stringList(raw.files, MAX_REPORTED_FILES, 1024),
    repo: {
      roots: stringList(repo.roots, 8, 64).filter((root) => COMMIT.test(root)),
      remote: cleanText(repo.remote, 300),
    },
    addresses: stringList(raw.addresses, MAX_ADDRESSES, 32).filter((address) => ADDRESS.test(address)),
    version,
  };
}

// ---------------------------------------------------------------------------
// The node
// ---------------------------------------------------------------------------

export class CocoNode {
  readonly memberId = randomId();
  readonly me: MemberState;

  // Set by the localhost API, so it knows when to publish the session file for hooks.
  onRoomChange: ((inRoom: boolean) => void) | null = null;

  repoRoot: string | null = null;
  private lineEndingOnly: string[] = [];
  private filesTruncated = false;

  private options: NodeOptions;
  private room: { id: string; key: Buffer; tag: string } | null = null;
  private members = new Map<string, Member>();
  private left = new Set<string>();
  private invite: Invite | null = null;

  private inbox: InboxMessage[] = [];
  private delivered = new BoundedSet(SEEN_LIMIT);   // message ids already put in our inbox
  private seen = new BoundedSet(SEEN_LIMIT);        // relayed packets we already handled
  private outbox = new Map<string, OutgoingMessage>();
  private waiters: ((messages: InboxMessage[]) => void)[] = [];

  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private lanPort = 0;
  private pendingConnections = 0;
  private discovery: Discovery | null = null;
  private inviteSightings = new Map<string, Sighting>();
  private roomTimers: NodeJS.Timeout[] = [];

  private refreshing: Promise<void> | null = null;
  private refreshQueued = false;
  private closed = false;

  // What an incoming join ceremony asks of us.
  private gate: InviteGate = {
    refusal: () => this.inviteRefusal(),
    secret: () => this.invite?.secret ?? '',
    recordFailure: () => this.recordWrongCode(),
    admit: (joinerId, name) => this.admit(joinerId, name),
  };

  constructor(options: NodeOptions) {
    this.options = options;
    this.me = placeholderState(this.memberId, cleanName(options.name ?? ''));
  }

  // Reads the repo and picks a default name. Call once, before anything else.
  async init() {
    this.repoRoot = await findRepoRoot(this.options.projectDir);

    if (this.options.name === undefined) {
      const gitName = this.repoRoot ? await gitUserName(this.repoRoot) : '';
      this.me.name = cleanName(gitName || systemUserName());
    }

    if (this.repoRoot !== null) {
      this.me.repo = await repoIdentity(this.repoRoot);
      await this.refresh();
    }
  }

  get inRoom(): boolean {
    return this.room !== null;
  }

  private credentials(): MemberCredentials | null {
    if (this.room === null) {
      return null;
    }
    return { roomId: this.room.id, roomKey: this.room.key, memberId: this.memberId };
  }

  private memberCount(): number {
    return 1 + this.members.size;
  }

  private requireRoom() {
    if (this.room === null) {
      throw new Error('Not in a coco room yet. Use pair to start one, or join with a code from a teammate.');
    }
  }

  setName(name: string) {
    this.me.name = this.uniqueName(cleanName(name), null);
    this.broadcastState();
    this.advertise();
  }

  // ---- Pairing ------------------------------------------------------------

  // Starts a room if we aren't in one, and opens an invite code for it. Any member can invite.
  async pair(name?: string) {
    if (name) {
      this.setName(name);
    }
    await this.startNetwork();

    if (this.room === null) {
      const key = randomBytes(32);
      this.enterRoom(randomId(), key);
    }

    if (this.memberCount() >= MAX_MEMBERS) {
      throw new Error(`The room is full: coco-connect rooms hold up to ${MAX_MEMBERS} people.`);
    }

    // Asking again while a code is still good returns the same code, rather than
    // invalidating the one the user may already have read out.
    const usable = this.invite !== null && this.inviteRefusal() === null;
    if (!usable) {
      this.invite = {
        secret: newSecret(),
        hint: this.addressHint(),
        expiresAt: Date.now() + INVITE_TTL_MS,
        wrongCodes: 0,
      };
    }
    this.advertise();

    const invite = this.invite as Invite;
    return {
      code: formatCode({ hint: invite.hint, secret: invite.secret }),
      expiresInSeconds: Math.round((invite.expiresAt - Date.now()) / 1000),
      addresses: this.me.addresses,
      members: this.memberCount(),
    };
  }

  // The last number of our main IP address, or null if we have none.
  private addressHint(): number | null {
    const first = this.me.addresses[0];
    if (first === undefined) {
      return null;
    }
    return lastOctet(first.split(':')[0]);
  }

  private inviteRefusal(): string | null {
    if (this.room === null) {
      return 'no-invite';
    }
    // Checked before the invite: admitting the 4th person closes it, and a fifth should hear
    // "the room is full", not "ask for a new code".
    if (this.memberCount() >= MAX_MEMBERS) {
      return 'room-full';
    }
    if (this.invite === null) {
      return 'no-invite';
    }
    if (Date.now() > this.invite.expiresAt) {
      return 'expired';
    }
    if (this.invite.wrongCodes >= MAX_WRONG_CODES) {
      return 'locked';
    }
    return null;
  }

  private recordWrongCode() {
    if (this.invite === null) {
      return;
    }
    this.invite.wrongCodes += 1;
    if (this.invite.wrongCodes >= MAX_WRONG_CODES) {
      // Stop advertising the invite. The code is dead; the user has to make a new one.
      this.advertise();
    }
  }

  // A joiner proved they have the code. Add them, and return what they need to know.
  private admit(joinerId: string, rawName: string): object | string {
    if (this.room === null) {
      return 'no-invite';
    }
    if (joinerId === this.memberId || this.members.has(joinerId)) {
      return 'bad-message';
    }

    const name = this.uniqueName(cleanName(rawName), joinerId);

    // They count towards the room size straight away, so two joiners can't both take the last seat.
    // shortcut: two different members inviting at the same moment can still push the room past 4;
    // add a room-wide seat count if that ever matters.
    this.left.delete(joinerId);
    this.members.set(joinerId, this.newMember(placeholderState(joinerId, name)));

    if (this.memberCount() >= MAX_MEMBERS) {
      this.invite = null;
    }
    this.advertise();

    return {
      roomId: this.room.id,
      roomKey: toBase64(this.room.key),
      name,
      members: this.allStates(),
    };
  }

  // Makes a display name unique in the room: "sam", "sam-2", "sam-3"...
  private uniqueName(name: string, forMemberId: string | null): string {
    const taken = new Set<string>();
    if (forMemberId !== null) {
      taken.add(this.me.name.toLowerCase());
    }
    for (const member of this.members.values()) {
      if (member.state.memberId !== forMemberId) {
        taken.add(member.state.name.toLowerCase());
      }
    }

    let candidate = name;
    let suffix = 2;
    while (taken.has(candidate.toLowerCase())) {
      candidate = `${name}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  // Joins a room with a code from a teammate. `host` ("ip" or "ip:port") skips the search.
  async join(codeText: string, name?: string, host?: string) {
    if (this.room !== null) {
      throw new Error('Already in a coco room. Leave it first to join another.');
    }
    const code = parseCode(codeText);
    if (code === null) {
      throw new Error('That is not a coco code. Codes are 6 digits, usually with a short number in front, like 20-482913.');
    }
    if (name) {
      this.setName(name);
    }

    await this.startNetwork();

    const search = new JoinSearch(this, code.secret);
    for (const own of this.me.addresses) {
      search.skip(own);
    }

    let welcome: Welcome | null = null;
    try {
      welcome = await this.findHost(search, code.hint, host);
    } finally {
      if (welcome === null && this.room === null) {
        this.stopNetwork();
      }
    }

    if (welcome === null) {
      throw new Error(search.explainFailure(code.hint, host));
    }

    this.enterRoom(welcome.roomId, welcome.roomKey);
    if (welcome.name !== '') {
      this.me.name = cleanName(welcome.name);
    }
    for (const raw of welcome.members) {
      const state = parseState(raw);
      if (state !== null) {
        this.mergeState(state);
      }
    }
    this.broadcastState();
    this.advertise();

    return { members: this.memberCount(), name: this.me.name };
  }

  // Tries the places the host could be, most likely first, until one welcomes us.
  private async findHost(search: JoinSearch, hint: number | null, host: string | undefined): Promise<Welcome | null> {
    // 1. An address the user gave us.
    if (host) {
      const { host: hostName, port } = splitHostPort(host.trim(), DEFAULT_LAN_PORT);
      const welcome = await search.attempt(`${hostName}:${port}`);
      if (welcome !== null || search.finalError !== null) {
        return welcome;
      }
    }

    // 2. Hosts already heard on Bonjour, whose address matches the hint.
    const early = await this.tryInviteSightings(search, hint, true);
    if (early !== null || search.finalError !== null) {
      return early;
    }

    // 3. The hint applied to each of our own networks, on the default port. This finds the host
    //    on networks that block Bonjour but let laptops talk.
    if (hint !== null) {
      for (const address of this.me.addresses) {
        const guess = `${withLastOctet(address.split(':')[0], hint)}:${DEFAULT_LAN_PORT}`;
        const welcome = await search.attempt(guess);
        if (welcome !== null || search.finalError !== null) {
          return welcome;
        }
      }
    }

    // 4. Keep listening on Bonjour for a few seconds, trying any host with an open invite.
    const deadline = Date.now() + JOIN_SEARCH_MS;
    while (Date.now() < deadline) {
      this.discovery?.refresh();
      const welcome = await this.tryInviteSightings(search, hint, false);
      if (welcome !== null || search.finalError !== null) {
        return welcome;
      }
      await sleep(JOIN_POLL_MS);
    }
    return null;
  }

  // Tries every Bonjour host advertising an open invite. With `onlyMatching`, only those whose
  // address ends in the hint number.
  private async tryInviteSightings(search: JoinSearch, hint: number | null, onlyMatching: boolean) {
    const candidates = [...this.inviteSightings.values()].flatMap((sighting) => sighting.addresses);

    for (const address of candidates) {
      const matches = hint === null || lastOctet(address.split(':')[0]) === hint;
      if (onlyMatching && !matches) {
        continue;
      }
      const welcome = await search.attempt(address);
      if (welcome !== null || search.finalError !== null) {
        return welcome;
      }
    }
    return null;
  }

  canDial(address: string): boolean {
    return this.options.canDial ? this.options.canDial(address) : true;
  }

  private enterRoom(roomId: string, roomKey: Buffer) {
    this.room = { id: roomId, key: roomKey, tag: roomTag(roomKey) };
    this.left.clear();
    this.startRoomTimers();
    this.advertise();
    this.onRoomChange?.(true);
  }

  // Leaves the room: tells everyone, then disconnects.
  async leave() {
    if (this.room === null) {
      return;
    }

    this.flood({ t: 'bye', memberId: this.memberId }, null);
    // Give the goodbye a moment to go out before the sockets close.
    await sleep(200);

    for (const member of this.members.values()) {
      this.forgetMember(member);
    }
    this.members.clear();
    this.outbox.clear();
    this.inviteSightings.clear();
    this.room = null;
    this.invite = null;
    this.stopRoomTimers();
    this.stopNetwork();
    this.onRoomChange?.(false);
  }

  async close() {
    if (this.closed) {
      return;
    }
    await this.leave();
    this.closed = true;
    this.stopNetwork();
    this.resolveWaiters([]);
  }

  // ---- Network ------------------------------------------------------------

  // Starts accepting connections from teammates, and Bonjour. Only runs once we pair or join,
  // so a session that never uses coco-connect never opens a port.
  private async startNetwork() {
    if (this.httpServer !== null) {
      return;
    }

    const server = http.createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
    wss.on('connection', (ws, request) => this.onConnection(ws, request));
    wss.on('error', () => {
      // Errors on the shared server are also reported on the http server; nothing to do here.
    });

    await listenWithFallback(server, this.options.lanPort ?? DEFAULT_LAN_PORT);

    this.httpServer = server;
    this.wss = wss;
    this.lanPort = (server.address() as AddressInfo).port;
    this.updateAddresses();

    if (this.options.discovery !== false) {
      this.discovery = new Discovery((sighting) => this.onSighting(sighting));
    }
    this.advertise();
  }

  private stopNetwork() {
    this.discovery?.stop();
    this.discovery = null;

    if (this.wss !== null) {
      for (const client of this.wss.clients) {
        client.terminate();
      }
      this.wss.close();
      this.wss = null;
    }
    if (this.httpServer !== null) {
      this.httpServer.close();
      this.httpServer = null;
    }
    this.lanPort = 0;
    this.me.addresses = [];
  }

  // Our announcement on Bonjour: who we are, our room tag, and whether we hold an open invite.
  private advertise() {
    if (this.discovery === null || this.httpServer === null) {
      return;
    }
    this.discovery.announce({
      memberId: this.memberId,
      name: this.me.name,
      roomTag: this.room?.tag ?? '',
      invite: this.inviteRefusal() === null,
      port: this.lanPort,
    });
  }

  // Re-reads our IP addresses. A new Wi-Fi network or DHCP lease gives a new IP; teammates
  // learn it from our next state message.
  private updateAddresses() {
    if (this.lanPort === 0) {
      return;
    }
    const hosts = this.options.hosts ?? lanAddresses().map((entry) => entry.address);
    const addresses = hosts.slice(0, MAX_ADDRESSES).map((host) => `${host}:${this.lanPort}`);

    if (addresses.join(',') === this.me.addresses.join(',')) {
      return;
    }
    this.me.addresses = addresses;
    this.broadcastState();
  }

  private onConnection(ws: WebSocket, request: http.IncomingMessage) {
    // Unauthenticated connections cost us little, but cap them so a flood can't pile up.
    if (this.pendingConnections >= MAX_PENDING_CONNECTIONS) {
      ws.terminate();
      return;
    }
    this.pendingConnections += 1;

    const remote = String(request.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    const address = `${remote}:${request.socket.remotePort}`;

    const context = { gate: this.gate, credentials: () => this.credentials() };
    acceptConnection(ws, address, context)
      .then((link) => {
        if (link !== null) {
          this.attachLink(link);
        }
      })
      .catch(() => {
        // acceptConnection already closed the socket.
      })
      .finally(() => {
        this.pendingConnections -= 1;
      });
  }

  private onSighting(sighting: Sighting) {
    if (sighting.memberId === this.memberId) {
      return;
    }

    if (sighting.invite) {
      this.inviteSightings.set(sighting.memberId, sighting);
    } else {
      this.inviteSightings.delete(sighting.memberId);
    }

    // A room member Bonjour can see: remember where, and try them now if we lost them.
    const member = this.members.get(sighting.memberId);
    if (this.room === null || member === undefined || sighting.roomTag !== this.room.tag) {
      return;
    }
    member.bonjourAddresses = sighting.addresses;

    const disconnected = !(member.link?.isOpen ?? false);
    if (disconnected && member.dialAttempt > 2 && member.dialTimer !== null) {
      clearTimeout(member.dialTimer);
      member.dialTimer = null;
      member.dialAttempt = 0;
    }
    this.ensureDialing(member);
  }

  // ---- Members and links --------------------------------------------------

  private newMember(state: MemberState): Member {
    return {
      state,
      heardAt: Date.now(),
      link: null,
      dialAttempt: 0,
      dialTimer: null,
      dialing: false,
      lastDialError: null,
      bonjourAddresses: [],
    };
  }

  private allStates(): MemberState[] {
    return [this.me, ...[...this.members.values()].map((member) => member.state)];
  }

  private isOnline(member: Member): boolean {
    if (member.link?.isOpen) {
      return true;
    }
    return Date.now() - member.heardAt < ONLINE_WINDOW_MS && member.state.version > 0;
  }

  // Stores a newer state for a member. Returns true if it was news, so the caller passes it on.
  private mergeState(state: MemberState): boolean {
    if (state.memberId === this.memberId || this.left.has(state.memberId) || this.room === null) {
      return false;
    }

    const member = this.members.get(state.memberId);
    if (member === undefined) {
      const added = this.newMember(state);
      this.members.set(state.memberId, added);
      this.ensureDialing(added);
      return true;
    }

    if (state.version <= member.state.version) {
      return false;
    }
    member.state = state;
    member.heardAt = Date.now();
    this.ensureDialing(member);
    return true;
  }

  private dialAddresses(member: Member): string[] {
    const own = new Set(this.me.addresses);
    const all = [...member.bonjourAddresses, ...member.state.addresses];
    return [...new Set(all)].filter((address) => !own.has(address));
  }

  // Makes sure we're connected to a member, or will try again soon.
  private ensureDialing(member: Member) {
    if (this.room === null || this.closed) {
      return;
    }
    if (member.link?.isOpen || member.dialing || member.dialTimer !== null) {
      return;
    }
    if (this.dialAddresses(member).length === 0) {
      return;
    }

    member.dialTimer = setTimeout(() => {
      member.dialTimer = null;
      void this.dial(member);
    }, this.dialDelay(member));
    member.dialTimer.unref();
  }

  // Both sides dial each other, so a pair connects if either direction works (a Windows laptop
  // that blocks incoming connections can still dial out). The side with the lower id goes first;
  // the other waits a moment, which usually avoids opening two connections at once.
  private dialDelay(member: Member): number {
    if (member.dialAttempt === 0) {
      return this.memberId < member.state.memberId ? 0 : FIRST_DIAL_DELAY_MS;
    }
    const backoff = Math.min(1000 * 2 ** (member.dialAttempt - 1), MAX_DIAL_DELAY_MS);
    return backoff + Math.floor(Math.random() * 500);
  }

  private async dial(member: Member) {
    const credentials = this.credentials();
    const stillMember = this.members.get(member.state.memberId) === member;
    if (credentials === null || !stillMember || member.link?.isOpen) {
      return;
    }

    const addresses = this.dialAddresses(member);
    if (addresses.length === 0) {
      return;
    }
    // Each attempt tries the next address, so one dead address (a VM adapter) can't block us.
    const address = addresses[member.dialAttempt % addresses.length];
    member.dialAttempt += 1;
    member.dialing = true;

    try {
      if (!this.canDial(address)) {
        throw new ProtocolError('unreachable');
      }
      const link = await dialMember(address, credentials);
      member.dialing = false;
      this.attachLink(link);
    } catch (error) {
      member.dialing = false;
      member.lastDialError = `${address}: ${describeError(error)}`;
    }

    // Covers both a failed dial and reaching someone other than who we expected
    // (their IP now belongs to another member).
    if (this.members.get(member.state.memberId) === member) {
      this.ensureDialing(member);
    }
  }

  private attachLink(link: Link) {
    if (this.room === null || this.closed || this.left.has(link.peerId)) {
      link.close();
      return;
    }

    let member = this.members.get(link.peerId);
    if (member === undefined) {
      // A member someone else admitted; their state arrives in their sync message.
      member = this.newMember(placeholderState(link.peerId, 'teammate'));
      this.members.set(link.peerId, member);
    }

    const existing = member.link;
    if (existing !== null && existing.isOpen) {
      // Two connections to the same teammate: both sides keep the one dialed by the lower id,
      // so they agree without talking about it. If the same side dialed both, the old one is
      // probably dead (that's why they redialed), so keep the new one.
      const preferredDialer = this.memberId < link.peerId ? this.memberId : link.peerId;
      const keepExisting = existing.dialerId !== link.dialerId && existing.dialerId === preferredDialer;
      if (keepExisting) {
        link.close();
        return;
      }
      member.link = link;
      existing.close();
    } else {
      member.link = link;
    }

    if (member.dialTimer !== null) {
      clearTimeout(member.dialTimer);
      member.dialTimer = null;
    }
    member.dialAttempt = 0;
    member.lastDialError = null;
    member.heardAt = Date.now();

    link.start({
      onMessage: (from, message) => this.onLinkMessage(from, message),
      onClose: (closed) => this.onLinkClosed(closed),
    });
    link.send({ t: 'sync', states: this.allStates(), left: [...this.left] });
    this.retryOutbox();
  }

  private onLinkClosed(link: Link) {
    const member = this.members.get(link.peerId);
    if (member === undefined || member.link !== link) {
      // A link we already replaced or dropped.
      return;
    }
    member.link = null;
    member.dialAttempt = 0;
    this.ensureDialing(member);
  }

  private forgetMember(member: Member) {
    if (member.dialTimer !== null) {
      clearTimeout(member.dialTimer);
      member.dialTimer = null;
    }
    const link = member.link;
    member.link = null;
    link?.close();
  }

  // Sends to every direct link except the one the message came in on.
  private flood(message: Record<string, unknown>, except: Link | null) {
    for (const member of this.members.values()) {
      const link = member.link;
      if (link !== null && link !== except && link.isOpen) {
        link.send(message);
      }
    }
  }

  // ---- Incoming messages --------------------------------------------------

  private onLinkMessage(link: Link, message: Record<string, unknown>) {
    const member = this.members.get(link.peerId);
    if (member !== undefined) {
      member.heardAt = Date.now();
    }

    if (message.t === 'sync') {
      this.onSync(link, message);
    } else if (message.t === 'state') {
      this.onState(link, message.state);
    } else if (message.t === 'msg') {
      this.onChat(link, message);
    } else if (message.t === 'ack') {
      this.onAck(link, message);
    } else if (message.t === 'bye') {
      this.onBye(link, message.memberId);
    }
  }

  private onSync(link: Link, message: Record<string, unknown>) {
    const states = Array.isArray(message.states) ? message.states.slice(0, MAX_MEMBERS * 2) : [];
    for (const raw of states) {
      this.onState(link, raw);
    }

    const left = Array.isArray(message.left) ? message.left.slice(0, 100) : [];
    for (const memberId of left) {
      this.onBye(link, memberId);
    }
  }

  private onState(link: Link, raw: unknown) {
    const state = parseState(raw);
    if (state !== null && this.mergeState(state)) {
      this.flood({ t: 'state', state }, link);
    }
  }

  private onChat(link: Link, message: Record<string, unknown>) {
    const id = validId(message.id);
    const from = validId(message.from);
    const to = validId(message.to);
    const tries = Number(message.tries);
    if (!id || !from || !to || !Number.isSafeInteger(tries)) {
      return;
    }

    // Each retry of a message is a new packet, so relays pass retries on too.
    const packet = `msg:${id}:${tries}`;
    if (this.seen.has(packet)) {
      return;
    }
    this.seen.add(packet);

    if (to !== this.memberId) {
      this.flood(message, link);
      return;
    }

    if (!this.delivered.has(id)) {
      this.delivered.add(id);
      this.addToInbox({
        id,
        fromId: from,
        from: this.members.get(from)?.state.name ?? 'teammate',
        to: message.everyone === true ? 'everyone' : 'you',
        text: cleanText(message.text, MAX_MESSAGE_LENGTH),
        at: new Date().toISOString(),
      });
    }

    // Acknowledge every copy, in case our earlier acknowledgement got lost.
    const nonce = randomId();
    this.seen.add(`ack:${nonce}`);
    this.flood({ t: 'ack', id, from: this.memberId, to: from, nonce }, null);
  }

  private onAck(link: Link, message: Record<string, unknown>) {
    const id = validId(message.id);
    const to = validId(message.to);
    const nonce = validId(message.nonce);
    if (!id || !to || !nonce) {
      return;
    }

    const packet = `ack:${nonce}`;
    if (this.seen.has(packet)) {
      return;
    }
    this.seen.add(packet);

    if (to === this.memberId) {
      this.outbox.delete(id);
    } else {
      this.flood(message, link);
    }
  }

  private onBye(link: Link | null, rawId: unknown) {
    const memberId = validId(rawId);
    if (!memberId || memberId === this.memberId || this.left.has(memberId)) {
      return;
    }
    this.left.add(memberId);

    const member = this.members.get(memberId);
    if (member !== undefined) {
      this.forgetMember(member);
      this.members.delete(memberId);
    }
    for (const message of this.outbox.values()) {
      if (message.to === memberId) {
        this.outbox.delete(message.id);
      }
    }

    this.flood({ t: 'bye', memberId }, link);
    // Someone leaving frees a seat.
    this.advertise();
  }

  // ---- Our state ----------------------------------------------------------

  // Sends our latest state to everyone (also used as the heartbeat).
  private broadcastState() {
    this.me.version += 1;
    if (this.room !== null) {
      this.flood({ t: 'state', state: this.me }, null);
    }
  }

  // Re-reads git. Calls that overlap share one run, plus one more afterwards, so a burst of
  // edits costs at most two `git status` runs.
  refresh(): Promise<void> {
    if (this.refreshing !== null) {
      this.refreshQueued = true;
      return this.refreshing;
    }

    this.refreshing = (async () => {
      try {
        do {
          this.refreshQueued = false;
          await this.readGit();
        } while (this.refreshQueued);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async readGit() {
    if (this.repoRoot === null) {
      return;
    }
    const current = await snapshot(this.repoRoot);
    this.lineEndingOnly = current.lineEndingOnly;
    this.filesTruncated = current.truncated;

    const changed = current.branch !== this.me.branch || current.files.join('\n') !== this.me.files.join('\n');
    if (changed) {
      this.me.branch = current.branch;
      this.me.files = current.files;
      this.broadcastState();
    }
  }

  announceTask(task: string) {
    this.requireRoom();
    this.me.task = cleanText(task, MAX_TASK_LENGTH);
    this.broadcastState();
  }

  // ---- Timers -------------------------------------------------------------

  private startRoomTimers() {
    this.stopRoomTimers();
    const every = (ms: number, work: () => void) => {
      const timer = setInterval(work, ms);
      timer.unref();
      this.roomTimers.push(timer);
    };

    every(HEARTBEAT_MS, () => this.broadcastState());
    every(REFRESH_MS, () => void this.refresh());
    every(ADDRESS_CHECK_MS, () => this.updateAddresses());
    every(RETRY_MESSAGES_MS, () => this.retryOutbox());
    every(PRUNE_MS, () => this.prune());
  }

  private stopRoomTimers() {
    for (const timer of this.roomTimers) {
      clearInterval(timer);
    }
    this.roomTimers = [];
  }

  // Forgets members we haven't heard from in a long time (their session crashed or the laptop
  // left), so we stop dialing them forever. A joiner who was admitted but never connected
  // (their session died mid-join) is forgotten sooner, so they don't hold a seat.
  private prune() {
    const now = Date.now();
    for (const member of [...this.members.values()]) {
      const silentFor = now - member.heardAt;
      const neverConnected = member.state.version === 0;
      const gone = neverConnected ? silentFor > GHOST_AFTER_MS : silentFor > FORGET_AFTER_MS;
      if (!this.isOnline(member) && gone) {
        this.forgetMember(member);
        this.members.delete(member.state.memberId);
      }
    }
    this.advertise();
  }

  // ---- Messages -----------------------------------------------------------

  // Sends a note to one teammate (by name) or everyone. Messages to teammates who are offline
  // wait, and go out when they come back (for up to an hour).
  send(rawText: string, to?: string) {
    this.requireRoom();

    const text = cleanText(rawText, MAX_MESSAGE_LENGTH);
    if (text.trim() === '') {
      throw new Error('The message is empty.');
    }

    const everyone = to === undefined || to.trim() === '' || ['all', 'everyone'].includes(to.trim().toLowerCase());
    const recipients = everyone ? [...this.members.values()] : [this.findMember(to as string)];
    if (recipients.length === 0) {
      throw new Error('Nobody else is in the room yet.');
    }

    for (const member of recipients) {
      const message: OutgoingMessage = {
        id: randomId(),
        to: member.state.memberId,
        text,
        everyone,
        createdAt: Date.now(),
        tries: 0,
      };
      this.outbox.set(message.id, message);
      this.transmit(message);
    }
    this.trimOutbox();

    return recipients.map((member) => ({ name: member.state.name, online: this.isOnline(member) }));
  }

  private findMember(name: string): Member {
    const wanted = name.trim().toLowerCase();
    for (const member of this.members.values()) {
      if (member.state.name.toLowerCase() === wanted || member.state.memberId === wanted) {
        return member;
      }
    }
    const names = [...this.members.values()].map((member) => member.state.name);
    const known = names.length > 0 ? names.join(', ') : 'nobody yet';
    throw new Error(`No teammate called "${name}" in the room. In the room: ${known}.`);
  }

  private transmit(message: OutgoingMessage) {
    message.tries += 1;
    const packet = {
      t: 'msg',
      id: message.id,
      from: this.memberId,
      to: message.to,
      text: message.text,
      everyone: message.everyone,
      tries: message.tries,
    };
    // Mark our own packet as seen, so a relay bouncing it back doesn't make us forward it again.
    this.seen.add(`msg:${message.id}:${message.tries}`);
    this.flood(packet, null);
  }

  private retryOutbox() {
    const now = Date.now();
    for (const message of [...this.outbox.values()]) {
      const recipient = this.members.get(message.to);
      if (recipient === undefined || now - message.createdAt > MESSAGE_TTL_MS) {
        this.outbox.delete(message.id);
        continue;
      }
      if (this.isOnline(recipient)) {
        this.transmit(message);
      }
    }
  }

  private trimOutbox() {
    while (this.outbox.size > MAX_OUTBOX) {
      const oldest = this.outbox.keys().next().value as string;
      this.outbox.delete(oldest);
    }
  }

  private addToInbox(message: InboxMessage) {
    this.inbox.push(message);
    if (this.inbox.length > MAX_INBOX) {
      this.inbox.splice(0, this.inbox.length - MAX_INBOX);
    }

    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(this.readInbox());
    }
  }

  // Returns and clears unread messages.
  readInbox(): InboxMessage[] {
    return this.inbox.splice(0);
  }

  // Waits up to `ms` for at least one message (used by `coco-connect listen`).
  waitForMessages(ms: number): Promise<InboxMessage[]> {
    if (this.inbox.length > 0 || this.closed) {
      return Promise.resolve(this.readInbox());
    }

    return new Promise((resolve) => {
      const waiter = (messages: InboxMessage[]) => {
        clearTimeout(timer);
        resolve(messages);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((other) => other !== waiter);
        resolve([]);
      }, ms);
      this.waiters.push(waiter);
    });
  }

  private resolveWaiters(messages: InboxMessage[]) {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      waiter(messages);
    }
  }

  // ---- Edit checks --------------------------------------------------------

  // Is `file` one an online teammate in the same repo has uncommitted changes in?
  check(file: string): CheckResult {
    if (this.room === null || this.repoRoot === null || file === '') {
      return { blocked: false, by: [], file: null };
    }

    const relative = repoRelative(this.repoRoot, realPath(path.resolve(this.repoRoot, file)));
    if (relative === null) {
      return { blocked: false, by: [], file: null };
    }

    const by: string[] = [];
    for (const member of this.members.values()) {
      if (this.blocks(member, relative)) {
        by.push(member.state.name);
      }
    }
    return { blocked: by.length > 0, by, file: relative };
  }

  private blocks(member: Member, relative: string): boolean {
    if (!this.isOnline(member) || !sameRepo(this.me.repo, member.state.repo)) {
      return false;
    }
    return member.state.files.some((theirs) => samePath(theirs, relative));
  }

  // ---- Status -------------------------------------------------------------

  status(): Status {
    const teammates = [...this.members.values()].map((member) => this.teammateStatus(member));

    let invite: Status['invite'] = null;
    if (this.invite !== null && this.inviteRefusal() === null) {
      invite = {
        code: formatCode({ hint: this.invite.hint, secret: this.invite.secret }),
        expiresInSeconds: Math.round((this.invite.expiresAt - Date.now()) / 1000),
        wrongCodes: this.invite.wrongCodes,
      };
    }

    return {
      me: {
        name: this.me.name,
        memberId: this.memberId,
        branch: this.me.branch,
        task: this.me.task,
        files: this.me.files,
        repoRoot: this.repoRoot,
      },
      inRoom: this.room !== null,
      members: this.room === null ? 0 : this.memberCount(),
      invite,
      teammates,
      pendingMessages: this.outbox.size,
      lanAddresses: this.me.addresses,
      warnings: this.warnings(),
    };
  }

  private teammateStatus(member: Member): TeammateStatus {
    const online = this.isOnline(member);
    let connection: TeammateStatus['connection'] = 'offline';
    if (member.link?.isOpen) {
      connection = 'direct';
    } else if (online) {
      connection = 'through a teammate';
    }

    return {
      name: member.state.name,
      memberId: member.state.memberId,
      online,
      connection,
      branch: member.state.branch,
      task: member.state.task,
      files: member.state.files,
      sameRepo: sameRepo(this.me.repo, member.state.repo),
      lastDialError: member.lastDialError,
      addresses: this.dialAddresses(member),
    };
  }

  private warnings(): string[] {
    const warnings: string[] = [];

    if (this.repoRoot === null) {
      warnings.push('This session is not inside a git repo, so file changes are not shared and nothing is blocked.');
    }
    if (this.lineEndingOnly.length > 0) {
      warnings.push(
        `${this.lineEndingOnly.length} file(s) differ only in line endings (CRLF vs LF) and are not reported to teammates. ` +
          'This usually means core.autocrlf is set differently on this laptop; check `git config core.autocrlf`.',
      );
    }
    if (this.filesTruncated) {
      warnings.push(`More than ${MAX_REPORTED_FILES} changed files; only the first ${MAX_REPORTED_FILES} are shared.`);
    }
    if (this.invite !== null && this.invite.wrongCodes >= MAX_WRONG_CODES) {
      warnings.push(
        'The invite code was locked after too many wrong tries (someone may be guessing). Run pair again for a new code.',
      );
    }
    if (this.room !== null && this.me.addresses.length === 0) {
      warnings.push('This laptop has no network address right now. Is Wi-Fi on?');
    }
    for (const adapter of this.discovery?.health() ?? []) {
      if (adapter.error !== null) {
        warnings.push(`Bonjour is not working on ${adapter.address} (${adapter.error}). Joining by code still works with the host address.`);
      }
    }
    return warnings;
  }

  discoveryHealth() {
    return this.discovery?.health() ?? [];
  }

  // For diagnose: every member's addresses and last connection error.
  teammateAddresses(): { name: string; addresses: string[]; online: boolean; lastDialError: string | null }[] {
    return [...this.members.values()].map((member) => ({
      name: member.state.name,
      addresses: this.dialAddresses(member),
      online: this.isOnline(member),
      lastDialError: member.lastDialError,
    }));
  }

  get port(): number {
    return this.lanPort;
  }
}

// ---------------------------------------------------------------------------
// One run of "find the host and prove the code"
// ---------------------------------------------------------------------------

class JoinSearch {
  finalError: ProtocolError | null = null;

  private node: CocoNode;
  private secret: string;
  private tried = new Set<string>();
  private failures: string[] = [];
  private reachedHost = false;

  constructor(node: CocoNode, secret: string) {
    this.node = node;
    this.secret = secret;
  }

  skip(address: string) {
    this.tried.add(address);
  }

  // Tries one address. Returns the welcome, or null. A definite "no" from a host
  // (wrong code, full room) is kept in finalError, and the search stops.
  async attempt(address: string): Promise<Welcome | null> {
    if (this.tried.has(address) || this.finalError !== null) {
      return null;
    }
    this.tried.add(address);

    if (!this.node.canDial(address)) {
      this.failures.push(`${address}: unreachable`);
      return null;
    }

    try {
      return await joinRoom(address, this.secret, { memberId: this.node.memberId, name: this.node.me.name });
    } catch (error) {
      const reason = describeError(error);
      this.failures.push(`${address}: ${reason}`);

      if (error instanceof ProtocolError && reason !== 'timeout' && reason !== 'closed') {
        this.reachedHost = true;
      }
      if (error instanceof ProtocolError && FINAL_JOIN_ERRORS.has(reason)) {
        this.finalError = error;
      }
      return null;
    }
  }

  // A message for the user saying what went wrong and what to do next.
  explainFailure(hint: number | null, host: string | undefined): string {
    const reason = this.finalError?.reason ?? null;

    if (reason === 'wrong-code') {
      return 'Wrong code. Check the 6 digits with the host. After 5 wrong tries the code stops working and the host has to make a new one.';
    }
    if (reason === 'locked') {
      return 'That code was locked after too many wrong tries. Ask the host to run pair again for a new code.';
    }
    if (reason === 'room-full') {
      return `That room already has ${MAX_MEMBERS} people, the most coco-connect allows.`;
    }
    if (reason === 'host-proof') {
      return (
        'Something answered as the host but could not prove it knows the code. Someone may be interfering on this ' +
        'network. Try again, or use a phone hotspot.'
      );
    }

    const sawExpired = this.failures.some((failure) => failure.endsWith('expired'));
    if (sawExpired) {
      return 'Found the host, but the code has expired (codes last 10 minutes). Ask them to run pair again.';
    }
    if (this.reachedHost) {
      return 'Found a coco-connect laptop, but it has no open invite. Ask the host to run pair again and read you the new code.';
    }

    const lines = ["Couldn't find the host on this network."];
    if (host === undefined) {
      lines.push(
        hint === null
          ? 'Ask the host for their address (pair shows it) and join again with host set to it.'
          : 'Ask the host for their full address (pair shows it, e.g. 192.168.1.20) and join again with host set to it.',
      );
    }
    lines.push(
      'If that fails too: both laptops must be on the same Wi-Fi; on Windows the network must be set to Private; ' +
        'campus and hotel Wi-Fi often block laptops from talking, so try a phone hotspot. The diagnose tool checks all of this.',
    );
    if (this.failures.length > 0) {
      lines.push(`Tried: ${this.failures.slice(0, 6).join('; ')}`);
    }
    return lines.join(' ');
  }
}

// Listens on `port` on every interface; if it's taken (another session on this laptop has it),
// on any free port. Teammates learn the actual port from Bonjour and from our state.
function listenWithFallback(server: http.Server, port: number): Promise<void> {
  const listen = (wanted: number) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(wanted, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });

  return listen(port).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
      return listen(0);
    }
    throw error;
  });
}

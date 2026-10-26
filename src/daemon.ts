// The coco-connect daemon. One runs on each laptop.
//
// It does three jobs:
//   1. Keeps a WebSocket open to the teammate's daemon and swaps state over it.
//   2. Serves a small HTTP API on localhost so our hooks and MCP tools can ask questions.
//   3. Announces itself on the Wi-Fi with Bonjour so the two daemons find each other.
//
// Nothing is written to disk: our state comes from git, the peer's state lives in memory.

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { Bonjour } from 'bonjour-service';

// What one agent is doing right now.
export interface AgentState {
  name: string;     // who owns this agent, e.g. "umang"
  branch: string;   // current git branch
  task: string;     // free text set by the announce tool
  files: string[];  // files with uncommitted changes, relative to the repo root
}

// A note one agent sent to the other.
export interface InboxMessage {
  from: string;
  text: string;
  at: string;  // ISO timestamp of when we received it
}

export interface DaemonOptions {
  name: string;        // our name, must differ from the teammate's
  secret: string;      // shared secret, must match the teammate's
  repo: string;        // any directory inside the git repo we work on
  localPort: number;   // localhost port for hooks and MCP tools
  peerPort: number;    // Wi-Fi port the teammate's daemon connects to
  peer?: string;       // "host:port" to dial directly, which skips Bonjour
  discovery: boolean;  // whether to use Bonjour at all
}

const RECONNECT_MS = 3000;
const SERVICE_TYPE = 'coco-connect';

// Runs a git command in the repo and returns its raw output.
function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function currentBranch(repo: string): string {
  try {
    return git(repo, ['branch', '--show-current']).trim();
  } catch {
    return '';
  }
}

// Lists files with uncommitted changes (modified, staged or new), relative to the repo root.
export function changedFiles(repo: string): string[] {
  const output = git(repo, ['status', '--porcelain', '--untracked-files=all']);
  const lines = output.split('\n').filter((line) => line !== '');

  // Each line looks like "XY path", or "XY old -> new" for a rename.
  // shortcut: git quotes paths with spaces or unicode; switch to `-z` parsing if that bites.
  return lines.map((line) => {
    const filePath = line.slice(3);
    const arrow = filePath.indexOf(' -> ');
    return arrow === -1 ? filePath : filePath.slice(arrow + 4);
  });
}

// Resolves symlinks in a file's folder, so macOS paths like /tmp vs /private/tmp compare equal.
// The file itself may not exist yet (the agent could be about to create it).
function realPath(file: string): string {
  try {
    return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  } catch {
    return file;
  }
}

// Reads a JSON request body, treating an empty or broken body as {}.
async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    return {};
  }
}

export async function startDaemon(opts: DaemonOptions) {
  const repoRoot = fs.realpathSync(git(opts.repo, ['rev-parse', '--show-toplevel']).trim());

  // Our own state, the peer's last known state, and messages waiting to be read.
  const me: AgentState = {
    name: opts.name,
    branch: currentBranch(repoRoot),
    task: '',
    files: changedFiles(repoRoot),
  };
  let peer: AgentState | null = null;
  let peerSocket: WebSocket | null = null;
  const inbox: InboxMessage[] = [];

  let closing = false;
  let reconnectTimer: NodeJS.Timeout | null = null;

  function sendToPeer(message: object) {
    if (peerSocket && peerSocket.readyState === WebSocket.OPEN) {
      peerSocket.send(JSON.stringify(message));
    }
  }

  function sendHello(ws: WebSocket) {
    ws.send(JSON.stringify({ type: 'hello', secret: opts.secret, state: me }));
  }

  // Wires up one socket, either one we dialed or one that dialed us.
  // The first message on it must be a hello carrying the right secret.
  function attach(ws: WebSocket, weDialed: boolean, onClose: () => void) {
    let authed = false;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        ws.close();
        return;
      }

      if (!authed) {
        if (msg.type !== 'hello' || msg.secret !== opts.secret) {
          ws.close();
          return;
        }
        authed = true;
        // The side that accepted the connection only reveals its state after checking the secret.
        if (!weDialed) {
          sendHello(ws);
        }
        // A newer connection replaces an older one (e.g. after the teammate restarts).
        if (peerSocket && peerSocket !== ws) {
          peerSocket.close();
        }
        peerSocket = ws;
        peer = msg.state;
        return;
      }

      if (msg.type === 'state') {
        peer = msg.state;
      }
      if (msg.type === 'msg') {
        inbox.push({ from: peer?.name ?? 'teammate', text: String(msg.text), at: new Date().toISOString() });
      }
    });

    ws.on('close', () => {
      // Only forget the peer if this was the live socket, not one we replaced.
      if (peerSocket === ws) {
        peerSocket = null;
        peer = null;
      }
      onClose();
    });

    // An error is always followed by 'close', which does the cleanup.
    ws.on('error', () => {});
  }

  // Connects to the teammate's daemon, and keeps retrying whenever the link drops.
  function dial(address: string) {
    if (closing) {
      return;
    }
    const ws = new WebSocket(`ws://${address}`);
    ws.on('open', () => sendHello(ws));
    attach(ws, true, () => {
      if (!closing) {
        reconnectTimer = setTimeout(() => dial(address), RECONNECT_MS);
      }
    });
  }

  // Re-reads branch and changed files from git, and tells the peer if anything moved.
  function refresh() {
    const files = changedFiles(repoRoot);
    const branch = currentBranch(repoRoot);
    const changed = branch !== me.branch || files.join('\n') !== me.files.join('\n');
    me.files = files;
    me.branch = branch;
    if (changed) {
      sendToPeer({ type: 'state', state: me });
    }
  }

  // --- Localhost API for hooks and MCP tools ---

  const local = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    const body = req.method === 'POST' ? await readJson(req) : {};

    function reply(status: number, data: unknown) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    }

    try {
      if (route === 'GET /status') {
        reply(200, { me, peer, connected: peerSocket !== null });
      } else if (route === 'POST /announce') {
        me.task = String(body.task ?? '');
        sendToPeer({ type: 'state', state: me });
        reply(200, me);
      } else if (route === 'POST /refresh') {
        refresh();
        reply(200, me);
      } else if (route === 'POST /send') {
        if (!peerSocket) {
          reply(409, { error: 'teammate is not connected' });
          return;
        }
        sendToPeer({ type: 'msg', text: String(body.text ?? '') });
        reply(200, { ok: true });
      } else if (route === 'GET /inbox') {
        // Reading the inbox empties it.
        reply(200, inbox.splice(0));
      } else if (route === 'GET /check') {
        // Is the file the hook is about to edit one the peer has uncommitted changes in?
        const file = realPath(path.resolve(repoRoot, url.searchParams.get('file') ?? ''));
        const relative = path.relative(repoRoot, file);
        const blocked = peer !== null && peer.files.includes(relative);
        reply(200, { blocked, by: blocked ? peer!.name : null, file: relative });
      } else {
        reply(404, { error: 'unknown route' });
      }
    } catch (error) {
      reply(500, { error: String(error) });
    }
  });

  // Localhost only, so other devices on the Wi-Fi can't drive our agent.
  await new Promise<void>((resolve) => local.listen(opts.localPort, '127.0.0.1', resolve));

  // --- Wi-Fi side: accept the teammate's connection ---

  const wss = new WebSocketServer({ port: opts.peerPort, host: '0.0.0.0' });
  await new Promise<void>((resolve) => wss.on('listening', resolve));
  wss.on('connection', (ws) => attach(ws, false, () => {}));

  // --- Finding the teammate ---

  let bonjour: Bonjour | null = null;

  if (opts.peer) {
    dial(opts.peer);
  } else if (opts.discovery) {
    bonjour = new Bonjour();
    bonjour.publish({
      name: `coco-${opts.name}`,
      type: SERVICE_TYPE,
      port: opts.peerPort,
      txt: { name: opts.name },
    });

    let dialing = false;
    bonjour.find({ type: SERVICE_TYPE }, (service) => {
      const theirName = service.txt?.name;
      // Only the alphabetically-first name dials, so the pair never opens two sockets.
      if (!theirName || dialing || opts.name >= theirName) {
        return;
      }
      const ipv4 = (service.addresses ?? []).find((address) => address.includes('.'));
      const host = ipv4 ?? service.referer?.address;
      if (!host) {
        return;
      }
      dialing = true;
      dial(`${host}:${service.port}`);
    });
  }

  async function close() {
    closing = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    if (bonjour) {
      bonjour.unpublishAll();
      bonjour.destroy();
    }
    peerSocket?.close();
    for (const client of wss.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => local.close(resolve));
  }

  return { close, repoRoot };
}

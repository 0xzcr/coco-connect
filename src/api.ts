// The node's localhost HTTP API, used by hooks and `coco-connect listen`.
// It listens on 127.0.0.1 only, and every request needs the token from the session file,
// so other users on this machine and web pages in a browser can't talk to it.

import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { newToken, removeSession, writeSession } from './registry.ts';
import type { CocoNode } from './room.ts';

// Hooks wait for git at most this long, so an edit is never held up by a slow repo.
const REFRESH_WAIT_MS = 2000;

// Kept under the 300s that Node's fetch waits for response headers.
export const MAX_WAIT_MS = 240_000;

export interface ApiSession {
  sessionId: string;
  claudePid: number;
  projectDir: string;
}

export async function startApi(node: CocoNode, session: ApiSession) {
  const token = newToken();

  const server = http.createServer((request, response) => {
    handle(node, token, request, response).catch((error) => {
      reply(response, 500, { error: String(error) });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  // The session file exists only while we're in a room, so hooks in sessions that never use
  // coco-connect find nothing and exit straight away.
  const publish = (inRoom: boolean) => {
    if (inRoom) {
      writeSession({ ...session, pid: process.pid, port, token });
    } else {
      removeSession(session.sessionId);
    }
  };
  node.onRoomChange = publish;
  if (node.inRoom) {
    publish(true);
  }

  return {
    port,
    token,
    close: async () => {
      removeSession(session.sessionId);
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function reply(response: http.ServerResponse, status: number, data: unknown) {
  if (response.headersSent) {
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(data));
}

async function handle(node: CocoNode, token: string, request: http.IncomingMessage, response: http.ServerResponse) {
  const given = Buffer.from(String(request.headers['x-coco-token'] ?? ''));
  const expected = Buffer.from(token);
  const valid = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!valid) {
    reply(response, 401, { error: 'bad token' });
    return;
  }

  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const route = `${request.method} ${url.pathname}`;

  if (route === 'GET /check') {
    reply(response, 200, node.check(url.searchParams.get('file') ?? ''));
    return;
  }

  if (route === 'POST /refresh') {
    await Promise.race([node.refresh(), new Promise((resolve) => setTimeout(resolve, REFRESH_WAIT_MS))]);
    reply(response, 200, { ok: true });
    return;
  }

  if (route === 'GET /inbox') {
    reply(response, 200, node.readInbox());
    return;
  }

  if (route === 'GET /wait') {
    const asked = Number(url.searchParams.get('ms') ?? MAX_WAIT_MS);
    const ms = Number.isFinite(asked) ? Math.min(Math.max(asked, 0), MAX_WAIT_MS) : MAX_WAIT_MS;
    const messages = await node.waitForMessages(ms);
    if (request.socket.destroyed) {
      // `listen` was stopped while waiting; keep the messages for the next hook or listener.
      node.unreadInbox(messages);
      return;
    }
    reply(response, 200, messages);
    return;
  }

  reply(response, 404, { error: 'unknown route' });
}

// Client side, for hooks and `listen`.
export async function callSession(
  entry: { port: number; token: string },
  method: 'GET' | 'POST',
  route: string,
  timeoutMs: number,
) {
  const response = await fetch(`http://127.0.0.1:${entry.port}${route}`, {
    method,
    headers: { 'x-coco-token': entry.token },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`coco-connect API answered ${response.status}`);
  }
  return response.json();
}

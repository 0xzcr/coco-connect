// How a hook finds the coco-connect node of its own Claude session.
//
// Claude Code starts one MCP server (our node) per session, and runs hooks as separate short
// processes. While the node is in a room, it writes ~/.coco-connect/sessions/<session id>.json
// with its localhost port and a random token. A hook looks up its session's file and talks to
// that node. No file means "not in a room", and the hook exits at once.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SessionEntry {
  sessionId: string;
  pid: number;          // the node's process id, to spot files left behind by a crash
  claudePid: number;    // the Claude Code process that started the node
  port: number;         // localhost API port
  token: string;        // required on every API call
  projectDir: string;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function cocoHome(): string {
  return process.env.COCO_HOME ?? path.join(os.homedir(), '.coco-connect');
}

function sessionsDir(): string {
  return path.join(cocoHome(), 'sessions');
}

// Session ids come from hook input, so they're checked before being used in a file name.
function sessionFile(sessionId: string): string | null {
  if (!SESSION_ID.test(sessionId)) {
    return null;
  }
  return path.join(sessionsDir(), `${sessionId}.json`);
}

export function newToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

// Writes the file atomically (temp file + rename), readable only by this user.
export function writeSession(entry: SessionEntry) {
  const file = sessionFile(entry.sessionId);
  if (file === null) {
    throw new Error(`unusable session id: ${entry.sessionId}`);
  }
  fs.mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });

  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function removeSession(sessionId: string) {
  const file = sessionFile(sessionId);
  if (file !== null) {
    fs.rmSync(file, { force: true });
  }
}

// True if a process with this id exists. EPERM means it exists but belongs to another user.
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readEntry(file: string): SessionEntry | null {
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionEntry;
    const valid = Number.isInteger(entry.port) && typeof entry.token === 'string' && Number.isInteger(entry.pid);
    return valid ? entry : null;
  } catch {
    return null;
  }
}

// Reads an entry, deleting it if its node is gone (the session crashed without cleaning up).
function liveEntry(file: string): SessionEntry | null {
  const entry = readEntry(file);
  if (entry === null) {
    return null;
  }
  if (!pidAlive(entry.pid)) {
    fs.rmSync(file, { force: true });
    return null;
  }
  return entry;
}

// Finds this session's node. The session id is the normal way. If it fails (some Claude Code
// commands start a new session id while the MCP server keeps running), we fall back to the
// Claude Code process id, which is the same for the hook and the node.
export function findSession(lookup: { sessionId?: string; claudePid?: number }): SessionEntry | null {
  const file = lookup.sessionId ? sessionFile(lookup.sessionId) : null;
  if (file !== null) {
    const entry = liveEntry(file);
    if (entry !== null) {
      return entry;
    }
  }

  if (!lookup.claudePid) {
    return null;
  }

  let names: string[] = [];
  try {
    names = fs.readdirSync(sessionsDir()).filter((name) => name.endsWith('.json'));
  } catch {
    return null;
  }

  for (const name of names) {
    const entry = liveEntry(path.join(sessionsDir(), name));
    if (entry !== null && entry.claudePid === lookup.claudePid) {
      return entry;
    }
  }
  return null;
}

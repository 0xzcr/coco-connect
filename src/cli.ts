// Entry point. Claude Code runs the first two; the agent runs `listen`.
//
//   coco-connect mcp                        the per-session node + MCP tools (started by the plugin)
//   coco-connect hook pre|post|prompt       Claude Code hooks (started by the plugin)
//   coco-connect listen [--minutes N]       wait for a teammate's message, print it, exit
//   coco-connect version

import { parseArgs } from 'node:util';
import { MAX_WAIT_MS, callSession } from './api.ts';
import { runHook } from './hook.ts';
import { findSession } from './registry.ts';
import { formatInbox, type InboxMessage } from './text.ts';
import { VERSION } from './version.ts';

const DEFAULT_LISTEN_MINUTES = 30;

// Waits for messages via the session's node. Meant to run as a background command: when it
// exits, Claude Code wakes the agent with its output.
async function listen(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { minutes: { type: 'string' } } });
  const minutes = Number(values.minutes ?? DEFAULT_LISTEN_MINUTES);
  const totalMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : DEFAULT_LISTEN_MINUTES * 60_000;

  const entry = findSession({
    sessionId: process.env.CLAUDE_CODE_SESSION_ID,
    claudePid: Number(process.env.CLAUDE_PID),
  });
  if (entry === null) {
    console.log('coco-connect: this session is not in a coco room, so there is nothing to listen for.');
    return 1;
  }

  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const waitMs = Math.min(MAX_WAIT_MS, deadline - Date.now());

    let messages: InboxMessage[];
    try {
      messages = await callSession(entry, 'GET', `/wait?ms=${waitMs}`, waitMs + 10_000);
    } catch {
      console.log('coco-connect: lost contact with this session\'s coco-connect (the session ended or left the room).');
      return 1;
    }

    if (messages.length > 0) {
      console.log(formatInbox(messages));
      return 0;
    }
  }

  console.log(`coco-connect: no messages from teammates in the last ${Math.round(totalMs / 60_000)} minutes.`);
  return 0;
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'mcp') {
  const { runMcp } = await import('./mcp.ts');
  await runMcp();
} else if (command === 'hook') {
  process.exitCode = await runHook(rest[0]);
} else if (command === 'listen') {
  process.exitCode = await listen(rest);
} else if (command === 'version') {
  console.log(VERSION);
} else {
  console.log('usage: coco-connect mcp | hook pre|post|prompt | listen [--minutes N] | version');
  process.exitCode = 1;
}

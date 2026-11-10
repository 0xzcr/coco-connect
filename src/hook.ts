// Claude Code hooks. Claude Code runs `coco-connect hook <kind>` with event JSON on stdin.
//
//   pre     PreToolUse on file edits: blocks the edit if a teammate in the same repo has
//           uncommitted or unpushed changes in that file.
//   post    PostToolUse on edits and Bash: re-reads git so teammates see the change, and hands
//           the agent new teammate messages and what changed in the room.
//   prompt  UserPromptSubmit: hands the agent new teammate messages and room changes.
//
// Every hook fails open: if anything goes wrong (no room, node gone, timeout), the agent
// carries on as if coco-connect weren't installed. Plugin hooks run in every project, so the
// common case, "this session isn't in a room", has to be fast: one missing file and we're done.

import { callSession } from './api.ts';
import { findSession, type SessionEntry } from './registry.ts';
import { formatInbox, formatRoomNews, type InboxMessage } from './text.ts';

const MAX_STDIN_BYTES = 4 * 1024 * 1024;
const CHECK_TIMEOUT_MS = 1500;
const REFRESH_TIMEOUT_MS = 3000;

type HookInput = Record<string, unknown>;

async function readInput(): Promise<HookInput> {
  if (process.stdin.isTTY) {
    return {};
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > MAX_STDIN_BYTES) {
      return {};
    }
    chunks.push(chunk as Buffer);
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function findOwnSession(input: HookInput): SessionEntry | null {
  const sessionId = typeof input.session_id === 'string' ? input.session_id : process.env.CLAUDE_CODE_SESSION_ID;
  return findSession({ sessionId, claudePid: Number(process.env.CLAUDE_PID) });
}

// The path the edit tool is about to write.
function targetFile(input: HookInput): string | null {
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  const file = toolInput.file_path ?? toolInput.notebook_path;
  return typeof file === 'string' && file !== '' ? file : null;
}

async function preEdit(entry: SessionEntry, input: HookInput): Promise<number> {
  const file = targetFile(input);
  if (file === null) {
    return 0;
  }

  const result = await callSession(entry, 'GET', `/check?file=${encodeURIComponent(file)}`, CHECK_TIMEOUT_MS);
  if (!result.blocked) {
    return 0;
  }

  // Exit code 2 blocks the tool call, and Claude Code shows stderr to the agent as the reason.
  const by = result.by as string[];
  const who = by.join(' and ');
  const verb = by.length > 1 ? 'are' : 'is';
  process.stderr.write(
    `coco-connect: ${who} ${verb} changing ${result.file} and hasn't pushed it yet, so editing it now would conflict. ` +
      `Don't work around this. Use the send_message tool to ask ${who} about it, or carry on with other files. ` +
      'The block lifts once they push or revert the file. If they push, pull before you edit it.',
  );
  return 2;
}

// Prints room changes and new messages as extra context for the agent, in the JSON form
// Claude Code expects. Prints nothing if there's no news.
async function deliverUpdates(entry: SessionEntry, eventName: string) {
  const updates = await callSession(entry, 'GET', '/updates', CHECK_TIMEOUT_MS);
  const news = formatRoomNews(updates.news as string[]);
  const messages = formatInbox(updates.messages as InboxMessage[]);
  const context = [news, messages].filter((part) => part !== '').join('\n\n');
  if (context === '') {
    return;
  }
  const output = { hookSpecificOutput: { hookEventName: eventName, additionalContext: context } };
  process.stdout.write(JSON.stringify(output));
}

async function postTool(entry: SessionEntry): Promise<number> {
  await callSession(entry, 'POST', '/refresh', REFRESH_TIMEOUT_MS);
  await deliverUpdates(entry, 'PostToolUse');
  return 0;
}

async function promptSubmit(entry: SessionEntry): Promise<number> {
  await deliverUpdates(entry, 'UserPromptSubmit');
  return 0;
}

export async function runHook(kind: string | undefined): Promise<number> {
  try {
    const input = await readInput();
    const entry = findOwnSession(input);
    if (entry === null) {
      return 0;
    }

    if (kind === 'pre') {
      return await preEdit(entry, input);
    }
    if (kind === 'post') {
      return await postTool(entry);
    }
    if (kind === 'prompt') {
      return await promptSubmit(entry);
    }
    return 0;
  } catch {
    return 0;
  }
}

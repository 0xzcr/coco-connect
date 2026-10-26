// Claude Code hooks. Claude Code runs `coco-connect hook <kind>` and passes event JSON on stdin.
//
//   pre      PreToolUse on edits: blocks the edit if the teammate has uncommitted changes in that file.
//   post     PostToolUse on edits: tells the daemon to re-read git and update the teammate.
//   session  SessionStart: prints the teammate's status and unread messages into the agent's context.
//
// Every hook fails open: if the daemon is down, the agent carries on as if coco-connect weren't there.

import { callDaemon } from './local.ts';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString();
}

async function preEdit(): Promise<number> {
  const input = JSON.parse((await readStdin()) || '{}');
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!file) {
    return 0;
  }

  const { data } = await callDaemon('GET', `/check?file=${encodeURIComponent(file)}`);
  if (!data.blocked) {
    return 0;
  }

  // Exit code 2 blocks the tool call, and Claude Code shows stderr to the agent.
  process.stderr.write(
    `coco-connect: ${data.by}'s agent has uncommitted changes in ${data.file}. ` +
      `Use the send_message tool to coordinate with them before editing it.`,
  );
  return 2;
}

async function postEdit(): Promise<number> {
  await callDaemon('POST', '/refresh');
  return 0;
}

async function sessionStart(): Promise<number> {
  const status = (await callDaemon('GET', '/status')).data;
  const inbox = (await callDaemon('GET', '/inbox')).data;

  // SessionStart stdout is added to the agent's context.
  if (!status.connected) {
    console.log('coco-connect: teammate is not connected right now.');
    return 0;
  }
  const peer = status.peer;
  console.log(`coco-connect: ${peer.name}'s agent is on branch "${peer.branch}".`);
  console.log(`Their task: ${peer.task || '(not announced)'}`);
  console.log(`Files they have uncommitted changes in: ${peer.files.join(', ') || 'none'}`);
  for (const message of inbox) {
    console.log(`Message from ${message.from}: ${message.text}`);
  }
  console.log('Call the announce tool with your task before starting work.');
  return 0;
}

export async function runHook(kind: string): Promise<number> {
  try {
    if (kind === 'pre') return await preEdit();
    if (kind === 'post') return await postEdit();
    if (kind === 'session') return await sessionStart();
    return 0;
  } catch {
    return 0;
  }
}

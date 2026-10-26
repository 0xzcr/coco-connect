#!/usr/bin/env node
// Entry point.
//   coco-connect start --name <you> [--peer host:port] [--repo dir]
//   coco-connect doctor [--peer host]     (find out why the laptops aren't connecting)
//   coco-connect mcp                      (run by Claude Code)
//   coco-connect hook pre|post|session    (run by Claude Code)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { startDaemon, lanAddresses } from './daemon.ts';
import { runHook } from './hook.ts';
import { runDoctor } from './doctor.ts';

// The shared secret comes from COCO_SECRET, or from ~/.coco-connect/secret.
function readSecret(): string {
  const secretFile = path.join(os.homedir(), '.coco-connect', 'secret');
  const secret = process.env.COCO_SECRET ?? (fs.existsSync(secretFile) ? fs.readFileSync(secretFile, 'utf8') : '');
  if (secret.trim() === '') {
    throw new Error(`No shared secret. Put the same secret in ${secretFile} on both laptops.`);
  }
  return secret.trim();
}

async function start(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      peer: { type: 'string' },
      repo: { type: 'string', default: process.cwd() },
      port: { type: 'string', default: process.env.COCO_PORT ?? '7777' },
      'peer-port': { type: 'string', default: '7778' },
    },
  });
  if (!values.name) {
    throw new Error('--name is required, and must differ from your teammate\'s.');
  }

  const daemon = await startDaemon({
    name: values.name,
    secret: readSecret(),
    repo: values.repo,
    localPort: Number(values.port),
    peerPort: Number(values['peer-port']),
    peer: values.peer,
    discovery: true,
  });
  console.log(`coco-connect running for ${values.name} in ${daemon.repoRoot}`);
  console.log(values.peer ? `Dialing ${values.peer}...` : 'Looking for your teammate on the Wi-Fi...');
  // Printed so the teammate can use --peer without hunting for an OS-specific IP command.
  const addresses = lanAddresses().map((address) => `${address}:${values['peer-port']}`);
  console.log(`If they can't find you, they can run with --peer ${addresses.join(' or --peer ')}`);

  process.on('SIGINT', async () => {
    await daemon.close();
    process.exit(0);
  });
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'start') {
  await start(rest);
} else if (command === 'mcp') {
  await import('./mcp.ts');
} else if (command === 'hook') {
  process.exitCode = await runHook(rest[0]);
} else if (command === 'doctor') {
  const { values } = parseArgs({ args: rest, options: { peer: { type: 'string' } } });
  process.exitCode = await runDoctor(values.peer);
} else {
  console.log('usage: coco-connect start --name <you> [--peer host:port] | doctor [--peer host] | mcp | hook pre|post|session');
  process.exitCode = 1;
}

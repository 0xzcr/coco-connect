// The diagnose tool: works out why teammates can't connect, one layer at a time, and says
// what to do about it in plain words.

import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { lanAddresses, splitHostPort, tcpProbe, type ProbeResult } from './netinfo.ts';
import type { CocoNode } from './room.ts';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 2500;

const OK = '✓';
const BAD = '✗';
const NOTE = '!';

// Windows treats new Wi-Fi as "Public" and then blocks incoming connections and Bonjour.
async function windowsNetworkIsPublic(): Promise<boolean> {
  if (process.platform !== 'win32') {
    return false;
  }
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-Command', '(Get-NetConnectionProfile).NetworkCategory'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    );
    return stdout.includes('Public');
  } catch {
    return false;
  }
}

// macOS 15 (Darwin 24) and later ask before an app may talk to devices on the local network.
function macAsksForLocalNetwork(): boolean {
  return process.platform === 'darwin' && Number(os.release().split('.')[0]) >= 24;
}

function describePlatform(): string {
  const names: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
  return `${names[process.platform] ?? process.platform} (${os.release()}), Node ${process.version}`;
}

interface ProbeTarget {
  name: string;
  address: string;
}

function probeTargets(node: CocoNode): ProbeTarget[] {
  return node
    .teammateAddresses()
    .filter((teammate) => !teammate.online)
    .flatMap((teammate) => targetsFor(teammate.name, teammate.addresses));
}

function targetsFor(name: string, addresses: string[]): ProbeTarget[] {
  return addresses.slice(0, 4).map((address) => ({ name, address }));
}

function explainProbe(result: ProbeResult): string {
  if (result === 'open') {
    return 'port reachable, so the network is fine; the link should come up within 30s (if not, they may be in a different room)';
  }
  if (result === 'refused') {
    return "their laptop answered but nothing listens there: their session ended, or they left the room";
  }
  if (result === 'timeout') {
    return "no answer: their firewall drops it (Windows on a Public network, or macOS firewall blocking node), or this Wi-Fi isolates laptops";
  }
  if (result === 'unreachable') {
    return 'no route to them: they are on another network, or (on macOS) the Local Network permission is off';
  }
  return 'could not connect';
}

export async function diagnose(node: CocoNode): Promise<string> {
  const lines: string[] = [];
  const add = (mark: string, text: string) => lines.push(`${mark} ${text}`);

  lines.push(`System: ${describePlatform()}`);

  // 1. Windows network profile.
  if (await windowsNetworkIsPublic()) {
    add(BAD, 'This Wi-Fi is set to "Public", so Windows blocks teammates from connecting to you and hides Bonjour.');
    lines.push('  Fix: Settings > Network & internet > Wi-Fi > this network > Network profile type > Private.');
  }

  // 2. Our own addresses.
  const addresses = lanAddresses();
  if (addresses.length === 0) {
    add(BAD, 'This laptop has no network address. Turn Wi-Fi on, or join the same network as your teammates.');
  } else {
    const listed = addresses.map((entry) => `${entry.address} (${entry.interface})`).join(', ');
    add(OK, `Network addresses: ${listed}`);
  }

  // 3. The room.
  const status = node.status();
  if (!status.inRoom) {
    add(NOTE, 'Not in a room. Use pair to start one, or join with a teammate\'s code.');
  } else {
    add(OK, `In a room of ${status.members}, accepting connections on port ${node.port}.`);
  }

  // 4. Bonjour.
  const adapters = node.discoveryHealth();
  for (const adapter of adapters) {
    if (adapter.error === null) {
      add(OK, `Bonjour running on ${adapter.address}.`);
    } else {
      add(BAD, `Bonjour failed on ${adapter.address}: ${adapter.error}. Teammates can still join with your address.`);
    }
  }

  // 5. Each teammate.
  for (const teammate of status.teammates) {
    if (teammate.connection === 'direct') {
      add(OK, `${teammate.name}: connected directly.`);
    } else if (teammate.connection === 'through a teammate') {
      add(OK, `${teammate.name}: reachable through another teammate (no direct connection, which is fine).`);
    } else {
      const error = teammate.lastDialError ? ` Last error: ${teammate.lastDialError}.` : '';
      add(BAD, `${teammate.name}: offline.${error}`);
    }
  }

  // 6. Raw network checks for teammates we can't reach.
  const targets = probeTargets(node);
  const results = await Promise.all(
    targets.map((target) => {
      const { host, port } = splitHostPort(target.address, 0);
      return tcpProbe(host, port, PROBE_TIMEOUT_MS);
    }),
  );
  targets.forEach((target, index) => {
    const result = results[index];
    add(result === 'open' ? OK : BAD, `${target.name} at ${target.address}: ${explainProbe(result)}.`);
  });

  // 7. macOS Local Network permission. It can't be read directly; "unreachable" errors to
  //    addresses on our own network are what it looks like when it's off.
  const lostRoutes = results.includes('unreachable') || status.teammates.some((t) => t.lastDialError?.includes('EHOSTUNREACH'));
  if (macAsksForLocalNetwork() && lostRoutes) {
    add(NOTE, 'macOS may be blocking local network access for the app running Claude Code.');
    lines.push(
      '  Fix: System Settings > Privacy & Security > Local Network, and turn on your terminal (Terminal, iTerm, VS Code, Claude...). Then restart that app.',
    );
  }

  // 8. Everything else the room noticed.
  for (const warning of status.warnings) {
    add(NOTE, warning);
  }

  const anyOffline = status.teammates.some((teammate) => !teammate.online);
  if (anyOffline) {
    lines.push('');
    lines.push(
      'If nothing above explains it: ask the offline teammate to run diagnose too. Campus, hotel and office guest Wi-Fi ' +
        'often stop laptops talking to each other; a phone hotspot is the quickest way to confirm.',
    );
  }

  return lines.join('\n');
}

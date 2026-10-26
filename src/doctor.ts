// `coco-connect doctor [--peer host[:port]]`
//
// Checks the connection one layer at a time and says which layer failed:
//   1. Is our own daemon running?
//   2. Can Bonjour see the teammate's daemon on this Wi-Fi?
//   3. Can we open a TCP connection to the teammate's daemon port?
//   4. Are the two daemons actually connected?

import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { Bonjour } from 'bonjour-service';
import { callDaemon } from './local.ts';

const BROWSE_MS = 3000;
const TCP_TIMEOUT_MS = 2000;
const DEFAULT_PEER_PORT = 7778;

function ok(text: string) {
  console.log(`  ✓ ${text}`);
}
function fail(text: string) {
  console.log(`  ✗ ${text}`);
}

// Our daemon's /status, or null if it isn't running.
async function localStatus() {
  try {
    return (await callDaemon('GET', '/status')).data;
  } catch {
    return null;
  }
}

// Listens for coco-connect announcements for a few seconds and returns what it heard.
async function browse(): Promise<{ name: string; host: string; port: number }[]> {
  const bonjour = new Bonjour();
  const found: { name: string; host: string; port: number }[] = [];

  bonjour.find({ type: 'coco-connect' }, (service) => {
    const ipv4 = (service.addresses ?? []).find((address) => address.includes('.'));
    found.push({
      name: String(service.txt?.name ?? service.name),
      host: ipv4 ?? service.referer?.address ?? service.host,
      port: service.port,
    });
  });

  await new Promise((resolve) => setTimeout(resolve, BROWSE_MS));
  bonjour.destroy();
  return found;
}

// True if a TCP connection to host:port opens within the timeout.
function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: TCP_TIMEOUT_MS });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

// Splits "host" or "host:port" into its parts.
function parsePeer(peer: string) {
  const [host, port] = peer.split(':');
  return { host, port: port ? Number(port) : DEFAULT_PEER_PORT };
}

// Windows treats new Wi-Fi as "Public" and then blocks incoming connections and Bonjour.
// Returns true if this Windows laptop is on a Public network. Always false on macOS.
function windowsNetworkIsPublic(): boolean {
  if (process.platform !== 'win32') {
    return false;
  }
  try {
    const category = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', '(Get-NetConnectionProfile).NetworkCategory'],
      { encoding: 'utf8' },
    );
    return category.includes('Public');
  } catch {
    return false;
  }
}

export async function runDoctor(peerArg?: string) {
  if (windowsNetworkIsPublic()) {
    console.log('0. Windows network profile');
    fail('This Wi-Fi is set to "Public", so Windows blocks your teammate from connecting.');
    console.log('  Fix: Settings → Network & internet → Wi-Fi → your network → Network profile type → Private.');
  }

  // 1. Our own daemon.
  console.log('1. Local daemon');
  const status = await localStatus();
  if (!status) {
    fail('Not running on this laptop. Start it with `coco-connect start --name <you>`.');
    return 1;
  }
  ok(`Running as "${status.me.name}".`);
  if (status.connected) {
    ok(`Already connected to ${status.peer.name}. Nothing to fix.`);
    return 0;
  }

  // 2. Bonjour.
  console.log('2. Bonjour discovery (listening for 3s)');
  const others = (await browse()).filter((service) => service.name !== status.me.name);
  if (others.length > 0) {
    ok(`Found: ${others.map((service) => `${service.name} at ${service.host}:${service.port}`).join(', ')}`);
  } else {
    fail("Can't see the teammate's daemon. Either it isn't running, or this Wi-Fi blocks Bonjour.");
  }

  // Pick who to test: the --peer address if given, otherwise whoever Bonjour found.
  const target = peerArg ? parsePeer(peerArg) : others[0];
  if (!target) {
    console.log('\nVerdict: no address to test. `coco-connect start` prints your teammate\'s address. Rerun with it:');
    console.log('  coco-connect doctor --peer <their IP>');
    return 1;
  }

  // 3. Raw network reachability.
  console.log(`3. TCP connection to ${target.host}:${target.port}`);
  const reachable = await canConnect(target.host, target.port);
  if (!reachable) {
    fail('Could not connect.');
    console.log('\nVerdict: the network or their firewall is blocking it.');
    console.log('  - Is their daemon running? It must be started before this check can pass.');
    console.log('  - Their laptop is a Mac: System Settings → Network → Firewall, allow incoming connections for node.');
    console.log('  - Their laptop is Windows: set the Wi-Fi to "Private" and allow Node.js through Windows Firewall');
    console.log('    (running `coco-connect doctor` on it checks the profile).');
    console.log('  - Still failing? The Wi-Fi probably isolates devices (common on hostel/campus networks).');
    console.log('    Confirm by retrying with both laptops on one phone hotspot.');
    console.log('  (Ping is no help here: Windows blocks it by default.)');
    return 1;
  }
  ok('Port is reachable.');

  // 4. Reachable but not connected means the problem is in coco-connect itself.
  console.log('4. Daemon handshake');
  fail('The network is fine, but the daemons are not connected.');
  console.log('\nVerdict: a coco-connect setup problem, not the Wi-Fi.');
  console.log('  - Is the secret in ~/.coco-connect/secret identical on both laptops?');
  console.log('  - Are your --name values different?');
  if (!peerArg && others.length > 0) {
    console.log(`  - Try dialing directly: coco-connect start --name ${status.me.name} --peer ${target.host}:${target.port}`);
  }
  return 1;
}

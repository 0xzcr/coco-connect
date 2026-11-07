// The network lab. Each laptop is a Docker container with its own IP address and network stack,
// running the real plugin bundle (dist/coco.mjs) on Node 20. It is driven over MCP exactly the way
// Claude Code drives it, and the edit hook runs as its own process, as Claude Code runs it.
//
// Containers run Linux, so the lab recreates the *network* side of Macs and Windows PCs:
//   - one shared Wi-Fi with real Bonjour (multicast) between the laptops
//   - Windows Firewall before anyone clicks "Allow" for Node.js, or Wi-Fi set to Public:
//     incoming connections and incoming Bonjour are dropped, outgoing traffic works
//     (a Mac with its firewall on and Node.js blocked behaves the same way)
//   - the WSL / Hyper-V adapter Windows adds, which holds the default route
//   - macOS 15+ with Local Network access denied, and guest Wi-Fi that isolates laptops
//   - routers that drop Bonjour, slow and lossy Wi-Fi, a laptop sleeping, switching Wi-Fi
// Windows-only code (C:\ paths, CRLF, PowerShell) is tested on real Windows in CI instead
// (.github/workflows/test.yml).
//
// Needs Docker. Off by default because it takes several minutes:
//   npm run test:lab

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { cloneOf, makeOrigin, sleep, waitFor } from './helpers.ts';

const enabled = process.env.COCO_TEST_LAB === '1';

const ROOT = path.join(import.meta.dirname, '..');
const IMAGE = 'coco-lab';
const PREFIX = 'coco-lab-';                  // every container and network the lab makes
const WIFI = 'coco-lab-wifi';                // the shared Wi-Fi all laptops are on
const WIFI_SUBNET = '10.77.0.0/24';
const BONJOUR_GROUP = '224.0.0.251';
const DEFAULT_PORT = 7778;

// How the plugin runs inside each container, as Claude Code would start it.
const BUNDLE = '/coco/dist/coco.mjs';
const SESSION = 'lab-session';
const SESSION_ENV = [
  '-e', 'COCO_HOME=/tmp/coco',
  '-e', `CLAUDE_CODE_SESSION_ID=${SESSION}`,
  '-e', 'CLAUDE_PROJECT_DIR=/work',
];

const WAIT_MS = 30_000;
const POLL_MS = 500;
const TEST_TIMEOUT_MS = 5 * 60_000;

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function textOf(result: unknown): string {
  const parts = (result as { content?: { text?: string }[] }).content ?? [];
  return parts.map((part) => part.text ?? '').join('\n');
}

// Containers and networks left behind by an earlier run that crashed.
function removeLeftovers() {
  const containers = docker(['ps', '-aq', '--filter', `name=${PREFIX}`]).split('\n').filter(Boolean);
  if (containers.length > 0) {
    docker(['rm', '-f', ...containers]);
  }
  const networks = docker(['network', 'ls', '-q', '--filter', `name=${PREFIX}`]).split('\n').filter(Boolean);
  if (networks.length > 0) {
    docker(['network', 'rm', ...networks]);
  }
}

// ---------------------------------------------------------------------------
// One laptop
// ---------------------------------------------------------------------------

interface Invite {
  code: string;
  address: string;   // the host's address as pair shows it, e.g. "10.77.0.20:7778"
}

class Laptop {
  readonly name: string;
  readonly repo: string;        // the git clone on this machine, mounted at /work in the container
  private container: string;
  private client = new Client({ name: 'coco-lab', version: '1.0.0' });

  constructor(name: string, repo: string) {
    this.name = name;
    this.repo = repo;
    this.container = `${PREFIX}${name}`;
  }

  // Starts the container on the given networks, then the plugin's MCP server inside it.
  async start(networkFlags: string[]) {
    docker([
      'run', '-d',
      '--name', this.container,
      '--hostname', this.name,
      '--cap-add', 'NET_ADMIN',
      ...networkFlags,
      '-v', `${ROOT}:/coco:ro`,
      '-v', `${this.repo}:/work`,
      IMAGE, 'sleep', 'infinity',
    ]);

    const transport = new StdioClientTransport({
      command: 'docker',
      args: ['exec', '-i', ...SESSION_ENV, this.container, 'node', BUNDLE, 'mcp'],
      stderr: 'inherit',
    });
    await this.client.connect(transport);
  }

  async close() {
    await this.client.close().catch(() => {});
    docker(['rm', '-f', this.container]);
  }

  // --- Talking to the plugin, as Claude would -------------------------------

  async call(tool: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await this.client.callTool({ name: tool, arguments: args });
    const text = textOf(result);
    assert.ok(!result.isError, `${this.name}'s ${tool} failed: ${text}`);
    return text;
  }

  async callFailing(tool: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await this.client.callTool({ name: tool, arguments: args });
    const text = textOf(result);
    assert.ok(result.isError, `${this.name}'s ${tool} should have failed, but said: ${text}`);
    return text;
  }

  async pair(): Promise<Invite> {
    const text = await this.call('pair', { name: this.name });
    const code = /Invite code: (\S+)/.exec(text)?.[1];
    const address = /add your address: (\S+)/.exec(text)?.[1];
    assert.ok(code && address, text);
    return { code, address };
  }

  async join(code: string, host?: string): Promise<string> {
    return this.call('join', { code, host, name: this.name });
  }

  async joinFailing(code: string): Promise<string> {
    return this.callFailing('join', { code, name: this.name });
  }

  // This laptop's status line for one teammate, e.g. "- ben: online (direct), branch main, ...".
  // Empty when the teammate isn't in the room.
  async lineFor(teammate: string): Promise<string> {
    const status = await this.call('status');
    const line = status.split('\n').find((candidate) => candidate.startsWith(`- ${teammate}:`));
    return line ?? '';
  }

  async waitToSee(teammate: string, pattern: RegExp, timeoutMs = WAIT_MS) {
    const what = `${this.name} to see ${teammate} match ${pattern}`;
    await waitFor(async () => pattern.test(await this.lineFor(teammate)), timeoutMs, what, POLL_MS);
  }

  async send(text: string, to: string): Promise<string> {
    return this.call('send_message', { text, to });
  }

  // Reads the inbox until a message with `text` has arrived.
  async waitForMessage(text: string, timeoutMs = WAIT_MS) {
    let received = '';
    const arrived = async () => {
      received += await this.call('read_inbox');
      return received.includes(`> ${text}`);
    };
    await waitFor(arrived, timeoutMs, `${this.name} to get "${text}"`, POLL_MS);
  }

  // Changes a file the way an editor would, so git sees an uncommitted change.
  async edit(file: string) {
    fs.writeFileSync(path.join(this.repo, file), `${this.name} was here\n`);
    // status makes the node re-read git now, instead of within 10 seconds.
    await this.call('status');
  }

  // Runs the edit hook as Claude Code does before an Edit. Returns its block message, or null.
  hookBlocks(file: string): string | null {
    const event = { session_id: SESSION, tool_name: 'Edit', tool_input: { file_path: `/work/${file}` } };
    const run = spawnSync('docker', ['exec', '-i', ...SESSION_ENV, this.container, 'node', BUNDLE, 'hook', 'pre'], {
      input: JSON.stringify(event),
      encoding: 'utf8',
    });
    return run.status === 2 ? run.stderr : null;
  }

  async waitUntilBlocked(file: string) {
    const blocked = () => this.hookBlocks(file) !== null;
    await waitFor(blocked, WAIT_MS, `${this.name}'s edit to ${file} to be blocked`, POLL_MS);
  }

  // --- Network conditions -----------------------------------------------------

  private shell(command: string) {
    docker(['exec', this.container, 'sh', '-c', command]);
  }

  // Windows Firewall before anyone clicks "Allow" for Node.js, or a Wi-Fi set to Public:
  // new incoming connections and incoming Bonjour vanish. Outgoing traffic still works, and so
  // does loopback, which the edit hook uses to reach its own session.
  windowsFirewall() {
    this.shell('iptables -A INPUT ! -i lo -p tcp --syn -j DROP');
    this.shell('iptables -A INPUT ! -i lo -p udp --dport 5353 -j DROP');
  }

  // macOS 15+ with Local Network access denied for the terminal: anything sent to the local
  // network fails at once with "no route to host". (An iptables REJECT would only make Linux
  // retry until a timeout; an "unreachable" routing rule fails at once, like macOS.)
  denyLocalNetwork() {
    this.shell(`ip rule add to ${WIFI_SUBNET} unreachable`);
    this.shell(`ip rule add to ${BONJOUR_GROUP} unreachable`);
  }

  // Guest Wi-Fi that isolates laptops: nothing from the other laptops arrives, Bonjour included.
  isolate() {
    this.shell(`iptables -A INPUT -s ${WIFI_SUBNET} -j DROP`);
  }

  // A router that drops multicast, so Bonjour never arrives.
  blockBonjour() {
    this.shell('iptables -A INPUT -p udp --dport 5353 -j DROP');
  }

  // Slow, lossy Wi-Fi.
  slowWifi() {
    this.shell('tc qdisc add dev wifi root netem delay 200ms 50ms loss 5%');
  }

  // Undoes every rule above: Windows allows Node.js, macOS allows Local Network, a phone hotspot...
  restoreNetwork() {
    this.shell('iptables -F INPUT');
    this.shell(`ip rule del to ${WIFI_SUBNET} unreachable 2>/dev/null || true`);
    this.shell(`ip rule del to ${BONJOUR_GROUP} unreachable 2>/dev/null || true`);
  }

  // Something else on this laptop (say, a second Claude Code session) already has the default port.
  async takeDefaultPort() {
    docker(['exec', '-d', this.container, 'node', '-e', `require('net').createServer().listen(${DEFAULT_PORT})`]);
    const taken = () => spawnSync('docker', ['exec', this.container, 'sh', '-c', `ss -ltn | grep -q ':${DEFAULT_PORT} '`]).status === 0;
    await waitFor(taken, 5000, `port ${DEFAULT_PORT} to be taken`, 100);
  }

  // The lid closes: every process on the laptop freezes until it opens again.
  sleep() {
    docker(['pause', this.container]);
  }

  wake() {
    docker(['unpause', this.container]);
  }

  // Moving to another access point: the old address disappears and a new one arrives.
  changeAddress(ip: string) {
    docker(['network', 'disconnect', WIFI, this.container]);
    docker(['network', 'connect', '--ip', ip, '--driver-opt', 'com.docker.network.endpoint.ifname=wifi', WIFI, this.container]);
  }
}

// ---------------------------------------------------------------------------
// One test's laptops, all sharing one repo
// ---------------------------------------------------------------------------

class Lab {
  private origin = makeOrigin();
  private laptops: Laptop[] = [];
  private networks: string[] = [];

  async mac(name: string, ip: string): Promise<Laptop> {
    return this.add(name, wifiFlag(ip));
  }

  // A Windows PC with the WSL / Hyper-V adapter. It goes first and takes the default route, as
  // on many Windows laptops, so multicast sent without care goes out the wrong adapter. Each PC
  // gets its own WSL network, because that network never leaves the PC.
  async windows(name: string, ip: string): Promise<Laptop> {
    const network = `${PREFIX}wsl-${name}`;
    const subnet = `172.29.${80 + this.networks.length}.0/24`;
    docker(['network', 'create', '--subnet', subnet, network]);
    this.networks.push(network);

    const wsl = `name=${network},driver-opt=com.docker.network.endpoint.ifname=vEthernetWSL,gw-priority=1`;
    return this.add(name, ['--network', wsl, ...wifiFlag(ip)]);
  }

  private async add(name: string, networkFlags: string[]): Promise<Laptop> {
    const laptop = new Laptop(name, cloneOf(this.origin));
    this.laptops.push(laptop);
    await laptop.start(networkFlags);
    return laptop;
  }

  async close() {
    await Promise.all(this.laptops.map((laptop) => laptop.close()));
    if (this.networks.length > 0) {
      docker(['network', 'rm', ...this.networks]);
    }
  }
}

function wifiFlag(ip: string): string[] {
  return ['--network', `name=${WIFI},ip=${ip},driver-opt=com.docker.network.endpoint.ifname=wifi`];
}

async function withLab(run: (lab: Lab) => Promise<void>) {
  const lab = new Lab();
  try {
    await run(lab);
  } finally {
    await lab.close();
  }
}

// ---------------------------------------------------------------------------
// What every working pair of laptops must be able to do
// ---------------------------------------------------------------------------

// The everyday loop, both ways: an uncommitted change blocks the other's edit, and messages arrive.
async function checkWorkingTogether(a: Laptop, b: Laptop) {
  await a.edit(`${a.name}.txt`);
  await b.waitUntilBlocked(`${a.name}.txt`);
  assert.match(b.hookBlocks(`${a.name}.txt`) ?? '', new RegExp(`${a.name} has uncommitted changes`));
  assert.equal(b.hookBlocks('untouched.txt'), null);

  await b.edit(`${b.name}.txt`);
  await a.waitUntilBlocked(`${b.name}.txt`);

  await a.send(`hello ${b.name}`, b.name);
  await b.waitForMessage(`hello ${b.name}`);
  await b.send(`hello ${a.name}`, a.name);
  await a.waitForMessage(`hello ${a.name}`);
}

// Samples the status once a second, failing if the direct link ever drops (links flapping).
async function staysDirect(laptop: Laptop, teammate: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    assert.match(await laptop.lineFor(teammate), /online \(direct\)/);
    await sleep(1000);
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('network lab', { skip: !enabled && 'set COCO_TEST_LAB=1 (needs Docker): npm run test:lab' }, () => {
  before(() => {
    docker(['build', '-q', '-t', IMAGE, path.join(ROOT, 'lab')]);
    removeLeftovers();
    docker(['network', 'create', '--subnet', WIFI_SUBNET, WIFI]);
  });

  after(() => {
    removeLeftovers();
  });

  test('Mac and Mac: the code alone finds the host over Bonjour', { timeout: TEST_TIMEOUT_MS }, () =>
    withLab(async (lab) => {
      const ana = await lab.mac('ana', '10.77.0.20');
      const ben = await lab.mac('ben', '10.77.0.21');

      // A second session on Ana's Mac already holds the usual port, so the code's address hint
      // can't find her. Only Bonjour can.
      await ana.takeDefaultPort();
      const invite = await ana.pair();
      assert.doesNotMatch(invite.address, /:7778$/);

      await ben.join(invite.code);
      await ana.waitToSee('ben', /online \(direct\)/);
      await ben.waitToSee('ana', /online \(direct\)/);
      await checkWorkingTogether(ana, ben);

      await ben.call('leave');
      await waitFor(async () => (await ana.lineFor('ben')) === '', WAIT_MS, 'ana to see ben leave', POLL_MS);
    }),
  );

  test('Mac hosts, a fresh Windows PC joins: its firewall drops everything incoming and WSL holds the default route', { timeout: TEST_TIMEOUT_MS }, () =>
    withLab(async (lab) => {
      const ana = await lab.mac('ana', '10.77.0.20');
      const wes = await lab.windows('wes', '10.77.0.31');
      wes.windowsFirewall();

      // Wes can't hear Bonjour; the code's hint (Ana's last address number) finds her.
      const invite = await ana.pair();
      await wes.join(invite.code);
      await ana.waitToSee('wes', /online \(direct\)/);
      await wes.waitToSee('ana', /online \(direct\)/);

      // Ana's own attempts to reach Wes time out. The link Wes dialed must stay up regardless.
      await staysDirect(ana, 'wes', 15_000);
      await checkWorkingTogether(ana, wes);
    }),
  );

  test('a fresh Windows PC hosts: the Mac gets a clear error, then joins with the same code once Windows allows Node.js', { timeout: TEST_TIMEOUT_MS }, () =>
    withLab(async (lab) => {
      const wes = await lab.windows('wes', '10.77.0.31');
      const ana = await lab.mac('ana', '10.77.0.20');
      wes.windowsFirewall();

      const invite = await wes.pair();
      const error = await ana.joinFailing(invite.code);
      assert.match(error, /Couldn't find the host/);
      assert.match(error, /Private/);

      // Wes clicks "Allow" (or sets the Wi-Fi to Private).
      wes.restoreNetwork();
      await ana.join(invite.code);
      await wes.waitToSee('ana', /online \(direct\)/);
      await checkWorkingTogether(wes, ana);
    }),
  );

  test('two Macs and two fresh Windows PCs: the Windows pair talks through a Mac, and a fifth laptop is turned away', { timeout: TEST_TIMEOUT_MS }, () =>
    withLab(async (lab) => {
      const ana = await lab.mac('ana', '10.77.0.20');
      const ben = await lab.mac('ben', '10.77.0.21');
      const wes = await lab.windows('wes', '10.77.0.31');
      const wyn = await lab.windows('wyn', '10.77.0.32');
      const cal = await lab.mac('cal', '10.77.0.22');
      wes.windowsFirewall();
      wyn.windowsFirewall();

      const invite = await ana.pair();
      await ben.join(invite.code);
      await wes.join(invite.code);
      await wyn.join(invite.code);

      // Both Windows PCs drop incoming connections, so neither can reach the other directly.
      await wes.waitToSee('wyn', /online \(through a teammate\)/, 60_000);
      await wyn.waitToSee('wes', /online \(through a teammate\)/, 60_000);
      // Everyone else reaches everyone, because the Windows PCs dial out to them.
      await ben.waitToSee('wyn', /online \(direct\)/);
      await ben.waitToSee('wes', /online \(direct\)/);
      await checkWorkingTogether(wes, wyn);

      const full = await cal.joinFailing(invite.code);
      assert.match(full, /already has 4 people/);
    }),
  );

  test('a router that drops Bonjour, and the host is not on the usual port: the code alone fails clearly, the address works', { timeout: TEST_TIMEOUT_MS }, () =>
    withLab(async (lab) => {
      const ana = await lab.mac('ana', '10.77.0.20');
      const ben = await lab.mac('ben', '10.77.0.21');
      ana.blockBonjour();
      ben.blockBonjour();
      await ana.takeDefaultPort();

      const invite = await ana.pair();
      const error = await ben.joinFailing(invite.code);
      assert.match(error, /Ask the host for their full address/);

      await ben.join(invite.code, invite.address);
      await ana.waitToSee('ben', /online \(direct\)/);
      await checkWorkingTogether(ana, ben);
    }),
  );

  test('guest Wi-Fi that isolates laptops: a clear error, then it works on a phone hotspot', { timeout: TEST_TIMEOUT_MS }, () =>
    withLab(async (lab) => {
      const ana = await lab.mac('ana', '10.77.0.20');
      const ben = await lab.mac('ben', '10.77.0.21');
      ana.isolate();
      ben.isolate();

      const invite = await ana.pair();
      const error = await ben.joinFailing(invite.code);
      assert.match(error, /Couldn't find the host/);
      assert.match(error, /phone hotspot/);

      // Both move to a phone hotspot.
      ana.restoreNetwork();
      ben.restoreNetwork();
      await ben.join(invite.code);
      await ana.waitToSee('ben', /online \(direct\)/);
    }),
  );

  test('a Mac with Local Network access denied (macOS 15+): a clear error, then it joins once allowed', { timeout: TEST_TIMEOUT_MS }, () =>
    withLab(async (lab) => {
      const ana = await lab.mac('ana', '10.77.0.20');
      const ben = await lab.mac('ben', '10.77.0.21');
      ben.denyLocalNetwork();

      const invite = await ana.pair();
      const error = await ben.joinFailing(invite.code);
      assert.match(error, /Couldn't find the host/);
      // macOS says EHOSTUNREACH, Linux ENETUNREACH; the plugin treats both as "no route".
      assert.match(error, /EHOSTUNREACH|ENETUNREACH/);

      // Ben turns Local Network on in System Settings.
      ben.restoreNetwork();
      await ben.join(invite.code);
      await ana.waitToSee('ben', /online \(direct\)/);
    }),
  );

  test('a Windows PC sleeps: it shows offline, messages wait for it, and arrive after it wakes', { timeout: TEST_TIMEOUT_MS }, () =>
    withLab(async (lab) => {
      // Wes's firewall stays on, so only Wes can bring the link back: the hardest case.
      const ana = await lab.mac('ana', '10.77.0.20');
      const wes = await lab.windows('wes', '10.77.0.31');
      wes.windowsFirewall();

      const invite = await ana.pair();
      await wes.join(invite.code);
      await ana.waitToSee('wes', /online \(direct\)/);

      wes.sleep();
      await ana.waitToSee('wes', /offline/, 90_000);
      assert.match(await ana.send('are you back?', 'wes'), /offline; it will be delivered/);
      assert.match(await ana.call('diagnose'), /wes at 10\.77\.0\.31:\d+: no answer/);

      wes.wake();
      await wes.waitForMessage('are you back?', 90_000);
      await ana.waitToSee('wes', /online \(direct\)/, 60_000);
    }),
  );

  test('switching Wi-Fi: a laptop gets a new address and the room reconnects', { timeout: TEST_TIMEOUT_MS }, () =>
    withLab(async (lab) => {
      const ana = await lab.mac('ana', '10.77.0.20');
      const ben = await lab.mac('ben', '10.77.0.21');

      const invite = await ana.pair();
      await ben.join(invite.code);
      await ana.waitToSee('ben', /online \(direct\)/);

      ben.changeAddress('10.77.0.121');
      await ana.send('still there?', 'ben');
      await ben.waitForMessage('still there?', 90_000);
      await ana.waitToSee('ben', /online \(direct\)/, 60_000);
      await checkWorkingTogether(ana, ben);
    }),
  );

  test('slow, lossy Wi-Fi (200ms ± 50ms, 5% loss): pairing, blocking and messages still work', { timeout: TEST_TIMEOUT_MS }, () =>
    withLab(async (lab) => {
      const ana = await lab.mac('ana', '10.77.0.20');
      const ben = await lab.windows('ben', '10.77.0.31');
      ana.slowWifi();
      ben.slowWifi();

      const invite = await ana.pair();
      await ben.join(invite.code);
      await ana.waitToSee('ben', /online \(direct\)/);
      await checkWorkingTogether(ana, ben);
    }),
  );
});

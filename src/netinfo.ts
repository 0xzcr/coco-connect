// This laptop's network addresses, and a raw "can I reach that port?" check.

import net from 'node:net';
import os from 'node:os';

export interface LanAddress {
  address: string;    // IPv4, e.g. "192.168.1.20"
  interface: string;  // adapter name, e.g. "en0" or "Wi-Fi"
}

// Adapters that belong to VMs, containers and VPNs rather than the real Wi-Fi or Ethernet.
// Windows laptops often have several (Hyper-V, WSL), and their addresses lead nowhere for a
// teammate, so we list them last rather than hiding them: on rare setups they are the only way.
const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|vmnet|hyper-v|wsl|docker|bridge|utun|tun|tap|zerotier|tailscale|awdl|llw|loopback/i;

// IPv4 addresses a teammate on the same network could reach, best guesses first.
export function lanAddresses(): LanAddress[] {
  const real: LanAddress[] = [];
  const virtual: LanAddress[] = [];

  for (const { name, info } of allAddresses()) {
    const usable = info.family === 'IPv4' && !info.internal && !info.address.startsWith('169.254.');
    if (!usable) {
      continue;
    }
    const entry = { address: info.address, interface: name };
    if (VIRTUAL_ADAPTER.test(name)) {
      virtual.push(entry);
    } else {
      real.push(entry);
    }
  }

  return [...real, ...virtual];
}

// Every address of every adapter as one flat list, each tagged with its adapter's name.
function allAddresses(): { name: string; info: os.NetworkInterfaceInfo }[] {
  const result: { name: string; info: os.NetworkInterfaceInfo }[] = [];
  const adapters = os.networkInterfaces();

  for (const name of Object.keys(adapters)) {
    result.push(...tagWithName(name, adapters[name] ?? []));
  }
  return result;
}

function tagWithName(name: string, addresses: os.NetworkInterfaceInfo[]) {
  return addresses.map((info) => ({ name, info }));
}

// The last number of an IPv4 address: "192.168.1.20" -> 20.
export function lastOctet(address: string): number {
  return Number(address.split('.')[3]);
}

// Replaces the last number of an IPv4 address: ("192.168.1.7", 20) -> "192.168.1.20".
export function withLastOctet(address: string, octet: number): string {
  const parts = address.split('.');
  parts[3] = String(octet);
  return parts.join('.');
}

// Splits "host:port", using `defaultPort` when there is no port.
export function splitHostPort(value: string, defaultPort: number): { host: string; port: number } {
  const colon = value.lastIndexOf(':');
  if (colon === -1) {
    return { host: value, port: defaultPort };
  }
  const port = Number(value.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { host: value.slice(0, colon), port: defaultPort };
  }
  return { host: value.slice(0, colon), port };
}

export type ProbeResult = 'open' | 'refused' | 'timeout' | 'unreachable' | 'error';

// Tries a plain TCP connection. The kind of failure tells us a lot:
//   refused      the laptop is there, but nothing listens on that port (daemon not running)
//   timeout      packets vanish: a firewall, or Wi-Fi that isolates devices
//   unreachable  no route; on macOS this is also what a denied Local Network permission looks like
export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      socket.destroy();
      resolve('open');
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve('timeout');
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(classifyError(error.code));
    });
  });
}

export function classifyError(code: string | undefined): ProbeResult {
  if (code === 'ECONNREFUSED') {
    return 'refused';
  }
  if (code === 'ETIMEDOUT') {
    return 'timeout';
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EHOSTDOWN') {
    return 'unreachable';
  }
  return 'error';
}

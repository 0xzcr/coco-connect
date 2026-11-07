// Finding teammates on the Wi-Fi with Bonjour (mDNS + DNS-SD).
//
// What we do differently from a plain `new Bonjour()`, and why:
//   - One Bonjour instance per network adapter. The library listens on every adapter but
//     sends on only one, and on Windows that is often a virtual adapter (WSL, Hyper-V, VPN), so
//     a Mac never hears the Windows laptop. Sending on each adapter fixes that.
//   - Socket errors are caught. If port 5353 can't be opened (Windows can hold it, a firewall
//     can refuse it), the library emits an 'error' event nobody listens to, and Node crashes.
//     We record the error and carry on without discovery on that adapter.
//   - Name-conflict probing is off. The library's default reaction to a conflict is to throw,
//     and our names are random per session anyway.
//   - Adapters are re-checked every few seconds, so switching Wi-Fi or waking from sleep with
//     a new IP address just works.

import { Bonjour, type Service } from 'bonjour-service';
import { lanAddresses } from './netinfo.ts';

const SERVICE_TYPE = 'coco-connect';
const RESCAN_MS = 10_000;

// What we put in our Bonjour announcement. Nothing here is secret.
export interface Advert {
  memberId: string;
  name: string;
  roomTag: string;   // lets room members recognise each other; meaningless to anyone else
  invite: boolean;   // true while we hold an open pairing code
  port: number;      // our LAN WebSocket port
}

// Someone else's announcement, as we heard it.
export interface Sighting {
  memberId: string;
  name: string;
  roomTag: string;
  invite: boolean;
  addresses: string[];  // "ip:port", the address the announcement came from first
}

interface AdapterInstance {
  address: string;
  bonjour: Bonjour;
  browser: ReturnType<Bonjour['find']> | null;
  error: string | null;
}

export interface AdapterHealth {
  address: string;
  error: string | null;
}

export class Discovery {
  private advert: Advert | null = null;
  private instances = new Map<string, AdapterInstance>();
  private rescanTimer: NodeJS.Timeout | null = null;
  private onSighting: (sighting: Sighting) => void;

  constructor(onSighting: (sighting: Sighting) => void) {
    this.onSighting = onSighting;
  }

  // Starts announcing and listening. Calling it again replaces the announcement,
  // e.g. when an invite opens or closes.
  announce(advert: Advert) {
    // Re-announcing tears down and rebuilds every socket, so skip it when nothing changed.
    const unchanged = this.advert !== null && JSON.stringify(this.advert) === JSON.stringify(advert);
    if (unchanged) {
      return;
    }
    this.advert = advert;

    // Drop every instance and start fresh, so the new announcement goes out everywhere.
    // Destroying sends a "goodbye", so browsers forget the old announcement at once.
    this.destroyAll();
    this.rescan();

    if (this.rescanTimer === null) {
      this.rescanTimer = setInterval(() => this.rescan(), RESCAN_MS);
      this.rescanTimer.unref();
    }
  }

  stop() {
    if (this.rescanTimer !== null) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }
    this.destroyAll();
    this.advert = null;
  }

  health(): AdapterHealth[] {
    return [...this.instances.values()].map((instance) => ({
      address: instance.address,
      error: instance.error,
    }));
  }

  // Asks every adapter again "who's out there?", and re-reads what we already know.
  // Cheap, so the room calls it while it is looking for someone.
  refresh() {
    for (const instance of this.instances.values()) {
      this.query(instance);
    }
  }

  // Matches our instances to the adapters the laptop has right now.
  private rescan() {
    if (this.advert === null) {
      return;
    }

    const current = new Set(lanAddresses().map((entry) => entry.address));

    for (const [address, instance] of this.instances) {
      if (!current.has(address)) {
        this.destroy(instance);
        this.instances.delete(address);
      }
    }

    for (const address of current) {
      if (!this.instances.has(address)) {
        this.instances.set(address, this.create(address, this.advert));
      }
    }

    this.refresh();
  }

  private create(address: string, advert: Advert): AdapterInstance {
    const instance: AdapterInstance = { address, bonjour: null as unknown as Bonjour, browser: null, error: null };

    const recordError = (error: unknown) => {
      instance.error = describeError(error);
    };

    // `interface` picks the adapter to send on and join the multicast group on. `bind` must stay
    // 0.0.0.0, because a socket bound to a unicast address never receives multicast on macOS/Linux.
    const options = { interface: address, bind: '0.0.0.0' };

    try {
      instance.bonjour = new Bonjour(options as object, recordError);
    } catch (error) {
      recordError(error);
      return instance;
    }

    // The library never listens for this event itself; without our listener, Node would crash.
    const mdns = (instance.bonjour as unknown as { server: { mdns: NodeJS.EventEmitter } }).server.mdns;
    mdns.on('error', recordError);
    mdns.on('warning', () => {
      // Sending on an adapter that went away, malformed packets from other devices, etc.
    });

    try {
      instance.bonjour.publish({
        name: `coco-${advert.memberId}`,
        type: SERVICE_TYPE,
        port: advert.port,
        probe: false,
        disableIPv6: true,
        txt: {
          member: advert.memberId,
          name: advert.name,
          room: advert.roomTag,
          invite: advert.invite ? '1' : '0',
        },
      });
      instance.browser = instance.bonjour.find({ type: SERVICE_TYPE }, (service) => this.report(service));
    } catch (error) {
      recordError(error);
    }

    return instance;
  }

  // Sends a fresh query, and re-reports the services the browser already knows about,
  // in case their addresses changed.
  private query(instance: AdapterInstance) {
    if (instance.browser === null) {
      return;
    }
    try {
      instance.browser.update();
    } catch (error) {
      instance.error = describeError(error);
    }
    for (const service of instance.browser.services) {
      this.report(service);
    }
  }

  private report(service: Service) {
    const sighting = toSighting(service);
    if (sighting !== null) {
      this.onSighting(sighting);
    }
  }

  private destroy(instance: AdapterInstance) {
    try {
      instance.browser?.stop();
      instance.bonjour.unpublishAll();
      instance.bonjour.destroy();
    } catch {
      // Already broken; nothing to clean up.
    }
  }

  private destroyAll() {
    for (const instance of this.instances.values()) {
      this.destroy(instance);
    }
    this.instances.clear();
  }
}

// Turns a Bonjour service record into a Sighting, or null if it isn't a coco-connect one
// we can use.
export function toSighting(service: Service): Sighting | null {
  const txt = (service.txt ?? {}) as Record<string, unknown>;
  const memberId = String(txt.member ?? '');
  if (memberId === '' || !Number.isInteger(service.port)) {
    return null;
  }

  // The address the packet actually came from is the one most likely to work, so it goes first.
  const hosts = [service.referer?.address, ...(service.addresses ?? [])];
  const ipv4Hosts = hosts.filter((host): host is string => typeof host === 'string' && host.includes('.'));
  const unique = [...new Set(ipv4Hosts)];

  if (unique.length === 0) {
    return null;
  }

  return {
    memberId,
    name: String(txt.name ?? ''),
    roomTag: String(txt.room ?? ''),
    invite: String(txt.invite ?? '0') === '1',
    addresses: unique.map((host) => `${host}:${service.port}`),
  };
}

function describeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code ? `${code}: ${message}` : message;
}

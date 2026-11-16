import {
  BROADCAST_IP,
  BROADCAST_MAC,
  ZERO_MAC,
  broadcastOf,
  cidr,
  inCidr,
  interfaceAddress,
  ip,
  type Cidr,
  type Ipv4,
  type Mac,
} from './addr';
import { ArpCache } from './arp';
import { Device } from './device';
import type { Nic } from './link';
import type { ArpPacket, EthernetFrame, IcmpMessage, Ipv4Packet, UnreachableCode } from './packets';
import { SECOND, type Simulation, type Timer } from './sim';
import type { IpDropReason } from './trace';

/** An IP-configured network interface. */
export interface Interface {
  readonly nic: Nic;
  readonly address: Ipv4;
  readonly subnet: Cidr;
  readonly arp: ArpCache;
}

export interface Route {
  readonly dest: Cidr;
  /** Next hop, or null when the destination is directly attached. */
  readonly gateway: Ipv4 | null;
  readonly iface: Interface;
}

export type PingResult =
  | { readonly status: 'reply'; readonly from: Ipv4; readonly rttUs: number; readonly ttl: number }
  | { readonly status: 'timeout' }
  | { readonly status: 'unreachable'; readonly from: Ipv4; readonly code: UnreachableCode }
  | { readonly status: 'ttl-exceeded'; readonly from: Ipv4 };

export interface PingOptions {
  ttl?: number;
  timeoutUs?: number;
}

export interface IpNodeOptions {
  /** Routers forward packets addressed to others; hosts drop them. */
  forwarding: boolean;
  /** How long an ARP entry is trusted. Defaults to 60 s. */
  arpTtlUs?: number;
  /** Gap between ARP request retries. Defaults to 1 s. */
  arpRetryUs?: number;
  /** ARP requests sent before giving up on an address. Defaults to 3. */
  arpMaxAttempts?: number;
  /** TTL given to packets this node originates. Defaults to 64. */
  defaultTtl?: number;
}

interface PendingResolution {
  readonly queue: Ipv4Packet[];
  attempts: number;
  timer: Timer | null;
}

interface PingWaiter {
  readonly sentAt: number;
  readonly timer: Timer;
  readonly done: (result: PingResult) => void;
}

/** Packets held per unresolved next hop while ARP is in progress. */
const ARP_QUEUE_LIMIT = 8;
/** Identifier carried in this engine's echo requests. Sequence numbers tell pings apart. */
const ECHO_ID = 1;

/**
 * The IP layer shared by hosts and routers: interface addresses, a routing
 * table, ARP resolution, ICMP, and (for routers) forwarding.
 */
export class IpNode extends Device {
  readonly interfaces: Interface[] = [];
  readonly routes: Route[] = [];
  readonly forwarding: boolean;

  private readonly arpTtlUs: number;
  private readonly arpRetryUs: number;
  private readonly arpMaxAttempts: number;
  private readonly defaultTtl: number;

  private readonly pending = new Map<Interface, Map<Ipv4, PendingResolution>>();
  private readonly pings = new Map<number, PingWaiter>();
  private nextPacketId = 1;
  private nextEchoSeq = 1;

  constructor(sim: Simulation, id: string, options: IpNodeOptions) {
    super(sim, id);
    this.forwarding = options.forwarding;
    this.arpTtlUs = options.arpTtlUs ?? 60 * SECOND;
    this.arpRetryUs = options.arpRetryUs ?? SECOND;
    this.arpMaxAttempts = options.arpMaxAttempts ?? 3;
    this.defaultTtl = options.defaultTtl ?? 64;
  }

  /** Gives an interface an address such as "10.0.0.5/24" and adds the route to its subnet. */
  configureInterface(nic: Nic, address: string): Interface {
    if (nic.owner !== this) throw new Error(`${nic.owner.id}:${nic.name} does not belong to ${this.id}`);
    if (this.interfaces.some((i) => i.nic === nic)) {
      throw new Error(`${this.id}:${nic.name} already has an address`);
    }
    const parsed = interfaceAddress(address);
    const iface: Interface = { nic, ...parsed, arp: new ArpCache(this.arpTtlUs) };
    this.interfaces.push(iface);
    this.pending.set(iface, new Map());
    this.routes.push({ dest: parsed.subnet, gateway: null, iface });
    return iface;
  }

  /** Adds a route such as ("0.0.0.0/0", "10.0.0.1"). The gateway must be on an attached subnet. */
  addRoute(dest: string, gateway: string): Route {
    const via = ip(gateway);
    const iface = this.interfaces.find((i) => inCidr(via, i.subnet));
    if (!iface) throw new Error(`${this.id} has no interface on the same subnet as gateway ${gateway}`);
    const route: Route = { dest: cidr(dest), gateway: via, iface };
    this.routes.push(route);
    return route;
  }

  /** Longest-prefix match. Between equally specific routes, the one added first wins. */
  lookupRoute(dst: Ipv4): Route | undefined {
    let best: Route | undefined;
    for (const route of this.routes) {
      if (inCidr(dst, route.dest) && (!best || route.dest.prefix > best.dest.prefix)) best = route;
    }
    return best;
  }

  ownsAddress(address: Ipv4): boolean {
    return this.interfaces.some((i) => i.address === address);
  }

  interfaceFor(nic: Nic): Interface | undefined {
    return this.interfaces.find((i) => i.nic === nic);
  }

  /**
   * Sends one ICMP echo request. `done` is called exactly once, from inside the
   * simulation, with the reply, an error reported by the network, or a timeout.
   */
  ping(target: string | Ipv4, done: (result: PingResult) => void, options: PingOptions = {}): void {
    const dst = typeof target === 'string' ? ip(target) : target;
    const route = this.lookupRoute(dst);
    if (!route) {
      const from = this.interfaces[0]?.address ?? 0;
      this.sim.schedule(0, () => done({ status: 'unreachable', from, code: 'net' }));
      return;
    }
    const seq = this.nextEchoSeq++;
    const timer = this.sim.schedule(options.timeoutUs ?? 5 * SECOND, () => {
      this.pings.delete(seq);
      done({ status: 'timeout' });
    });
    this.pings.set(seq, { sentAt: this.sim.now, timer, done });
    this.originate(route.iface.address, dst, { type: 'echo-request', id: ECHO_ID, seq }, options.ttl);
  }

  override onFrame(nic: Nic, frame: EthernetFrame): void {
    const iface = this.interfaceFor(nic);
    if (!iface) return;
    if (frame.etherType === 'arp') this.handleArp(iface, frame.payload);
    else this.handleIp(iface, frame.payload);
  }

  // ---------------------------------------------------------------- ARP ----

  /** Address resolution as laid out in RFC 826. */
  private handleArp(iface: Interface, arp: ArpPacket): void {
    let merged = false;
    if (iface.arp.lookup(arp.senderIp, this.sim.now) !== undefined) {
      this.learn(iface, arp.senderIp, arp.senderMac);
      merged = true;
    }
    if (arp.targetIp !== iface.address) return;
    if (!merged) this.learn(iface, arp.senderIp, arp.senderMac);
    if (arp.op === 'request') {
      iface.nic.send({
        src: iface.nic.mac,
        dst: arp.senderMac,
        etherType: 'arp',
        payload: {
          op: 'reply',
          senderMac: iface.nic.mac,
          senderIp: iface.address,
          targetMac: arp.senderMac,
          targetIp: arp.senderIp,
        },
      });
    }
  }

  private learn(iface: Interface, address: Ipv4, mac: Mac): void {
    const change = iface.arp.set(address, mac, this.sim.now);
    if (change !== 'refresh') {
      this.sim.record({ kind: 'arp-cache', device: this.id, iface: iface.nic.name, ip: address, mac, change });
    }
    const waiting = this.pending.get(iface)!;
    const resolution = waiting.get(address);
    if (!resolution) return;
    resolution.timer?.cancel();
    waiting.delete(address);
    for (const packet of resolution.queue) this.sendFrame(iface, mac, packet);
  }

  private resolve(iface: Interface, nextHop: Ipv4, packet: Ipv4Packet): void {
    const waiting = this.pending.get(iface)!;
    const existing = waiting.get(nextHop);
    if (existing) {
      if (existing.queue.length < ARP_QUEUE_LIMIT) existing.queue.push(packet);
      else this.drop(packet, 'arp-queue-full');
      return;
    }
    const resolution: PendingResolution = { queue: [packet], attempts: 0, timer: null };
    waiting.set(nextHop, resolution);
    this.requestAddress(iface, nextHop, resolution);
  }

  private requestAddress(iface: Interface, target: Ipv4, resolution: PendingResolution): void {
    resolution.attempts++;
    iface.nic.send({
      src: iface.nic.mac,
      dst: BROADCAST_MAC,
      etherType: 'arp',
      payload: {
        op: 'request',
        senderMac: iface.nic.mac,
        senderIp: iface.address,
        targetMac: ZERO_MAC,
        targetIp: target,
      },
    });
    resolution.timer = this.sim.schedule(this.arpRetryUs, () => {
      if (resolution.attempts < this.arpMaxAttempts) {
        this.requestAddress(iface, target, resolution);
        return;
      }
      this.pending.get(iface)!.delete(target);
      for (const packet of resolution.queue) {
        this.drop(packet, 'arp-timeout');
        this.sendError(packet, { type: 'dest-unreachable', code: 'host', original: packet });
      }
    });
  }

  // ----------------------------------------------------------------- IP ----

  private handleIp(iface: Interface, packet: Ipv4Packet): void {
    const forMe =
      this.ownsAddress(packet.dst) || packet.dst === BROADCAST_IP || packet.dst === broadcastOf(iface.subnet);
    if (forMe) {
      this.deliver(packet);
      return;
    }
    if (!this.forwarding) {
      this.drop(packet, 'not-for-me');
      return;
    }
    if (packet.ttl <= 1) {
      this.drop(packet, 'ttl-exceeded');
      this.sendError(packet, { type: 'time-exceeded', original: packet });
      return;
    }
    const route = this.lookupRoute(packet.dst);
    if (!route) {
      this.drop(packet, 'no-route');
      this.sendError(packet, { type: 'dest-unreachable', code: 'net', original: packet });
      return;
    }
    const forwarded: Ipv4Packet = { ...packet, ttl: packet.ttl - 1 };
    this.sim.record({ kind: 'ip-forward', device: this.id, iface: route.iface.nic.name, packet: forwarded });
    this.transmit(route, forwarded);
  }

  /** Builds a packet that starts at this node and sends it on its way. */
  private originate(src: Ipv4, dst: Ipv4, payload: IcmpMessage, ttl = this.defaultTtl): void {
    const packet: Ipv4Packet = { src, dst, ttl, id: this.nextPacketId++, protocol: 'icmp', payload };
    if (this.ownsAddress(dst)) {
      // Addressed to ourselves: loop it back without touching the wire.
      this.sim.schedule(0, () => this.deliver(packet));
      return;
    }
    const route = this.lookupRoute(dst);
    if (!route) {
      this.drop(packet, 'no-route');
      return;
    }
    this.transmit(route, packet);
  }

  private transmit(route: Route, packet: Ipv4Packet): void {
    const iface = route.iface;
    if (packet.dst === BROADCAST_IP || packet.dst === broadcastOf(iface.subnet)) {
      this.sendFrame(iface, BROADCAST_MAC, packet);
      return;
    }
    const nextHop = route.gateway ?? packet.dst;
    const mac = iface.arp.lookup(nextHop, this.sim.now);
    if (mac !== undefined) this.sendFrame(iface, mac, packet);
    else this.resolve(iface, nextHop, packet);
  }

  private sendFrame(iface: Interface, dst: Mac, packet: Ipv4Packet): void {
    iface.nic.send({ src: iface.nic.mac, dst, etherType: 'ipv4', payload: packet });
  }

  private deliver(packet: Ipv4Packet): void {
    this.sim.record({ kind: 'ip-deliver', device: this.id, packet });
    this.handleIcmp(packet);
  }

  private drop(packet: Ipv4Packet, reason: IpDropReason): void {
    this.sim.record({ kind: 'ip-drop', device: this.id, packet, reason });
  }

  // --------------------------------------------------------------- ICMP ----

  private handleIcmp(packet: Ipv4Packet): void {
    const message = packet.payload;
    switch (message.type) {
      case 'echo-request':
        // Like most modern stacks, stay silent when pinged at a broadcast address.
        if (this.ownsAddress(packet.dst)) {
          this.originate(packet.dst, packet.src, { type: 'echo-reply', id: message.id, seq: message.seq });
        }
        return;
      case 'echo-reply':
        if (message.id === ECHO_ID) {
          const waiter = this.pings.get(message.seq);
          if (!waiter) return;
          this.finishPing(message.seq, {
            status: 'reply',
            from: packet.src,
            rttUs: this.sim.now - waiter.sentAt,
            ttl: packet.ttl,
          });
        }
        return;
      case 'dest-unreachable':
      case 'time-exceeded': {
        const original = message.original;
        const echo = original.payload;
        if (echo.type !== 'echo-request' || echo.id !== ECHO_ID || !this.ownsAddress(original.src)) return;
        this.finishPing(
          echo.seq,
          message.type === 'time-exceeded'
            ? { status: 'ttl-exceeded', from: packet.src }
            : { status: 'unreachable', from: packet.src, code: message.code },
        );
        return;
      }
    }
  }

  private finishPing(seq: number, result: PingResult): void {
    const waiter = this.pings.get(seq);
    if (!waiter) return;
    waiter.timer.cancel();
    this.pings.delete(seq);
    waiter.done(result);
  }

  /** Reports a delivery failure to the packet's sender. Errors about errors are never sent. */
  private sendError(
    about: Ipv4Packet,
    error: Extract<IcmpMessage, { type: 'dest-unreachable' | 'time-exceeded' }>,
  ): void {
    const type = about.payload.type;
    if (type === 'dest-unreachable' || type === 'time-exceeded') return;
    const route = this.lookupRoute(about.src);
    if (!route) return;
    this.originate(route.iface.address, about.src, error);
  }
}

import {
  IpNode,
  type EthernetFrame,
  type Ipv4,
  type Link,
  type Simulation,
  type TcpCloseReason,
  type TcpState,
  type TraceEvent,
} from '../engine';
import { tagOf, type Tag } from './protocol';

/**
 * What became of a frame after it was sent: it arrived and was used, it was
 * lost on the way, the cable was cut under it, or it arrived at an interface
 * that discarded it because it was addressed to someone else.
 */
export type Fate = 'arrive' | 'lost' | 'cut' | 'ignored';

/** One frame crossing one cable. */
export interface Flight {
  /** Trace number of the send, which is unique. */
  readonly id: number;
  readonly frame: EthernetFrame;
  readonly tag: Tag;
  readonly from: string;
  readonly to: string;
  readonly link: Link;
  readonly t0: number;
  readonly t1: number;
  /** Position among frames that left the same interface at the same instant, so they do not overlap. */
  readonly slot: number;
  fate: Fate;
  /** Wall-clock time at which the flight was first seen to have ended; drives its fade-out. */
  endedAtMs: number | null;
}

export type Tone = 'rx' | 'learn' | 'drop' | 'info';

/** A ring that briefly expands around a device. */
export interface Pulse {
  readonly device: string;
  readonly tone: Tone;
  readonly atMs: number;
}

/** A few words that briefly float above a device. */
export interface Caption {
  readonly device: string;
  readonly text: string;
  readonly tone: Tone;
  readonly atMs: number;
}

export interface ArcEnd {
  readonly device: string;
  readonly port: number;
  state: TcpState;
}

/** A TCP connection, drawn over the map between its two hosts. */
export interface Arc {
  readonly key: string;
  /** The two devices, in the order first seen: the side that started the connection comes first. */
  readonly a: string;
  readonly b: string;
  readonly ends: ArcEnd[];
  reason: TcpCloseReason | null;
  closedAtMs: number | null;
}

export type ArcPhase = 'connecting' | 'open' | 'closing' | 'closed';

export function phaseOf(arc: Arc): ArcPhase {
  const states = arc.ends.map((end) => end.state);
  if (states.every((state) => state === 'CLOSED' || state === 'TIME_WAIT')) return 'closed';
  if (states.some((state) => state.startsWith('SYN')) || states.length < 2) return 'connecting';
  return states.every((state) => state === 'ESTABLISHED') ? 'open' : 'closing';
}

/** When a flight stops moving. A lost frame gets halfway. */
export function endOf(flight: Flight): number {
  return flight.fate === 'lost' ? flight.t0 + (flight.t1 - flight.t0) / 2 : flight.t1;
}

const DROP_WORDS: Record<string, string> = {
  'no-route': 'no route',
  'ttl-exceeded': 'TTL ran out',
  'arp-timeout': 'nobody answered ARP',
  'arp-queue-full': 'queue full',
  'not-for-me': 'not for me',
  'port-closed': 'port closed',
  'syn-queue-full': 'SYN queue full',
  'rst-out-of-window': 'reset ignored',
  'no-matching-query': 'forged reply ignored',
  'question-mismatch': 'wrong question, ignored',
  'out-of-bailiwick': 'not yours to say, ignored',
  'no-carrier': 'cable is down',
};

const FLIGHT_LINGER_MS = 600;
const PULSE_MS = 600;
const CAPTION_MS = 2000;
const ARC_LINGER_MS = 1600;

/**
 * Turns the engine's trace into things to draw. It holds no network state of
 * its own: feed it every trace event in order and it keeps the set of frames
 * in flight, connection arcs, and short-lived effects.
 */
export class Model {
  flights: Flight[] = [];
  pulses: Pulse[] = [];
  captions: Caption[] = [];
  readonly arcs = new Map<string, Arc>();
  private readonly owners = new Map<Ipv4, string>();

  constructor(private readonly sim: Simulation) {}

  ingest(event: TraceEvent, nowMs: number): void {
    switch (event.kind) {
      case 'frame-tx':
        this.launch(event);
        return;
      case 'frame-rx':
        this.pulses.push({ device: event.device, tone: 'rx', atMs: nowMs });
        return;
      case 'frame-drop':
        this.settle(event, nowMs);
        return;
      case 'ip-drop':
      case 'tcp-drop':
      case 'dns-reject':
        this.say(event.device, DROP_WORDS[event.reason] ?? event.reason, 'drop', nowMs);
        return;
      case 'arp-cache':
      case 'mac-learn':
        this.pulses.push({ device: event.device, tone: 'learn', atMs: nowMs });
        return;
      case 'dns-cache':
        this.say(event.device, event.rcode === 'NXDOMAIN' ? 'noted: no such name' : 'cached', 'learn', nowMs);
        return;
      case 'tcp-retransmit':
        this.say(event.device, event.cause === 'fast' ? 'resend (3 repeats)' : 'resend (timeout)', 'info', nowMs);
        return;
      case 'tcp-state':
        this.connection(event, nowMs);
        return;
      case 'ip-forward':
      case 'ip-deliver':
        return;
    }
  }

  /** True while any frame is still travelling. */
  busy(): boolean {
    return this.flights.some((flight) => flight.endedAtMs === null);
  }

  /** Notes which flights have ended and discards effects that have finished playing. */
  prune(clockUs: number, nowMs: number): void {
    for (const flight of this.flights) {
      if (flight.endedAtMs === null && clockUs >= endOf(flight)) flight.endedAtMs = nowMs;
    }
    this.flights = this.flights.filter((f) => f.endedAtMs === null || nowMs - f.endedAtMs < FLIGHT_LINGER_MS);
    this.pulses = this.pulses.filter((pulse) => nowMs - pulse.atMs < PULSE_MS);
    this.captions = this.captions.filter((caption) => nowMs - caption.atMs < CAPTION_MS);
    for (const [key, arc] of this.arcs) {
      if (arc.closedAtMs !== null && nowMs - arc.closedAtMs > ARC_LINGER_MS) this.arcs.delete(key);
    }
  }

  private launch(event: Extract<TraceEvent, { kind: 'frame-tx' }>): void {
    const nic = this.sim.devices.get(event.device)?.nics.find((n) => n.name === event.iface);
    const link = nic?.link;
    if (!nic || !link) return;
    const far = link.a === nic ? link.b : link.a;
    const slot = this.flights.filter((f) => f.link === link && f.from === event.device && f.t0 === event.t).length;
    this.flights.push({
      id: event.seq,
      frame: event.frame,
      tag: tagOf(event.frame),
      from: event.device,
      to: far.owner.id,
      link,
      t0: event.t,
      t1: event.t + link.latencyUs,
      slot,
      fate: 'arrive',
      endedAtMs: null,
    });
  }

  /** Works out which flight a dropped frame was, and marks how it ended. */
  private settle(event: Extract<TraceEvent, { kind: 'frame-drop' }>, nowMs: number): void {
    const mark = (fate: Fate, match: (flight: Flight) => boolean) => {
      for (let i = this.flights.length - 1; i >= 0; i--) {
        const flight = this.flights[i]!;
        if (flight.frame === event.frame && flight.fate === 'arrive' && match(flight)) {
          flight.fate = fate;
          return;
        }
      }
    };
    switch (event.reason) {
      case 'link-loss':
        mark('lost', (f) => f.from === event.device && f.t0 === event.t);
        return;
      case 'link-down':
        mark('cut', (f) => f.from === event.device && f.t1 === event.t);
        return;
      case 'mac-filter':
        mark('ignored', (f) => f.to === event.device && f.t1 === event.t);
        return;
      case 'no-carrier':
        this.say(event.device, DROP_WORDS['no-carrier']!, 'drop', nowMs);
        return;
      case 'same-port':
        return;
    }
  }

  private say(device: string, text: string, tone: Tone, nowMs: number): void {
    // The same thing said twice in quick succession reads as noise.
    const repeat = this.captions.some((c) => c.device === device && c.text === text && nowMs - c.atMs < 400);
    if (!repeat) this.captions.push({ device, text, tone, atMs: nowMs });
    this.pulses.push({ device, tone, atMs: nowMs });
  }

  private connection(event: Extract<TraceEvent, { kind: 'tcp-state' }>, nowMs: number): void {
    const remote = this.ownerOf(event.remote);
    if (remote === undefined) return; // the other end is not a device on the map (a forged source, say)
    const here = `${event.device}:${event.localPort}`;
    const there = `${remote}:${event.remotePort}`;
    const key = [here, there].sort().join(' ~ ');

    let arc = this.arcs.get(key);
    if (!arc || arc.closedAtMs !== null) {
      arc = { key, a: event.device, b: remote, ends: [], reason: null, closedAtMs: null };
      this.arcs.set(key, arc);
    }
    let end = arc.ends.find((e) => e.device === event.device && e.port === event.localPort);
    if (!end) {
      end = { device: event.device, port: event.localPort, state: event.to };
      arc.ends.push(end);
    }
    end.state = event.to;
    if (event.reason && event.reason !== 'closed') arc.reason = event.reason;
    if (phaseOf(arc) === 'closed') arc.closedAtMs = nowMs;
  }

  private ownerOf(address: Ipv4): string | undefined {
    const known = this.owners.get(address);
    if (known !== undefined) return known;
    for (const device of this.sim.devices.values()) {
      if (device instanceof IpNode && device.ownsAddress(address)) {
        this.owners.set(address, device.id);
        return device.id;
      }
    }
    return undefined;
  }
}

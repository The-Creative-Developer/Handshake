import { macFromIndex, type Mac } from './addr';
import type { Device } from './device';
import { Link, type LinkOptions, type Nic } from './link';
import { Rng } from './rng';
import type { TraceBody, TraceEvent } from './trace';

/** Simulated time is counted in whole microseconds. */
export const MS = 1_000;
export const SECOND = 1_000_000;

export interface Timer {
  cancel(): void;
}

interface Scheduled {
  readonly time: number;
  readonly seq: number;
  fn: (() => void) | null;
}

function before(a: Scheduled, b: Scheduled): boolean {
  return a.time < b.time || (a.time === b.time && a.seq < b.seq);
}

/**
 * A discrete-event simulation. Events run in order of time, and events due at
 * the same instant run in the order they were scheduled, so a run depends only
 * on the seed and on what was scheduled. There is no wall clock anywhere.
 */
export class Simulation {
  now = 0;
  readonly trace: TraceEvent[] = [];
  readonly rng: Rng;
  readonly devices = new Map<string, Device>();
  readonly links: Link[] = [];

  private readonly heap: Scheduled[] = [];
  private nextSeq = 0;
  private nextMacIndex = 1;

  constructor(options: { seed?: number } = {}) {
    this.rng = new Rng(options.seed ?? 1);
  }

  /** Runs `fn` after `delayUs` microseconds of simulated time. */
  schedule(delayUs: number, fn: () => void): Timer {
    if (!Number.isInteger(delayUs) || delayUs < 0) {
      throw new Error(`Delay must be a non-negative whole number of microseconds, got ${delayUs}`);
    }
    const entry: Scheduled = { time: this.now + delayUs, seq: this.nextSeq++, fn };
    this.push(entry);
    return {
      cancel: () => {
        entry.fn = null;
      },
    };
  }

  /** Runs the next due event. Returns false when nothing is left to run. */
  step(): boolean {
    const entry = this.popLive();
    if (!entry) return false;
    this.now = entry.time;
    const fn = entry.fn!;
    entry.fn = null;
    fn();
    return true;
  }

  /** Runs every event due at or before `untilUs`, then moves the clock there. */
  runUntil(untilUs: number): void {
    for (;;) {
      this.discardCancelled();
      const head = this.heap[0];
      if (!head || head.time > untilUs) break;
      this.step();
    }
    if (untilUs > this.now) this.now = untilUs;
  }

  /** Runs until no events remain. Throws if the network never goes quiet. */
  runUntilIdle(maxEvents = 1_000_000): void {
    let count = 0;
    while (this.step()) {
      if (++count > maxEvents) throw new Error(`Simulation still busy after ${maxEvents} events`);
    }
  }

  record(body: TraceBody): void {
    this.trace.push({ ...body, seq: this.trace.length, t: this.now });
  }

  register(device: Device): void {
    if (this.devices.has(device.id)) throw new Error(`Duplicate device id: "${device.id}"`);
    this.devices.set(device.id, device);
  }

  allocateMac(): Mac {
    return macFromIndex(this.nextMacIndex++);
  }

  /** Joins two network interfaces with a cable. */
  connect(a: Nic, b: Nic, options: LinkOptions = {}): Link {
    if (a === b) throw new Error('Cannot connect an interface to itself');
    for (const nic of [a, b]) {
      if (nic.link) throw new Error(`${nic.owner.id}:${nic.name} is already connected`);
    }
    const link = new Link(this, a, b, options);
    a.link = link;
    b.link = link;
    this.links.push(link);
    return link;
  }

  private discardCancelled(): void {
    while (this.heap[0] && this.heap[0].fn === null) this.pop();
  }

  private popLive(): Scheduled | undefined {
    this.discardCancelled();
    return this.pop();
  }

  private push(entry: Scheduled): void {
    const heap = this.heap;
    let i = heap.length;
    heap.push(entry);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (before(heap[parent]!, entry)) break;
      heap[i] = heap[parent]!;
      i = parent;
    }
    heap[i] = entry;
  }

  private pop(): Scheduled | undefined {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop();
    if (top === undefined || last === undefined) return undefined;
    if (heap.length === 0) return top;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= heap.length) break;
      const right = left + 1;
      const child = right < heap.length && before(heap[right]!, heap[left]!) ? right : left;
      if (before(last, heap[child]!)) break;
      heap[i] = heap[child]!;
      i = child;
    }
    heap[i] = last;
    return top;
  }
}

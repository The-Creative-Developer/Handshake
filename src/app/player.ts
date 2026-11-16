import type { Simulation, TraceEvent } from '../engine';
import type { Model } from './model';

/** Simulated microseconds per real millisecond at 1× speed: a 1 ms cable takes 0.4 s to cross. */
const BASE_RATE = 2.5;
/** With nothing in flight, a gap longer than this is skipped instead of waited through. */
const QUIET_US = 4_000;
/** A slow frame (a background tab, say) never advances the clock by more than this. */
const MAX_FRAME_MS = 50;

/**
 * Drives the simulation in step with the screen. The simulated clock is the
 * simulation's own; this decides how far to advance it each frame and passes
 * every new trace event on to the model and to whoever is listening.
 */
export class Player {
  playing = true;
  speed = 1;
  skipSilence = true;
  /** The most recent stretch of silence that was jumped over. */
  lastSkip: { us: number; atMs: number } | null = null;
  private cursor = 0;

  constructor(
    readonly sim: Simulation,
    private readonly model: Model,
    private readonly onEvent: (event: TraceEvent) => void,
  ) {}

  get clock(): number {
    return this.sim.now;
  }

  /** True when nothing is moving and nothing is scheduled. */
  get idle(): boolean {
    return !this.model.busy() && this.sim.nextEventTime() === undefined;
  }

  /** Called once per screen frame with the real time elapsed since the last one. */
  frame(dtMs: number, nowMs: number): void {
    if (this.playing) {
      let target = this.sim.now + Math.round(Math.min(dtMs, MAX_FRAME_MS) * BASE_RATE * this.speed);
      if (!this.model.busy()) {
        const next = this.sim.nextEventTime();
        if (next === undefined) {
          target = this.sim.now; // nothing left to happen: hold the clock
        } else if (this.skipSilence && next - this.sim.now > QUIET_US) {
          this.lastSkip = { us: next - this.sim.now, atMs: nowMs };
          target = next;
        }
      }
      this.sim.runUntil(target);
    }
    this.drain(nowMs);
    this.model.prune(this.sim.now, nowMs);
  }

  /** Advances to the next moment at which something happens. */
  step(nowMs: number): void {
    const next = this.sim.nextEventTime();
    if (next === undefined) return;
    this.sim.runUntil(next);
    this.drain(nowMs);
    this.model.prune(this.sim.now, nowMs);
  }

  /** Hands over any trace events recorded since the last call. */
  drain(nowMs: number): void {
    const trace = this.sim.trace;
    while (this.cursor < trace.length) {
      const event = trace[this.cursor++]!;
      this.model.ingest(event, nowMs);
      this.onEvent(event);
    }
  }
}

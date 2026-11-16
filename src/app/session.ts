import type { EthernetFrame, Simulation, TraceEvent } from '../engine';
import { Axis } from './axis';
import { Model } from './model';
import { applyInput, type Input, type Note, type Scenario } from './scenario';

/** Simulated microseconds per real millisecond at 1× speed: a 1 ms cable takes 0.4 s to cross. */
const BASE_RATE = 2.5;
/** With nothing in flight, a gap longer than this is skipped instead of waited through. */
const QUIET_US = 4_000;
/** A slow frame (a background tab, say) never advances the clock by more than this. */
const MAX_FRAME_MS = 50;
/** While re-running history in bulk, the display model is tidied this often. */
const TIDY_EVERY = 256;

/** An input together with the moment it was made. */
export interface Recorded {
  readonly t: number;
  readonly input: Input;
}

/** Something an application reported: the outcome of a lookup, a ping, a fetch. */
export interface NoteEntry {
  readonly t: number;
  readonly device: string;
  readonly text: string;
}

export interface SessionListener {
  onEvent(event: TraceEvent): void;
  onNote(note: NoteEntry): void;
  /**
   * The network is about to be rebuilt and history re-run ('start'), or that
   * has just finished ('end'). Between the two, `onEvent` and `onNote` are
   * called again for everything up to the moment being returned to.
   */
  onRebuild(phase: 'start' | 'end'): void;
}

/**
 * One sitting with a scenario: the running simulation, a recording of
 * everything that has happened, and the means to go back.
 *
 * The engine is deterministic, so any earlier moment can be recovered exactly
 * by building the network afresh and applying the same inputs at the same
 * times. Nothing is ever undone; the past is simply run again. An input made
 * from a past moment discards what used to follow it and starts a new future.
 */
export class Session {
  playing = true;
  speed = 1;
  skipSilence = true;
  /** The most recent stretch of silence that was jumped over. */
  lastSkip: { us: number; atMs: number } | null = null;

  scenario!: Scenario;
  model!: Model;

  /** Every trace event of this timeline, up to the furthest moment reached. */
  readonly recording: TraceEvent[] = [];
  /** For each recorded event, when it was over: a frame's arrival time, or the event's own time. */
  readonly ends: number[] = [];
  readonly notes: NoteEntry[] = [];
  readonly inputs: Recorded[] = [];
  readonly axis = new Axis();
  /** The furthest moment this timeline has reached. */
  head = 0;

  // How much of the recording, the notes and the inputs the current simulation has got through.
  private cursor = 0;
  private noteCursor = 0;
  private inputCursor = 0;
  /** The trace position at which each frame first appeared: the same for a frame however often history is re-run. */
  private readonly firstSeen = new WeakMap<EthernetFrame, number>();

  constructor(
    private readonly build: () => Scenario,
    private readonly listener: SessionListener,
  ) {
    this.mount();
  }

  get sim(): Simulation {
    return this.scenario.sim;
  }

  get clock(): number {
    return this.sim.now;
  }

  /** True when the clock is somewhere before the furthest moment reached. */
  get inPast(): boolean {
    return this.sim.now < this.head;
  }

  /** True when nothing is moving and nothing is due, recorded or scheduled. */
  get idle(): boolean {
    return !this.model.busy() && this.nextTime() === undefined;
  }

  /** Whether two frame objects are the same frame, possibly from different runs of history. */
  sameFrame(a: EthernetFrame, b: EthernetFrame): boolean {
    if (a === b) return true;
    const key = this.firstSeen.get(a);
    return key !== undefined && key === this.firstSeen.get(b);
  }

  /** The current run's copy of a frame selected in an earlier run, if history has got that far. */
  currentFrame(frame: EthernetFrame): EthernetFrame | undefined {
    const key = this.firstSeen.get(frame);
    const event = key === undefined ? undefined : this.sim.trace[key];
    return event && 'frame' in event ? event.frame : undefined;
  }

  /** Does something to the network now, and remembers it. */
  perform(input: Input, nowMs: number): void {
    this.drain(nowMs);
    if (this.inPast || this.inputCursor < this.inputs.length) this.forgetFuture();
    this.inputs.push({ t: this.sim.now, input });
    this.inputCursor = this.inputs.length;
    applyInput(this.scenario, input, this.note);
    this.drain(nowMs);
    if (input.kind !== 'link') this.playing = true; // something was set in motion: let it be seen
  }

  /** Called once per screen frame with the real time elapsed since the last one. */
  frame(dtMs: number, nowMs: number): void {
    if (this.playing) {
      let target = this.sim.now + Math.round(Math.min(dtMs, MAX_FRAME_MS) * BASE_RATE * this.speed);
      if (!this.model.busy()) {
        const next = this.nextTime();
        if (next === undefined) {
          target = this.sim.now; // nothing left to happen: hold the clock
        } else if (this.skipSilence && next - this.sim.now > QUIET_US) {
          this.lastSkip = { us: next - this.sim.now, atMs: nowMs };
          target = next;
        }
      }
      this.advance(target, nowMs, false);
    }
    this.drain(nowMs);
    this.model.prune(this.sim.now, nowMs);
  }

  /** Advances to the next moment at which something happens. */
  step(nowMs: number): void {
    this.playing = false;
    const next = this.nextTime();
    if (next === undefined) return;
    this.advance(next, nowMs, false);
    this.model.prune(this.sim.now, nowMs);
  }

  /** Goes back to the last moment before now at which something happened. */
  stepBack(nowMs: number): void {
    let previous: number | undefined;
    for (let i = Math.min(this.cursor, this.recording.length) - 1; i >= 0; i--) {
      if (this.recording[i]!.t < this.sim.now) {
        previous = this.recording[i]!.t;
        break;
      }
    }
    this.seek(previous ?? 0, nowMs);
  }

  /** Jumps to any moment between the start and the furthest point reached, and pauses there. */
  seek(t: number, nowMs: number): void {
    const target = Math.round(Math.min(Math.max(t, 0), this.head));
    this.playing = false;
    if (target < this.sim.now) {
      this.listener.onRebuild('start');
      this.mount();
      this.advance(target, nowMs, true);
      this.model.settle(target);
      this.listener.onRebuild('end');
    } else if (target > this.sim.now) {
      this.advance(target, nowMs, true);
      this.model.settle(target);
    }
  }

  // ------------------------------------------------------------- internal ----

  private readonly note: Note = (device, text) => {
    const entry: NoteEntry = { t: this.sim.now, device, text };
    if (this.noteCursor >= this.notes.length) this.notes.push(entry);
    this.noteCursor++;
    this.listener.onNote(entry);
  };

  /** Replaces the network with a freshly built one at time zero. Devices keep their places on the map. */
  private mount(): void {
    const places = this.scenario?.places;
    this.scenario = this.build();
    for (const [id, place] of Object.entries(places ?? {})) {
      const fresh = this.scenario.places[id];
      if (fresh) Object.assign(fresh, { x: place.x, y: place.y });
    }
    this.model = new Model(this.scenario.sim);
    this.cursor = 0;
    this.noteCursor = 0;
    this.inputCursor = 0;
  }

  /** When the next thing happens: a scheduled event or a recorded input, whichever is sooner. */
  private nextTime(): number | undefined {
    const event = this.sim.nextEventTime();
    const input = this.inputs[this.inputCursor]?.t;
    if (event === undefined) return input;
    return input === undefined ? event : Math.min(event, input);
  }

  /** Runs the simulation to `target`, applying recorded inputs as their moments come. */
  private advance(target: number, nowMs: number, bulk: boolean): void {
    for (;;) {
      const next = this.inputs[this.inputCursor];
      if (!next || next.t > target) break;
      this.sim.runUntil(next.t);
      this.drain(nowMs, bulk);
      this.inputCursor++;
      applyInput(this.scenario, next.input, this.note);
    }
    this.sim.runUntil(target);
    this.drain(nowMs, bulk);
    this.head = Math.max(this.head, this.sim.now);
  }

  /** Passes on trace events produced since the last call, recording any that are new. */
  private drain(nowMs: number, bulk = false): void {
    const trace = this.sim.trace;
    while (this.cursor < trace.length) {
      const index = this.cursor++;
      const event = trace[index]!;
      const flight = this.model.ingest(event, nowMs);
      if ('frame' in event && !this.firstSeen.has(event.frame)) this.firstSeen.set(event.frame, index);
      if (index >= this.recording.length) {
        const end = flight?.t1 ?? event.t;
        this.recording.push(event);
        this.ends.push(end);
        this.axis.add(event.t, end);
      }
      if (bulk && index % TIDY_EVERY === 0) this.model.settle(event.t);
      this.listener.onEvent(event);
    }
  }

  /** Discards everything recorded after the present moment. */
  private forgetFuture(): void {
    this.inputs.length = this.inputCursor;
    this.recording.length = this.cursor;
    this.ends.length = this.cursor;
    this.notes.length = this.noteCursor;
    this.head = this.sim.now;
    this.axis.reset();
    for (let i = 0; i < this.recording.length; i++) this.axis.add(this.recording[i]!.t, this.ends[i]!);
  }
}

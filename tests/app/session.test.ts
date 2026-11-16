import { describe, expect, it } from 'vitest';
import { Axis, GAP_PX } from '../../src/app/axis';
import { toyInternet } from '../../src/app/scenario';
import { Session, type NoteEntry, type SessionListener } from '../../src/app/session';
import { MS, SECOND, type TraceEvent } from '../../src/engine';

const LOOKUP = { kind: 'action', index: 0 } as const;
const FETCH = { kind: 'action', index: 2 } as const;
const CLOSED_PORT = { kind: 'action', index: 3 } as const;
/** The cable between the two routers. */
const BACKBONE = 1;

/** A session with a listener that keeps what a log would show. */
function open() {
  const seen: { events: TraceEvent[]; notes: NoteEntry[]; rebuilds: number } = { events: [], notes: [], rebuilds: 0 };
  const listener: SessionListener = {
    onEvent: (event) => seen.events.push(event),
    onNote: (note) => seen.notes.push(note),
    onRebuild: (phase) => {
      if (phase !== 'start') return;
      seen.events = [];
      seen.notes = [];
      seen.rebuilds++;
    },
  };
  const session = new Session(toyInternet, listener);
  let now = 0;
  /** Plays for a number of 16 ms screen frames. */
  const run = (frames: number) => {
    for (let i = 0; i < frames; i++) session.frame(16, (now += 16));
  };
  /** Plays until nothing is moving and nothing is due. Returns the longest silence skipped on the way. */
  const settle = () => {
    session.playing = true;
    let longest = 0;
    for (let i = 0; i < 20_000 && !session.idle; i++) {
      session.frame(16, (now += 16));
      longest = Math.max(longest, session.lastSkip?.us ?? 0);
    }
    expect(session.idle).toBe(true);
    return longest;
  };
  return { session, seen, run, settle };
}

const plain = (value: unknown) => JSON.stringify(value);

describe('Session: playback', () => {
  it('holds the clock still when nothing is left to happen', () => {
    const { session, run } = open();
    run(50);
    expect(session.clock).toBe(0);
    expect(session.idle).toBe(true);
  });

  it('moves a frame across a cable in about 0.4 seconds', () => {
    const { session, seen, run } = open();
    session.perform(LOOKUP, 0);
    run(24); // 384 ms
    expect(seen.events.map((e) => e.kind)).toEqual(['frame-tx']);
    run(2);
    expect(seen.events.map((e) => e.kind)).toContain('frame-rx');
  });

  it('jumps over silence, and says how much it skipped', () => {
    const { session, settle } = open();
    session.perform(FETCH, 0);
    const longest = settle(); // includes the minute a closed connection lingers
    expect(session.clock).toBeGreaterThan(60 * SECOND);
    expect(longest).toBeGreaterThan(59 * SECOND);
  });

  it('waits out the silence when told not to skip it', () => {
    const { session, run } = open();
    session.skipSilence = false;
    session.perform(FETCH, 0); // done in about 90 ms, then a minute's wait for the connection to be forgotten
    run(4000); // 64 s of real time is 160 ms of simulated time
    expect(session.clock).toBe(160 * MS);
    expect(session.lastSkip).toBeNull();
  });

  it('does nothing while paused, except when stepped', () => {
    const { session, run } = open();
    session.perform(LOOKUP, 0);
    session.playing = false;
    run(100);
    expect(session.clock).toBe(0);
    session.step(0);
    expect(session.clock).toBe(MS);
    session.step(0);
    expect(session.clock).toBe(2 * MS);
  });

  it('runs faster at higher speeds', () => {
    const { session, run } = open();
    session.speed = 4;
    session.perform(LOOKUP, 0);
    run(25); // 400 ms at 4× is 4 ms of simulated time
    expect(session.clock).toBe(4 * MS);
  });
});

describe('Session: going back', () => {
  it('reproduces any earlier moment exactly', () => {
    const { session, seen, settle } = open();
    session.perform(LOOKUP, 0);
    settle();
    session.perform(FETCH, 0);
    settle();
    const full = session.recording.slice();
    const notes = session.notes.slice();
    const head = session.head;

    for (const t of [0, 3 * MS + 500, 20 * MS, 56 * MS, 70 * MS, head]) {
      session.seek(t, 0);
      const expected = full.filter((event) => event.t <= t);
      expect(session.clock).toBe(t);
      expect(plain(session.sim.trace)).toBe(plain(expected));
      // What the log is told matches too, and so do the reported outcomes.
      expect(seen.events).toHaveLength(expected.length);
      expect(seen.notes).toEqual(notes.filter((note) => note.t <= t));
    }
    // The recording itself was never disturbed by all that travelling.
    expect(session.recording).toHaveLength(full.length);
    expect(session.head).toBe(head);
  });

  it('shows the frames that were in flight at that moment, and nothing else', () => {
    const { session, settle } = open();
    session.perform(LOOKUP, 0);
    settle();
    session.seek(4 * MS + 500, 0);
    // At 4.5 ms the laptop's query, sent at 4 ms once ARP had answered, is halfway to the switch.
    expect(session.model.flights.map((f) => [f.from, f.to, f.tag.label, f.t0])).toEqual([['laptop', 'sw1', 'DNS ?', 4 * MS]]);
    expect(session.model.pulses).toEqual([]);
    expect(session.model.captions).toEqual([]);
    expect(session.playing).toBe(false);
  });

  it('plays forward from the past through the same history, then carries on', () => {
    const { session, settle } = open();
    session.perform(LOOKUP, 0);
    settle();
    const full = plain(session.recording);
    session.seek(10 * MS, 0);
    expect(session.inPast).toBe(true);
    settle();
    expect(session.inPast).toBe(false);
    expect(plain(session.sim.trace)).toBe(full);
    expect(plain(session.recording)).toBe(full);
  });

  it('applies recorded inputs again at the moments they were made', () => {
    const { session, settle } = open();
    session.perform(LOOKUP, 0);
    settle();
    const fetchedAt = session.clock;
    session.perform(FETCH, 0);
    settle();
    const full = plain(session.recording);

    session.seek(fetchedAt - MS, 0);
    expect(session.inPast).toBe(true);
    expect(session.sim.trace.some((event) => event.kind === 'tcp-state')).toBe(false); // no fetch yet
    settle(); // the fetch must start by itself when its moment comes
    expect(plain(session.sim.trace)).toBe(full);
    expect(session.inputs).toHaveLength(2);
  });

  it('discards the old future when something new is done in the past', () => {
    const { session, settle } = open();
    session.perform(LOOKUP, 0);
    settle();
    session.perform(FETCH, 0);
    settle();
    const before = session.recording.length;

    session.seek(55 * MS, 0); // just before the lookup's answer arrives, and so before the fetch
    session.perform(CLOSED_PORT, 0);
    expect(session.inputs.map((r) => r.input)).toEqual([LOOKUP, CLOSED_PORT]);
    expect(session.head).toBe(55 * MS);
    expect(session.recording.every((event) => event.t <= 55 * MS)).toBe(true);
    expect(session.recording.length).toBeLessThan(before);

    settle();
    expect(session.notes.map((n) => n.text)).toEqual([
      'www.example.com is 10.0.2.10',
      'fetch 10.0.2.10:8080: connection refused',
    ]);
    // The squeezed time axis was rebuilt for the new history and stays in order.
    const starts = session.axis.spans.map((span) => span.x);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('undoes and redoes a cut cable as time moves past the cut', () => {
    const { session, settle } = open();
    session.perform(LOOKUP, 0);
    settle();
    const cutAt = session.clock;
    session.perform({ kind: 'link', index: BACKBONE, up: false }, 0);
    expect(session.sim.links[BACKBONE]!.up).toBe(false);
    session.perform(FETCH, 0);
    settle();
    expect(session.notes.at(-1)?.text).toMatch(/connection timeout/);

    session.seek(cutAt - MS, 0);
    expect(session.sim.links[BACKBONE]!.up).toBe(true);
    session.seek(cutAt, 0);
    expect(session.sim.links[BACKBONE]!.up).toBe(false);
  });

  it('steps backwards one moment at a time', () => {
    const { session, settle } = open();
    session.perform(LOOKUP, 0);
    settle();
    session.seek(3 * MS, 0);
    session.stepBack(0);
    expect(session.clock).toBe(2 * MS);
    session.stepBack(0);
    session.stepBack(0);
    expect(session.clock).toBe(0);
    session.stepBack(0);
    expect(session.clock).toBe(0);
  });

  it('keeps devices where they were dragged, and recognises the same frame across runs', () => {
    const { session, settle } = open();
    session.perform(LOOKUP, 0);
    settle();
    session.scenario.places['laptop']!.x = 333;
    const event = session.recording.find((e) => e.kind === 'frame-tx' && e.t === 4 * MS);
    const frame = event && 'frame' in event ? event.frame : undefined;
    expect(frame).toBeDefined();

    session.seek(5 * MS, 0);
    expect(session.scenario.places['laptop']!.x).toBe(333);
    const again = session.currentFrame(frame!);
    expect(again).toBeDefined();
    expect(again).not.toBe(frame); // a different object from a different run
    expect(session.sameFrame(frame!, again!)).toBe(true);
    expect(session.sameFrame(frame!, session.sim.trace[0] && 'frame' in session.sim.trace[0] ? session.sim.trace[0].frame : frame!)).toBe(false);

    session.seek(MS, 0);
    expect(session.currentFrame(frame!)).toBeUndefined(); // history has not got that far
  });

  it('clamps a jump to what has actually happened', () => {
    const { session, settle } = open();
    session.perform(LOOKUP, 0);
    settle();
    const head = session.head;
    session.seek(head + SECOND, 0);
    expect(session.clock).toBe(head);
    session.seek(-5, 0);
    expect(session.clock).toBe(0);
  });
});

describe('Axis', () => {
  it('draws activity to scale and squeezes silence to a fixed width', () => {
    const axis = new Axis();
    axis.add(0, 10 * MS);
    axis.add(60 * SECOND, 60 * SECOND + 2 * MS);
    expect(axis.spans).toHaveLength(2);
    expect(axis.toX(0)).toBe(0);
    expect(axis.toX(10 * MS)).toBe(90);
    expect(axis.toX(60 * SECOND)).toBe(90 + GAP_PX);
    expect(axis.width).toBe(90 + GAP_PX + 18);
    // Halfway through the silence is halfway across the gap.
    expect(axis.toX(30 * SECOND + 5 * MS)).toBeCloseTo(90 + GAP_PX / 2, 5);
  });

  it('joins things that happen close together', () => {
    const axis = new Axis();
    axis.add(0, MS);
    axis.add(MS, 2 * MS);
    axis.add(5 * MS, 6 * MS); // within the joining distance of the last end
    expect(axis.spans).toHaveLength(1);
    expect(axis.spans[0]).toMatchObject({ start: 0, end: 6 * MS });
    axis.add(20 * MS, 21 * MS);
    expect(axis.spans).toHaveLength(2);
  });

  it('converts positions back to times', () => {
    const axis = new Axis();
    axis.add(0, 10 * MS);
    axis.add(SECOND, SECOND + 10 * MS);
    axis.add(5 * SECOND, 5 * SECOND + MS);
    for (const t of [0, 3 * MS, 10 * MS, 400 * MS, SECOND, SECOND + 7 * MS, 3 * SECOND, 5 * SECOND + MS]) {
      expect(axis.toT(axis.toX(t))).toBeCloseTo(t, 3);
    }
    let previous = -1;
    for (let t = 0; t <= 5 * SECOND; t += 37 * MS) {
      const x = axis.toX(t);
      expect(x).toBeGreaterThanOrEqual(previous);
      previous = x;
    }
  });

  it('copes with nothing recorded and with time past the last thing recorded', () => {
    const axis = new Axis();
    expect(axis.width).toBe(0);
    expect(axis.toX(5 * MS)).toBe(0);
    expect(axis.toT(40)).toBe(0);
    axis.add(0, MS);
    expect(axis.toX(SECOND)).toBe(9 + GAP_PX); // silence after the end never grows wider than a gap
  });
});

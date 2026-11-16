import { describe, expect, it } from 'vitest';
import { SECOND, describeEvent, type PingResult } from '../../src/engine';
import { internetwork } from './helpers';

/** Runs a fixed workload over a lossy backbone and returns everything observable about it. */
function run(seed: number) {
  const { sim, a, b } = internetwork({ seed, lossRate: 0.3 });
  const results: PingResult[] = [];
  for (let i = 0; i < 20; i++) {
    sim.schedule(i * SECOND, () => {
      a.ping('10.0.2.10', (r) => results.push(r), { timeoutUs: SECOND / 2 });
      b.ping('10.0.1.10', (r) => results.push(r), { timeoutUs: SECOND / 2 });
    });
  }
  sim.runUntilIdle();
  return { trace: JSON.stringify(sim.trace), results, events: sim.trace };
}

describe('Determinism', () => {
  it('produces an identical trace for the same seed', () => {
    const first = run(1234);
    const second = run(1234);
    expect(second.trace).toBe(first.trace);
    expect(second.results).toEqual(first.results);
  });

  it('actually exercises loss, and a different seed loses different frames', () => {
    const first = run(1234);
    const other = run(99);
    const lost = (r: ReturnType<typeof run>) => r.events.filter((e) => e.kind === 'frame-drop' && e.reason === 'link-loss');
    expect(lost(first).length).toBeGreaterThan(0);
    expect(first.results.some((r) => r.status === 'reply')).toBe(true);
    expect(first.results.some((r) => r.status === 'timeout')).toBe(true);
    expect(other.trace).not.toBe(first.trace);
  });

  it('numbers events in order and never lets time run backwards', () => {
    const { events } = run(5);
    events.forEach((event, index) => {
      expect(event.seq).toBe(index);
      if (index > 0) expect(event.t).toBeGreaterThanOrEqual(events[index - 1]!.t);
    });
  });

  it('can describe every event it records', () => {
    const { events } = run(5);
    for (const event of events) expect(describeEvent(event)).toMatch(/\S/);
  });
});

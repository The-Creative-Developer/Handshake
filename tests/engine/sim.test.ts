import { describe, expect, it } from 'vitest';
import { Rng, Simulation } from '../../src/engine';

describe('Simulation scheduling', () => {
  it('runs events in time order regardless of scheduling order', () => {
    const sim = new Simulation();
    const order: string[] = [];
    sim.schedule(30, () => order.push('c'));
    sim.schedule(10, () => order.push('a'));
    sim.schedule(20, () => order.push('b'));
    sim.runUntilIdle();
    expect(order).toEqual(['a', 'b', 'c']);
    expect(sim.now).toBe(30);
  });

  it('runs same-time events in the order they were scheduled', () => {
    const sim = new Simulation();
    const order: number[] = [];
    for (let i = 0; i < 50; i++) sim.schedule(5, () => order.push(i));
    sim.runUntilIdle();
    expect(order).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it('keeps order across many interleaved events', () => {
    const sim = new Simulation();
    const rng = new Rng(7);
    const seen: number[] = [];
    for (let i = 0; i < 500; i++) {
      const delay = Math.floor(rng.next() * 100);
      sim.schedule(delay, () => seen.push(sim.now));
    }
    sim.runUntilIdle();
    expect(seen).toHaveLength(500);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('lets an event schedule further events relative to its own time', () => {
    const sim = new Simulation();
    const times: number[] = [];
    sim.schedule(10, () => {
      times.push(sim.now);
      sim.schedule(5, () => times.push(sim.now));
    });
    sim.runUntilIdle();
    expect(times).toEqual([10, 15]);
  });

  it('skips cancelled timers without advancing the clock', () => {
    const sim = new Simulation();
    let fired = false;
    sim.schedule(10, () => {});
    sim.schedule(1000, () => (fired = true)).cancel();
    sim.runUntilIdle();
    expect(fired).toBe(false);
    expect(sim.now).toBe(10);
  });

  it('runUntil stops at the requested time and leaves later events queued', () => {
    const sim = new Simulation();
    const order: string[] = [];
    sim.schedule(10, () => order.push('early'));
    sim.schedule(20, () => order.push('edge'));
    sim.schedule(30, () => order.push('late'));
    sim.runUntil(20);
    expect(order).toEqual(['early', 'edge']);
    expect(sim.now).toBe(20);
    sim.runUntilIdle();
    expect(order).toEqual(['early', 'edge', 'late']);
  });

  it('rejects negative and fractional delays', () => {
    const sim = new Simulation();
    expect(() => sim.schedule(-1, () => {})).toThrow();
    expect(() => sim.schedule(0.5, () => {})).toThrow();
  });

  it('reports a network that never goes quiet', () => {
    const sim = new Simulation();
    const loop = () => void sim.schedule(1, loop);
    loop();
    expect(() => sim.runUntilIdle(100)).toThrow(/still busy/);
  });
});

describe('Rng', () => {
  it('repeats exactly for the same seed and differs between seeds', () => {
    const draw = (seed: number) => {
      const rng = new Rng(seed);
      return Array.from({ length: 20 }, () => rng.next());
    };
    expect(draw(42)).toEqual(draw(42));
    expect(draw(42)).not.toEqual(draw(43));
    for (const value of draw(42)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

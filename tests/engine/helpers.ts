import { Host, Router, Simulation, Switch, type IpNode, type PingOptions, type PingResult, type TraceEvent } from '../../src/engine';

/** Sends a ping and returns the array its result will be pushed into once the simulation runs. */
export function ping(from: IpNode, target: string, options?: PingOptions): PingResult[] {
  const results: PingResult[] = [];
  from.ping(target, (result) => results.push(result), options);
  return results;
}

export function ofKind<K extends TraceEvent['kind']>(sim: Simulation, kind: K): Extract<TraceEvent, { kind: K }>[] {
  return sim.trace.filter((event): event is Extract<TraceEvent, { kind: K }> => event.kind === kind);
}

/** Three hosts on one switch, all in 10.0.0.0/24. */
export function lan(seed = 1) {
  const sim = new Simulation({ seed });
  const sw = new Switch(sim, 'sw1');
  const a = new Host(sim, 'a', { address: '10.0.0.1/24' });
  const b = new Host(sim, 'b', { address: '10.0.0.2/24' });
  const c = new Host(sim, 'c', { address: '10.0.0.3/24' });
  for (const host of [a, b, c]) sim.connect(host.nic, sw.freePort());
  return { sim, sw, a, b, c };
}

/**
 * Two LANs joined by two routers:
 *
 *   a (10.0.1.10) ── sw1 ── r1 ══ r2 ── b (10.0.2.10)
 *        10.0.1.0/24      10.0.12.0/30      10.0.2.0/24
 */
export function internetwork(options: { seed?: number; lossRate?: number } = {}) {
  const sim = new Simulation({ seed: options.seed ?? 1 });
  const a = new Host(sim, 'a', { address: '10.0.1.10/24', gateway: '10.0.1.1' });
  const b = new Host(sim, 'b', { address: '10.0.2.10/24', gateway: '10.0.2.1' });
  const sw = new Switch(sim, 'sw1');
  const r1 = new Router(sim, 'r1');
  const r2 = new Router(sim, 'r2');

  sim.connect(a.nic, sw.freePort());
  sim.connect(r1.addInterface('10.0.1.1/24'), sw.freePort());
  const backbone = sim.connect(r1.addInterface('10.0.12.1/30'), r2.addInterface('10.0.12.2/30'), {
    lossRate: options.lossRate ?? 0,
  });
  const edge = sim.connect(r2.addInterface('10.0.2.1/24'), b.nic);

  r1.addRoute('10.0.2.0/24', '10.0.12.2');
  r2.addRoute('10.0.1.0/24', '10.0.12.1');
  return { sim, a, b, sw, r1, r2, backbone, edge };
}

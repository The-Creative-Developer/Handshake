import { Host, Router, Simulation, Switch, type PingResult } from '../engine';

export interface DemoRun {
  readonly sim: Simulation;
  readonly pings: { readonly label: string; readonly result: PingResult }[];
}

/**
 * Two LANs joined by two routers, with a few pings that between them exercise
 * ARP, switching, routing and ICMP errors:
 *
 *   laptop (10.0.1.10) ── sw1 ── r1 ══ r2 ── server (10.0.2.10)
 */
export function runDemo(): DemoRun {
  const sim = new Simulation({ seed: 1 });
  const laptop = new Host(sim, 'laptop', { address: '10.0.1.10/24', gateway: '10.0.1.1' });
  const server = new Host(sim, 'server', { address: '10.0.2.10/24', gateway: '10.0.2.1' });
  const sw = new Switch(sim, 'sw1');
  const r1 = new Router(sim, 'r1');
  const r2 = new Router(sim, 'r2');

  sim.connect(laptop.nic, sw.freePort());
  sim.connect(r1.addInterface('10.0.1.1/24'), sw.freePort());
  sim.connect(r1.addInterface('10.0.12.1/30'), r2.addInterface('10.0.12.2/30'));
  sim.connect(r2.addInterface('10.0.2.1/24'), server.nic);
  r1.addRoute('10.0.2.0/24', '10.0.12.2');
  r2.addRoute('10.0.1.0/24', '10.0.12.1');

  const pings: DemoRun['pings'] = [];
  const send = (label: string, target: string, ttl?: number) =>
    laptop.ping(target, (result) => pings.push({ label, result }), { ttl });

  send('ping 10.0.2.10', '10.0.2.10');
  sim.runUntilIdle();
  send('ping 10.0.2.10 (caches warm)', '10.0.2.10');
  sim.runUntilIdle();
  send('ping 10.0.2.10 with TTL 1', '10.0.2.10', 1);
  sim.runUntilIdle();
  send('ping 172.16.0.1 (no route)', '172.16.0.1');
  sim.runUntilIdle();

  return { sim, pings };
}

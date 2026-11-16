# Handshake

A playable internet in the browser. Build a network from hosts, switches and routers, watch packets move
through it, then attack and defend it. Everything is simulated: no real traffic ever leaves the page.

![Engine demo: ping results and the event trace](docs/demo.png)

## Status

The simulation engine handles Ethernet, switching, ARP, IPv4 routing and ICMP. The page you get from
`npm run dev` is a placeholder that runs a fixed scenario and lists the event trace.

| Step | What | State |
| --- | --- | --- |
| 1 | Simulation engine: Ethernet, switch, ARP, IPv4, ICMP | Done |
| 1 | Simulation engine: UDP, DNS, TCP | Next |
| 2 | Canvas renderer and packet inspector | Not started |
| 3 | Timeline recording and scrubbing | Not started |
| 4 | Attack and defence modules | Not started |
| 5 | Multiplayer and AI scenarios | Not started |

## Commands

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run build
```

## The engine

`src/engine` has no dependency on the browser, so it runs the same in tests, in the page and later on a server.

```ts
import { Host, Router, Simulation, Switch } from './src/engine';

const sim = new Simulation({ seed: 1 });
const laptop = new Host(sim, 'laptop', { address: '10.0.1.10/24', gateway: '10.0.1.1' });
const server = new Host(sim, 'server', { address: '10.0.2.10/24', gateway: '10.0.2.1' });
const sw = new Switch(sim, 'sw1');
const router = new Router(sim, 'r1');

sim.connect(laptop.nic, sw.freePort());
sim.connect(router.addInterface('10.0.1.1/24'), sw.freePort());
sim.connect(router.addInterface('10.0.2.1/24'), server.nic);

laptop.ping('10.0.2.10', (result) => console.log(result));
sim.runUntilIdle();
console.log(sim.trace); // every frame sent, received, dropped, and every table change
```

### Design rules

- **Deterministic.** Time is a counter of simulated microseconds, events at the same instant run in the order
  they were scheduled, and all randomness comes from one seeded generator. The same seed and inputs always
  give the same trace. The engine never reads the wall clock or `Math.random`.
- **Everything is recorded.** Each frame sent, received or dropped and each table change is appended to
  `sim.trace` as plain data. The renderer and the timeline will be built on this log.
- **Packets are immutable objects**, not byte buffers, so the inspector can show them as they are. A router
  copies a packet to lower its TTL.
- **Protocols behave like the real ones.** ARP follows RFC 826, including trusting whoever spoke last, which
  is what makes ARP spoofing possible later without special-casing it.

### Layout

| File | Contents |
| --- | --- |
| `sim.ts` | Event queue, clock, trace, cabling |
| `addr.ts` | MAC, IPv4 and CIDR helpers |
| `packets.ts` | Ethernet, ARP, IPv4 and ICMP shapes |
| `link.ts` | Interfaces and cables, with latency, loss and link failure |
| `switch.ts` | Learning switch with address aging |
| `arp.ts` | Per-interface ARP cache |
| `ipnode.ts` | The IP layer shared by hosts and routers: routing table, ARP resolution, ICMP, forwarding |
| `host.ts`, `router.ts` | The two kinds of IP device |
| `trace.ts` | Trace event types and one-line descriptions |

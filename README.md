# Handshake

A playable internet in the browser. Watch packets cross a network of hosts, switches and routers, open any of
them up, and break things to see what happens. Everything is simulated: no real traffic ever leaves the page.

![Scrubbed back to the middle of a TCP handshake: the SYN-ACK is on its way to the laptop, the same frame is open in the inspector, and the rest of the recording is faded on the timeline](docs/demo.png)

## Status

The simulation engine covers Ethernet, switching, ARP, IPv4 routing, ICMP, UDP, DNS and TCP. On top of it
is an animated map of one built-in network, with an inspector for devices, cables and frames and a timeline
you can drag to go back to any earlier moment. You cannot yet build your own network.

| Step | What | State |
| --- | --- | --- |
| 1 | Simulation engine: Ethernet, switch, ARP, IPv4, ICMP | Done |
| 1 | Simulation engine: UDP, DNS | Done |
| 1 | Simulation engine: TCP | Done |
| 2 | Canvas renderer and packet inspector | Done |
| 3 | Timeline recording and scrubbing | Done |
| 4 | Attack and defence modules | Next |
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

## The interface

`npm run dev` opens a toy internet: an office with a laptop and a DNS resolver, and a data centre with a web
server and three name servers, joined by two routers.

- **The map.** Cables are ink lines, devices are simple glyphs (circle for a host, rounded box for a switch,
  diamond for a router), and each frame is a token coloured by protocol. Tokens keep to the right of their
  cable so the two directions never cross. A frame delivered to the wrong host fades to an outline; a lost
  frame ends in a red cross. TCP connections are drawn as arcs over the map, labelled with the state of each
  end.
- **The inspector.** Click a device to see its interfaces, routes, ARP cache, TCP connections, and (where it
  has them) resolver cache or DNS zones, all updating live. Click a cable to cut it, delay it or make it lose
  frames. Click a token or a log line to open the frame layer by layer.
- **The wire log.** One line per frame sent, plus drops, cache changes and TCP state changes. "Every step"
  adds receipts and forwarding decisions.
- **The timeline.** Everything that has happened is laid out left to right like a score: one lane per
  protocol and a bar for each frame, with rings where you did something, flags where an application reported
  back, and red crosses where something was lost. Silences are squeezed to a fixed width and labelled with
  how long they lasted. Drag anywhere on it to go to that moment: the map, the log and every table in the
  inspector show the network exactly as it was. Press play to watch it happen again, or do something
  different, which discards the old future and starts a new one.
- **Playback.** Play, pause (space), step forwards or backwards one event at a time (arrow keys), jump to
  the latest moment, and four speeds. Stretches where nothing happens are skipped unless you turn that off.
- **Doing things.** The buttons under the map run a lookup, a ping, a page fetch and a connection to a closed
  port from the laptop. Any host's inspector has a small console that does the same for a name or address
  you type.

The interface is plain TypeScript with a canvas for the map and DOM for the panels. It is split so that the
part that decides what to draw can be tested without a browser:

| File | Contents |
| --- | --- |
| `scenario.ts` | The built-in network and the actions a person at a host can take |
| `model.ts` | Turns the engine's trace into things to draw: frames in flight, connection arcs, brief effects |
| `session.ts` | Runs the simulation in step with the screen, records everything, and goes back in time |
| `axis.ts` | Maps simulated time to a position on the timeline, squeezing silences |
| `timeline.ts` | Draws the timeline strip and handles scrubbing |
| `scene.ts` | Draws the map on a canvas and handles clicks and drags |
| `inspector.ts` | The side panel |
| `log.ts` | The wire log |
| `protocol.ts`, `theme.ts`, `dom.ts` | Frame labels, colours and fonts, a small DOM helper |

### How going back works

Nothing is ever undone. The engine is deterministic, so the session records only what you did and when
(each click on an action, each change to a cable). To show an earlier moment it builds the network again
from scratch, applies those inputs at the same simulated times, and runs to the moment asked for. A test
checks that the rebuilt network's trace matches the original recording exactly, event for event.

This costs one re-run of history per jump backwards. For the built-in scenario that is a few milliseconds;
a very long session would need periodic checkpoints, which are not implemented.

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

### DNS

Name lookups work the way they do on the real internet. A host asks its recursive resolver; the resolver
starts at a root server and follows referrals down to the server that holds the answer, caching what it
learns for as long as each record allows.

```ts
import { DnsResolver, DnsServer, aRecord, nsRecord } from './src/engine';

new DnsServer(rootHost, [
  { origin: '', records: [nsRecord('com', 'a.gtld-servers.com'), aRecord('a.gtld-servers.com', '10.0.2.3')] },
]);
new DnsServer(tldHost, [
  { origin: 'com', records: [nsRecord('example.com', 'ns1.example.com'), aRecord('ns1.example.com', '10.0.2.4')] },
]);
new DnsServer(ns1Host, [{ origin: 'example.com', records: [aRecord('www.example.com', '10.0.2.10')] }]);
new DnsResolver(resolverHost, { rootServers: ['10.0.2.2'] });

const laptop = new Host(sim, 'laptop', { address: '10.0.1.10/24', gateway: '10.0.1.1', dnsServers: ['10.0.1.53'] });
laptop.lookup('www.example.com', (result) => console.log(result)); // { status: 'ok', addresses: [...] }
```

The resolver already has the defences that DNS poisoning has to get past: a random source port and
transaction id for every query, a check that each response matches the question asked, and a refusal to
believe a server about names outside the zone it was asked about. Each rejected response is recorded in the
trace as a `dns-reject` event.

Not modelled: record types other than A, NS and CNAME, SOA-driven negative caching (a fixed 60 seconds is
used), truncation and TCP fallback, and DNSSEC.

### TCP

```ts
server.tcp.listen(80, (connection) => {
  connection.onData = (request) => {
    connection.send('HTTP/1.0 200 OK\r\n\r\nhello');
    connection.end();
  };
});

const connection = laptop.tcp.connect('10.0.2.10', 80);
connection.onOpen = () => connection.send('GET / HTTP/1.0\r\n\r\n');
connection.onData = (data) => console.log(data);
connection.onClose = (reason) => console.log(reason); // 'closed', 'reset', 'refused', 'timeout', ...
```

What is modelled:

- The full connection state machine, from the three-way handshake through to both ways of closing, including
  one side finishing while the other keeps sending and both sides closing at once.
- Reliable, ordered delivery: segmentation, cumulative acknowledgements, reassembly of out-of-order segments,
  retransmission on timeout with exponential backoff, and fast retransmit after three repeated
  acknowledgements. The timeout adapts to measured round-trip times (RFC 6298).
- Congestion control: slow start, congestion avoidance, and the window cuts that follow a loss.
- Resets: a closed port answers with one, `abort()` sends one, and an incoming reset is honoured only if its
  sequence number falls inside the receive window.
- A limit on half-open connections per listening port. When it is full, further SYNs are dropped, which is
  the condition a SYN flood creates.
- Random initial sequence numbers and source ports.

Every state change, retransmission and rejected segment is recorded in the trace.

Not modelled: TCP options (window scaling, selective acknowledgement, timestamps, MSS negotiation), delayed
acknowledgements, Nagle's algorithm, zero-window probing, keep-alive, simultaneous open, urgent data and SYN
cookies. Payloads are text, one character per byte.

### Design rules

- **Deterministic.** Time is a counter of simulated microseconds, events at the same instant run in the order
  they were scheduled, and all randomness comes from generators derived from one seed. The same seed and
  inputs always give the same trace. The engine never reads the wall clock or `Math.random`.
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
| `packets.ts` | Ethernet, ARP, IPv4, ICMP, UDP and TCP shapes |
| `link.ts` | Interfaces and cables, with latency, loss and link failure |
| `switch.ts` | Learning switch with address aging |
| `arp.ts` | Per-interface ARP cache |
| `ipnode.ts` | The IP layer shared by hosts and routers: routing table, ARP resolution, ICMP, forwarding |
| `udp.ts` | UDP sockets: bound and ephemeral ports, delivery, errors reported back by the network |
| `tcp.ts` | TCP listeners and connections |
| `dns.ts` | DNS messages, records and name helpers |
| `dns-server.ts` | Authoritative server: answers, referrals, aliases |
| `dns-resolver.ts` | Caching recursive resolver |
| `dns-client.ts` | The stub resolver on every host |
| `host.ts`, `router.ts` | The two kinds of IP device |
| `trace.ts` | Trace event types and one-line descriptions |

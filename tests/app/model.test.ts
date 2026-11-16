import { describe, expect, it } from 'vitest';
import { Model, endOf, phaseOf } from '../../src/app/model';
import { formatClock, formatDuration, tagOf } from '../../src/app/protocol';
import { MS, SECOND, type EthernetFrame, type Simulation } from '../../src/engine';
import { internetwork, lan, ofKind, ping } from '../engine/helpers';

/** Feeds a model everything in a finished simulation's trace. */
function replay(sim: Simulation, nowMs = 0): Model {
  const model = new Model(sim);
  for (const event of sim.trace) model.ingest(event, nowMs);
  return model;
}

const tcp = (frame: EthernetFrame) =>
  frame.etherType === 'ipv4' && frame.payload.protocol === 'tcp' ? frame.payload.payload : undefined;

describe('Model: frames in flight', () => {
  it('makes one flight per frame sent, between the right devices', () => {
    const { sim, a } = lan();
    ping(a, '10.0.0.2');
    sim.runUntilIdle();
    const model = replay(sim);

    expect(model.flights).toHaveLength(ofKind(sim, 'frame-tx').length);
    const first = model.flights[0]!;
    expect(first).toMatchObject({ from: 'a', to: 'sw1', t0: 0, t1: MS, fate: 'arrive' });
    expect(first.tag).toEqual({ family: 'arp', label: 'ARP ?' });
  });

  it('marks a flooded copy that reaches the wrong host as ignored', () => {
    const { sim, a } = lan();
    ping(a, '10.0.0.2');
    sim.runUntilIdle();
    const model = replay(sim);
    // The ARP request is a broadcast, so every host accepts it. The echo request
    // is addressed to b, and by then the switch knows where b is.
    expect(model.flights.filter((f) => f.fate === 'ignored')).toEqual([]);

    const { sim: sim2, a: a2, b: b2 } = lan();
    a2.nic.send({ src: a2.nic.mac, dst: b2.nic.mac, etherType: 'arp', payload: { op: 'reply', senderMac: a2.nic.mac, senderIp: 1, targetMac: b2.nic.mac, targetIp: 2 } });
    sim2.runUntilIdle();
    const flooded = replay(sim2).flights.filter((f) => f.from === 'sw1');
    expect(flooded.map((f) => [f.to, f.fate]).sort()).toEqual([
      ['b', 'arrive'],
      ['c', 'ignored'],
    ]);
  });

  it('marks a frame lost on a bad cable, stopping it halfway', () => {
    const net = internetwork();
    ping(net.a, '10.0.2.10');
    net.sim.runUntilIdle();
    const mark = net.sim.trace.length;
    let dropped = false;
    net.backbone.filter = () => dropped || !(dropped = true);
    ping(net.a, '10.0.2.10', { timeoutUs: 20 * MS });
    net.sim.runUntilIdle();

    const model = new Model(net.sim);
    for (const event of net.sim.trace.slice(mark)) model.ingest(event, 0);
    const lost = model.flights.filter((f) => f.fate === 'lost');
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ from: 'r1', to: 'r2' });
    expect(endOf(lost[0]!)).toBe(lost[0]!.t0 + MS / 2);
  });

  it('marks a frame cut off when its cable goes down under it', () => {
    const net = internetwork();
    ping(net.a, '10.0.2.10');
    net.sim.runUntilIdle();
    const mark = net.sim.trace.length;
    const start = net.sim.now;
    ping(net.a, '10.0.2.10', { timeoutUs: 20 * MS });
    net.sim.runUntil(start + 3 * MS + 500);
    net.edge.up = false;
    net.sim.runUntilIdle();

    const model = new Model(net.sim);
    for (const event of net.sim.trace.slice(mark)) model.ingest(event, 0);
    expect(model.flights.filter((f) => f.fate === 'cut').map((f) => [f.from, f.to])).toEqual([['r2', 'b']]);
  });

  it('numbers frames that leave one interface together, so they can be drawn apart', () => {
    const net = internetwork({ tcp: { mss: 100 } });
    net.b.tcp.listen(80, () => {});
    const connection = net.a.tcp.connect(net.b.address, 80);
    connection.onOpen = () => connection.send('x'.repeat(300));
    net.sim.runUntilIdle();
    const burst = replay(net.sim).flights.filter((f) => f.from === 'a' && (tcp(f.frame)?.data.length ?? 0) > 0);
    expect(burst.map((f) => f.slot)).toEqual([1, 2, 3]); // slot 0 is the ACK that went first
  });

  it('counts as busy until every flight has landed, then lets finished effects expire', () => {
    const { sim, a } = lan();
    const model = new Model(sim);
    ping(a, '10.0.0.2');
    for (const event of sim.trace) model.ingest(event, 0);
    expect(model.busy()).toBe(true);
    model.prune(MS / 2, 100);
    expect(model.busy()).toBe(true);
    model.prune(MS, 200);
    expect(model.busy()).toBe(false);
    expect(model.flights).toHaveLength(1); // still fading out
    model.prune(MS, 900);
    expect(model.flights).toEqual([]);
  });
});

describe('Model: connections', () => {
  it('follows a connection from opening to closing', () => {
    const net = internetwork();
    net.b.tcp.listen(80, (c) => (c.onEnd = () => c.end()));
    const connection = net.a.tcp.connect(net.b.address, 80);
    const model = new Model(net.sim);
    const phases: string[] = [];
    let cursor = 0;
    const feed = () => {
      while (cursor < net.sim.trace.length) {
        model.ingest(net.sim.trace[cursor++]!, 0);
        const arc = [...model.arcs.values()][0];
        if (arc && phases.at(-1) !== phaseOf(arc)) phases.push(phaseOf(arc));
      }
    };
    feed();
    net.sim.runUntil(50 * MS); // long enough for the server to see the final ACK too
    feed();
    expect(connection.state).toBe('ESTABLISHED');
    connection.end();
    net.sim.runUntil(net.sim.now + SECOND);
    feed();

    expect(phases).toEqual(['connecting', 'open', 'closing', 'closed']);
    const arc = [...model.arcs.values()][0]!;
    expect([arc.a, arc.b]).toEqual(['a', 'b']);
    expect(arc.reason).toBeNull();
    expect(arc.closedAtMs).toBe(0);
    model.prune(net.sim.now, 5000);
    expect(model.arcs.size).toBe(0);
  });

  it('records why a connection failed', () => {
    const net = internetwork();
    net.a.tcp.connect(net.b.address, 81);
    net.sim.runUntilIdle();
    const arc = [...replay(net.sim).arcs.values()][0]!;
    expect(phaseOf(arc)).toBe('closed');
    expect(arc.reason).toBe('refused');
  });

  it('draws nothing for a connection whose other end is not on the map', () => {
    const { sim, b, c } = lan();
    b.tcp.listen(80, () => {});
    c.nic.send({
      src: c.nic.mac,
      dst: b.nic.mac,
      etherType: 'ipv4',
      payload: { src: 0x0a0000c8, dst: b.address, ttl: 64, id: 1, protocol: 'tcp', payload: { srcPort: 4000, dstPort: 80, seq: 1, ackNo: 0, syn: true, ack: false, fin: false, rst: false, window: 100, data: '' } },
    });
    sim.runUntil(10 * MS);
    expect(replay(sim).arcs.size).toBe(0);
  });
});

describe('Model: captions', () => {
  it('says in plain words why a packet was dropped', () => {
    const net = internetwork();
    ping(net.a, '172.16.0.1');
    net.sim.runUntilIdle();
    const captions = replay(net.sim).captions;
    expect(captions.map((c) => [c.device, c.text, c.tone])).toContainEqual(['r1', 'no route', 'drop']);
  });
});

describe('Labels', () => {
  it('tags frames by what they are', () => {
    const { sim, a } = lan();
    ping(a, '10.0.0.2');
    sim.runUntilIdle();
    const labels = ofKind(sim, 'frame-tx').filter((e) => e.device !== 'sw1').map((e) => tagOf(e.frame).label);
    expect(labels).toEqual(['ARP ?', 'ARP ✓', 'PING', 'PONG']);
  });

  it('formats times', () => {
    expect(formatClock(56_000)).toBe('0.056 s');
    expect(formatDuration(4_000)).toBe('4.0 ms');
    expect(formatDuration(1_500_000)).toBe('1.5 s');
    expect(formatDuration(59_900_000)).toBe('60 s');
  });
});

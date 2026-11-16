import { describe, expect, it } from 'vitest';
import { BROADCAST_MAC, MS, SECOND, ZERO_MAC, ip } from '../../src/engine';
import { lan, ofKind, ping } from './helpers';

describe('ARP and ping on one LAN', () => {
  it('resolves the neighbour, then delivers the echo and its reply', () => {
    const { sim, a, b } = lan();
    const results = ping(a, '10.0.0.2');
    sim.runUntilIdle();

    expect(results).toEqual([{ status: 'reply', from: ip('10.0.0.2'), rttUs: 8 * MS, ttl: 64 }]);

    const frames = ofKind(sim, 'frame-tx').filter((e) => e.device === 'a' || e.device === 'b');
    expect(frames.map((e) => [e.device, e.frame.etherType, e.frame.dst])).toEqual([
      ['a', 'arp', BROADCAST_MAC],
      ['b', 'arp', a.nic.mac],
      ['a', 'ipv4', b.nic.mac],
      ['b', 'ipv4', a.nic.mac],
    ]);
  });

  it('fills both caches from a single exchange', () => {
    const { sim, a, b, c } = lan();
    ping(a, '10.0.0.2');
    sim.runUntilIdle();

    const iface = (host: typeof a) => host.interfaces[0]!;
    expect(iface(a).arp.lookup(b.address, sim.now)).toBe(b.nic.mac);
    expect(iface(b).arp.lookup(a.address, sim.now)).toBe(a.nic.mac);
    // c heard the broadcast request but was not its target, so it learned nothing.
    expect(iface(c).arp.snapshot(sim.now)).toEqual([]);
  });

  it('does not ask again while the entry is fresh', () => {
    const { sim, a } = lan();
    ping(a, '10.0.0.2');
    sim.runUntilIdle();
    const arpFrames = () => ofKind(sim, 'frame-tx').filter((e) => e.frame.etherType === 'arp').length;
    const before = arpFrames();

    const results = ping(a, '10.0.0.2');
    sim.runUntilIdle();
    expect(results[0]).toMatchObject({ status: 'reply', rttUs: 4 * MS });
    expect(arpFrames()).toBe(before);
  });

  it('asks again once the entry has expired', () => {
    const { sim, a } = lan();
    ping(a, '10.0.0.2');
    sim.runUntilIdle();
    sim.runUntil(sim.now + 61 * SECOND);

    const before = sim.trace.length;
    const results = ping(a, '10.0.0.2');
    sim.runUntilIdle();
    expect(results[0]).toMatchObject({ status: 'reply' });
    const requests = sim.trace
      .slice(before)
      .filter((e) => e.kind === 'frame-tx' && e.device === 'a' && e.frame.etherType === 'arp');
    expect(requests).toHaveLength(1);
  });

  it('sends well-formed requests and replies', () => {
    const { sim, a, b } = lan();
    ping(a, '10.0.0.2');
    sim.runUntilIdle();
    const [request, reply] = ofKind(sim, 'frame-tx')
      .filter((e) => (e.device === 'a' || e.device === 'b') && e.frame.etherType === 'arp')
      .map((e) => e.frame.payload);
    expect(request).toEqual({
      op: 'request',
      senderMac: a.nic.mac,
      senderIp: a.address,
      targetMac: ZERO_MAC,
      targetIp: b.address,
    });
    expect(reply).toEqual({
      op: 'reply',
      senderMac: b.nic.mac,
      senderIp: b.address,
      targetMac: a.nic.mac,
      targetIp: a.address,
    });
  });

  it('retries three times, then reports the host unreachable', () => {
    const { sim, a } = lan();
    const results = ping(a, '10.0.0.99');
    sim.runUntilIdle();

    const requests = ofKind(sim, 'frame-tx').filter((e) => e.device === 'a' && e.frame.etherType === 'arp');
    expect(requests.map((e) => e.t)).toEqual([0, SECOND, 2 * SECOND]);
    expect(results).toEqual([{ status: 'unreachable', from: a.address, code: 'host' }]);
    expect(ofKind(sim, 'ip-drop').map((e) => e.reason)).toEqual(['arp-timeout']);
  });

  it('queues packets behind one resolution and sends them in order', () => {
    const { sim, a } = lan();
    const first = ping(a, '10.0.0.2');
    const second = ping(a, '10.0.0.2');
    sim.runUntilIdle();

    expect(first[0]).toMatchObject({ status: 'reply' });
    expect(second[0]).toMatchObject({ status: 'reply' });
    const fromA = ofKind(sim, 'frame-tx').filter((e) => e.device === 'a');
    expect(fromA.filter((e) => e.frame.etherType === 'arp')).toHaveLength(1);
    const seqs = fromA.flatMap((e) =>
      e.frame.etherType === 'ipv4' && e.frame.payload.protocol === 'icmp' && e.frame.payload.payload.type === 'echo-request'
        ? [e.frame.payload.payload.seq]
        : [],
    );
    expect(seqs).toEqual([1, 2]);
  });

  it('overwrites a cached entry when a later ARP claims the same address', () => {
    // RFC 826 trusts whoever spoke last. This is the behaviour ARP spoofing relies on.
    const { sim, a, b, c } = lan();
    ping(a, '10.0.0.2');
    sim.runUntilIdle();

    c.nic.send({
      src: c.nic.mac,
      dst: a.nic.mac,
      etherType: 'arp',
      payload: { op: 'reply', senderMac: c.nic.mac, senderIp: b.address, targetMac: a.nic.mac, targetIp: a.address },
    });
    sim.runUntilIdle();

    expect(a.interfaces[0]!.arp.lookup(b.address, sim.now)).toBe(c.nic.mac);
    const changes = ofKind(sim, 'arp-cache').filter((e) => e.device === 'a');
    expect(changes.map((e) => e.change)).toEqual(['add', 'update']);
  });

  it('answers a ping to its own address without using the wire', () => {
    const { sim, a } = lan();
    const results = ping(a, '10.0.0.1');
    sim.runUntilIdle();
    expect(results).toEqual([{ status: 'reply', from: a.address, rttUs: 0, ttl: 64 }]);
    expect(ofKind(sim, 'frame-tx')).toEqual([]);
  });

  it('stays silent when pinged at the subnet broadcast address', () => {
    const { sim, a } = lan();
    const results = ping(a, '10.0.0.255', { timeoutUs: SECOND });
    sim.runUntilIdle();
    expect(results).toEqual([{ status: 'timeout' }]);
    expect(ofKind(sim, 'ip-deliver').map((e) => e.device).sort()).toEqual(['b', 'c']);
  });

  it('fails at once when there is no route to the destination', () => {
    const { sim, a } = lan();
    const results = ping(a, '8.8.8.8');
    expect(results).toEqual([]); // never synchronously
    sim.runUntilIdle();
    expect(results).toEqual([{ status: 'unreachable', from: a.address, code: 'net' }]);
    expect(sim.now).toBe(0);
  });
});

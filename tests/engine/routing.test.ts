import { describe, expect, it } from 'vitest';
import { Host, MS, Router, SECOND, Simulation, ip } from '../../src/engine';
import { internetwork, ofKind, ping } from './helpers';

describe('Routing between subnets', () => {
  it('carries a ping across two routers and back', () => {
    const { sim, a } = internetwork();
    const results = ping(a, '10.0.2.10');
    sim.runUntilIdle();
    // Two routers each lower the TTL of the reply once.
    expect(results).toEqual([{ status: 'reply', from: ip('10.0.2.10'), rttUs: 16 * MS, ttl: 62 }]);
  });

  it('is faster the second time, once every hop has resolved its neighbour', () => {
    const { sim, a } = internetwork();
    ping(a, '10.0.2.10');
    sim.runUntilIdle();
    const results = ping(a, '10.0.2.10');
    sim.runUntilIdle();
    expect(results[0]).toMatchObject({ status: 'reply', rttUs: 8 * MS });
  });

  it('rewrites the frame addresses at each hop but keeps the IP addresses end to end', () => {
    const { sim, a, b, r1, r2 } = internetwork();
    ping(a, '10.0.2.10');
    sim.runUntilIdle();

    const requestHops = ofKind(sim, 'frame-tx').filter(
      (e) =>
        e.frame.etherType === 'ipv4' &&
        e.frame.payload.protocol === 'icmp' &&
        e.frame.payload.payload.type === 'echo-request' &&
        e.device !== 'sw1',
    );
    expect(requestHops.map((e) => e.device)).toEqual(['a', 'r1', 'r2']);
    expect(requestHops.map((e) => [e.frame.src, e.frame.dst])).toEqual([
      [a.nic.mac, r1.nics[0]!.mac],
      [r1.nics[1]!.mac, r2.nics[0]!.mac],
      [r2.nics[1]!.mac, b.nic.mac],
    ]);
    for (const hop of requestHops) {
      if (hop.frame.etherType !== 'ipv4') throw new Error('unreachable');
      expect(hop.frame.payload.src).toBe(a.address);
      expect(hop.frame.payload.dst).toBe(b.address);
    }
    expect(requestHops.map((e) => (e.frame.etherType === 'ipv4' ? e.frame.payload.ttl : null))).toEqual([64, 63, 62]);
  });

  it('reports each hop in turn as the TTL grows, which is how traceroute works', () => {
    const { sim, a } = internetwork();
    const hops = [1, 2, 3].map((ttl) => ping(a, '10.0.2.10', { ttl }));
    sim.runUntilIdle();
    expect(hops.map((h) => h[0])).toEqual([
      { status: 'ttl-exceeded', from: ip('10.0.1.1') },
      { status: 'ttl-exceeded', from: ip('10.0.12.2') },
      { status: 'reply', from: ip('10.0.2.10'), rttUs: expect.any(Number), ttl: 62 },
    ]);
  });

  it('reports the network unreachable when a router has no route', () => {
    const { sim, a } = internetwork();
    const results = ping(a, '172.16.0.1');
    sim.runUntilIdle();
    expect(results).toEqual([{ status: 'unreachable', from: ip('10.0.1.1'), code: 'net' }]);
    expect(ofKind(sim, 'ip-drop').map((e) => [e.device, e.reason])).toEqual([['r1', 'no-route']]);
  });

  it('reports the host unreachable when the last router cannot resolve it', () => {
    const { sim, a } = internetwork();
    const results = ping(a, '10.0.2.99', { timeoutUs: 10 * SECOND });
    sim.runUntilIdle();
    expect(results).toEqual([{ status: 'unreachable', from: ip('10.0.12.2'), code: 'host' }]);
  });

  it('reports the host unreachable from the router whose onward link is down', () => {
    const { sim, a, backbone } = internetwork();
    backbone.up = false;
    const results = ping(a, '10.0.2.10');
    sim.runUntilIdle();
    // r1 cannot resolve r2 over the dead link, so it gives up after three ARP attempts.
    expect(results).toEqual([{ status: 'unreachable', from: ip('10.0.1.1'), code: 'host' }]);
    const dead = ofKind(sim, 'frame-drop').filter((e) => e.device === 'r1' && e.reason === 'no-carrier');
    expect(dead).toHaveLength(3);
  });

  it('times out when the network gives no answer before the deadline', () => {
    const { sim, a, backbone } = internetwork();
    backbone.up = false;
    const results = ping(a, '10.0.2.10', { timeoutUs: SECOND });
    sim.runUntilIdle();
    expect(results).toEqual([{ status: 'timeout' }]);
  });

  it('drops a frame that was in flight when its link went down', () => {
    const { sim, a, edge } = internetwork();
    ping(a, '10.0.2.10'); // warm every cache
    sim.runUntilIdle();

    const start = sim.now;
    const results = ping(a, '10.0.2.10');
    // The request leaves r2 for b at +3 ms and would land at +4 ms.
    sim.runUntil(start + 3 * MS + 500);
    edge.up = false;
    sim.runUntilIdle();

    expect(results).toEqual([{ status: 'timeout' }]);
    expect(ofKind(sim, 'frame-drop').filter((e) => e.reason === 'link-down')).toHaveLength(1);
  });

  it('prefers the most specific route', () => {
    const sim = new Simulation();
    const r = new Router(sim, 'r');
    const wide = new Host(sim, 'wide', { address: '10.0.0.2/30' });
    const narrow = new Host(sim, 'narrow', { address: '10.0.0.6/30' });
    sim.connect(r.addInterface('10.0.0.1/30'), wide.nic);
    sim.connect(r.addInterface('10.0.0.5/30'), narrow.nic);
    r.addRoute('0.0.0.0/0', '10.0.0.2');
    r.addRoute('192.168.0.0/16', '10.0.0.2');
    r.addRoute('192.168.5.0/24', '10.0.0.6');

    expect(r.lookupRoute(ip('192.168.5.9'))?.gateway).toBe(ip('10.0.0.6'));
    expect(r.lookupRoute(ip('192.168.6.9'))?.gateway).toBe(ip('10.0.0.2'));
    expect(r.lookupRoute(ip('8.8.8.8'))?.dest.prefix).toBe(0);
    expect(r.lookupRoute(ip('10.0.0.6'))?.gateway).toBeNull();
  });

  it('does not forward on a host', () => {
    const { sim, a, b } = internetwork();
    // Hand b a packet addressed to someone else, as if it had been misdelivered.
    b.onFrame(b.nic, {
      src: a.nic.mac,
      dst: b.nic.mac,
      etherType: 'ipv4',
      payload: {
        src: a.address,
        dst: ip('10.0.1.77'),
        ttl: 64,
        id: 1,
        protocol: 'icmp',
        payload: { type: 'echo-request', id: 1, seq: 1 },
      },
    });
    sim.runUntilIdle();
    expect(ofKind(sim, 'ip-drop').map((e) => [e.device, e.reason])).toEqual([['b', 'not-for-me']]);
    expect(ofKind(sim, 'frame-tx')).toEqual([]);
  });

  it('never answers an ICMP error with another error', () => {
    const { sim, a, r1 } = internetwork();
    // An error message arrives at r1 for a network it has no route to.
    r1.onFrame(r1.nics[0]!, {
      src: a.nic.mac,
      dst: r1.nics[0]!.mac,
      etherType: 'ipv4',
      payload: {
        src: a.address,
        dst: ip('172.16.0.1'),
        ttl: 64,
        id: 9,
        protocol: 'icmp',
        payload: {
          type: 'time-exceeded',
          original: {
            src: ip('172.16.0.1'),
            dst: a.address,
            ttl: 1,
            id: 8,
            protocol: 'icmp',
            payload: { type: 'echo-request', id: 1, seq: 1 },
          },
        },
      },
    });
    sim.runUntilIdle();
    expect(ofKind(sim, 'ip-drop').map((e) => e.reason)).toEqual(['no-route']);
    expect(ofKind(sim, 'frame-tx')).toEqual([]);
  });

  it('rejects configuration mistakes', () => {
    const sim = new Simulation();
    const r = new Router(sim, 'r');
    const nic = r.addInterface('10.0.0.1/24');
    expect(() => r.addRoute('0.0.0.0/0', '192.168.1.1')).toThrow(/same subnet/);
    expect(() => r.configureInterface(nic, '10.0.9.1/24')).toThrow(/already has an address/);
    expect(() => new Router(sim, 'r')).toThrow(/Duplicate device id/);
    const other = new Router(sim, 'other').addInterface('10.0.0.2/24');
    sim.connect(nic, other);
    expect(() => sim.connect(nic, other)).toThrow(/already connected/);
  });
});

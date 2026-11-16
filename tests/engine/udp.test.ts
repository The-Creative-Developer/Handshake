import { describe, expect, it } from 'vitest';
import { MS, ip, type UdpError, type UdpMessage } from '../../src/engine';
import { internetwork, lan, ofKind } from './helpers';

const text = (value: string) => ({ kind: 'raw', text: value }) as const;

describe('UDP', () => {
  it('carries a datagram across routers and the reply back', () => {
    const { sim, a, b } = internetwork();
    const server = b.udp.bind(7);
    server.onMessage = (m) => server.send(m.from, m.fromPort, m.data);

    const client = a.udp.bind();
    const received: UdpMessage[] = [];
    client.onMessage = (m) => received.push(m);
    client.send('10.0.2.10', 7, text('hello'));
    sim.runUntilIdle();

    expect(received).toEqual([{ from: ip('10.0.2.10'), fromPort: 7, to: a.address, data: text('hello') }]);
  });

  it('tells the sender when nothing is listening on the port', () => {
    const { sim, a, b } = internetwork();
    const client = a.udp.bind();
    const errors: UdpError[] = [];
    client.onError = (e) => errors.push(e);
    client.send('10.0.2.10', 9, text('anyone?'));
    sim.runUntilIdle();

    expect(errors).toEqual([{ to: b.address, toPort: 9, from: b.address, reason: 'port' }]);
    expect(ofKind(sim, 'ip-drop').map((e) => [e.device, e.reason])).toEqual([['b', 'port-closed']]);
  });

  it('passes on errors reported by routers along the way', () => {
    const { sim, a } = internetwork();
    const client = a.udp.bind();
    const errors: UdpError[] = [];
    client.onError = (e) => errors.push(e);
    client.send('172.16.0.1', 9, text('x')); // r1 has no route
    client.send('10.0.2.99', 9, text('x')); // r2 cannot find the host
    sim.runUntilIdle();

    expect(errors).toEqual([
      { to: ip('172.16.0.1'), toPort: 9, from: ip('10.0.1.1'), reason: 'net' },
      { to: ip('10.0.2.99'), toPort: 9, from: ip('10.0.12.2'), reason: 'host' },
    ]);
  });

  it('reports a missing route without sending anything, and never synchronously', () => {
    const { sim, a } = lan(); // no default gateway
    const client = a.udp.bind();
    const errors: UdpError[] = [];
    client.onError = (e) => errors.push(e);
    client.send('8.8.8.8', 53, text('x'));
    expect(errors).toEqual([]);
    sim.runUntilIdle();
    expect(errors).toEqual([{ to: ip('8.8.8.8'), toPort: 53, from: a.address, reason: 'net' }]);
    expect(ofKind(sim, 'frame-tx')).toEqual([]);
  });

  it('delivers a broadcast to every listener and stays quiet where nobody listens', () => {
    const { sim, a, b, c } = lan();
    const heard: string[] = [];
    b.udp.bind(5000).onMessage = () => heard.push('b');
    const sender = a.udp.bind();
    sender.onError = () => heard.push('error');
    sender.send('10.0.0.255', 5000, text('hi all'));
    sim.runUntilIdle();

    expect(heard).toEqual(['b']);
    // c dropped it, but a broadcast must never be answered with an ICMP error.
    expect(ofKind(sim, 'ip-drop').map((e) => [e.device, e.reason])).toEqual([[c.id, 'port-closed']]);
    expect(ofKind(sim, 'frame-tx').filter((e) => e.device === 'c')).toEqual([]);
  });

  it('replies from the address the request was sent to', () => {
    const { sim, a, r1 } = internetwork();
    const server = r1.udp.bind(7);
    server.onMessage = (m) => server.send(m.from, m.fromPort, m.data, { from: m.to });

    const client = a.udp.bind();
    const sources: number[] = [];
    client.onMessage = (m) => sources.push(m.from);
    // 10.0.12.1 is r1's far-side address; the reply still leaves by the near interface.
    client.send('10.0.12.1', 7, text('ping'));
    sim.runUntilIdle();
    expect(sources).toEqual([ip('10.0.12.1')]);
  });

  it('loops back a datagram sent to the node itself', () => {
    const { sim, a } = lan();
    const received: UdpMessage[] = [];
    a.udp.bind(4000).onMessage = (m) => received.push(m);
    a.udp.bind(4001).send('10.0.0.1', 4000, text('self'));
    sim.runUntilIdle();
    expect(received).toEqual([{ from: a.address, fromPort: 4001, to: a.address, data: text('self') }]);
    expect(ofKind(sim, 'frame-tx')).toEqual([]);
    expect(sim.now).toBe(0);
  });

  it('gives each unbound socket its own port from the ephemeral range', () => {
    const { a } = lan();
    const ports = Array.from({ length: 200 }, () => a.udp.bind().port);
    expect(new Set(ports).size).toBe(200);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(49152);
      expect(port).toBeLessThanOrEqual(65535);
    }
  });

  it('manages the life of a port', () => {
    const { sim, a, b } = lan();
    const first = a.udp.bind(6000);
    expect(() => a.udp.bind(6000)).toThrow(/in use/);
    expect(() => a.udp.bind(0)).toThrow(/Invalid UDP port/);
    expect(() => a.udp.bind(70000)).toThrow(/Invalid UDP port/);

    first.close();
    expect(() => first.send('10.0.0.2', 1, text('x'))).toThrow(/closed/);

    // A late error for a closed socket goes nowhere, and the port can be bound again.
    const again = a.udp.bind(6000);
    const errors: UdpError[] = [];
    again.onError = (e) => errors.push(e);
    again.send(b.address, 9, text('x'));
    sim.runUntil(sim.now + MS);
    again.close();
    sim.runUntilIdle();
    expect(errors).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { BROADCAST_MAC, SECOND, type EthernetFrame, type Mac } from '../../src/engine';
import { lan, ofKind } from './helpers';

/** A throwaway unicast frame; the switch only looks at the two MAC addresses. */
function frame(src: Mac, dst: Mac): EthernetFrame {
  return {
    src,
    dst,
    etherType: 'ipv4',
    payload: { src: 1, dst: 2, ttl: 64, id: 1, protocol: 'icmp', payload: { type: 'echo-request', id: 1, seq: 1 } },
  };
}

describe('Switch', () => {
  it('floods a frame for an unknown destination to every other port', () => {
    const { sim, a, b, c } = lan();
    a.nic.send(frame(a.nic.mac, b.nic.mac));
    sim.runUntilIdle();

    const received = ofKind(sim, 'frame-rx').filter((e) => e.device !== 'sw1');
    expect(received.map((e) => e.device)).toEqual(['b']);
    // c saw the flooded copy on the wire but its interface discarded it.
    const filtered = ofKind(sim, 'frame-drop').filter((e) => e.reason === 'mac-filter');
    expect(filtered.map((e) => e.device)).toEqual([c.id]);
  });

  it('learns source addresses and then forwards out of a single port', () => {
    const { sim, sw, a, b } = lan();
    a.nic.send(frame(a.nic.mac, b.nic.mac)); // teaches the switch where a is
    sim.runUntilIdle();
    expect(sw.portFor(a.nic.mac)?.name).toBe('p0');

    const before = sim.trace.length;
    b.nic.send(frame(b.nic.mac, a.nic.mac));
    sim.runUntilIdle();

    const later = sim.trace.slice(before);
    const switchSends = later.filter((e) => e.kind === 'frame-tx' && e.device === 'sw1');
    expect(switchSends).toHaveLength(1);
    expect(switchSends[0]).toMatchObject({ iface: 'p0' });
    expect(later.some((e) => e.kind === 'frame-drop')).toBe(false);
  });

  it('floods broadcasts to every other connected port, never back out of the ingress', () => {
    const { sim, a } = lan();
    a.nic.send(frame(a.nic.mac, BROADCAST_MAC));
    sim.runUntilIdle();
    const switchSends = ofKind(sim, 'frame-tx').filter((e) => e.device === 'sw1');
    expect(switchSends.map((e) => e.iface).sort()).toEqual(['p1', 'p2']);
  });

  it('records a learning event only when an address appears or moves', () => {
    const { sim, a, b } = lan();
    a.nic.send(frame(a.nic.mac, b.nic.mac));
    a.nic.send(frame(a.nic.mac, b.nic.mac));
    sim.runUntilIdle();
    expect(ofKind(sim, 'mac-learn')).toHaveLength(1);

    // The same address showing up on another port is how MAC spoofing looks to a switch.
    b.nic.send(frame(a.nic.mac, BROADCAST_MAC));
    sim.runUntilIdle();
    const learned = ofKind(sim, 'mac-learn');
    expect(learned).toHaveLength(2);
    expect(learned[1]).toMatchObject({ mac: a.nic.mac, port: 'p1' });
  });

  it('forgets addresses that have not been seen for the aging time', () => {
    const { sim, sw, a, b } = lan();
    a.nic.send(frame(a.nic.mac, b.nic.mac));
    sim.runUntilIdle();
    sim.runUntil(sim.now + sw.agingUs + SECOND);
    expect(sw.portFor(a.nic.mac)).toBeUndefined();
  });

  it('adds ports on demand', () => {
    const { sw } = lan();
    const used = sw.nics.filter((port) => port.link).length;
    expect(used).toBe(3);
    expect(sw.freePort().name).toBe('p3');
    sw.nics[3]!.link = sw.nics[0]!.link; // pretend the last port is taken
    expect(sw.freePort().name).toBe('p4');
  });
});

import { describe, expect, it } from 'vitest';
import { broadcastOf, cidr, formatCidr, formatIp, inCidr, interfaceAddress, ip, macFromIndex, maskOf } from '../../src/engine';

describe('IPv4 addresses', () => {
  it('round-trips through parse and format', () => {
    for (const text of ['0.0.0.0', '10.0.0.1', '192.168.1.254', '255.255.255.255']) {
      expect(formatIp(ip(text))).toBe(text);
    }
  });

  it('stays unsigned for addresses above 127.255.255.255', () => {
    expect(ip('192.168.0.1')).toBe(3232235521);
    expect(ip('255.255.255.255')).toBe(0xffffffff);
  });

  it('rejects malformed addresses', () => {
    for (const text of ['', '1.2.3', '1.2.3.4.5', '256.0.0.1', '1.2.3.x', '1..2.3', ' 1.2.3.4', '-1.2.3.4']) {
      expect(() => ip(text), text).toThrow();
    }
  });
});

describe('CIDR blocks', () => {
  it('computes masks at the edges', () => {
    expect(maskOf(0)).toBe(0);
    expect(maskOf(24)).toBe(0xffffff00);
    expect(maskOf(32)).toBe(0xffffffff);
  });

  it('clears host bits when parsing', () => {
    expect(formatCidr(cidr('10.1.2.3/16'))).toBe('10.1.0.0/16');
  });

  it('tests membership', () => {
    const lan = cidr('192.168.1.0/24');
    expect(inCidr(ip('192.168.1.77'), lan)).toBe(true);
    expect(inCidr(ip('192.168.2.1'), lan)).toBe(false);
    expect(inCidr(ip('8.8.8.8'), cidr('0.0.0.0/0'))).toBe(true);
    expect(inCidr(ip('10.0.0.1'), cidr('10.0.0.1/32'))).toBe(true);
    expect(inCidr(ip('10.0.0.2'), cidr('10.0.0.1/32'))).toBe(false);
  });

  it('finds the broadcast address', () => {
    expect(formatIp(broadcastOf(cidr('192.168.1.0/24')))).toBe('192.168.1.255');
    expect(formatIp(broadcastOf(cidr('10.0.12.0/30')))).toBe('10.0.12.3');
  });

  it('keeps the host address when parsing an interface address', () => {
    const parsed = interfaceAddress('10.0.0.5/24');
    expect(formatIp(parsed.address)).toBe('10.0.0.5');
    expect(formatCidr(parsed.subnet)).toBe('10.0.0.0/24');
  });

  it('rejects malformed blocks', () => {
    for (const text of ['10.0.0.0', '10.0.0.0/33', '10.0.0.0/', '10.0.0.0/8/8', '10.0.0/8']) {
      expect(() => cidr(text), text).toThrow();
    }
  });
});

describe('MAC allocation', () => {
  it('produces stable, distinct, locally administered addresses', () => {
    expect(macFromIndex(1)).toBe('02:00:00:00:00:01');
    expect(macFromIndex(0x1234)).toBe('02:00:00:00:12:34');
    expect(macFromIndex(1)).not.toBe(macFromIndex(2));
  });
});

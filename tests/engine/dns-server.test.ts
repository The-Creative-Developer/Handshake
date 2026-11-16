import { describe, expect, it } from 'vitest';
import {
  DnsServer,
  Host,
  Simulation,
  aRecord,
  ancestorsOf,
  cnameRecord,
  dnsQuery,
  isWithin,
  normalizeName,
  nsRecord,
  type DnsRecordType,
} from '../../src/engine';
import { dnsInternet } from './helpers';

const ask = (server: DnsServer, name: string, type: DnsRecordType = 'A') =>
  server.respond(dnsQuery(1, name, type, false));

describe('Domain names', () => {
  it('normalises case and the trailing dot', () => {
    expect(normalizeName('WWW.Example.COM.')).toBe('www.example.com');
    expect(normalizeName('.')).toBe('');
    expect(normalizeName('')).toBe('');
  });

  it('rejects malformed names', () => {
    for (const name of ['a..b', '.a', 'a b.com', 'exa$mple.com', `${'x'.repeat(64)}.com`]) {
      expect(() => normalizeName(name), name).toThrow();
    }
  });

  it('knows which names sit inside a zone', () => {
    expect(isWithin('www.example.com', 'example.com')).toBe(true);
    expect(isWithin('example.com', 'example.com')).toBe(true);
    expect(isWithin('badexample.com', 'example.com')).toBe(false);
    expect(isWithin('example.com', 'www.example.com')).toBe(false);
    expect(isWithin('anything.at.all', '')).toBe(true);
  });

  it('lists a name and its parents up to the root', () => {
    expect(ancestorsOf('a.b.example.com')).toEqual(['a.b.example.com', 'b.example.com', 'example.com', 'com', '']);
    expect(ancestorsOf('')).toEqual(['']);
  });
});

describe('Authoritative DNS server', () => {
  it('answers with authority for a name it holds', () => {
    const { servers } = dnsInternet();
    const reply = ask(servers.example, 'www.example.com');
    expect(reply).toMatchObject({ response: true, id: 1, rcode: 'NOERROR', authoritative: true });
    expect(reply.answers).toEqual([aRecord('www.example.com', '10.0.0.80')]);
  });

  it('returns every record in a set', () => {
    const { servers } = dnsInternet();
    expect(ask(servers.example, 'mail.example.com').answers).toHaveLength(2);
  });

  it('accepts any spelling of the name', () => {
    const { servers } = dnsInternet();
    expect(ask(servers.example, 'WWW.Example.COM.').answers).toHaveLength(1);
  });

  it('refers the asker onwards for a name it has delegated, with the servers’ addresses', () => {
    const { servers } = dnsInternet();
    const reply = ask(servers.tld, 'www.example.com');
    expect(reply).toMatchObject({ rcode: 'NOERROR', authoritative: false, answers: [] });
    expect(reply.authority).toEqual([nsRecord('example.com', 'ns1.example.com')]);
    expect(reply.additional).toEqual([aRecord('ns1.example.com', '10.0.0.3', 3600)]);
  });

  it('refers without addresses when the delegated servers live in a zone it does not hold', () => {
    const { servers } = dnsInternet();
    const reply = ask(servers.root, 'www.shop.com');
    expect(reply.authority.map((r) => r.name)).toEqual(['com']);
    const glueless = ask(servers.example, 'www.shop.com');
    expect(glueless.rcode).toBe('REFUSED');
  });

  it('does not answer as an authority for glue below a delegation', () => {
    const { servers } = dnsInternet();
    const reply = ask(servers.tld, 'ns1.example.com');
    expect(reply.authoritative).toBe(false);
    expect(reply.answers).toEqual([]);
    expect(reply.authority).toHaveLength(1);
  });

  it('refuses names outside its zones', () => {
    const { servers } = dnsInternet();
    expect(ask(servers.example, 'www.other.org')).toMatchObject({ rcode: 'REFUSED', authoritative: false });
  });

  it('says a name does not exist', () => {
    const { servers } = dnsInternet();
    expect(ask(servers.example, 'nope.example.com')).toMatchObject({ rcode: 'NXDOMAIN', authoritative: true });
  });

  it('distinguishes a missing record type from a missing name', () => {
    const { servers } = dnsInternet();
    // The zone top has NS records but no address.
    expect(ask(servers.example, 'example.com')).toMatchObject({ rcode: 'NOERROR', authoritative: true, answers: [] });
    // b.example.com has no records of its own, but a.b.example.com exists beneath it.
    expect(ask(servers.example, 'b.example.com')).toMatchObject({ rcode: 'NOERROR', answers: [] });
    expect(ask(servers.example, 'www.example.com', 'CNAME')).toMatchObject({ rcode: 'NOERROR', answers: [] });
  });

  it('follows an alias as far as its own zones reach', () => {
    const { servers } = dnsInternet();
    expect(ask(servers.example, 'web.example.com').answers).toEqual([
      cnameRecord('web.example.com', 'www.example.com'),
      aRecord('www.example.com', '10.0.0.80'),
    ]);
    // The target is in someone else's zone, so only the alias itself is returned.
    expect(ask(servers.example, 'store.example.com').answers).toEqual([
      cnameRecord('store.example.com', 'www.shop.com'),
    ]);
    expect(ask(servers.example, 'web.example.com', 'CNAME').answers).toEqual([
      cnameRecord('web.example.com', 'www.example.com'),
    ]);
  });

  it('survives an alias loop', () => {
    const sim = new Simulation();
    const server = new DnsServer(new Host(sim, 'ns', { address: '10.0.0.1/24' }), [
      { origin: 'loop.test', records: [cnameRecord('a.loop.test', 'b.loop.test'), cnameRecord('b.loop.test', 'a.loop.test')] },
    ]);
    const reply = ask(server, 'a.loop.test');
    expect(reply.rcode).toBe('NOERROR');
    expect(reply.answers.length).toBeLessThan(12);
  });

  it('lists its name servers with their addresses', () => {
    const { servers } = dnsInternet();
    const reply = ask(servers.example, 'example.com', 'NS');
    expect(reply.answers).toEqual([nsRecord('example.com', 'ns1.example.com')]);
    expect(reply.additional).toEqual([aRecord('ns1.example.com', '10.0.0.3', 3600)]);
  });

  it('picks the most specific zone when it serves a parent and a child', () => {
    const { servers } = dnsInternet();
    servers.tld.addZone('example.com', [aRecord('www.example.com', '10.9.9.9')]);
    expect(ask(servers.tld, 'www.example.com')).toMatchObject({
      authoritative: true,
      answers: [aRecord('www.example.com', '10.9.9.9')],
    });
  });

  it('rejects zone mistakes', () => {
    const { servers } = dnsInternet();
    expect(() => servers.example.addZone('example.com')).toThrow(/already served/);
    expect(() => servers.example.addZone('other.org', [aRecord('www.example.com', '10.0.0.1')])).toThrow(/not inside/);
    expect(() => servers.example.addRecord(aRecord('www.nowhere.org', '10.0.0.1'))).toThrow(/No zone/);
    servers.example.addRecord(aRecord('new.example.com', '10.0.0.7'));
    expect(ask(servers.example, 'new.example.com').answers).toHaveLength(1);
  });
});

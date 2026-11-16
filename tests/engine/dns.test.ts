import { describe, expect, it } from 'vitest';
import {
  DNS_PORT,
  DnsResolver,
  SECOND,
  aRecord,
  dnsQuery,
  dnsReply,
  ip,
  nsRecord,
  type DnsMessage,
  type Host,
  type LookupResult,
} from '../../src/engine';
import { dnsInternet, ofKind, queriesFrom } from './helpers';

const ROOT = ip('10.0.0.1');
const TLD = ip('10.0.0.2');
const EXAMPLE = ip('10.0.0.3');
const HOSTING = ip('10.0.0.4');
const RESOLVER = ip('10.0.0.53');

function lookup(host: Host, name: string): LookupResult[] {
  const results: LookupResult[] = [];
  host.lookup(name, (result) => results.push(result));
  return results;
}

/** Runs a server on `host` that answers every query with whatever `forge` returns. */
function rogueServer(host: Host, forge: (query: DnsMessage) => DnsMessage): void {
  const socket = host.udp.bind(DNS_PORT);
  socket.onMessage = (m) => {
    if (m.data.kind !== 'dns') return;
    socket.send(m.from, m.fromPort, { kind: 'dns', message: forge(m.data.message) });
  };
}

describe('DNS resolution', () => {
  it('walks from the root to the server that holds the answer', () => {
    const { sim, client } = dnsInternet();
    const results = lookup(client, 'www.example.com');
    sim.runUntilIdle();

    expect(results).toEqual([{ status: 'ok', addresses: [ip('10.0.0.80')], aliases: [], server: RESOLVER }]);
    expect(queriesFrom(sim, 'client')).toEqual([RESOLVER]);
    expect(queriesFrom(sim, 'resolver')).toEqual([ROOT, TLD, EXAMPLE]);
  });

  it('answers a repeat question from its cache, with the time left counting down', () => {
    const { sim, client, resolver } = dnsInternet();
    lookup(client, 'www.example.com');
    sim.runUntilIdle();
    sim.runUntil(sim.now + 100 * SECOND);

    const mark = sim.trace.length;
    const results = lookup(client, 'www.example.com');
    sim.runUntilIdle();
    expect(results[0]).toMatchObject({ status: 'ok', addresses: [ip('10.0.0.80')] });
    expect(queriesFrom(sim, 'resolver', mark)).toEqual([]);
    const ttl = resolver.cached('www.example.com', 'A')?.[0]?.ttl;
    expect(ttl).toBeGreaterThan(195);
    expect(ttl).toBeLessThanOrEqual(200);
  });

  it('goes straight to a zone’s own servers once it knows them', () => {
    const { sim, client } = dnsInternet();
    lookup(client, 'www.example.com');
    sim.runUntilIdle();
    const mark = sim.trace.length;
    const results = lookup(client, 'mail.example.com');
    sim.runUntilIdle();
    expect(results[0]).toMatchObject({ status: 'ok', addresses: [ip('10.0.0.25'), ip('10.0.0.26')] });
    expect(queriesFrom(sim, 'resolver', mark)).toEqual([EXAMPLE]);
  });

  it('asks again once a record’s lifetime has run out', () => {
    const { sim, client, resolver } = dnsInternet();
    lookup(client, 'www.example.com');
    sim.runUntilIdle();
    sim.runUntil(sim.now + 301 * SECOND);
    expect(resolver.cached('www.example.com', 'A')).toBeUndefined();

    const mark = sim.trace.length;
    const results = lookup(client, 'www.example.com');
    sim.runUntilIdle();
    expect(results[0]).toMatchObject({ status: 'ok' });
    // The delegation lives for an hour, so only the last hop is repeated.
    expect(queriesFrom(sim, 'resolver', mark)).toEqual([EXAMPLE]);
  });

  it('returns to the parent zone when a delegation outlives its servers’ addresses', () => {
    const { sim, client, servers } = dnsInternet();
    // short.com's only server is named inside short.com, and its address expires
    // long before the delegation does.
    servers.tld.addRecord(nsRecord('short.com', 'ns.short.com', 3600));
    servers.tld.addRecord(aRecord('ns.short.com', '10.0.0.4', 30));
    servers.hosting.addZone('short.com', [
      nsRecord('short.com', 'ns.short.com', 3600),
      aRecord('ns.short.com', '10.0.0.4', 30),
      aRecord('www.short.com', '10.0.0.82', 10),
    ]);
    lookup(client, 'www.short.com');
    sim.runUntilIdle();
    sim.runUntil(sim.now + 40 * SECOND);

    const mark = sim.trace.length;
    const results = lookup(client, 'www.short.com');
    sim.runUntilIdle();
    expect(results[0]).toMatchObject({ status: 'ok', addresses: [ip('10.0.0.82')] });
    expect(queriesFrom(sim, 'resolver', mark)).toEqual([TLD, HOSTING]);
  });

  it('follows an alias within a zone', () => {
    const { sim, client } = dnsInternet();
    const results = lookup(client, 'web.example.com');
    sim.runUntilIdle();
    expect(results).toEqual([
      { status: 'ok', addresses: [ip('10.0.0.80')], aliases: ['www.example.com'], server: RESOLVER },
    ]);
    expect(queriesFrom(sim, 'resolver')).toEqual([ROOT, TLD, EXAMPLE]);
  });

  it('follows an alias into another zone, finding that zone’s servers by name first', () => {
    const { sim, client } = dnsInternet();
    const results = lookup(client, 'store.example.com');
    sim.runUntilIdle();
    expect(results).toEqual([
      { status: 'ok', addresses: [ip('10.0.0.81')], aliases: ['www.shop.com'], server: RESOLVER },
    ]);
    expect(queriesFrom(sim, 'resolver')).toEqual([
      ROOT, // store.example.com: ask com
      TLD, // ask example.com
      EXAMPLE, // it is an alias for www.shop.com
      TLD, // www.shop.com: ask ns.hosting.net, address not given
      ROOT, // ns.hosting.net: ask net
      TLD, // ask hosting.net, at 10.0.0.4
      HOSTING, // www.shop.com at last
    ]);
  });

  it('does not hand a client a parent zone’s hint as if it were the answer', () => {
    const { sim, client, resolver } = dnsInternet();
    lookup(client, 'www.example.com');
    sim.runUntilIdle();
    // The resolver holds ns1.example.com's address only as a hint from the com servers.
    expect(resolver.cached('ns1.example.com', 'A')).toHaveLength(1);

    const mark = sim.trace.length;
    const results = lookup(client, 'ns1.example.com');
    sim.runUntilIdle();
    expect(results[0]).toMatchObject({ status: 'ok', addresses: [EXAMPLE] });
    expect(queriesFrom(sim, 'resolver', mark)).toEqual([EXAMPLE]);
  });

  it('reports a name that does not exist, and remembers that for a while', () => {
    const { sim, client } = dnsInternet();
    const first = lookup(client, 'nope.example.com');
    sim.runUntilIdle();
    expect(first).toEqual([{ status: 'nxdomain', server: RESOLVER }]);

    let mark = sim.trace.length;
    const second = lookup(client, 'nope.example.com');
    sim.runUntilIdle();
    expect(second).toEqual(first);
    expect(queriesFrom(sim, 'resolver', mark)).toEqual([]);

    sim.runUntil(sim.now + 61 * SECOND);
    mark = sim.trace.length;
    lookup(client, 'nope.example.com');
    sim.runUntilIdle();
    expect(queriesFrom(sim, 'resolver', mark)).toEqual([EXAMPLE]);
  });

  it('reports a name that exists but has no address', () => {
    const { sim, client } = dnsInternet();
    const both = [lookup(client, 'example.com'), lookup(client, 'b.example.com')];
    sim.runUntilIdle();
    expect(both.map((r) => r[0])).toEqual([
      { status: 'nodata', server: RESOLVER },
      { status: 'nodata', server: RESOLVER },
    ]);
  });

  it('answers other record types when asked directly', () => {
    const { sim, resolver } = dnsInternet();
    const outcomes: unknown[] = [];
    resolver.resolve('example.com', 'NS', (o) => outcomes.push(o));
    resolver.resolve('web.example.com', 'CNAME', (o) => outcomes.push(o));
    sim.runUntilIdle();
    expect(outcomes).toEqual([
      { rcode: 'NOERROR', answers: [nsRecord('example.com', 'ns1.example.com')] },
      { rcode: 'NOERROR', answers: [expect.objectContaining({ type: 'CNAME', target: 'www.example.com' })] },
    ]);
  });

  it('fails when the server that holds the answer is down', () => {
    const { sim, client, hosts } = dnsInternet();
    hosts.example.nic.link!.up = false;
    const results = lookup(client, 'www.example.com');
    sim.runUntilIdle();
    expect(results).toEqual([{ status: 'failed', reason: 'servfail' }]);
  });

  it('moves on to another root server when the first is dead', () => {
    const { sim, add, client } = dnsInternet();
    new DnsResolver(add('resolver2', '10.0.0.54'), { rootServers: ['10.0.0.99', '10.0.0.1'] });
    client.dns.servers = [ip('10.0.0.54')];
    const results = lookup(client, 'www.example.com');
    sim.runUntilIdle();
    expect(results[0]).toMatchObject({ status: 'ok', addresses: [ip('10.0.0.80')] });
    expect(queriesFrom(sim, 'resolver2')).toEqual([ROOT, TLD, EXAMPLE]); // the query to .99 never left: no ARP reply
  });

  it('refuses to do the legwork for a query that did not ask for it', () => {
    const { sim, client } = dnsInternet();
    const socket = client.udp.bind();
    const replies: DnsMessage[] = [];
    socket.onMessage = (m) => m.data.kind === 'dns' && replies.push(m.data.message);
    socket.send(RESOLVER, DNS_PORT, { kind: 'dns', message: dnsQuery(7, 'www.example.com', 'A', false) });
    sim.runUntilIdle();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ id: 7, rcode: 'REFUSED' });
    expect(queriesFrom(sim, 'resolver')).toEqual([]);
  });
});

describe('DNS client', () => {
  it('fails at once with no resolver configured', () => {
    const { sim, web } = dnsInternet();
    const results = lookup(web, 'www.example.com');
    expect(results).toEqual([]);
    sim.runUntilIdle();
    expect(results).toEqual([{ status: 'failed', reason: 'no-servers' }]);
  });

  it('gives up quickly when the resolver’s port is closed', () => {
    const { sim, client, web } = dnsInternet();
    client.dns.servers = [web.address];
    const results = lookup(client, 'www.example.com');
    sim.runUntilIdle();
    expect(results).toEqual([{ status: 'failed', reason: 'unreachable' }]);
    expect(sim.now).toBeLessThan(SECOND);
  });

  it('falls back to the next resolver in its list', () => {
    const { sim, client, web } = dnsInternet();
    client.dns.servers = [web.address, RESOLVER];
    const results = lookup(client, 'www.example.com');
    sim.runUntilIdle();
    expect(results[0]).toMatchObject({ status: 'ok', server: RESOLVER });
  });

  it('retries, then times out, when the resolver never answers', () => {
    const { sim, client, web } = dnsInternet();
    web.udp.bind(DNS_PORT); // listening, but silent
    client.dns.servers = [web.address];
    const results = lookup(client, 'www.example.com');
    sim.runUntilIdle();
    expect(results).toEqual([{ status: 'failed', reason: 'timeout' }]);
    expect(queriesFrom(sim, 'client')).toEqual([web.address, web.address]);
    expect(sim.now).toBe(4 * SECOND);
  });

  it('will not use a server that only hands out referrals', () => {
    const { sim, client } = dnsInternet();
    client.dns.servers = [ROOT];
    const results = lookup(client, 'www.example.com');
    sim.runUntilIdle();
    expect(results).toEqual([{ status: 'failed', reason: 'refused' }]);
  });

  it('ignores a reply that does not match what it asked', () => {
    const { sim, client, web } = dnsInternet();
    rogueServer(web, (query) =>
      dnsReply({ ...query, id: query.id ^ 1 }, { recursionAvailable: true, answers: [aRecord(query.question.name, '6.6.6.6')] }),
    );
    client.dns.servers = [web.address];
    const results = lookup(client, 'www.example.com');
    sim.runUntilIdle();
    expect(results).toEqual([{ status: 'failed', reason: 'timeout' }]);
    const rejects = ofKind(sim, 'dns-reject');
    expect(rejects.map((e) => [e.device, e.reason])).toEqual([
      ['client', 'no-matching-query'],
      ['client', 'no-matching-query'],
    ]);
  });
});

describe('DNS resolver under attack', () => {
  /** Delegates evil.com to a server the attacker controls. */
  function withEvilZone(forge: (query: DnsMessage) => DnsMessage) {
    const net = dnsInternet();
    net.servers.tld.addRecord(nsRecord('evil.com', 'ns.evil.com'));
    net.servers.tld.addRecord(aRecord('ns.evil.com', '10.0.0.66'));
    rogueServer(net.add('evil', '10.0.0.66'), forge);
    return net;
  }

  it('ignores records for names outside the zone a server was asked about', () => {
    const { sim, client, resolver } = withEvilZone((query) =>
      dnsReply(query, {
        authoritative: true,
        answers: [aRecord(query.question.name, '6.6.6.6'), aRecord('www.example.com', '6.6.6.6')],
      }),
    );
    const evil = lookup(client, 'x.evil.com');
    sim.runUntilIdle();
    expect(evil[0]).toMatchObject({ status: 'ok', addresses: [ip('6.6.6.6')] });

    // The planted record was noticed and thrown away.
    expect(resolver.cached('www.example.com', 'A')).toBeUndefined();
    const rejects = ofKind(sim, 'dns-reject');
    expect(rejects).toHaveLength(1);
    expect(rejects[0]).toMatchObject({ device: 'resolver', reason: 'out-of-bailiwick', from: ip('10.0.0.66') });
    expect(rejects[0]!.record).toEqual(aRecord('www.example.com', '6.6.6.6'));

    const real = lookup(client, 'www.example.com');
    sim.runUntilIdle();
    expect(real[0]).toMatchObject({ status: 'ok', addresses: [ip('10.0.0.80')] });
  });

  it('ignores a referral that tries to take over someone else’s zone', () => {
    const { sim, client, resolver } = withEvilZone((query) =>
      dnsReply(query, {
        authority: [nsRecord('com', 'ns.evil.com')],
        additional: [aRecord('ns.evil.com', '10.0.0.66')],
      }),
    );
    const results = lookup(client, 'x.evil.com');
    sim.runUntilIdle();
    expect(results).toEqual([{ status: 'failed', reason: 'servfail' }]);
    expect(resolver.cached('com', 'NS')).toEqual([expect.objectContaining({ host: 'a.gtld-servers.net' })]);
    expect(ofKind(sim, 'dns-reject').every((e) => e.reason === 'out-of-bailiwick')).toBe(true);
  });

  it('ignores a response whose id does not match the query', () => {
    const { sim, client, resolver } = withEvilZone((query) =>
      dnsReply({ ...query, id: query.id ^ 1 }, { authoritative: true, answers: [aRecord(query.question.name, '6.6.6.6')] }),
    );
    const results = lookup(client, 'x.evil.com');
    sim.runUntilIdle();
    expect(results).toEqual([{ status: 'failed', reason: 'servfail' }]);
    expect(resolver.cached('x.evil.com', 'A')).toBeUndefined();
    expect(ofKind(sim, 'dns-reject').map((e) => e.reason)).toEqual(['no-matching-query', 'no-matching-query']);
  });

  it('ignores a response that answers a different question', () => {
    const { sim, client, resolver } = withEvilZone((query) =>
      dnsReply(
        { ...query, question: { name: 'www.evil.com', type: 'A' } },
        { authoritative: true, answers: [aRecord('www.evil.com', '6.6.6.6')] },
      ),
    );
    const results = lookup(client, 'x.evil.com');
    sim.runUntilIdle();
    expect(results[0]).toMatchObject({ status: 'failed' });
    expect(resolver.cached('www.evil.com', 'A')).toBeUndefined();
    expect(ofKind(sim, 'dns-reject')[0]).toMatchObject({ reason: 'question-mismatch' });
  });

  it('gives up on an alias loop instead of chasing it forever', () => {
    const { sim, client } = withEvilZone((query) => {
      const name = query.question.name;
      const other = name === 'a.evil.com' ? 'b.evil.com' : 'a.evil.com';
      return dnsReply(query, { authoritative: true, answers: [{ name, type: 'CNAME', ttl: 60, target: other }] });
    });
    const results = lookup(client, 'a.evil.com');
    sim.runUntilIdle();
    expect(results).toEqual([{ status: 'failed', reason: 'servfail' }]);
  });
});

describe('DNS determinism', () => {
  function run(seed: number) {
    const { sim, client } = dnsInternet(seed);
    const results: LookupResult[] = [];
    for (const name of ['www.example.com', 'store.example.com', 'nope.example.com', 'web.example.com']) {
      client.lookup(name, (r) => results.push(r));
    }
    sim.runUntilIdle();
    return { trace: JSON.stringify(sim.trace), results };
  }

  it('repeats exactly for the same seed', () => {
    expect(run(7)).toEqual(run(7));
  });

  it('picks different ports and ids under a different seed, with the same outcome', () => {
    const first = run(7);
    const other = run(8);
    expect(other.trace).not.toBe(first.trace);
    expect(other.results).toEqual(first.results);
  });
});

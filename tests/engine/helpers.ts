import {
  DnsResolver,
  DnsServer,
  Host,
  Router,
  Simulation,
  Switch,
  aRecord,
  cnameRecord,
  nsRecord,
  type HostConfig,
  type IpNode,
  type Ipv4,
  type PingOptions,
  type PingResult,
  type TraceEvent,
} from '../../src/engine';

/** Sends a ping and returns the array its result will be pushed into once the simulation runs. */
export function ping(from: IpNode, target: string, options?: PingOptions): PingResult[] {
  const results: PingResult[] = [];
  from.ping(target, (result) => results.push(result), options);
  return results;
}

export function ofKind<K extends TraceEvent['kind']>(sim: Simulation, kind: K): Extract<TraceEvent, { kind: K }>[] {
  return sim.trace.filter((event): event is Extract<TraceEvent, { kind: K }> => event.kind === kind);
}

/** Three hosts on one switch, all in 10.0.0.0/24. */
export function lan(seed = 1) {
  const sim = new Simulation({ seed });
  const sw = new Switch(sim, 'sw1');
  const a = new Host(sim, 'a', { address: '10.0.0.1/24' });
  const b = new Host(sim, 'b', { address: '10.0.0.2/24' });
  const c = new Host(sim, 'c', { address: '10.0.0.3/24' });
  for (const host of [a, b, c]) sim.connect(host.nic, sw.freePort());
  return { sim, sw, a, b, c };
}

/**
 * Two LANs joined by two routers:
 *
 *   a (10.0.1.10) ── sw1 ── r1 ══ r2 ── b (10.0.2.10)
 *        10.0.1.0/24      10.0.12.0/30      10.0.2.0/24
 */
export function internetwork(options: { seed?: number; lossRate?: number } = {}) {
  const sim = new Simulation({ seed: options.seed ?? 1 });
  const a = new Host(sim, 'a', { address: '10.0.1.10/24', gateway: '10.0.1.1' });
  const b = new Host(sim, 'b', { address: '10.0.2.10/24', gateway: '10.0.2.1' });
  const sw = new Switch(sim, 'sw1');
  const r1 = new Router(sim, 'r1');
  const r2 = new Router(sim, 'r2');

  sim.connect(a.nic, sw.freePort());
  sim.connect(r1.addInterface('10.0.1.1/24'), sw.freePort());
  const backbone = sim.connect(r1.addInterface('10.0.12.1/30'), r2.addInterface('10.0.12.2/30'), {
    lossRate: options.lossRate ?? 0,
  });
  const edge = sim.connect(r2.addInterface('10.0.2.1/24'), b.nic);

  r1.addRoute('10.0.2.0/24', '10.0.12.2');
  r2.addRoute('10.0.1.0/24', '10.0.12.1');
  return { sim, a, b, sw, r1, r2, backbone, edge };
}

/**
 * A small internet's worth of DNS on one LAN (10.0.0.0/24):
 *
 *   root (.1)      the root zone, delegating com and net
 *   tld (.2)       com and net, delegating example.com, shop.com and hosting.net
 *   example (.3)   example.com
 *   hosting (.4)   hosting.net and shop.com (shop.com is delegated without glue)
 *   resolver (.53) recursive resolver, starting from the root
 *   client (.10)   uses the resolver
 *   web (.80)      a host that runs no DNS at all
 */
export function dnsInternet(seed = 1) {
  const sim = new Simulation({ seed });
  const sw = new Switch(sim, 'sw', 8);
  const add = (id: string, address: string, config: Partial<HostConfig> = {}) => {
    const host = new Host(sim, id, { address: `${address}/24`, ...config });
    sim.connect(host.nic, sw.freePort());
    return host;
  };

  const client = add('client', '10.0.0.10', { dnsServers: ['10.0.0.53'] });
  const web = add('web', '10.0.0.80');
  const hosts = {
    resolver: add('resolver', '10.0.0.53'),
    root: add('root', '10.0.0.1'),
    tld: add('tld', '10.0.0.2'),
    example: add('example', '10.0.0.3'),
    hosting: add('hosting', '10.0.0.4'),
  };

  const resolver = new DnsResolver(hosts.resolver, { rootServers: ['10.0.0.1'] });
  const root = new DnsServer(hosts.root, [
    {
      origin: '',
      records: [
        nsRecord('', 'a.root-servers.net'),
        aRecord('a.root-servers.net', '10.0.0.1', 3600),
        nsRecord('com', 'a.gtld-servers.net'),
        nsRecord('net', 'a.gtld-servers.net'),
        aRecord('a.gtld-servers.net', '10.0.0.2', 3600),
      ],
    },
  ]);
  const tld = new DnsServer(hosts.tld, [
    {
      origin: 'com',
      records: [
        nsRecord('com', 'a.gtld-servers.net'),
        nsRecord('example.com', 'ns1.example.com'),
        aRecord('ns1.example.com', '10.0.0.3', 3600),
        nsRecord('shop.com', 'ns.hosting.net'),
      ],
    },
    {
      origin: 'net',
      records: [
        nsRecord('net', 'a.gtld-servers.net'),
        aRecord('a.gtld-servers.net', '10.0.0.2', 3600),
        nsRecord('hosting.net', 'ns.hosting.net'),
        aRecord('ns.hosting.net', '10.0.0.4', 3600),
      ],
    },
  ]);
  const example = new DnsServer(hosts.example, [
    {
      origin: 'example.com',
      records: [
        nsRecord('example.com', 'ns1.example.com'),
        aRecord('ns1.example.com', '10.0.0.3', 3600),
        aRecord('www.example.com', '10.0.0.80'),
        cnameRecord('web.example.com', 'www.example.com'),
        aRecord('mail.example.com', '10.0.0.25'),
        aRecord('mail.example.com', '10.0.0.26'),
        cnameRecord('store.example.com', 'www.shop.com'),
        aRecord('a.b.example.com', '10.0.0.90'),
      ],
    },
  ]);
  const hosting = new DnsServer(hosts.hosting, [
    {
      origin: 'hosting.net',
      records: [nsRecord('hosting.net', 'ns.hosting.net'), aRecord('ns.hosting.net', '10.0.0.4', 3600)],
    },
    {
      origin: 'shop.com',
      records: [nsRecord('shop.com', 'ns.hosting.net'), aRecord('www.shop.com', '10.0.0.81')],
    },
  ]);

  return { sim, sw, add, client, web, hosts, resolver, servers: { root, tld, example, hosting } };
}

/** The servers a device sent DNS queries to, in order, from trace position `since` onwards. */
export function queriesFrom(sim: Simulation, device: string, since = 0): Ipv4[] {
  const out: Ipv4[] = [];
  for (const event of sim.trace.slice(since)) {
    if (event.kind !== 'frame-tx' || event.device !== device || event.frame.etherType !== 'ipv4') continue;
    const packet = event.frame.payload;
    if (packet.protocol !== 'udp' || packet.payload.data.kind !== 'dns') continue;
    if (!packet.payload.data.message.response) out.push(packet.dst);
  }
  return out;
}

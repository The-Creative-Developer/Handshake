import {
  DnsResolver,
  DnsServer,
  Host,
  Router,
  Simulation,
  Switch,
  aRecord,
  formatIp,
  nsRecord,
  type LookupResult,
  type PingResult,
} from '../engine';

export interface DemoStep {
  readonly label: string;
  readonly outcome: string;
  readonly ok: boolean;
}

export interface DemoRun {
  readonly sim: Simulation;
  readonly steps: DemoStep[];
}

const ms = (us: number) => `${(us / 1000).toFixed(1)} ms`;

function describePing(result: PingResult): string {
  switch (result.status) {
    case 'reply':
      return `reply from ${formatIp(result.from)} in ${ms(result.rttUs)}, ttl ${result.ttl}`;
    case 'timeout':
      return 'timed out';
    case 'unreachable':
      return `${formatIp(result.from)} says ${result.code} unreachable`;
    case 'ttl-exceeded':
      return `${formatIp(result.from)} says time exceeded`;
  }
}

function describeLookup(result: LookupResult, took: number): string {
  switch (result.status) {
    case 'ok':
      return `${result.addresses.map(formatIp).join(', ')} in ${ms(took)}`;
    case 'nxdomain':
      return `no such name, in ${ms(took)}`;
    case 'nodata':
      return 'the name has no address';
    case 'failed':
      return `failed: ${result.reason}`;
  }
}

/**
 * A toy internet: an office LAN and a data-centre LAN joined by two routers.
 * The data centre holds a web server and the three DNS servers a lookup has to
 * visit (root, .com, example.com). The office has a laptop and its resolver.
 *
 *   laptop, resolver ── sw1 ── r1 ══ r2 ── sw2 ── www, root, tld, ns1
 *      10.0.1.0/24          10.0.12.0/30          10.0.2.0/24
 */
export function runDemo(): DemoRun {
  const sim = new Simulation({ seed: 1 });
  const sw1 = new Switch(sim, 'sw1');
  const sw2 = new Switch(sim, 'sw2', 6);
  const r1 = new Router(sim, 'r1');
  const r2 = new Router(sim, 'r2');
  sim.connect(r1.addInterface('10.0.1.1/24'), sw1.freePort());
  sim.connect(r1.addInterface('10.0.12.1/30'), r2.addInterface('10.0.12.2/30'));
  sim.connect(r2.addInterface('10.0.2.1/24'), sw2.freePort());
  r1.addRoute('10.0.2.0/24', '10.0.12.2');
  r2.addRoute('10.0.1.0/24', '10.0.12.1');

  const office = (id: string, address: string, dnsServers?: string[]) => {
    const host = new Host(sim, id, { address: `${address}/24`, gateway: '10.0.1.1', dnsServers });
    sim.connect(host.nic, sw1.freePort());
    return host;
  };
  const dataCentre = (id: string, address: string) => {
    const host = new Host(sim, id, { address: `${address}/24`, gateway: '10.0.2.1' });
    sim.connect(host.nic, sw2.freePort());
    return host;
  };

  const laptop = office('laptop', '10.0.1.10', ['10.0.1.53']);
  new DnsResolver(office('resolver', '10.0.1.53'), { rootServers: ['10.0.2.2'] });
  const www = dataCentre('www', '10.0.2.10');
  // A one-line web server: read the request, answer it, hang up.
  www.tcp.listen(80, (connection) => {
    connection.onData = (request) => {
      const found = request.startsWith('GET / ');
      connection.send(found ? 'HTTP/1.0 200 OK\r\n\r\nHello from www.example.com' : 'HTTP/1.0 404 Not Found\r\n\r\n');
      connection.end();
    };
  });
  new DnsServer(dataCentre('root', '10.0.2.2'), [
    {
      origin: '',
      records: [nsRecord('com', 'a.gtld-servers.com'), aRecord('a.gtld-servers.com', '10.0.2.3', 3600)],
    },
  ]);
  new DnsServer(dataCentre('tld', '10.0.2.3'), [
    {
      origin: 'com',
      records: [nsRecord('example.com', 'ns1.example.com'), aRecord('ns1.example.com', '10.0.2.4', 3600)],
    },
  ]);
  new DnsServer(dataCentre('ns1', '10.0.2.4'), [
    {
      origin: 'example.com',
      records: [
        nsRecord('example.com', 'ns1.example.com'),
        aRecord('ns1.example.com', '10.0.2.4', 3600),
        aRecord('www.example.com', '10.0.2.10'),
      ],
    },
  ]);

  const steps: DemoStep[] = [];
  const lookup = (label: string, name: string) => {
    const start = sim.now;
    laptop.lookup(name, (result) =>
      steps.push({ label, outcome: describeLookup(result, sim.now - start), ok: result.status === 'ok' }),
    );
    sim.runUntilIdle();
  };
  const ping = (label: string, target: string, ttl?: number) => {
    laptop.ping(
      target,
      (result) => steps.push({ label, outcome: describePing(result), ok: result.status === 'reply' }),
      { ttl },
    );
    sim.runUntilIdle();
  };

  const get = (label: string, address: string, port = 80) => {
    const start = sim.now;
    const connection = laptop.tcp.connect(address, port);
    let response = '';
    connection.onOpen = () => {
      connection.send('GET / HTTP/1.0\r\n\r\n');
      connection.end();
    };
    connection.onData = (data) => (response += data);
    connection.onClose = (reason) => {
      const body = response.split('\r\n\r\n')[1] ?? '';
      const ok = reason === 'closed' && response.startsWith('HTTP/1.0 200');
      steps.push({ label, outcome: ok ? `"${body}" in ${ms(sim.now - start)}` : `connection ${reason}`, ok });
    };
    sim.runUntilIdle();
  };

  lookup('lookup www.example.com', 'www.example.com');
  ping('ping 10.0.2.10', '10.0.2.10');
  lookup('lookup www.example.com (cached)', 'www.example.com');
  lookup('lookup nope.example.com', 'nope.example.com');
  ping('ping 10.0.2.10 with TTL 1', '10.0.2.10', 1);
  ping('ping 172.16.0.1 (no route)', '172.16.0.1');
  get('GET http://10.0.2.10/ over TCP', '10.0.2.10');
  get('GET http://10.0.2.10:8080/ (closed port)', '10.0.2.10', 8080);

  return { sim, steps };
}

import {
  DnsResolver,
  DnsServer,
  Host,
  Router,
  Simulation,
  Switch,
  aRecord,
  formatIp,
  ip,
  nsRecord,
  type Ipv4,
  type LookupResult,
  type PingResult,
} from '../engine';
import { formatDuration } from './protocol';

export type Role = 'laptop' | 'server' | 'resolver';

export interface Place {
  /** Position on the map, in the scenario's own units. The view scales them to fit. */
  x: number;
  y: number;
  readonly label: string;
  /** Picks the pictogram drawn inside a host. Switches and routers have their own shapes. */
  readonly role?: Role;
  /** Where the label goes. Below by default; pick a side that no cable runs through. */
  readonly side?: 'below' | 'left' | 'right';
}

export interface Services {
  readonly resolver?: DnsResolver;
  readonly dnsServer?: DnsServer;
}

/** A line for the log that comes from an application rather than from the network. */
export type Note = (device: string, text: string) => void;

export interface Scenario {
  readonly title: string;
  readonly blurb: string;
  readonly sim: Simulation;
  readonly places: Record<string, Place>;
  readonly services: Record<string, Services>;
  /** One-click things to try. */
  readonly actions: { readonly label: string; run(note: Note): void }[];
}

/**
 * Something a person did to the network. Inputs are plain data, so a session
 * can record them and apply them again to a rebuilt network to get back to
 * any earlier moment.
 */
export type Input =
  | { readonly kind: 'action'; readonly index: number }
  | { readonly kind: 'lookup' | 'ping' | 'fetch'; readonly host: string; readonly target: string }
  | {
      /** A change to a cable, identified by its position in the simulation's list. */
      readonly kind: 'link';
      readonly index: number;
      readonly up?: boolean;
      readonly lossRate?: number;
      readonly latencyUs?: number;
    };

export function applyInput(scenario: Scenario, input: Input, note: Note): void {
  switch (input.kind) {
    case 'action':
      scenario.actions[input.index]?.run(note);
      return;
    case 'link': {
      const link = scenario.sim.links[input.index];
      if (!link) return;
      if (input.up !== undefined) link.up = input.up;
      if (input.lossRate !== undefined) link.lossRate = input.lossRate;
      if (input.latencyUs !== undefined) link.latencyUs = input.latencyUs;
      return;
    }
    default: {
      const host = scenario.sim.devices.get(input.host);
      if (!(host instanceof Host)) return;
      if (input.kind === 'lookup') lookup(host, input.target, note);
      else if (input.kind === 'ping') ping(host, input.target, note);
      else fetchPage(host, input.target, note);
    }
  }
}

/** A short description of an input, for the timeline. */
export function describeInput(scenario: Scenario, input: Input): string {
  switch (input.kind) {
    case 'action':
      return scenario.actions[input.index]?.label ?? 'action';
    case 'link': {
      const link = scenario.sim.links[input.index];
      const name = link ? `${link.a.owner.id}–${link.b.owner.id}` : 'cable';
      if (input.up !== undefined) return `${input.up ? 'repaired' : 'cut'} ${name}`;
      if (input.lossRate !== undefined) return `${name}: ${Math.round(input.lossRate * 100)}% loss`;
      return `${name}: ${(input.latencyUs ?? 0) / 1000} ms delay`;
    }
    default:
      return `${input.host}: ${input.kind === 'lookup' ? 'look up' : input.kind} ${input.target}`;
  }
}

// ----------------------------------------------------------------- actions ----
// What a person at a host can do. Each reports its outcome through `note`.

function describePing(result: PingResult): string {
  switch (result.status) {
    case 'reply':
      return `reply from ${formatIp(result.from)} in ${formatDuration(result.rttUs)}`;
    case 'timeout':
      return 'no reply';
    case 'unreachable':
      return `${formatIp(result.from)} says ${result.code} unreachable`;
    case 'ttl-exceeded':
      return `${formatIp(result.from)} says time exceeded`;
  }
}

function describeLookup(name: string, result: LookupResult): string {
  switch (result.status) {
    case 'ok':
      return `${name} is ${result.addresses.map(formatIp).join(', ')}`;
    case 'nxdomain':
      return `${name} does not exist`;
    case 'nodata':
      return `${name} has no address`;
    case 'failed':
      return `could not look up ${name}: ${result.reason}`;
  }
}

/** Turns what a person typed, an address or a name, into an address. */
function resolve(host: Host, target: string, note: Note, then: (address: Ipv4) => void): void {
  const text = target.trim();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(text)) {
    try {
      then(ip(text));
    } catch {
      note(host.id, `"${text}" is not a valid address`);
    }
    return;
  }
  try {
    host.lookup(text, (result) => {
      note(host.id, describeLookup(text, result));
      if (result.status === 'ok') then(result.addresses[0]!);
    });
  } catch {
    note(host.id, `"${text}" is not a valid name`);
  }
}

export function lookup(host: Host, name: string, note: Note): void {
  resolve(host, name, note, () => {});
}

export function ping(host: Host, target: string, note: Note): void {
  resolve(host, target, note, (address) => {
    host.ping(address, (result) => note(host.id, `ping ${formatIp(address)}: ${describePing(result)}`));
  });
}

/** Fetches "/" over TCP port `port`, in the shape of an HTTP/1.0 request. */
export function fetchPage(host: Host, target: string, note: Note, port = 80): void {
  resolve(host, target, note, (address) => {
    const start = host.sim.now;
    const connection = host.tcp.connect(address, port);
    let response = '';
    connection.onOpen = () => {
      connection.send('GET / HTTP/1.0\r\n\r\n');
      connection.end();
    };
    connection.onData = (data) => (response += data);
    connection.onClose = (reason) => {
      const where = `${formatIp(address)}:${port}`;
      if (reason !== 'closed') {
        note(host.id, `fetch ${where}: connection ${reason}`);
        return;
      }
      const body = response.split('\r\n\r\n')[1] ?? '';
      note(host.id, `fetch ${where}: “${body}” in ${formatDuration(host.sim.now - start)}`);
    };
  });
}

// ---------------------------------------------------------------- scenario ----

/**
 * A toy internet: an office LAN and a data-centre LAN joined by two routers.
 * The data centre holds a web server and the three DNS servers a lookup has to
 * visit (root, .com, example.com). The office has a laptop and its resolver.
 */
export function toyInternet(): Scenario {
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
  const resolver = new DnsResolver(office('resolver', '10.0.1.53'), { rootServers: ['10.0.2.2'] });

  const www = dataCentre('www', '10.0.2.10');
  www.tcp.listen(80, (connection) => {
    connection.onData = (request) => {
      const found = request.startsWith('GET / ');
      connection.send(found ? 'HTTP/1.0 200 OK\r\n\r\nHello from www.example.com' : 'HTTP/1.0 404 Not Found\r\n\r\n');
      connection.end();
    };
  });

  const root = new DnsServer(dataCentre('root', '10.0.2.2'), [
    { origin: '', records: [nsRecord('com', 'a.gtld-servers.com'), aRecord('a.gtld-servers.com', '10.0.2.3', 3600)] },
  ]);
  const tld = new DnsServer(dataCentre('tld', '10.0.2.3'), [
    { origin: 'com', records: [nsRecord('example.com', 'ns1.example.com'), aRecord('ns1.example.com', '10.0.2.4', 3600)] },
  ]);
  const ns1 = new DnsServer(dataCentre('ns1', '10.0.2.4'), [
    {
      origin: 'example.com',
      records: [
        nsRecord('example.com', 'ns1.example.com'),
        aRecord('ns1.example.com', '10.0.2.4', 3600),
        aRecord('www.example.com', '10.0.2.10'),
      ],
    },
  ]);

  return {
    title: 'A toy internet',
    blurb:
      'An office and a data centre, joined by two routers. The laptop knows the web server only by name, so it ' +
      'has to ask its resolver, which in turn asks three name servers before anyone can say hello.',
    sim,
    places: {
      laptop: { x: 80, y: 110, label: 'Laptop', role: 'laptop', side: 'left' },
      resolver: { x: 80, y: 410, label: 'Resolver', role: 'resolver', side: 'left' },
      sw1: { x: 250, y: 260, label: 'Office switch' },
      r1: { x: 430, y: 260, label: 'Office router' },
      r2: { x: 640, y: 260, label: 'Data-centre router' },
      sw2: { x: 820, y: 260, label: 'Rack switch' },
      www: { x: 960, y: 40, label: 'Web server', role: 'server', side: 'right' },
      root: { x: 1010, y: 185, label: 'Root DNS', role: 'server', side: 'right' },
      tld: { x: 1010, y: 335, label: '.com DNS', role: 'server', side: 'right' },
      ns1: { x: 960, y: 480, label: 'example.com DNS', role: 'server', side: 'right' },
    },
    services: {
      resolver: { resolver },
      root: { dnsServer: root },
      tld: { dnsServer: tld },
      ns1: { dnsServer: ns1 },
    },
    actions: [
      { label: 'Look up www.example.com', run: (note) => lookup(laptop, 'www.example.com', note) },
      { label: 'Ping the web server', run: (note) => ping(laptop, 'www.example.com', note) },
      { label: 'Fetch the page', run: (note) => fetchPage(laptop, 'www.example.com', note) },
      { label: 'Knock on a closed port', run: (note) => fetchPage(laptop, '10.0.2.10', note, 8080) },
    ],
  };
}

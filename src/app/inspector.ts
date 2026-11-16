import {
  BROADCAST_MAC,
  Host,
  IpNode,
  Router,
  Switch,
  describeRecord,
  formatCidr,
  formatIp,
  type ArpPacket,
  type Device,
  type DnsMessage,
  type DnsRecord,
  type EthernetFrame,
  type IcmpMessage,
  type Ipv4Packet,
  type Link,
  type Mac,
  type Nic,
  type TcpSegment,
} from '../engine';
import { append, clear, h } from './dom';
import { FAMILY_NAME, tagOf } from './protocol';
import { fetchPage, lookup, ping, type Note, type Scenario } from './scenario';
import type { Selection } from './scene';
import type { Family } from './theme';

type Row = [label: string, value: string | Node];

function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return h('section', { class: 'block' }, h('h3', null, title), ...children);
}

function empty(text: string): HTMLElement {
  return h('p', { class: 'empty' }, text);
}

/** A two-column list of facts: a label on the left, its value on the right. */
function facts(rows: Row[]): HTMLElement {
  const list = h('dl', { class: 'facts' });
  for (const [label, value] of rows) append(list, [h('dt', null, label), h('dd', null, value)]);
  return list;
}

function table(head: string[], rows: (string | Node)[][]): HTMLElement {
  return h(
    'table',
    { class: 'grid' },
    h('thead', null, h('tr', null, ...head.map((cell) => h('th', null, cell)))),
    h('tbody', null, ...rows.map((row) => h('tr', null, ...row.map((cell) => h('td', null, cell))))),
  );
}

function token(family: Family, label: string): HTMLElement {
  return h('span', { class: `token ${family}` }, label);
}

/** A record without its name: "A 10.0.2.10". */
function recordValue(record: DnsRecord): string {
  const value = record.type === 'A' ? formatIp(record.address) : record.type === 'NS' ? record.host : record.target;
  return `${record.type} ${value}`;
}

/** Makes line endings visible, so an HTTP request reads as it was sent. */
function printable(text: string): string {
  return text.replace(/\r/g, '␍').replace(/\n/g, '␊\n');
}

/**
 * The panel beside the map. It shows whatever is selected: a device and its
 * tables, a cable and its controls, or a frame opened up layer by layer.
 */
export class Inspector {
  private selection: Selection = null;
  /** The part that is rebuilt as the simulation runs. Controls live outside it so they keep focus. */
  private live: HTMLElement | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly scenario: Scenario,
    private readonly note: Note,
    private readonly afterAction: () => void,
  ) {
    this.show(null);
  }

  show(selection: Selection): void {
    this.selection = selection;
    this.live = null;
    clear(this.root);
    this.root.scrollTop = 0;
    if (!selection) this.intro();
    else if (selection.kind === 'device') this.device(selection.id);
    else if (selection.kind === 'link') this.link(selection.link);
    else this.frame(selection.frame);
  }

  /** Brings the live part up to date. Cheap to call often. */
  refresh(): void {
    if (!this.live || !this.selection) return;
    if (this.selection.kind === 'device') {
      const device = this.scenario.sim.devices.get(this.selection.id);
      if (device) this.live.replaceChildren(...this.deviceState(device));
    } else if (this.selection.kind === 'link') {
      this.live.replaceChildren(this.linkState(this.selection.link));
    }
  }

  // ----------------------------------------------------------------- intro ----

  private intro(): void {
    const legend: [Family, string, string][] = [
      ['arp', 'ARP ?', 'Who on this LAN has this address?'],
      ['dns', 'DNS ?', 'What address does this name have?'],
      ['icmp', 'PING', 'Are you there? Also carries error reports.'],
      ['tcp', 'SYN', 'A connection: opening, data, closing.'],
    ];
    append(this.root, [
      h('p', { class: 'eyebrow' }, 'Scenario'),
      h('h2', null, this.scenario.title),
      h('p', { class: 'lede' }, this.scenario.blurb),
      section(
        'Reading the map',
        h(
          'ul',
          { class: 'legend' },
          ...legend.map(([family, label, meaning]) => h('li', null, token(family, label), h('span', null, meaning))),
        ),
        h(
          'p',
          { class: 'aside' },
          'Tokens keep to the right of their cable, so the two directions never cross. A token that fades to an ' +
            'outline reached a device that was not its addressee. A red cross is a frame that never arrived.',
        ),
      ),
      section(
        'Things to try',
        h(
          'ul',
          { class: 'tips' },
          h('li', null, 'Click a device to see what it knows right now.'),
          h('li', null, 'Click a token, or a line in the log, to open the frame.'),
          h('li', null, 'Click a cable to cut it or make it lossy, then fetch the page again.'),
          h('li', null, 'Drag devices to rearrange the map.'),
        ),
      ),
    ]);
  }

  // ---------------------------------------------------------------- device ----

  private device(id: string): void {
    const device = this.scenario.sim.devices.get(id);
    const place = this.scenario.places[id];
    if (!device || !place) return;
    const kind = device instanceof Switch ? 'Switch' : device instanceof Router ? 'Router' : 'Host';
    const blurb =
      device instanceof Switch
        ? 'Passes frames between the cables plugged into it, using only the hardware addresses on them.'
        : device instanceof Router
          ? 'Joins networks. It reads the IP address on each packet and sends it one hop closer.'
          : 'An end of the conversation: packets start and finish here.';
    this.live = h('div', { class: 'live' }, ...this.deviceState(device));
    append(this.root, [
      h('p', { class: 'eyebrow' }, `${kind} · ${id}`),
      h('h2', null, place.label),
      h('p', { class: 'lede' }, blurb),
      device instanceof Host ? this.console(device) : null,
      this.live,
    ]);
  }

  /** A small form for sending something from a host. */
  private console(host: Host): HTMLElement {
    const input = h('input', { type: 'text', value: 'www.example.com', spellcheck: 'false', 'aria-label': 'Name or address' });
    const run = (action: (host: Host, target: string, note: Note) => void) => () => {
      if (input.value.trim() === '') return;
      action(host, input.value, this.note);
      this.afterAction();
    };
    return section(
      'Send from here',
      h(
        'div',
        { class: 'console' },
        input,
        h(
          'div',
          { class: 'buttons' },
          h('button', { type: 'button', onclick: run(lookup) }, 'Look up'),
          h('button', { type: 'button', onclick: run(ping) }, 'Ping'),
          h('button', { type: 'button', onclick: run((hst, target, note) => fetchPage(hst, target, note)) }, 'Fetch'),
        ),
      ),
    );
  }

  private deviceState(device: Device): HTMLElement[] {
    const now = this.scenario.sim.now;
    const out: HTMLElement[] = [];

    if (device instanceof Switch) {
      const entries = device.entries();
      out.push(
        section(
          'Address table',
          entries.length > 0
            ? table(['Hardware address', 'Port', 'Leads to'], entries.map((e) => [e.mac, e.port, this.ownerOf(e.mac)]))
            : empty('Nothing learned yet. A switch learns where a device is the first time it hears from it.'),
        ),
        section('Ports', table(['Port', 'Cable to'], device.nics.map((nic) => [nic.name, this.farEnd(nic)]))),
      );
      return out;
    }
    if (!(device instanceof IpNode)) return out;

    out.push(
      section(
        'Interfaces',
        table(
          ['Name', 'Address', 'Hardware', 'Cable to'],
          device.interfaces.map((iface) => [
            iface.nic.name,
            `${formatIp(iface.address)}/${iface.subnet.prefix}`,
            iface.nic.mac,
            this.farEnd(iface.nic),
          ]),
        ),
      ),
      section(
        'Routes',
        table(
          ['Destination', 'Send to', 'Out of'],
          device.routes.map((route) => [
            route.dest.prefix === 0 ? 'everything else' : formatCidr(route.dest),
            route.gateway === null ? 'directly' : formatIp(route.gateway),
            route.iface.nic.name,
          ]),
        ),
      ),
    );

    const neighbours = device.interfaces.flatMap((iface) =>
      iface.arp.snapshot(now).map((entry) => [formatIp(entry.address), entry.mac, this.ownerOf(entry.mac)]),
    );
    out.push(
      section(
        'Neighbours (ARP cache)',
        neighbours.length > 0
          ? table(['Address', 'Hardware', 'Is'], neighbours)
          : empty('Empty. It fills as this device talks to others on its LAN.'),
      ),
    );

    const listening = device.tcp.listeningPorts;
    const connections = device.tcp.connections;
    if (listening.length > 0 || connections.length > 0) {
      out.push(
        section(
          'TCP',
          listening.length > 0 ? facts([['Listening on', listening.map((port) => `port ${port}`).join(', ')]]) : null,
          connections.length > 0
            ? table(
                ['Local', 'Remote', 'State'],
                connections.map((c) => [`:${c.localPort}`, `${formatIp(c.remoteAddr)}:${c.remotePort}`, c.state.replace(/_/g, ' ')]),
              )
            : null,
        ),
      );
    }

    const services = this.scenario.services[device.id];
    if (services?.resolver) {
      const cached = services.resolver.entries();
      out.push(
        section(
          'Resolver cache',
          cached.length > 0
            ? table(
                ['Name', 'Answer', 'Expires'],
                cached.map((entry) => [
                  entry.name || '.',
                  entry.type === 'NXDOMAIN'
                    ? 'does not exist'
                    : entry.records.length === 0
                      ? `no ${entry.type} record`
                      : entry.records.map(recordValue).join(', '),
                  entry.records[0] ? `${entry.records[0].ttl} s` : '',
                ]),
              )
            : empty('Empty. Every answer the resolver fetches is kept here until it expires.'),
        ),
      );
    }
    if (services?.dnsServer) {
      for (const zone of services.dnsServer.zones) {
        out.push(
          section(
            `Zone ${zone.origin === '' ? '. (the root)' : zone.origin}`,
            table(['Record'], zone.records.map((record) => [describeRecord(record)])),
          ),
        );
      }
    }
    return out;
  }

  // ----------------------------------------------------------------- cable ----

  private link(link: Link): void {
    const toggle = h('button', { type: 'button', class: 'wide' });
    const relabel = () => (toggle.textContent = link.up ? 'Cut this cable' : 'Repair this cable');
    relabel();
    toggle.addEventListener('click', () => {
      link.up = !link.up;
      relabel();
      this.refresh();
    });

    const lossValue = h('output', null, `${Math.round(link.lossRate * 100)}%`);
    const loss = h('input', { type: 'range', min: '0', max: '60', step: '5', value: String(Math.round(link.lossRate * 100)) });
    loss.addEventListener('input', () => {
      link.lossRate = Number(loss.value) / 100;
      lossValue.textContent = `${loss.value}%`;
    });

    const delayValue = h('output', null, `${link.latencyUs / 1000} ms`);
    const delay = h('input', { type: 'range', min: '1', max: '10', step: '1', value: String(link.latencyUs / 1000) });
    delay.addEventListener('input', () => {
      link.latencyUs = Number(delay.value) * 1000;
      delayValue.textContent = `${delay.value} ms`;
    });

    this.live = h('div', { class: 'live' }, this.linkState(link));
    append(this.root, [
      h('p', { class: 'eyebrow' }, 'Cable'),
      h('h2', null, `${this.labelOf(link.a.owner.id)} to ${this.labelOf(link.b.owner.id)}`),
      h('p', { class: 'lede' }, 'A cable carries frames one way or the other, taking a fixed time to cross.'),
      this.live,
      section(
        'Tamper with it',
        h('label', { class: 'slider' }, h('span', null, 'Frames lost'), loss, lossValue),
        h('label', { class: 'slider' }, h('span', null, 'Delay'), delay, delayValue),
        toggle,
      ),
    ]);
  }

  private linkState(link: Link): HTMLElement {
    return section(
      'Right now',
      facts([
        ['Joins', `${link.a.owner.id}:${link.a.name} and ${link.b.owner.id}:${link.b.name}`],
        ['State', link.up ? 'connected' : 'cut'],
      ]),
    );
  }

  // ----------------------------------------------------------------- frame ----

  private frame(frame: EthernetFrame): void {
    const tag = tagOf(frame);
    const broadcast = frame.dst === BROADCAST_MAC;
    const inner = frame.etherType === 'arp' ? this.arpLayer(frame.payload) : this.ipLayer(frame.payload);
    append(this.root, [
      h('p', { class: 'eyebrow' }, 'Frame'),
      h('h2', null, token(tag.family, tag.label), ` ${FAMILY_NAME[tag.family]}`),
      h('p', { class: 'lede' }, 'Each layer is an envelope inside the one before. Different devices open different ones.'),
      this.layer('Ethernet', 'eth', 'Read by every switch. Rewritten at each router.', [
        ['From', `${frame.src} · ${this.ownerOf(frame.src)}`],
        ['To', broadcast ? `${frame.dst} · everyone on this LAN` : `${frame.dst} · ${this.ownerOf(frame.dst)}`],
      ], inner),
    ]);
  }

  private layer(title: string, tone: string, reader: string, rows: Row[], inner?: Node | null): HTMLElement {
    return h(
      'div',
      { class: `layer ${tone}` },
      h('header', null, h('span', { class: 'name' }, title), h('span', { class: 'reader' }, reader)),
      facts(rows),
      inner ?? null,
    );
  }

  private arpLayer(arp: ArpPacket): HTMLElement {
    const asking = arp.op === 'request';
    return this.layer('ARP', 'arp', 'Stays on one LAN. Never crosses a router.', [
      ['Says', asking ? `Who has ${formatIp(arp.targetIp)}?` : `${formatIp(arp.senderIp)} is at ${arp.senderMac}`],
      ['Sender', `${formatIp(arp.senderIp)} at ${arp.senderMac}`],
      ['Target', asking ? `${formatIp(arp.targetIp)}, hardware address unknown` : `${formatIp(arp.targetIp)} at ${arp.targetMac}`],
    ]);
  }

  private ipLayer(packet: Ipv4Packet): HTMLElement {
    const rows: Row[] = [
      ['From', formatIp(packet.src)],
      ['To', formatIp(packet.dst)],
      ['Hops left (TTL)', String(packet.ttl)],
      ['Packet id', String(packet.id)],
    ];
    const inner =
      packet.protocol === 'icmp'
        ? this.icmpLayer(packet.payload)
        : packet.protocol === 'udp'
          ? this.layer(
              'UDP',
              'udp',
              'Read by the two hosts. No connection, no guarantees.',
              [
                ['From port', String(packet.payload.srcPort)],
                ['To port', String(packet.payload.dstPort)],
              ],
              packet.payload.data.kind === 'dns'
                ? this.dnsLayer(packet.payload.data.message)
                : this.dataLayer(packet.payload.data.text),
            )
          : this.tcpLayer(packet.payload);
    return this.layer('IPv4', 'ip', 'Read by routers. Unchanged end to end, apart from the TTL.', rows, inner);
  }

  private icmpLayer(message: IcmpMessage): HTMLElement {
    const reader = 'Read by the host it is addressed to.';
    switch (message.type) {
      case 'echo-request':
      case 'echo-reply':
        return this.layer('ICMP', 'icmp', reader, [
          ['Says', message.type === 'echo-request' ? 'Are you there?' : 'Yes, I am here.'],
          ['Sequence', String(message.seq)],
        ]);
      case 'dest-unreachable':
      case 'time-exceeded': {
        const about = message.original;
        return this.layer('ICMP', 'icmp', reader, [
          [
            'Says',
            message.type === 'time-exceeded'
              ? 'Your packet ran out of hops before it arrived.'
              : `Could not deliver your packet: ${message.code} unreachable.`,
          ],
          ['About', `the packet from ${formatIp(about.src)} to ${formatIp(about.dst)}, id ${about.id}`],
        ]);
      }
    }
  }

  private tcpLayer(segment: TcpSegment): HTMLElement {
    const flags = [segment.syn && 'SYN', segment.fin && 'FIN', segment.rst && 'RST', segment.ack && 'ACK'].filter(Boolean);
    const rows: Row[] = [
      ['From port', String(segment.srcPort)],
      ['To port', String(segment.dstPort)],
      ['Flags', flags.join(' · ') || 'none'],
      ['Sequence number', String(segment.seq)],
    ];
    if (segment.ack) rows.push(['Acknowledges up to', String(segment.ackNo)]);
    rows.push(['Window', `${segment.window} bytes`]);
    return this.layer(
      'TCP',
      'tcp',
      'Read only by the two ends of the connection.',
      rows,
      segment.data.length > 0 ? this.dataLayer(segment.data) : null,
    );
  }

  private dnsLayer(message: DnsMessage): HTMLElement {
    const rows: Row[] = [
      ['Is a', message.response ? 'response' : 'question'],
      ['Transaction id', String(message.id)],
      ['Asks', `${message.question.type} record for ${message.question.name || '.'}`],
    ];
    if (message.response) {
      rows.push(['Result', message.rcode === 'NOERROR' ? 'no error' : message.rcode]);
      rows.push(['From the authority', message.authoritative ? 'yes' : 'no']);
    } else {
      rows.push(['Do the legwork for me', message.recursionDesired ? 'yes' : 'no']);
    }
    const lists: [string, readonly DnsRecord[]][] = [
      ['Answers', message.answers],
      ['Ask these servers', message.authority],
      ['Their addresses', message.additional],
    ];
    for (const [label, records] of lists) {
      if (records.length > 0) rows.push([label, h('span', { class: 'records' }, ...records.map((r) => h('span', null, describeRecord(r))))]);
    }
    return this.layer('DNS', 'dns', 'Read by the name server or the asker.', rows);
  }

  private dataLayer(text: string): HTMLElement {
    return h(
      'div',
      { class: 'layer data' },
      h('header', null, h('span', { class: 'name' }, 'Data'), h('span', { class: 'reader' }, `${text.length} bytes, read by the application.`)),
      h('pre', null, printable(text)),
    );
  }

  // --------------------------------------------------------------- helpers ----

  private labelOf(id: string): string {
    return this.scenario.places[id]?.label ?? id;
  }

  private farEnd(nic: Nic): string {
    const link = nic.link;
    if (!link) return 'nothing';
    const far = link.a === nic ? link.b : link.a;
    return `${this.labelOf(far.owner.id)}${link.up ? '' : ' (cut)'}`;
  }

  /** The device that owns a hardware address, by its label. */
  private ownerOf(mac: Mac): string {
    for (const device of this.scenario.sim.devices.values()) {
      if (device.nics.some((nic) => nic.mac === mac)) return this.labelOf(device.id);
    }
    return 'unknown';
  }
}

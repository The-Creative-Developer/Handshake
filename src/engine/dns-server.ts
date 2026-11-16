import {
  DNS_PORT,
  ancestorsOf,
  dnsReply,
  isWithin,
  normalizeName,
  type DnsMessage,
  type DnsRecord,
  type DnsRecordType,
  type DnsReplyFields,
} from './dns';
import type { IpNode } from './ipnode';

export interface Zone {
  /** The name at the top of the zone, e.g. "example.com". The root zone is "". */
  readonly origin: string;
  readonly records: DnsRecord[];
}

/** How far a server will follow a chain of aliases through its own zones. */
const MAX_ALIAS_HOPS = 8;

/**
 * An authoritative name server. It answers only from the zones it holds: an
 * answer for names it owns, a referral for names it has delegated to another
 * server, and a refusal for everything else. It never asks other servers.
 */
export class DnsServer {
  readonly zones: Zone[] = [];

  constructor(
    readonly node: IpNode,
    zones: { origin: string; records: DnsRecord[] }[] = [],
  ) {
    for (const zone of zones) this.addZone(zone.origin, zone.records);
    const socket = node.udp.bind(DNS_PORT);
    socket.onMessage = (message) => {
      if (message.data.kind !== 'dns' || message.data.message.response) return;
      const reply = this.respond(message.data.message);
      socket.send(message.from, message.fromPort, { kind: 'dns', message: reply }, { from: message.to });
    };
  }

  addZone(origin: string, records: DnsRecord[] = []): Zone {
    const name = normalizeName(origin);
    if (this.zones.some((zone) => zone.origin === name)) throw new Error(`Zone "${name}" is already served here`);
    for (const record of records) {
      if (!isWithin(record.name, name)) throw new Error(`"${record.name}" is not inside zone "${name}"`);
    }
    const zone: Zone = { origin: name, records: [...records] };
    this.zones.push(zone);
    return zone;
  }

  /** Adds a record to whichever zone here holds its name. */
  addRecord(record: DnsRecord): void {
    const zone = this.zoneFor(record.name);
    if (!zone) throw new Error(`No zone here holds "${record.name}"`);
    zone.records.push(record);
  }

  /** Works out the response to a query. This has no side effects, so it can be called directly. */
  respond(query: DnsMessage): DnsMessage {
    let name: string;
    try {
      name = normalizeName(query.question.name);
    } catch {
      return dnsReply(query, { rcode: 'SERVFAIL' });
    }
    const zone = this.zoneFor(name);
    if (!zone) return dnsReply(query, { rcode: 'REFUSED' });

    const delegation = this.delegationFor(zone, name);
    if (delegation) {
      // Someone else is the authority below this point. Say who, and where to find them.
      return dnsReply(query, { authority: delegation, additional: this.addressesOf(delegation) });
    }
    return dnsReply(query, { authoritative: true, ...this.lookup(zone, name, query.question.type) });
  }

  /** The most specific zone served here that contains `name`. */
  private zoneFor(name: string): Zone | undefined {
    let best: Zone | undefined;
    for (const zone of this.zones) {
      if (isWithin(name, zone.origin) && (!best || zone.origin.length > best.origin.length)) best = zone;
    }
    return best;
  }

  /** NS records for the highest delegation point between the zone's top and `name`, if there is one. */
  private delegationFor(zone: Zone, name: string): DnsRecord[] | undefined {
    const below = ancestorsOf(name).filter((n) => n !== zone.origin && isWithin(n, zone.origin));
    for (const point of below.reverse()) {
      const ns = zone.records.filter((record) => record.type === 'NS' && record.name === point);
      if (ns.length > 0) return ns;
    }
    return undefined;
  }

  private lookup(zone: Zone, name: string, type: DnsRecordType): DnsReplyFields {
    const here = zone.records.filter((record) => record.name === name);
    const exact = here.filter((record) => record.type === type);
    if (exact.length > 0) {
      return { answers: exact, additional: type === 'NS' ? this.addressesOf(exact) : [] };
    }
    const alias = here.find((record) => record.type === 'CNAME');
    if (alias) return { answers: this.followAlias(alias, type) };

    // The name exists if it has other records or if any record lies beneath it.
    const exists = name === zone.origin || zone.records.some((record) => isWithin(record.name, name));
    return exists ? {} : { rcode: 'NXDOMAIN' };
  }

  /** Returns the alias followed by as much of its chain as this server can answer for. */
  private followAlias(alias: DnsRecord, type: DnsRecordType): DnsRecord[] {
    const answers = [alias];
    let next: DnsRecord | undefined = alias;
    for (let hop = 0; hop < MAX_ALIAS_HOPS && next?.type === 'CNAME'; hop++) {
      const target: string = next.target;
      const zone = this.zoneFor(target);
      if (!zone || this.delegationFor(zone, target)) break;
      const there = zone.records.filter((record) => record.name === target);
      const found = there.filter((record) => record.type === type);
      if (found.length > 0) {
        answers.push(...found);
        break;
      }
      next = there.find((record) => record.type === 'CNAME');
      if (next) answers.push(next);
    }
    return answers;
  }

  /** Address records held here for the hosts named by a set of NS records. */
  private addressesOf(ns: DnsRecord[]): DnsRecord[] {
    const hosts = new Set(ns.flatMap((record) => (record.type === 'NS' ? [record.host] : [])));
    return this.zones.flatMap((zone) => zone.records.filter((record) => record.type === 'A' && hosts.has(record.name)));
  }
}

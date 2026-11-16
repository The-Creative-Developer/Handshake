import { ip, type Ipv4 } from './addr';

export const DNS_PORT = 53;

export type DnsRecordType = 'A' | 'NS' | 'CNAME';

/** A resource record. `ttl` is in seconds, as on the wire. */
export type DnsRecord =
  | { readonly name: string; readonly type: 'A'; readonly ttl: number; readonly address: Ipv4 }
  | { readonly name: string; readonly type: 'NS'; readonly ttl: number; readonly host: string }
  | { readonly name: string; readonly type: 'CNAME'; readonly ttl: number; readonly target: string };

export type DnsRcode = 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL' | 'REFUSED';

export interface DnsQuestion {
  readonly name: string;
  readonly type: DnsRecordType;
}

export interface DnsMessage {
  /** 16-bit transaction id. A response must echo the id of the query it answers. */
  readonly id: number;
  readonly response: boolean;
  readonly recursionDesired: boolean;
  readonly recursionAvailable: boolean;
  /** Set when the responder is the authority for the name, rather than repeating what it was told. */
  readonly authoritative: boolean;
  readonly rcode: DnsRcode;
  readonly question: DnsQuestion;
  readonly answers: readonly DnsRecord[];
  readonly authority: readonly DnsRecord[];
  readonly additional: readonly DnsRecord[];
}

/**
 * Puts a domain name in canonical form: lower case, no trailing dot. The root
 * is the empty string.
 */
export function normalizeName(name: string): string {
  const trimmed = name.trim().toLowerCase().replace(/\.$/, '');
  if (trimmed === '') return '';
  for (const label of trimmed.split('.')) {
    if (!/^[a-z0-9_-]{1,63}$/.test(label)) throw new Error(`Invalid domain name: "${name}"`);
  }
  return trimmed;
}

/** True when `name` is `zone` itself or lies beneath it. Both must be normalised. */
export function isWithin(name: string, zone: string): boolean {
  return zone === '' || name === zone || name.endsWith(`.${zone}`);
}

/** The name followed by each of its parents, ending with the root: a.b.c, b.c, c, "". */
export function ancestorsOf(name: string): string[] {
  const out: string[] = [];
  let current = name;
  while (current !== '') {
    out.push(current);
    const dot = current.indexOf('.');
    current = dot === -1 ? '' : current.slice(dot + 1);
  }
  out.push('');
  return out;
}

export function aRecord(name: string, address: string | Ipv4, ttl = 300): DnsRecord {
  return { name: normalizeName(name), type: 'A', ttl, address: typeof address === 'string' ? ip(address) : address };
}

export function nsRecord(name: string, host: string, ttl = 3600): DnsRecord {
  return { name: normalizeName(name), type: 'NS', ttl, host: normalizeName(host) };
}

export function cnameRecord(name: string, target: string, ttl = 300): DnsRecord {
  return { name: normalizeName(name), type: 'CNAME', ttl, target: normalizeName(target) };
}

export function dnsQuery(id: number, name: string, type: DnsRecordType, recursionDesired: boolean): DnsMessage {
  return {
    id,
    response: false,
    recursionDesired,
    recursionAvailable: false,
    authoritative: false,
    rcode: 'NOERROR',
    question: { name, type },
    answers: [],
    authority: [],
    additional: [],
  };
}

export type DnsReplyFields = Partial<
  Pick<DnsMessage, 'rcode' | 'authoritative' | 'recursionAvailable' | 'answers' | 'authority' | 'additional'>
>;

/** Builds the response to `query`, echoing its id and question. */
export function dnsReply(query: DnsMessage, fields: DnsReplyFields = {}): DnsMessage {
  return {
    id: query.id,
    response: true,
    recursionDesired: query.recursionDesired,
    recursionAvailable: fields.recursionAvailable ?? false,
    authoritative: fields.authoritative ?? false,
    rcode: fields.rcode ?? 'NOERROR',
    question: query.question,
    answers: fields.answers ?? [],
    authority: fields.authority ?? [],
    additional: fields.additional ?? [],
  };
}

export function sameQuestion(a: DnsQuestion, b: DnsQuestion): boolean {
  return a.name === b.name && a.type === b.type;
}

/** The value a record points at, ignoring its name and TTL. */
export function recordData(record: DnsRecord): string {
  switch (record.type) {
    case 'A':
      return String(record.address);
    case 'NS':
      return record.host;
    case 'CNAME':
      return record.target;
  }
}

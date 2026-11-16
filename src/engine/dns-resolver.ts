import { ip, type Ipv4 } from './addr';
import {
  DNS_PORT,
  ancestorsOf,
  dnsQuery,
  dnsReply,
  isWithin,
  normalizeName,
  recordData,
  sameQuestion,
  type DnsMessage,
  type DnsRecord,
  type DnsRecordType,
} from './dns';
import type { IpNode } from './ipnode';
import { SECOND } from './sim';
import type { DnsRejectReason } from './trace';

export interface DnsResolverOptions {
  /** Addresses of the root name servers: where every lookup starts when nothing is cached. */
  rootServers: string[];
  /** How long to wait for one server before trying the next. Defaults to 1 s. */
  queryTimeoutUs?: number;
  /** How long to remember that a name or record does not exist, in seconds. Defaults to 60. */
  negativeTtl?: number;
}

/** What a resolution produced: the alias chain followed, then the records asked for. */
export interface DnsOutcome {
  readonly rcode: 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL';
  readonly answers: DnsRecord[];
}

/**
 * Data from an answer outranks data that only came along with a referral, so
 * a parent zone's hint can never overwrite what the authority itself said.
 */
type Rank = 'answer' | 'referral';

interface CacheEntry {
  readonly records: DnsRecord[];
  readonly expiresAt: number;
  readonly rank: Rank;
}

interface Task {
  readonly name: string;
  readonly type: DnsRecordType;
  /** How many resolutions deep this is: 0 for a client's question, more when looking up a name server's address. */
  readonly depth: number;
  queries: number;
  /** Name servers whose own address could not be found. */
  readonly deadHosts: Set<string>;
  readonly done: (outcome: DnsOutcome) => void;
}

const MAX_ALIAS_HOPS = 8;
const MAX_DEPTH = 4;
const MAX_QUERIES = 32;

/**
 * A caching recursive resolver. Clients send it a question and it does the
 * legwork: starting from the root servers it follows referrals down to the
 * server that holds the answer, remembering everything it learns on the way.
 */
export class DnsResolver {
  private readonly roots: Ipv4[];
  private readonly queryTimeoutUs: number;
  private readonly negativeTtl: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    readonly node: IpNode,
    options: DnsResolverOptions,
  ) {
    this.roots = options.rootServers.map(ip);
    this.queryTimeoutUs = options.queryTimeoutUs ?? SECOND;
    this.negativeTtl = options.negativeTtl ?? 60;

    const socket = node.udp.bind(DNS_PORT);
    socket.onMessage = (message) => {
      if (message.data.kind !== 'dns' || message.data.message.response) return;
      const query = message.data.message;
      const respond = (reply: DnsMessage) =>
        socket.send(message.from, message.fromPort, { kind: 'dns', message: reply }, { from: message.to });

      if (!query.recursionDesired) {
        respond(dnsReply(query, { rcode: 'REFUSED', recursionAvailable: true }));
        return;
      }
      let name: string;
      try {
        name = normalizeName(query.question.name);
      } catch {
        respond(dnsReply(query, { rcode: 'SERVFAIL', recursionAvailable: true }));
        return;
      }
      this.resolve(name, query.question.type, (outcome) =>
        respond(dnsReply(query, { rcode: outcome.rcode, answers: outcome.answers, recursionAvailable: true })),
      );
    };
  }

  /** Resolves a name. `done` is called once, from inside the simulation. */
  resolve(name: string, type: DnsRecordType, done: (outcome: DnsOutcome) => void): void {
    this.start(normalizeName(name), type, 0, done);
  }

  /** The unexpired cached records for a name, with the time each has left. */
  cached(name: string, type: DnsRecordType): DnsRecord[] | undefined {
    return this.read(`${type} ${normalizeName(name)}`);
  }

  /** Forgets everything learned so far. */
  flush(): void {
    this.cache.clear();
  }

  // -------------------------------------------------------------- lookup ----

  private start(name: string, type: DnsRecordType, depth: number, done: (outcome: DnsOutcome) => void): void {
    this.advance({ name, type, depth, queries: 0, deadHosts: new Set(), done });
  }

  /**
   * Gets as far as the cache allows, then asks the network for the first thing
   * missing. Every useful response lands in the cache and calls this again, so
   * a lookup is just this step repeated until the cache can answer in full.
   */
  private advance(task: Task): void {
    const chain: DnsRecord[] = [];
    let name = task.name;
    for (let hop = 0; hop <= MAX_ALIAS_HOPS; hop++) {
      if (this.read(`NXDOMAIN ${name}`)) {
        task.done({ rcode: 'NXDOMAIN', answers: chain });
        return;
      }
      // A client is only given what an authority actually answered, never a
      // parent zone's hint. Hints are good enough for finding name servers.
      const records = this.read(`${task.type} ${name}`, task.depth === 0);
      if (records) {
        task.done({ rcode: 'NOERROR', answers: [...chain, ...records] });
        return;
      }
      const alias = task.type === 'CNAME' ? undefined : this.read(`CNAME ${name}`)?.[0];
      if (alias?.type !== 'CNAME') {
        this.askFor(task, name);
        return;
      }
      chain.push(alias);
      name = alias.target;
    }
    task.done({ rcode: 'SERVFAIL', answers: [] }); // an alias loop
  }

  private askFor(task: Task, name: string): void {
    const { zone, addresses, unresolved } = this.serversFor(name, task.deadHosts);
    if (addresses.length > 0) {
      this.query(task, name, zone, addresses, 0);
      return;
    }
    // The zone's servers are known by name only. Find an address for one of them first.
    const host = unresolved[0];
    if (host === undefined || task.depth >= MAX_DEPTH) {
      task.done({ rcode: 'SERVFAIL', answers: [] });
      return;
    }
    this.start(host, 'A', task.depth + 1, () => {
      // Only an address cached under the server's own name makes it usable.
      if (!this.read(`A ${host}`)?.length) task.deadHosts.add(host);
      this.advance(task);
    });
  }

  /**
   * The closest zone to `name` with name servers that can be reached, falling
   * back to the root. `unresolved` lists servers known by name only whose
   * address is worth looking up.
   */
  private serversFor(name: string, dead: Set<string>): { zone: string; addresses: Ipv4[]; unresolved: string[] } {
    for (const zone of ancestorsOf(name)) {
      if (zone === '') break;
      const servers = this.read(`NS ${zone}`);
      if (!servers || servers.length === 0) continue;
      const addresses: Ipv4[] = [];
      const unresolved: string[] = [];
      for (const server of servers) {
        if (server.type !== 'NS') continue;
        const known = this.read(`A ${server.host}`) ?? [];
        const found = known.flatMap((record) => (record.type === 'A' ? [record.address] : []));
        if (found.length > 0) addresses.push(...found);
        // A server named inside the zone it serves can only be found through the
        // parent zone: asking the zone itself would be asking the server we lack.
        else if (!isWithin(server.host, zone) && !dead.has(server.host)) unresolved.push(server.host);
      }
      // Nothing usable here. Go up a level, where the delegation will be issued afresh.
      if (addresses.length === 0 && unresolved.length === 0) continue;
      return { zone, addresses, unresolved };
    }
    return { zone: '', addresses: this.roots, unresolved: [] };
  }

  /** Sends the question to `addresses[index]`, moving to the next server if it fails. */
  private query(task: Task, name: string, zone: string, addresses: Ipv4[], index: number): void {
    const server = addresses[index];
    if (server === undefined || ++task.queries > MAX_QUERIES) {
      task.done({ rcode: 'SERVFAIL', answers: [] });
      return;
    }
    const sim = this.node.sim;
    // A fresh random port and id for every query: a forged response has to guess both.
    const socket = this.node.udp.bind();
    const id = this.node.rng.int(0, 0xffff);
    const question = { name, type: task.type };

    const finish = () => {
      timer.cancel();
      socket.close();
    };
    const tryNext = () => {
      finish();
      this.query(task, name, zone, addresses, index + 1);
    };
    const timer = sim.schedule(this.queryTimeoutUs, tryNext);
    socket.onError = tryNext;
    socket.onMessage = (incoming) => {
      const reply = incoming.data.kind === 'dns' ? incoming.data.message : undefined;
      if (!reply) return;
      if (!reply.response || incoming.from !== server || incoming.fromPort !== DNS_PORT || reply.id !== id) {
        this.reject('no-matching-query', incoming.from, reply);
        return;
      }
      if (!sameQuestion(reply.question, question)) {
        this.reject('question-mismatch', incoming.from, reply);
        return;
      }
      finish();
      if (this.digest(name, task.type, zone, server, reply)) this.advance(task);
      else this.query(task, name, zone, addresses, index + 1);
    };
    socket.send(server, DNS_PORT, { kind: 'dns', message: dnsQuery(id, name, task.type, false) });
  }

  /**
   * Stores what a response teaches. Returns false when it teaches nothing, in
   * which case the caller should ask another server.
   */
  private digest(name: string, type: DnsRecordType, zone: string, server: Ipv4, reply: DnsMessage): boolean {
    if (reply.rcode === 'NXDOMAIN') {
      this.write(`NXDOMAIN ${name}`, name, type, [], 'answer', server, 'NXDOMAIN');
      return true;
    }
    if (reply.rcode !== 'NOERROR') return false;

    // A server is only believed about names inside the zone it was asked about.
    // Without this, any server could plant records for someone else's domain.
    const inBailiwick = (record: DnsRecord): boolean => {
      if (isWithin(record.name, zone)) return true;
      this.reject('out-of-bailiwick', server, reply, record);
      return false;
    };

    const answers = reply.answers.filter(inBailiwick);
    if (answers.length > 0) {
      if (!answers.some((record) => record.name === name && (record.type === type || record.type === 'CNAME'))) {
        return false;
      }
      for (const [key, set] of groupBySet(answers)) this.write(key, set[0]!.name, set[0]!.type, set, 'answer', server);
      return true;
    }

    const referral = reply.authority.filter((record) => record.type === 'NS' && inBailiwick(record));
    const cut = referral[0]?.name;
    if (cut !== undefined && cut !== zone && isWithin(cut, zone) && isWithin(name, cut)) {
      const servers = referral.filter((record) => record.name === cut);
      const hosts = new Set(servers.flatMap((record) => (record.type === 'NS' ? [record.host] : [])));
      const glue = reply.additional.filter(
        (record) => record.type === 'A' && hosts.has(record.name) && inBailiwick(record),
      );
      this.write(`NS ${cut}`, cut, 'NS', servers, 'referral', server);
      for (const [key, set] of groupBySet(glue)) this.write(key, set[0]!.name, 'A', set, 'referral', server);
      return true;
    }

    if (reply.authoritative) {
      // The name exists but has no record of this type.
      this.write(`${type} ${name}`, name, type, [], 'answer', server);
      return true;
    }
    return false;
  }

  // --------------------------------------------------------------- cache ----

  private read(key: string, answersOnly = false): DnsRecord[] | undefined {
    const entry = this.cache.get(key);
    if (!entry || (answersOnly && entry.rank !== 'answer')) return undefined;
    const now = this.node.sim.now;
    if (now > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    const ttl = Math.ceil((entry.expiresAt - now) / SECOND);
    return entry.records.map((record) => ({ ...record, ttl }));
  }

  private write(
    key: string,
    name: string,
    type: DnsRecordType,
    records: DnsRecord[],
    rank: Rank,
    from: Ipv4,
    rcode: 'NOERROR' | 'NXDOMAIN' = 'NOERROR',
  ): void {
    const now = this.node.sim.now;
    const current = this.cache.get(key);
    const live = current && now <= current.expiresAt ? current : undefined;
    if (live && live.rank === 'answer' && rank === 'referral') return;

    const ttl = records.length > 0 ? Math.min(...records.map((record) => record.ttl)) : this.negativeTtl;
    this.cache.set(key, { records, expiresAt: now + ttl * SECOND, rank });

    const signature = (set: DnsRecord[]) => set.map(recordData).sort().join(' ');
    const change = !live ? 'add' : signature(live.records) === signature(records) ? 'refresh' : 'update';
    this.node.sim.record({ kind: 'dns-cache', device: this.node.id, name, type, rcode, records, from, change });
  }

  private reject(reason: DnsRejectReason, from: Ipv4, message: DnsMessage, record?: DnsRecord): void {
    this.node.sim.record({
      kind: 'dns-reject',
      device: this.node.id,
      from,
      reason,
      message,
      ...(record ? { record } : {}),
    });
  }
}

/** Groups records into sets that share a name and type, keyed as the cache keys them. */
function groupBySet(records: DnsRecord[]): Map<string, DnsRecord[]> {
  const sets = new Map<string, DnsRecord[]>();
  for (const record of records) {
    const key = `${record.type} ${record.name}`;
    const set = sets.get(key);
    if (set) set.push(record);
    else sets.set(key, [record]);
  }
  return sets;
}

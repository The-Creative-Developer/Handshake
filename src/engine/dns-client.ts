import { ip, type Ipv4 } from './addr';
import { DNS_PORT, dnsQuery, normalizeName, sameQuestion, type DnsMessage } from './dns';
import type { IpNode } from './ipnode';
import { SECOND } from './sim';

export type LookupFailure = 'no-servers' | 'timeout' | 'unreachable' | 'servfail' | 'refused';

export type LookupResult =
  | {
      readonly status: 'ok';
      readonly addresses: Ipv4[];
      /** Names the lookup was redirected through, in order. */
      readonly aliases: string[];
      readonly server: Ipv4;
    }
  /** The name does not exist. */
  | { readonly status: 'nxdomain'; readonly server: Ipv4 }
  /** The name exists but has no address. */
  | { readonly status: 'nodata'; readonly server: Ipv4 }
  | { readonly status: 'failed'; readonly reason: LookupFailure };

export interface DnsClientOptions {
  /** Addresses of the recursive resolvers to ask, in order of preference. */
  servers?: string[];
  /** How long to wait for each reply. Defaults to 2 s. */
  timeoutUs?: number;
  /** How many times to go round the server list. Defaults to 2. */
  attempts?: number;
}

/**
 * The small resolver every host has: it asks a recursive resolver to do the
 * work and waits for the finished answer. It keeps no cache of its own.
 */
export class DnsClient {
  servers: Ipv4[];
  private readonly timeoutUs: number;
  private readonly attempts: number;

  constructor(
    readonly node: IpNode,
    options: DnsClientOptions = {},
  ) {
    this.servers = (options.servers ?? []).map(ip);
    this.timeoutUs = options.timeoutUs ?? 2 * SECOND;
    this.attempts = options.attempts ?? 2;
  }

  /** Looks up the addresses for a name. `done` is called once, from inside the simulation. */
  lookup(name: string, done: (result: LookupResult) => void): void {
    const qname = normalizeName(name);
    const order = Array.from({ length: this.attempts }, () => this.servers).flat();
    if (order.length === 0) {
      this.node.sim.schedule(0, () => done({ status: 'failed', reason: 'no-servers' }));
      return;
    }
    this.ask(qname, order, 0, 'timeout', done);
  }

  private ask(
    name: string,
    order: Ipv4[],
    index: number,
    lastFailure: LookupFailure,
    done: (result: LookupResult) => void,
  ): void {
    const server = order[index];
    if (server === undefined) {
      done({ status: 'failed', reason: lastFailure });
      return;
    }
    const socket = this.node.udp.bind();
    const id = this.node.rng.int(0, 0xffff);
    const question = { name, type: 'A' as const };

    const finish = () => {
      timer.cancel();
      socket.close();
    };
    const tryNext = (failure: LookupFailure) => {
      finish();
      this.ask(name, order, index + 1, failure, done);
    };
    const timer = this.node.sim.schedule(this.timeoutUs, () => tryNext('timeout'));
    socket.onError = () => tryNext('unreachable');
    socket.onMessage = (incoming) => {
      const reply = incoming.data.kind === 'dns' ? incoming.data.message : undefined;
      if (!reply) return;
      const expected =
        reply.response && incoming.from === server && incoming.fromPort === DNS_PORT && reply.id === id;
      if (!expected || !sameQuestion(reply.question, question)) {
        this.node.sim.record({
          kind: 'dns-reject',
          device: this.node.id,
          from: incoming.from,
          reason: expected ? 'question-mismatch' : 'no-matching-query',
          message: reply,
        });
        return;
      }
      if (!reply.recursionAvailable) {
        // An authoritative-only server would hand back a referral this client cannot follow.
        tryNext('refused');
        return;
      }
      switch (reply.rcode) {
        case 'NOERROR':
          finish();
          done(readAnswer(name, reply, server));
          return;
        case 'NXDOMAIN':
          finish();
          done({ status: 'nxdomain', server });
          return;
        case 'SERVFAIL':
          tryNext('servfail');
          return;
        case 'REFUSED':
          tryNext('refused');
          return;
      }
    };
    socket.send(server, DNS_PORT, { kind: 'dns', message: dnsQuery(id, name, 'A', true) });
  }
}

/** Follows the alias chain in a response from `name` to the addresses at its end. */
function readAnswer(name: string, reply: DnsMessage, server: Ipv4): LookupResult {
  const aliases: string[] = [];
  let current = name;
  for (let hop = 0; hop < reply.answers.length; hop++) {
    const alias = reply.answers.find((record) => record.type === 'CNAME' && record.name === current);
    if (alias?.type !== 'CNAME') break;
    aliases.push(alias.target);
    current = alias.target;
  }
  const addresses = reply.answers.flatMap((record) =>
    record.type === 'A' && record.name === current ? [record.address] : [],
  );
  return addresses.length > 0 ? { status: 'ok', addresses, aliases, server } : { status: 'nodata', server };
}

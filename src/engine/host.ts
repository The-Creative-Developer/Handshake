import type { Ipv4 } from './addr';
import { DnsClient, type LookupResult } from './dns-client';
import { IpNode, type IpNodeOptions } from './ipnode';
import type { Nic } from './link';
import type { Simulation } from './sim';

export interface HostConfig extends Omit<IpNodeOptions, 'forwarding'> {
  /** Interface address with prefix length, e.g. "10.0.0.5/24". */
  address: string;
  /** Default gateway, e.g. "10.0.0.1". Omit for a host that only talks to its own subnet. */
  gateway?: string;
  /** Recursive resolvers this host sends its name lookups to. */
  dnsServers?: string[];
}

/** An end device with a single interface. */
export class Host extends IpNode {
  readonly nic: Nic;
  readonly address: Ipv4;
  readonly dns: DnsClient;

  constructor(sim: Simulation, id: string, config: HostConfig) {
    const { address, gateway, dnsServers, ...options } = config;
    super(sim, id, { ...options, forwarding: false });
    this.nic = this.addNic('eth0');
    this.address = this.configureInterface(this.nic, address).address;
    if (gateway !== undefined) this.addRoute('0.0.0.0/0', gateway);
    this.dns = new DnsClient(this, { servers: dnsServers });
  }

  /** Looks up the addresses for a name using this host's configured resolvers. */
  lookup(name: string, done: (result: LookupResult) => void): void {
    this.dns.lookup(name, done);
  }
}

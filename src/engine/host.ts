import type { Ipv4 } from './addr';
import { IpNode, type IpNodeOptions } from './ipnode';
import type { Nic } from './link';
import type { Simulation } from './sim';

export interface HostConfig extends Omit<IpNodeOptions, 'forwarding'> {
  /** Interface address with prefix length, e.g. "10.0.0.5/24". */
  address: string;
  /** Default gateway, e.g. "10.0.0.1". Omit for a host that only talks to its own subnet. */
  gateway?: string;
}

/** An end device with a single interface. */
export class Host extends IpNode {
  readonly nic: Nic;
  readonly address: Ipv4;

  constructor(sim: Simulation, id: string, config: HostConfig) {
    const { address, gateway, ...options } = config;
    super(sim, id, { ...options, forwarding: false });
    this.nic = this.addNic('eth0');
    this.address = this.configureInterface(this.nic, address).address;
    if (gateway !== undefined) this.addRoute('0.0.0.0/0', gateway);
  }
}

import { IpNode, type IpNodeOptions } from './ipnode';
import type { Nic } from './link';
import type { Simulation } from './sim';

/** A device that forwards IP packets between the subnets it is attached to. */
export class Router extends IpNode {
  constructor(sim: Simulation, id: string, options: Omit<IpNodeOptions, 'forwarding'> = {}) {
    super(sim, id, { ...options, forwarding: true });
  }

  /** Adds an interface with an address such as "10.0.0.1/24" and returns it for cabling. */
  addInterface(address: string, name?: string): Nic {
    const nic = this.addNic(name);
    this.configureInterface(nic, address);
    return nic;
  }
}

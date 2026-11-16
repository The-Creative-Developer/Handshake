import { Nic } from './link';
import type { EthernetFrame } from './packets';
import type { Simulation } from './sim';

/** Anything with network interfaces: a host, a switch, a router. */
export abstract class Device {
  readonly nics: Nic[] = [];

  constructor(
    readonly sim: Simulation,
    readonly id: string,
  ) {
    sim.register(this);
  }

  addNic(name = `eth${this.nics.length}`): Nic {
    if (this.nics.some((nic) => nic.name === name)) {
      throw new Error(`${this.id} already has an interface named "${name}"`);
    }
    const nic = new Nic(this, name, this.sim.allocateMac());
    this.nics.push(nic);
    return nic;
  }

  /** Called when one of this device's interfaces accepts a frame. */
  abstract onFrame(nic: Nic, frame: EthernetFrame): void;
}

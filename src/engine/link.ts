import { BROADCAST_MAC, type Mac } from './addr';
import type { Device } from './device';
import type { EthernetFrame } from './packets';
import { MS, type Simulation } from './sim';

/** A network interface: one end of a cable, owned by a device. */
export class Nic {
  link: Link | null = null;
  /** When set, the interface accepts every frame, not only those addressed to it. */
  promiscuous = false;

  constructor(
    readonly owner: Device,
    readonly name: string,
    readonly mac: Mac,
  ) {}

  send(frame: EthernetFrame): void {
    const sim = this.owner.sim;
    if (!this.link || !this.link.up) {
      sim.record({ kind: 'frame-drop', device: this.owner.id, iface: this.name, frame, reason: 'no-carrier' });
      return;
    }
    sim.record({ kind: 'frame-tx', device: this.owner.id, iface: this.name, frame });
    this.link.transmit(this, frame);
  }

  /** Called by the link when a frame arrives at this end. */
  receive(frame: EthernetFrame): void {
    const sim = this.owner.sim;
    if (!this.promiscuous && frame.dst !== this.mac && frame.dst !== BROADCAST_MAC) {
      sim.record({ kind: 'frame-drop', device: this.owner.id, iface: this.name, frame, reason: 'mac-filter' });
      return;
    }
    sim.record({ kind: 'frame-rx', device: this.owner.id, iface: this.name, frame });
    this.owner.onFrame(this, frame);
  }
}

export interface LinkOptions {
  /** One-way delay in microseconds. Defaults to 1 ms. */
  latencyUs?: number;
  /** Probability in [0, 1] that a frame is lost in transit. Defaults to 0. */
  lossRate?: number;
}

/** A point-to-point cable between two interfaces. */
export class Link {
  up = true;
  latencyUs: number;
  lossRate: number;
  /**
   * When set, only frames for which this returns true get through. It models a
   * faulty or tampered cable, and lets a scenario lose one chosen frame.
   */
  filter: ((frame: EthernetFrame, from: Nic) => boolean) | null = null;

  constructor(
    private readonly sim: Simulation,
    readonly a: Nic,
    readonly b: Nic,
    options: LinkOptions = {},
  ) {
    this.latencyUs = options.latencyUs ?? MS;
    this.lossRate = options.lossRate ?? 0;
  }

  transmit(from: Nic, frame: EthernetFrame): void {
    const to = from === this.a ? this.b : this.a;
    const dropAt = (reason: 'link-loss' | 'link-down') =>
      this.sim.record({ kind: 'frame-drop', device: from.owner.id, iface: from.name, frame, reason });

    // The generator is only consulted on lossy links, so adding a clean link
    // elsewhere never shifts the random sequence the lossy ones see.
    if (this.filter && !this.filter(frame, from)) {
      dropAt('link-loss');
      return;
    }
    if (this.lossRate > 0 && this.sim.rng.next() < this.lossRate) {
      dropAt('link-loss');
      return;
    }
    this.sim.schedule(this.latencyUs, () => {
      // The cable may have been cut while the frame was in flight.
      if (!this.up) {
        dropAt('link-down');
        return;
      }
      to.receive(frame);
    });
  }
}

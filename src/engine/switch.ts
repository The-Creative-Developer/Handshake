import { BROADCAST_MAC, type Mac } from './addr';
import { Device } from './device';
import type { Nic } from './link';
import type { EthernetFrame } from './packets';
import { SECOND, type Simulation } from './sim';

interface MacEntry {
  port: Nic;
  learnedAt: number;
}

/**
 * A learning Ethernet switch. It remembers which port each source address was
 * last seen on, sends known unicast frames out of that one port, and floods
 * broadcasts and unknown destinations out of every other port.
 */
export class Switch extends Device {
  /** How long a learned address is trusted without being seen again. */
  agingUs = 300 * SECOND;
  private readonly table = new Map<Mac, MacEntry>();

  constructor(sim: Simulation, id: string, portCount = 4) {
    super(sim, id);
    for (let i = 0; i < portCount; i++) this.addPort();
  }

  addPort(): Nic {
    const port = this.addNic(`p${this.nics.length}`);
    port.promiscuous = true;
    return port;
  }

  /** Returns an unconnected port, adding one if all are in use. */
  freePort(): Nic {
    return this.nics.find((port) => !port.link) ?? this.addPort();
  }

  /** The port a MAC address is currently learned on, if any. */
  portFor(mac: Mac): Nic | undefined {
    const entry = this.table.get(mac);
    if (!entry) return undefined;
    if (this.sim.now - entry.learnedAt > this.agingUs) {
      this.table.delete(mac);
      return undefined;
    }
    return entry.port;
  }

  onFrame(ingress: Nic, frame: EthernetFrame): void {
    this.learn(frame.src, ingress);

    const out = frame.dst === BROADCAST_MAC ? undefined : this.portFor(frame.dst);
    if (out === ingress) {
      // The destination is back the way the frame came, so it has already seen it.
      this.sim.record({ kind: 'frame-drop', device: this.id, iface: ingress.name, frame, reason: 'same-port' });
      return;
    }
    if (out) {
      out.send(frame);
      return;
    }
    for (const port of this.nics) {
      if (port !== ingress && port.link) port.send(frame);
    }
  }

  private learn(mac: Mac, port: Nic): void {
    if (mac === BROADCAST_MAC) return;
    const known = this.portFor(mac);
    this.table.set(mac, { port, learnedAt: this.sim.now });
    if (known !== port) this.sim.record({ kind: 'mac-learn', device: this.id, mac, port: port.name });
  }
}

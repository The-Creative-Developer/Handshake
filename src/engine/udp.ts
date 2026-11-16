import { ip, type Ipv4 } from './addr';
import type { IpNode } from './ipnode';
import type { UdpData, UdpPacket, UnreachableCode } from './packets';
import type { Rng } from './rng';

/** A datagram as handed to the application that owns the receiving socket. */
export interface UdpMessage {
  readonly from: Ipv4;
  readonly fromPort: number;
  /** The local address the datagram was sent to. Reply from this address. */
  readonly to: Ipv4;
  readonly data: UdpData;
}

/** The network's report that an earlier datagram from this socket could not be delivered. */
export interface UdpError {
  readonly to: Ipv4;
  readonly toPort: number;
  /** The node that reported the failure. */
  readonly from: Ipv4;
  readonly reason: UnreachableCode | 'ttl-exceeded';
}

const EPHEMERAL_MIN = 49152;
const EPHEMERAL_MAX = 65535;

export class UdpSocket {
  onMessage: ((message: UdpMessage) => void) | null = null;
  onError: ((error: UdpError) => void) | null = null;
  private open = true;

  constructor(
    private readonly layer: UdpLayer,
    readonly port: number,
  ) {}

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Sends a datagram. `from` picks the source address on a node with several;
   * by default it is the address of the interface the datagram leaves by.
   */
  send(to: string | Ipv4, port: number, data: UdpData, options: { from?: Ipv4 } = {}): void {
    if (!this.open) throw new Error(`UDP socket on port ${this.port} is closed`);
    this.layer.transmit(this, typeof to === 'string' ? ip(to) : to, port, data, options.from);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.layer.release(this);
  }
}

/** A node's UDP layer: the table of bound ports and the hand-off to and from IP. */
export class UdpLayer {
  private readonly sockets = new Map<number, UdpSocket>();

  constructor(
    private readonly node: IpNode,
    private readonly rng: Rng,
  ) {}

  /**
   * Opens a socket on `port`. With no port, picks a random free one from the
   * ephemeral range, as real stacks do to make replies harder to forge.
   */
  bind(port?: number): UdpSocket {
    let chosen = port;
    if (chosen === undefined) {
      do chosen = this.rng.int(EPHEMERAL_MIN, EPHEMERAL_MAX);
      while (this.sockets.has(chosen));
    } else if (!Number.isInteger(chosen) || chosen < 1 || chosen > 65535) {
      throw new Error(`Invalid UDP port: ${chosen}`);
    } else if (this.sockets.has(chosen)) {
      throw new Error(`${this.node.id} already has UDP port ${chosen} in use`);
    }
    const socket = new UdpSocket(this, chosen);
    this.sockets.set(chosen, socket);
    return socket;
  }

  hasListener(port: number): boolean {
    return this.sockets.has(port);
  }

  /** Called by the socket. */
  transmit(socket: UdpSocket, to: Ipv4, port: number, data: UdpData, from: Ipv4 | undefined): void {
    const sent = this.node.sendPacket(
      to,
      { protocol: 'udp', payload: { srcPort: socket.port, dstPort: port, data } },
      { src: from },
    );
    if (sent) return;
    // No route at all: report it the way a remote router would, but never synchronously.
    const reporter = this.node.interfaces[0]?.address ?? 0;
    this.node.sim.schedule(0, () => this.notify(socket, { to, toPort: port, from: reporter, reason: 'net' }));
  }

  /** Called by the socket when it closes. */
  release(socket: UdpSocket): void {
    if (this.sockets.get(socket.port) === socket) this.sockets.delete(socket.port);
  }

  /** Called by the IP layer with a datagram addressed to this node. */
  receive(packet: UdpPacket): void {
    const datagram = packet.payload;
    this.sockets.get(datagram.dstPort)?.onMessage?.({
      from: packet.src,
      fromPort: datagram.srcPort,
      to: packet.dst,
      data: datagram.data,
    });
  }

  /** Called by the IP layer when an ICMP error arrives about a datagram this node sent. */
  fail(original: UdpPacket, reason: UdpError['reason'], from: Ipv4): void {
    const socket = this.sockets.get(original.payload.srcPort);
    if (socket) this.notify(socket, { to: original.dst, toPort: original.payload.dstPort, from, reason });
  }

  private notify(socket: UdpSocket, error: UdpError): void {
    if (socket.isOpen) socket.onError?.(error);
  }
}

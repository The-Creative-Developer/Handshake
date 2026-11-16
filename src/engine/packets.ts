import type { Ipv4, Mac } from './addr';
import type { DnsMessage } from './dns';

/**
 * Packets are plain immutable objects rather than byte buffers: the inspector
 * can show them directly and the trace can serialise them. Never mutate one
 * after it has been sent; copy it instead (a router does this to lower TTL).
 */

export interface ArpPacket {
  readonly op: 'request' | 'reply';
  readonly senderMac: Mac;
  readonly senderIp: Ipv4;
  readonly targetMac: Mac;
  readonly targetIp: Ipv4;
}

export type UnreachableCode = 'net' | 'host' | 'port';

export type IcmpMessage =
  | { readonly type: 'echo-request'; readonly id: number; readonly seq: number }
  | { readonly type: 'echo-reply'; readonly id: number; readonly seq: number }
  | { readonly type: 'dest-unreachable'; readonly code: UnreachableCode; readonly original: Ipv4Packet }
  | { readonly type: 'time-exceeded'; readonly original: Ipv4Packet };

/** What a UDP datagram carries: free text for simple applications, or a DNS message. */
export type UdpData =
  | { readonly kind: 'raw'; readonly text: string }
  | { readonly kind: 'dns'; readonly message: DnsMessage };

export interface UdpDatagram {
  readonly srcPort: number;
  readonly dstPort: number;
  readonly data: UdpData;
}

/**
 * A TCP segment. `data` is text, one character per byte. Sequence numbers
 * count bytes and wrap at 2^32; SYN and FIN each take up one number.
 */
export interface TcpSegment {
  readonly srcPort: number;
  readonly dstPort: number;
  /** Sequence number of the first byte of `data` (or of the SYN or FIN itself). */
  readonly seq: number;
  /** The next sequence number the sender expects to receive. Only meaningful when `ack` is set. */
  readonly ackNo: number;
  readonly syn: boolean;
  readonly ack: boolean;
  readonly fin: boolean;
  readonly rst: boolean;
  /** How many more bytes the sender is willing to receive. */
  readonly window: number;
  readonly data: string;
}

/** The transport-specific part of an IP packet. */
export type IpBody =
  | { readonly protocol: 'icmp'; readonly payload: IcmpMessage }
  | { readonly protocol: 'udp'; readonly payload: UdpDatagram }
  | { readonly protocol: 'tcp'; readonly payload: TcpSegment };

interface Ipv4Header {
  readonly src: Ipv4;
  readonly dst: Ipv4;
  readonly ttl: number;
  readonly id: number;
}

export type Ipv4Packet = Ipv4Header & IpBody;
export type IcmpPacket = Extract<Ipv4Packet, { protocol: 'icmp' }>;
export type UdpPacket = Extract<Ipv4Packet, { protocol: 'udp' }>;
export type TcpPacket = Extract<Ipv4Packet, { protocol: 'tcp' }>;

export type EthernetFrame =
  | { readonly src: Mac; readonly dst: Mac; readonly etherType: 'arp'; readonly payload: ArpPacket }
  | { readonly src: Mac; readonly dst: Mac; readonly etherType: 'ipv4'; readonly payload: Ipv4Packet };

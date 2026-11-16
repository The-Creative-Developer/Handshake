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

/** The transport-specific part of an IP packet. TCP will join this union. */
export type IpBody =
  | { readonly protocol: 'icmp'; readonly payload: IcmpMessage }
  | { readonly protocol: 'udp'; readonly payload: UdpDatagram };

interface Ipv4Header {
  readonly src: Ipv4;
  readonly dst: Ipv4;
  readonly ttl: number;
  readonly id: number;
}

export type Ipv4Packet = Ipv4Header & IpBody;
export type IcmpPacket = Extract<Ipv4Packet, { protocol: 'icmp' }>;
export type UdpPacket = Extract<Ipv4Packet, { protocol: 'udp' }>;

export type EthernetFrame =
  | { readonly src: Mac; readonly dst: Mac; readonly etherType: 'arp'; readonly payload: ArpPacket }
  | { readonly src: Mac; readonly dst: Mac; readonly etherType: 'ipv4'; readonly payload: Ipv4Packet };

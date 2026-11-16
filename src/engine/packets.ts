import type { Ipv4, Mac } from './addr';

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

export type UnreachableCode = 'net' | 'host';

export type IcmpMessage =
  | { readonly type: 'echo-request'; readonly id: number; readonly seq: number }
  | { readonly type: 'echo-reply'; readonly id: number; readonly seq: number }
  | { readonly type: 'dest-unreachable'; readonly code: UnreachableCode; readonly original: Ipv4Packet }
  | { readonly type: 'time-exceeded'; readonly original: Ipv4Packet };

/** ICMP is the only transport so far; TCP and UDP will join this as further union members. */
export interface Ipv4Packet {
  readonly src: Ipv4;
  readonly dst: Ipv4;
  readonly ttl: number;
  readonly id: number;
  readonly protocol: 'icmp';
  readonly payload: IcmpMessage;
}

export type EthernetFrame =
  | { readonly src: Mac; readonly dst: Mac; readonly etherType: 'arp'; readonly payload: ArpPacket }
  | { readonly src: Mac; readonly dst: Mac; readonly etherType: 'ipv4'; readonly payload: Ipv4Packet };

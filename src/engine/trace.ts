import { formatIp, type Ipv4, type Mac } from './addr';
import type { EthernetFrame, Ipv4Packet } from './packets';

export type FrameDropReason = 'no-carrier' | 'link-down' | 'link-loss' | 'mac-filter' | 'same-port';
export type IpDropReason = 'no-route' | 'ttl-exceeded' | 'arp-timeout' | 'arp-queue-full' | 'not-for-me';

/**
 * Everything observable that happens in a run. Events hold only plain data
 * (device ids and interface names, never object references) so the trace can
 * be serialised, diffed between runs and replayed by the timeline.
 */
export type TraceBody =
  | { readonly kind: 'frame-tx'; readonly device: string; readonly iface: string; readonly frame: EthernetFrame }
  | { readonly kind: 'frame-rx'; readonly device: string; readonly iface: string; readonly frame: EthernetFrame }
  | {
      readonly kind: 'frame-drop';
      readonly device: string;
      readonly iface: string;
      readonly frame: EthernetFrame;
      readonly reason: FrameDropReason;
    }
  | { readonly kind: 'mac-learn'; readonly device: string; readonly mac: Mac; readonly port: string }
  | {
      readonly kind: 'arp-cache';
      readonly device: string;
      readonly iface: string;
      readonly ip: Ipv4;
      readonly mac: Mac;
      readonly change: 'add' | 'update';
    }
  | { readonly kind: 'ip-forward'; readonly device: string; readonly iface: string; readonly packet: Ipv4Packet }
  | { readonly kind: 'ip-deliver'; readonly device: string; readonly packet: Ipv4Packet }
  | { readonly kind: 'ip-drop'; readonly device: string; readonly packet: Ipv4Packet; readonly reason: IpDropReason };

/** `seq` is the event's index in the trace; `t` is simulated time in microseconds. */
export type TraceEvent = TraceBody & { readonly seq: number; readonly t: number };

export function describePacket(packet: Ipv4Packet): string {
  const route = `${formatIp(packet.src)} → ${formatIp(packet.dst)}`;
  const icmp = packet.payload;
  switch (icmp.type) {
    case 'echo-request':
      return `ICMP echo request ${route} seq=${icmp.seq} ttl=${packet.ttl}`;
    case 'echo-reply':
      return `ICMP echo reply ${route} seq=${icmp.seq} ttl=${packet.ttl}`;
    case 'dest-unreachable':
      return `ICMP ${icmp.code} unreachable ${route} (for ${formatIp(icmp.original.dst)})`;
    case 'time-exceeded':
      return `ICMP time exceeded ${route} (for ${formatIp(icmp.original.dst)})`;
  }
}

export function describeFrame(frame: EthernetFrame): string {
  if (frame.etherType === 'ipv4') return describePacket(frame.payload);
  const arp = frame.payload;
  return arp.op === 'request'
    ? `ARP who has ${formatIp(arp.targetIp)}? tell ${formatIp(arp.senderIp)}`
    : `ARP ${formatIp(arp.senderIp)} is at ${arp.senderMac}`;
}

/** One-line, human-readable summary of an event, for logs and the trace panel. */
export function describeEvent(event: TraceBody): string {
  switch (event.kind) {
    case 'frame-tx':
    case 'frame-rx':
      return describeFrame(event.frame);
    case 'frame-drop':
      return `${describeFrame(event.frame)} [${event.reason}]`;
    case 'mac-learn':
      return `${event.mac} is on port ${event.port}`;
    case 'arp-cache':
      return `${formatIp(event.ip)} is at ${event.mac} (${event.change})`;
    case 'ip-forward':
      return `${describePacket(event.packet)} out ${event.iface}`;
    case 'ip-deliver':
      return describePacket(event.packet);
    case 'ip-drop':
      return `${describePacket(event.packet)} [${event.reason}]`;
  }
}

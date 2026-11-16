import { formatIp, type Ipv4, type Mac } from './addr';
import type { DnsMessage, DnsRecord, DnsRecordType } from './dns';
import type { EthernetFrame, Ipv4Packet } from './packets';

export type FrameDropReason = 'no-carrier' | 'link-down' | 'link-loss' | 'mac-filter' | 'same-port';
export type IpDropReason =
  | 'no-route'
  | 'ttl-exceeded'
  | 'arp-timeout'
  | 'arp-queue-full'
  | 'not-for-me'
  | 'port-closed';
export type DnsRejectReason = 'no-matching-query' | 'question-mismatch' | 'out-of-bailiwick';

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
  | { readonly kind: 'ip-drop'; readonly device: string; readonly packet: Ipv4Packet; readonly reason: IpDropReason }
  | {
      /** A resolver stored what it learned. An empty `records` with NOERROR means "this name has no such record". */
      readonly kind: 'dns-cache';
      readonly device: string;
      readonly name: string;
      readonly type: DnsRecordType;
      readonly rcode: 'NOERROR' | 'NXDOMAIN';
      readonly records: readonly DnsRecord[];
      /** The server the data came from. */
      readonly from: Ipv4;
      readonly change: 'add' | 'update' | 'refresh';
    }
  | {
      /** A resolver or client refused to believe a response, or one record inside it. */
      readonly kind: 'dns-reject';
      readonly device: string;
      readonly from: Ipv4;
      readonly reason: DnsRejectReason;
      readonly message: DnsMessage;
      readonly record?: DnsRecord;
    };

/** `seq` is the event's index in the trace; `t` is simulated time in microseconds. */
export type TraceEvent = TraceBody & { readonly seq: number; readonly t: number };

export function describeRecord(record: DnsRecord): string {
  const name = record.name || '.';
  switch (record.type) {
    case 'A':
      return `${name} A ${formatIp(record.address)}`;
    case 'NS':
      return `${name} NS ${record.host}`;
    case 'CNAME':
      return `${name} CNAME ${record.target}`;
  }
}

export function describeDns(message: DnsMessage): string {
  const question = `${message.question.type} ${message.question.name || '.'}`;
  if (!message.response) return `DNS query ${question}`;
  if (message.rcode !== 'NOERROR') return `DNS response ${question}: ${message.rcode}`;
  if (message.answers.length > 0) return `DNS response ${question}: ${message.answers.map(describeRecord).join(', ')}`;
  const referral = message.authority.find((record) => record.type === 'NS');
  if (referral) return `DNS response ${question}: ask the servers for ${referral.name || '.'}`;
  return `DNS response ${question}: no such record`;
}

export function describePacket(packet: Ipv4Packet): string {
  if (packet.protocol === 'udp') {
    const { srcPort, dstPort, data } = packet.payload;
    const route = `${formatIp(packet.src)}:${srcPort} → ${formatIp(packet.dst)}:${dstPort}`;
    return data.kind === 'dns' ? `${describeDns(data.message)} (${route})` : `UDP ${route} "${data.text}"`;
  }
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
    case 'dns-cache': {
      const subject = `${event.type} ${event.name || '.'}`;
      if (event.rcode === 'NXDOMAIN') return `${event.name} does not exist, says ${formatIp(event.from)}`;
      if (event.records.length === 0) return `${subject}: no such record, says ${formatIp(event.from)}`;
      return `${event.records.map(describeRecord).join(', ')} from ${formatIp(event.from)} (${event.change})`;
    }
    case 'dns-reject': {
      const what = event.record ? describeRecord(event.record) : describeDns(event.message);
      return `${what} from ${formatIp(event.from)} [${event.reason}]`;
    }
  }
}

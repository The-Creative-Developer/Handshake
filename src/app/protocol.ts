import type { EthernetFrame } from '../engine';
import type { Family } from './theme';

export interface Tag {
  readonly family: Family;
  /** A few characters that say what the frame is, short enough to ride on a token. */
  readonly label: string;
}

/** Classifies a frame for display: which protocol family it belongs to and a short label. */
export function tagOf(frame: EthernetFrame): Tag {
  if (frame.etherType === 'arp') {
    return { family: 'arp', label: frame.payload.op === 'request' ? 'ARP ?' : 'ARP ✓' };
  }
  const packet = frame.payload;
  switch (packet.protocol) {
    case 'icmp': {
      const type = packet.payload.type;
      const label =
        type === 'echo-request' ? 'PING' : type === 'echo-reply' ? 'PONG' : type === 'time-exceeded' ? 'TTL ✕' : 'UNREACH';
      return { family: 'icmp', label };
    }
    case 'udp': {
      const data = packet.payload.data;
      if (data.kind !== 'dns') return { family: 'udp', label: 'UDP' };
      const message = data.message;
      if (!message.response) return { family: 'dns', label: 'DNS ?' };
      if (message.rcode !== 'NOERROR') return { family: 'dns', label: 'DNS ✕' };
      return { family: 'dns', label: message.answers.length > 0 ? 'DNS ✓' : 'DNS →' };
    }
    case 'tcp': {
      const segment = packet.payload;
      if (segment.rst) return { family: 'tcp', label: 'RST' };
      if (segment.syn) return { family: 'tcp', label: segment.ack ? 'SYN·ACK' : 'SYN' };
      if (segment.fin) return { family: 'tcp', label: 'FIN' };
      if (segment.data.length > 0) return { family: 'tcp', label: `${segment.data.length} B` };
      return { family: 'tcp', label: 'ACK' };
    }
  }
}

export const FAMILY_NAME: Record<Family, string> = {
  arp: 'ARP',
  icmp: 'ICMP',
  dns: 'DNS',
  udp: 'UDP',
  tcp: 'TCP',
};

/** Simulated microseconds as seconds with millisecond precision, e.g. "0.056 s". */
export function formatClock(us: number): string {
  return `${(us / 1_000_000).toFixed(3)} s`;
}

/** A duration in whichever unit reads best. */
export function formatDuration(us: number): string {
  if (us >= 1_000_000) return `${(us / 1_000_000).toFixed(us >= 10_000_000 ? 0 : 1)} s`;
  return `${(us / 1000).toFixed(us >= 100_000 ? 0 : 1)} ms`;
}

/** A MAC address in lowercase colon notation, e.g. "02:00:00:00:00:01". */
export type Mac = string;

/** An IPv4 address held as an unsigned 32-bit integer. */
export type Ipv4 = number;

export const BROADCAST_MAC: Mac = 'ff:ff:ff:ff:ff:ff';
export const ZERO_MAC: Mac = '00:00:00:00:00:00';
export const BROADCAST_IP: Ipv4 = 0xffffffff;

export function ip(text: string): Ipv4 {
  const parts = text.split('.');
  if (parts.length !== 4) throw new Error(`Invalid IPv4 address: "${text}"`);
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) {
      throw new Error(`Invalid IPv4 address: "${text}"`);
    }
    value = value * 256 + Number(part);
  }
  return value;
}

export function formatIp(addr: Ipv4): string {
  return [addr >>> 24, (addr >>> 16) & 255, (addr >>> 8) & 255, addr & 255].join('.');
}

/** An address block such as 10.0.0.0/24. `network` always has its host bits cleared. */
export interface Cidr {
  readonly network: Ipv4;
  readonly prefix: number;
}

export function maskOf(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

function splitPrefix(text: string): { address: Ipv4; prefix: number } {
  const [addrText, prefixText, ...rest] = text.split('/');
  if (addrText === undefined || prefixText === undefined || rest.length > 0 || !/^\d{1,2}$/.test(prefixText)) {
    throw new Error(`Invalid CIDR: "${text}"`);
  }
  const prefix = Number(prefixText);
  if (prefix > 32) throw new Error(`Invalid CIDR: "${text}"`);
  return { address: ip(addrText), prefix };
}

export function cidr(text: string): Cidr {
  const { address, prefix } = splitPrefix(text);
  return { network: (address & maskOf(prefix)) >>> 0, prefix };
}

/** Parses an interface address like "10.0.0.5/24" into the address and the subnet it sits in. */
export function interfaceAddress(text: string): { address: Ipv4; subnet: Cidr } {
  const { address, prefix } = splitPrefix(text);
  return { address, subnet: { network: (address & maskOf(prefix)) >>> 0, prefix } };
}

export function inCidr(addr: Ipv4, block: Cidr): boolean {
  return (addr & maskOf(block.prefix)) >>> 0 === block.network;
}

export function broadcastOf(block: Cidr): Ipv4 {
  return (block.network | ~maskOf(block.prefix)) >>> 0;
}

export function formatCidr(block: Cidr): string {
  return `${formatIp(block.network)}/${block.prefix}`;
}

/** Builds a locally administered unicast MAC from a counter, so addresses are stable across runs. */
export function macFromIndex(index: number): Mac {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error(`MAC index out of range: ${index}`);
  }
  const octets = [0x02, 0x00, index >>> 24, (index >>> 16) & 255, (index >>> 8) & 255, index & 255];
  return octets.map((o) => o.toString(16).padStart(2, '0')).join(':');
}

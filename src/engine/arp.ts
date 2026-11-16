import type { Ipv4, Mac } from './addr';

interface ArpEntry {
  mac: Mac;
  updatedAt: number;
}

/**
 * One interface's table of IP-to-MAC mappings. Entries expire by age, checked
 * when they are read, so an idle cache schedules nothing.
 */
export class ArpCache {
  private readonly entries = new Map<Ipv4, ArpEntry>();

  constructor(private readonly ttlUs: number) {}

  lookup(address: Ipv4, now: number): Mac | undefined {
    const entry = this.entries.get(address);
    if (!entry) return undefined;
    if (now - entry.updatedAt > this.ttlUs) {
      this.entries.delete(address);
      return undefined;
    }
    return entry.mac;
  }

  /** Stores a mapping and reports whether it was new, changed, or merely refreshed. */
  set(address: Ipv4, mac: Mac, now: number): 'add' | 'update' | 'refresh' {
    const previous = this.lookup(address, now);
    this.entries.set(address, { mac, updatedAt: now });
    if (previous === undefined) return 'add';
    return previous === mac ? 'refresh' : 'update';
  }

  /** The unexpired entries, for display. */
  snapshot(now: number): { address: Ipv4; mac: Mac }[] {
    const live: { address: Ipv4; mac: Mac }[] = [];
    for (const address of [...this.entries.keys()]) {
      const mac = this.lookup(address, now);
      if (mac !== undefined) live.push({ address, mac });
    }
    return live;
  }
}

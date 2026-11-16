/**
 * The palette, for canvas drawing. The same values are declared as CSS custom
 * properties in style.css for everything drawn with DOM; keep the two in step.
 */
export const INK = '#191612';
export const PAPER = '#f3eee3';
export const MUTED = '#6b6357';
export const RULE = '#cdc3ae';
export const ALERT = '#dd3c22';

export type Family = 'arp' | 'icmp' | 'dns' | 'udp' | 'tcp';

/** One colour per protocol family, used for packet tokens everywhere they appear. */
export const FAMILY_COLOR: Record<Family, string> = {
  arp: '#d39a1c',
  icmp: '#b8436f',
  dns: '#2a4fd0',
  udp: '#5d6b78',
  tcp: '#0e7c6a',
};

/** Text colour that reads on top of each family colour. */
export const FAMILY_TEXT: Record<Family, string> = {
  arp: INK,
  icmp: '#fff',
  dns: '#fff',
  udp: '#fff',
  tcp: '#fff',
};

export const FONT_SANS = "'Instrument Sans Variable', sans-serif";
export const FONT_SERIF = "'Instrument Serif', serif";
export const FONT_MONO = "'Spline Sans Mono Variable', monospace";

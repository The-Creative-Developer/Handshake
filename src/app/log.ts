import { describeEvent, type EthernetFrame, type TraceEvent } from '../engine';
import { clear, h } from './dom';
import { formatClock, tagOf } from './protocol';

/** Rows kept in the page at once. Older ones are dropped from the top. */
const MAX_ROWS = 400;

/** Events that only repeat what a send already said. Shown when "every step" is on. */
const QUIET_KINDS = new Set<TraceEvent['kind']>(['frame-rx', 'ip-deliver', 'ip-forward', 'mac-learn']);

const MARKS: Partial<Record<TraceEvent['kind'], [text: string, tone: string]>> = {
  'frame-rx': ['received', 'plain'],
  'frame-drop': ['lost', 'alert'],
  'ip-drop': ['dropped', 'alert'],
  'tcp-drop': ['dropped', 'alert'],
  'dns-reject': ['rejected', 'alert'],
  'ip-deliver': ['delivered', 'plain'],
  'ip-forward': ['forwarded', 'plain'],
  'mac-learn': ['learned', 'learn'],
  'arp-cache': ['learned', 'learn'],
  'dns-cache': ['cached', 'learn'],
  'tcp-state': ['state', 'tcp'],
  'tcp-retransmit': ['resend', 'tcp'],
};

type Entry =
  | { readonly kind: 'event'; readonly event: TraceEvent }
  | { readonly kind: 'note'; readonly t: number; readonly device: string; readonly text: string };

function frameOf(event: TraceEvent): EthernetFrame | undefined {
  return 'frame' in event ? event.frame : undefined;
}

/**
 * The running record under the map: one line per thing that happened on the
 * wire, plus the outcomes that applications report.
 */
export class WireLog {
  private readonly entries: Entry[] = [];
  private verbose = false;
  private selected: HTMLElement | null = null;
  /** While set, new entries are stored but not drawn. */
  private loading = false;

  constructor(
    private readonly list: HTMLElement,
    /** Names the device at the far end of a cable, for "from → to". */
    private readonly peerOf: (device: string, iface: string) => string | undefined,
    private readonly onPick: (frame: EthernetFrame) => void,
  ) {}

  add(event: TraceEvent): void {
    const entry: Entry = { kind: 'event', event };
    this.entries.push(entry);
    if (!this.loading && this.shows(entry)) this.appendRow(entry);
  }

  note(t: number, device: string, text: string): void {
    const entry: Entry = { kind: 'note', t, device, text };
    this.entries.push(entry);
    if (!this.loading) this.appendRow(entry);
  }

  /** Empties the log and holds off drawing, ready for a stretch of history to be loaded in one go. */
  beginLoad(): void {
    this.entries.length = 0;
    this.loading = true;
  }

  /** Draws what was loaded. */
  endLoad(): void {
    this.loading = false;
    this.setVerbose(this.verbose);
  }

  setVerbose(verbose: boolean): void {
    this.verbose = verbose;
    clear(this.list);
    this.selected = null;
    const visible = this.entries.filter((entry) => this.shows(entry)).slice(-MAX_ROWS);
    for (const entry of visible) this.list.appendChild(this.row(entry));
    this.list.scrollTop = this.list.scrollHeight;
  }

  private shows(entry: Entry): boolean {
    return entry.kind === 'note' || this.verbose || !QUIET_KINDS.has(entry.event.kind);
  }

  private appendRow(entry: Entry): void {
    // Follow the newest line only if the reader has not scrolled back to look at something.
    const following = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
    this.list.appendChild(this.row(entry));
    while (this.list.childElementCount > MAX_ROWS) this.list.firstElementChild?.remove();
    if (following) this.list.scrollTop = this.list.scrollHeight;
  }

  private row(entry: Entry): HTMLElement {
    if (entry.kind === 'note') {
      return h(
        'li',
        { class: 'row note' },
        h('span', { class: 't' }, formatClock(entry.t)),
        h('span', { class: 'who' }, entry.device),
        h('span', { class: 'what' }, entry.text),
      );
    }
    const event = entry.event;
    const frame = frameOf(event);
    const peer = event.kind === 'frame-tx' ? this.peerOf(event.device, event.iface) : undefined;
    const mark = MARKS[event.kind];
    const row = h(
      'li',
      { class: frame ? 'row pickable' : 'row' },
      h('span', { class: 't' }, formatClock(event.t)),
      h('span', { class: 'who' }, peer ? `${event.device} → ${peer}` : event.device),
      frame && event.kind === 'frame-tx'
        ? h('span', { class: `token ${tagOf(frame).family}` }, tagOf(frame).label)
        : h('span', { class: `mark ${mark?.[1] ?? 'plain'}` }, mark?.[0] ?? event.kind),
      h('span', { class: 'what' }, describeEvent(event)),
    );
    if (frame) {
      row.addEventListener('click', () => {
        this.selected?.classList.remove('selected');
        this.selected = row;
        row.classList.add('selected');
        this.onPick(frame);
      });
    }
    return row;
  }
}

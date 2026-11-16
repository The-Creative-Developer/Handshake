import { GAP_PX } from './axis';
import { formatClock, formatDuration, tagOf } from './protocol';
import type { Session } from './session';
import { ALERT, FAMILY_COLOR, FONT_MONO, INK, MUTED, RULE, type Family } from './theme';

/** Space on the left for the lane names. */
const GUTTER = 62;
const MARK_Y = 13;
const LANE_TOP = 25;
const LANE_HEIGHT = 12;
const LABEL_Y = 86;
/** How close to the right edge the playhead may get before the strip scrolls. */
const LEAD = 90;
/** Blank space kept at either end of the content, so marks at the very start and end are not cut off. */
const PAD = 12;

const LANES: { name: string; families: Family[] }[] = [
  { name: 'ARP', families: ['arp'] },
  { name: 'DNS', families: ['dns', 'udp'] },
  { name: 'ICMP', families: ['icmp'] },
  { name: 'TCP', families: ['tcp'] },
];

const LANE_OF: Record<Family, number> = { arp: 0, dns: 1, udp: 1, icmp: 2, tcp: 3 };

/** Trace events that mean something was lost or refused, marked above the lanes. */
const TROUBLE = new Set(['frame-drop', 'ip-drop', 'tcp-drop', 'dns-reject']);

/**
 * The strip under the map: everything that has happened, laid out left to
 * right like a score, with one lane per protocol and a bar for each frame.
 * Dragging along it moves through time.
 */
export class TimelineStrip {
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private scroll = 0;
  private dragging = false;
  /** A moment asked for by the pointer and not yet acted on. At most one jump is made per screen frame. */
  private wanted: number | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly session: () => Session,
  ) {
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('pointerdown', (event) => {
      this.dragging = true;
      canvas.setPointerCapture(event.pointerId);
      this.wanted = this.timeAt(event);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (this.dragging) this.wanted = this.timeAt(event);
    });
    canvas.addEventListener('pointerup', () => (this.dragging = false));
    canvas.addEventListener('pointercancel', () => (this.dragging = false));
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.scroll += event.deltaX !== 0 ? event.deltaX : event.deltaY;
      },
      { passive: false },
    );
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * ratio);
    this.canvas.height = Math.round(rect.height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  /** The moment the pointer has asked to jump to since the last call, if any. */
  takeSeek(): number | null {
    const t = this.wanted;
    this.wanted = null;
    return t;
  }

  private timeAt(event: PointerEvent): number {
    const rect = this.canvas.getBoundingClientRect();
    return this.session().axis.toT(event.clientX - rect.left - GUTTER - PAD + this.scroll);
  }

  draw(): void {
    const ctx = this.ctx;
    const session = this.session();
    const axis = session.axis;
    const view = this.width - GUTTER;
    const playhead = axis.toX(session.clock);

    // Keep the playhead in view while it moves on its own or is being dragged.
    if (session.playing || this.dragging) {
      if (playhead - this.scroll > view - LEAD) this.scroll = playhead - (view - LEAD);
      if (playhead - this.scroll < LEAD / 2) this.scroll = playhead - LEAD / 2;
    }
    // Never scroll past either end; a recording that fits is not scrolled at all.
    this.scroll = Math.max(0, Math.min(this.scroll, axis.toX(session.head) + 2 * PAD - view));
    const x = (content: number) => GUTTER + PAD + content - this.scroll;

    ctx.clearRect(0, 0, this.width, this.height);
    ctx.textBaseline = 'middle';

    // Lane names and rules.
    ctx.font = `500 9px ${FONT_MONO}`;
    ctx.textAlign = 'right';
    LANES.forEach((lane, i) => {
      const y = LANE_TOP + i * LANE_HEIGHT + LANE_HEIGHT / 2;
      ctx.fillStyle = MUTED;
      ctx.fillText(lane.name, GUTTER - 12, y + 0.5);
      ctx.strokeStyle = RULE;
      ctx.lineWidth = 1;
      ctx.setLineDash([1, 3]);
      ctx.beginPath();
      ctx.moveTo(GUTTER, y);
      ctx.lineTo(this.width, y);
      ctx.stroke();
    });
    ctx.setLineDash([]);

    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, 0, view, this.height);
    ctx.clip();

    // One bar per frame, in its protocol's lane. Trouble is marked above.
    const { recording, ends } = session;
    const first = Math.max(0, axis.toT(this.scroll - PAD) - 2000);
    const last = axis.toT(this.scroll + view) + 2000;
    for (let i = 0; i < recording.length; i++) {
      const event = recording[i]!;
      if (event.t > last) break;
      if (ends[i]! < first) continue;
      if (event.kind === 'frame-tx') {
        const family = tagOf(event.frame).family;
        const x0 = x(axis.toX(event.t));
        const x1 = x(axis.toX(ends[i]!));
        ctx.fillStyle = FAMILY_COLOR[family];
        ctx.beginPath();
        ctx.roundRect(x0 + 0.5, LANE_TOP + LANE_OF[family] * LANE_HEIGHT + 3, Math.max(2, x1 - x0 - 1.5), 6, 3);
        ctx.fill();
      } else if (TROUBLE.has(event.kind) && !(event.kind === 'frame-drop' && event.reason === 'mac-filter')) {
        this.cross(x(axis.toX(event.t)), MARK_Y);
      }
    }

    // What the person did (rings) and what applications reported back (flags).
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    for (const { t } of session.inputs) {
      ctx.beginPath();
      ctx.arc(x(axis.toX(t)), MARK_Y, 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const note of session.notes) {
      const nx = x(axis.toX(note.t));
      ctx.beginPath();
      ctx.moveTo(nx, MARK_Y - 5);
      ctx.lineTo(nx + 7, MARK_Y - 1.5);
      ctx.lineTo(nx, MARK_Y + 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(nx - 0.75, MARK_Y - 5, 1.5, 10);
    }

    // Each burst is labelled with when it began; each silence with how long it lasted.
    ctx.font = `400 9px ${FONT_MONO}`;
    let labelledUpTo = -Infinity;
    axis.spans.forEach((span, i) => {
      const start = x(span.x);
      if (start - labelledUpTo > 56) {
        ctx.fillStyle = MUTED;
        ctx.textAlign = 'left';
        ctx.fillText(formatClock(span.start), start, LABEL_Y);
        labelledUpTo = start;
      }
      const previous = axis.spans[i - 1];
      if (!previous) return;
      const middle = start - GAP_PX / 2;
      ctx.strokeStyle = MUTED;
      ctx.lineWidth = 1;
      ctx.beginPath();
      // A break mark, the way a chart shows an axis with a piece left out.
      for (const dx of [-2.5, 2.5]) {
        ctx.moveTo(middle + dx - 2, LANE_TOP + 4 * LANE_HEIGHT);
        ctx.lineTo(middle + dx + 2, LANE_TOP);
      }
      ctx.stroke();
      ctx.fillStyle = MUTED;
      ctx.textAlign = 'center';
      ctx.fillText(formatDuration(span.start - previous.end), middle, MARK_Y);
    });

    // What lies ahead of the playhead has happened once already, and is shown faded.
    const px = x(playhead);
    if (session.inPast) {
      ctx.fillStyle = 'rgba(235, 228, 212, 0.68)';
      ctx.fillRect(px, 0, this.width - px, this.height);
    }

    // The playhead.
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, 6);
    ctx.lineTo(px, LANE_TOP + 4 * LANE_HEIGHT + 6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px - 5, 0);
    ctx.lineTo(px + 5, 0);
    ctx.lineTo(px + 5, 5);
    ctx.lineTo(px, 10);
    ctx.lineTo(px - 5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private cross(x: number, y: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = ALERT;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 3, y - 3);
    ctx.lineTo(x + 3, y + 3);
    ctx.moveTo(x + 3, y - 3);
    ctx.lineTo(x - 3, y + 3);
    ctx.stroke();
  }
}

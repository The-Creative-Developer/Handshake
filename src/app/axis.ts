/** A stretch of simulated time during which something was happening. */
export interface Span {
  start: number;
  end: number;
  /** Where the span begins on the strip, in pixels from the left of its content. */
  x: number;
}

/** Pixels per simulated microsecond inside a span: a 1 ms cable crossing is 9 px wide. */
const SCALE = 9 / 1000;
/** The width every stretch of silence is squeezed to, however long it lasted. */
export const GAP_PX = 36;
/** Things closer together than this belong to the same span. */
const JOIN_US = 4_000;

/**
 * Maps simulated time to a position on the timeline strip. Activity is drawn
 * to scale; the silences between bursts are squeezed to a fixed width, because
 * a minute of nothing should not push a tenth of a second of traffic off the
 * edge.
 */
export class Axis {
  readonly spans: Span[] = [];

  reset(): void {
    this.spans.length = 0;
  }

  /** Notes that something happened from `t0` to `t1`. Calls must come in order of `t0`. */
  add(t0: number, t1: number): void {
    const last = this.spans.at(-1);
    if (last && t0 <= last.end + JOIN_US) {
      last.end = Math.max(last.end, t1);
      return;
    }
    const x = last ? last.x + (last.end - last.start) * SCALE + GAP_PX : 0;
    this.spans.push({ start: t0, end: Math.max(t0, t1), x });
  }

  /** Width of everything recorded so far. */
  get width(): number {
    const last = this.spans.at(-1);
    return last ? last.x + (last.end - last.start) * SCALE : 0;
  }

  toX(t: number): number {
    const i = this.indexAt((span) => span.start <= t);
    const span = this.spans[i];
    if (!span) return 0;
    const endX = span.x + (span.end - span.start) * SCALE;
    if (t <= span.end) return span.x + (t - span.start) * SCALE;
    const next = this.spans[i + 1];
    // In the silence after a span: spread evenly across the gap if we know where it ends.
    if (next) return endX + (GAP_PX * (t - span.end)) / (next.start - span.end);
    return endX + Math.min((t - span.end) * SCALE, GAP_PX);
  }

  toT(x: number): number {
    const i = this.indexAt((span) => span.x <= x);
    const span = this.spans[i];
    if (!span) return 0;
    const length = (span.end - span.start) * SCALE;
    const dx = x - span.x;
    if (dx <= length) return span.start + dx / SCALE;
    const next = this.spans[i + 1];
    if (next) return span.end + (Math.min(dx - length, GAP_PX) / GAP_PX) * (next.start - span.end);
    return span.end + (dx - length) / SCALE;
  }

  /** Index of the last span for which `test` holds, given that it holds for a prefix of them. */
  private indexAt(test: (span: Span) => boolean): number {
    let low = 0;
    let high = this.spans.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (test(this.spans[mid]!)) {
        found = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    return found;
  }
}

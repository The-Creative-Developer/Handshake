import { IpNode, Router, Switch, formatIp, type EthernetFrame, type Link } from '../engine';
import { endOf, phaseOf, type Arc, type Flight, type Model, type Tone } from './model';
import type { Place, Scenario } from './scenario';
import { ALERT, FAMILY_COLOR, FAMILY_TEXT, FONT_MONO, FONT_SANS, INK, MUTED, PAPER } from './theme';

export type Selection =
  | { readonly kind: 'device'; readonly id: string }
  | { readonly kind: 'link'; readonly link: Link }
  | { readonly kind: 'frame'; readonly frame: EthernetFrame }
  | null;

interface Point {
  x: number;
  y: number;
}

/** Distance from a device's centre at which cables stop and tokens appear. */
const NODE_RADIUS = 25;
/** How far each direction of travel sits from the middle of the cable. */
const LANE = 10;
const TOKEN_HEIGHT = 18;
const MARGIN = { top: 96, right: 190, bottom: 132, left: 150 };

const TONE_COLOR: Record<Tone, string> = {
  rx: INK,
  learn: FAMILY_COLOR.arp,
  drop: ALERT,
  info: MUTED,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The map: cables, devices, frames in flight and connection arcs, drawn on a
 * canvas every screen frame. It also turns clicks and drags into selections
 * and moved devices.
 */
export class Scene {
  selection: Selection = null;
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private scale = 1;
  private origin: Point = { x: 0, y: 0 };
  private readonly bounds: { minX: number; minY: number; maxX: number; maxY: number };
  private hover: Selection = null;
  private drag: { id: string; moved: boolean; startX: number; startY: number } | null = null;
  /** Where each token was last drawn, for hit-testing. */
  private tokens: { flight: Flight; x: number; y: number; w: number }[] = [];
  private readonly listeners = new AbortController();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly scenario: Scenario,
    private readonly model: Model,
    private readonly onSelect: (selection: Selection) => void,
  ) {
    this.ctx = canvas.getContext('2d')!;
    const places = Object.values(scenario.places);
    this.bounds = {
      minX: Math.min(...places.map((p) => p.x)),
      minY: Math.min(...places.map((p) => p.y)),
      maxX: Math.max(...places.map((p) => p.x)),
      maxY: Math.max(...places.map((p) => p.y)),
    };
    const signal = this.listeners.signal;
    canvas.addEventListener('pointerdown', (e) => this.pointerDown(e), { signal });
    canvas.addEventListener('pointermove', (e) => this.pointerMove(e), { signal });
    canvas.addEventListener('pointerup', (e) => this.pointerUp(e), { signal });
    canvas.addEventListener('pointerleave', () => (this.hover = null), { signal });
  }

  /** Stops listening to the canvas. Call before replacing this scene with another. */
  dispose(): void {
    this.listeners.abort();
  }

  /** Matches the canvas to its element's size. Call when the layout changes. */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * ratio);
    this.canvas.height = Math.round(rect.height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    const spanX = Math.max(1, this.bounds.maxX - this.bounds.minX);
    const spanY = Math.max(1, this.bounds.maxY - this.bounds.minY);
    const roomX = Math.max(50, this.width - MARGIN.left - MARGIN.right);
    const roomY = Math.max(50, this.height - MARGIN.top - MARGIN.bottom);
    this.scale = Math.min(roomX / spanX, roomY / spanY, 1.5);
    this.origin = {
      x: MARGIN.left + (roomX - spanX * this.scale) / 2 - this.bounds.minX * this.scale,
      y: MARGIN.top + (roomY - spanY * this.scale) / 2 - this.bounds.minY * this.scale,
    };
  }

  draw(clockUs: number, nowMs: number): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    for (const arc of this.model.arcs.values()) this.drawArc(arc, nowMs);
    for (const link of this.scenario.sim.links) this.drawLink(link);
    this.tokens = [];
    for (const flight of this.model.flights) this.drawFlight(flight, clockUs, nowMs);
    for (const pulse of this.model.pulses) this.drawPulse(pulse.device, pulse.tone, nowMs - pulse.atMs);
    for (const id of Object.keys(this.scenario.places)) this.drawDevice(id);
    this.drawCaptions(nowMs);
    this.canvas.style.cursor = this.drag?.moved ? 'grabbing' : this.hover ? 'pointer' : 'default';
  }

  // ------------------------------------------------------------- geometry ----

  private at(id: string): Point {
    const place = this.scenario.places[id];
    if (!place) return { x: 0, y: 0 };
    return { x: this.origin.x + place.x * this.scale, y: this.origin.y + place.y * this.scale };
  }

  /** The visible part of a cable: from the edge of one device to the edge of the other. */
  private span(fromId: string, toId: string): { start: Point; end: Point; ux: number; uy: number } {
    const a = this.at(fromId);
    const b = this.at(toId);
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / length;
    const uy = (b.y - a.y) / length;
    const inset = Math.min(NODE_RADIUS, length / 2);
    return {
      start: { x: a.x + ux * inset, y: a.y + uy * inset },
      end: { x: b.x - ux * inset, y: b.y - uy * inset },
      ux,
      uy,
    };
  }

  // ---------------------------------------------------------------- cables ----

  private drawLink(link: Link): void {
    const ctx = this.ctx;
    const { start, end } = this.span(link.a.owner.id, link.b.owner.id);
    const selected = this.selection?.kind === 'link' && this.selection.link === link;
    const hovered = this.hover?.kind === 'link' && this.hover.link === link;
    const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };

    ctx.lineCap = 'round';
    if (selected || hovered) {
      ctx.strokeStyle = selected ? 'rgba(25, 22, 18, 0.16)' : 'rgba(25, 22, 18, 0.08)';
      ctx.lineWidth = 16;
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    }
    ctx.strokeStyle = link.up ? INK : ALERT;
    ctx.lineWidth = 4;
    ctx.setLineDash(link.up ? (link.lossRate > 0 ? [12, 9] : []) : [1, 11]);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.setLineDash([]);

    if (!link.up) {
      // A break in the line, marked the way a map marks a closed road.
      ctx.fillStyle = PAPER;
      ctx.strokeStyle = ALERT;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(mid.x, mid.y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mid.x - 3.5, mid.y - 3.5);
      ctx.lineTo(mid.x + 3.5, mid.y + 3.5);
      ctx.moveTo(mid.x + 3.5, mid.y - 3.5);
      ctx.lineTo(mid.x - 3.5, mid.y + 3.5);
      ctx.stroke();
    } else if (link.lossRate > 0) {
      this.badge(`${Math.round(link.lossRate * 100)}% loss`, mid.x, mid.y - 16, MUTED);
    }
  }

  private badge(text: string, x: number, y: number, color: string): void {
    const ctx = this.ctx;
    ctx.font = `500 10px ${FONT_MONO}`;
    const width = ctx.measureText(text).width + 10;
    ctx.fillStyle = PAPER;
    ctx.fillRect(x - width / 2, y - 8, width, 16);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
  }

  // ---------------------------------------------------------------- frames ----

  private drawFlight(flight: Flight, clockUs: number, nowMs: number): void {
    const ctx = this.ctx;
    const { start, end, ux, uy } = this.span(flight.from, flight.to);
    const stop = endOf(flight);
    const travelled = clamp((clockUs - flight.t0) / Math.max(1, flight.t1 - flight.t0), 0, (stop - flight.t0) / Math.max(1, flight.t1 - flight.t0));
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    // Frames that left together set off in single file, then close up so they all arrive on time.
    const along = clamp(travelled * length - flight.slot * 34 * (1 - travelled), 0, length);
    // Keep to the right, like road traffic, so the two directions never collide.
    const x = start.x + ux * along - uy * LANE;
    const y = start.y + uy * along + ux * LANE;

    const age = flight.endedAtMs === null ? -1 : nowMs - flight.endedAtMs;
    const failed = flight.fate === 'lost' || flight.fate === 'cut';
    let alpha = 1;
    if (age >= 0) {
      if (flight.fate === 'arrive') alpha = 1 - age / 140;
      else if (flight.fate === 'ignored') alpha = 1 - age / 520;
      else alpha = 1 - age / 260;
    }

    ctx.font = `600 10px ${FONT_MONO}`;
    const width = ctx.measureText(flight.tag.label).width + 14;
    const selected = this.selection?.kind === 'frame' && this.selection.frame === flight.frame;

    if (alpha > 0) {
      ctx.globalAlpha = clamp(alpha, 0, 1);
      const hollow = flight.fate === 'ignored' && age >= 0;
      this.pill(x, y, width, hollow ? PAPER : FAMILY_COLOR[flight.tag.family]);
      if (hollow) {
        ctx.strokeStyle = MUTED;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (selected) {
        ctx.strokeStyle = INK;
        ctx.lineWidth = 2;
        this.pillPath(x, y, width + 6, TOKEN_HEIGHT + 6);
        ctx.stroke();
      }
      ctx.fillStyle = hollow ? MUTED : FAMILY_TEXT[flight.tag.family];
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(flight.tag.label, x, y + 0.5);
      ctx.globalAlpha = 1;
      if (age < 0) this.tokens.push({ flight, x, y, w: width });
    }

    if (failed && age >= 0 && age < 600) {
      // The frame is gone: a cross where it vanished, inside a ring that spreads and fades.
      const t = age / 600;
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = ALERT;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x - 5, y - 5);
      ctx.lineTo(x + 5, y + 5);
      ctx.moveTo(x + 5, y - 5);
      ctx.lineTo(x - 5, y + 5);
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 8 + t * 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  private pillPath(x: number, y: number, width: number, height: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.roundRect(x - width / 2, y - height / 2, width, height, height / 2);
  }

  private pill(x: number, y: number, width: number, fill: string): void {
    this.pillPath(x, y, width, TOKEN_HEIGHT);
    this.ctx.fillStyle = fill;
    this.ctx.fill();
  }

  // --------------------------------------------------------------- devices ----

  private drawPulse(device: string, tone: Tone, ageMs: number): void {
    const ctx = this.ctx;
    const { x, y } = this.at(device);
    const t = clamp(ageMs / 600, 0, 1);
    ctx.globalAlpha = (1 - t) * (tone === 'rx' ? 0.28 : 0.8);
    ctx.strokeStyle = TONE_COLOR[tone];
    ctx.lineWidth = tone === 'rx' ? 1.5 : 2.5;
    ctx.beginPath();
    ctx.arc(x, y, NODE_RADIUS + 3 + t * 18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawDevice(id: string): void {
    const ctx = this.ctx;
    const place = this.scenario.places[id]!;
    const device = this.scenario.sim.devices.get(id);
    const { x, y } = this.at(id);
    const selected = this.selection?.kind === 'device' && this.selection.id === id;
    const hovered = this.hover?.kind === 'device' && this.hover.id === id;
    // A selected device is printed in reverse: ink body, paper pictogram.
    const body = selected ? INK : PAPER;
    const mark = selected ? PAPER : INK;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.fillStyle = body;
    ctx.strokeStyle = INK;
    ctx.lineWidth = hovered && !selected ? 3.5 : 2.5;

    if (device instanceof Switch) {
      ctx.beginPath();
      ctx.roundRect(x - 25, y - 17, 50, 34, 6);
      ctx.fill();
      ctx.stroke();
      // Two arrows passing each other: frames go straight through.
      ctx.strokeStyle = mark;
      ctx.lineWidth = 2;
      this.arrow(x - 13, y - 6, x + 13, y - 6);
      this.arrow(x + 13, y + 6, x - 13, y + 6);
    } else if (device instanceof Router) {
      ctx.beginPath();
      ctx.moveTo(x, y - 27);
      ctx.lineTo(x + 27, y);
      ctx.lineTo(x, y + 27);
      ctx.lineTo(x - 27, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // Four arrows pointing outwards: packets are sent on in any direction.
      ctx.strokeStyle = mark;
      ctx.lineWidth = 2;
      this.arrow(x, y - 3, x, y - 14);
      this.arrow(x, y + 3, x, y + 14);
      this.arrow(x - 3, y, x - 14, y);
      this.arrow(x + 3, y, x + 14, y);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      this.pictogram(place, x, y, mark);
    }

    // The name and address, on a strip of paper so nothing shows through the words.
    const address = device instanceof IpNode && device.interfaces.length === 1 ? formatIp(device.interfaces[0]!.address) : '';
    ctx.font = `600 12.5px ${FONT_SANS}`;
    const labelWidth = ctx.measureText(place.label).width;
    ctx.font = `400 10px ${FONT_MONO}`;
    const addressWidth = address ? ctx.measureText(address).width : 0;
    const stripWidth = Math.max(labelWidth, addressWidth) + 10;
    const stripHeight = address ? 31 : 17;
    const side = place.side ?? 'below';
    // `anchor` is where the text is pinned: its centre when below, its near edge when beside.
    const anchor = side === 'below' ? x : side === 'right' ? x + 33 : x - 33;
    const top = side === 'below' ? y + (device instanceof Router ? 34 : 30) : y - stripHeight / 2;
    const left = side === 'below' ? anchor - stripWidth / 2 : side === 'right' ? anchor - 5 : anchor - stripWidth + 5;
    // Text beside a device starts at the device and runs away from it.
    ctx.textAlign = side === 'below' ? 'center' : side === 'right' ? 'left' : 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = PAPER;
    ctx.fillRect(left, top, stripWidth, stripHeight);
    ctx.fillStyle = INK;
    ctx.font = `600 12.5px ${FONT_SANS}`;
    ctx.fillText(place.label, anchor, top + 9);
    if (address) {
      ctx.fillStyle = MUTED;
      ctx.font = `400 10px ${FONT_MONO}`;
      ctx.fillText(address, anchor, top + 23);
    }
  }

  private arrow(x1: number, y1: number, x2: number, y2: number): void {
    const ctx = this.ctx;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.moveTo(x2 - 5 * Math.cos(angle - 0.6), y2 - 5 * Math.sin(angle - 0.6));
    ctx.lineTo(x2, y2);
    ctx.lineTo(x2 - 5 * Math.cos(angle + 0.6), y2 - 5 * Math.sin(angle + 0.6));
    ctx.stroke();
  }

  private pictogram(place: Place, x: number, y: number, color: string): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    if (place.role === 'server') {
      // Three shelves of a rack.
      for (const dy of [-8, -1.5, 5]) ctx.fillRect(x - 9, y + dy, 18, 3.5);
    } else if (place.role === 'resolver') {
      // A magnifying glass: the one that goes and finds out.
      ctx.beginPath();
      ctx.arc(x - 2, y - 2, 6.5, 0, Math.PI * 2);
      ctx.moveTo(x + 3, y + 3);
      ctx.lineTo(x + 9, y + 9);
      ctx.stroke();
    } else {
      // A screen on its base.
      ctx.beginPath();
      ctx.roundRect(x - 9, y - 8, 18, 12, 1.5);
      ctx.moveTo(x - 12, y + 8);
      ctx.lineTo(x + 12, y + 8);
      ctx.stroke();
    }
  }

  private drawCaptions(nowMs: number): void {
    const ctx = this.ctx;
    const stacked = new Map<string, number>();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `500 10.5px ${FONT_MONO}`;
    ctx.lineJoin = 'round';
    // Newest first, so the latest caption sits closest to its device.
    for (let i = this.model.captions.length - 1; i >= 0; i--) {
      const caption = this.model.captions[i]!;
      const row = stacked.get(caption.device) ?? 0;
      stacked.set(caption.device, row + 1);
      const { x, y } = this.at(caption.device);
      const t = clamp((nowMs - caption.atMs) / 2000, 0, 1);
      ctx.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      const ty = y - 42 - row * 14 - t * 8;
      ctx.strokeStyle = PAPER;
      ctx.lineWidth = 4;
      ctx.strokeText(caption.text, x, ty);
      ctx.fillStyle = caption.tone === 'drop' ? ALERT : caption.tone === 'learn' ? '#8a620a' : INK;
      ctx.fillText(caption.text, x, ty);
    }
    ctx.globalAlpha = 1;
  }

  // ----------------------------------------------------------- connections ----

  private drawArc(arc: Arc, nowMs: number): void {
    const ctx = this.ctx;
    const a = this.at(arc.a);
    const b = this.at(arc.b);
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    // Bow the line away from the straight path, always upwards on the page.
    let nx = -(b.y - a.y) / length;
    let ny = (b.x - a.x) / length;
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    const siblings = [...this.model.arcs.values()].filter((other) => sameEnds(other, arc));
    const lift = Math.min(170, length * 0.24) + siblings.indexOf(arc) * 20;
    const control = { x: (a.x + b.x) / 2 + nx * lift, y: (a.y + b.y) / 2 + ny * lift };

    const phase = phaseOf(arc);
    const failed = arc.reason !== null && arc.reason !== 'closed';
    const fade = arc.closedAtMs === null ? 1 : clamp(1 - (nowMs - arc.closedAtMs) / 1600, 0, 1);
    ctx.globalAlpha = fade;
    ctx.strokeStyle = failed ? ALERT : FAMILY_COLOR.tcp;
    ctx.lineWidth = phase === 'open' ? 2.5 : 1.75;
    ctx.lineCap = 'round';
    ctx.setLineDash(phase === 'open' ? [] : phase === 'connecting' ? [5, 6] : [1, 6]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(control.x, control.y, b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);

    const states = arc.ends.map((end) => end.state);
    const text = failed ? arc.reason! : states.length === 2 && states[0] !== states[1] ? states.join(' · ') : states[0]!;
    // The highest point of the curve is halfway between the chord and the control point.
    const apex = { x: (a.x + b.x) / 2 + (nx * lift) / 2, y: (a.y + b.y) / 2 + (ny * lift) / 2 };
    this.badge(text.replace(/_/g, ' '), apex.x, apex.y, failed ? ALERT : FAMILY_COLOR.tcp);
    ctx.globalAlpha = 1;
  }

  // --------------------------------------------------------------- pointer ----

  private local(event: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** What lies under a point: a frame first, then a device, then a cable. */
  private pick(point: Point): Selection {
    for (let i = this.tokens.length - 1; i >= 0; i--) {
      const token = this.tokens[i]!;
      if (Math.abs(point.x - token.x) <= token.w / 2 + 4 && Math.abs(point.y - token.y) <= TOKEN_HEIGHT / 2 + 4) {
        return { kind: 'frame', frame: token.flight.frame };
      }
    }
    for (const id of Object.keys(this.scenario.places)) {
      const at = this.at(id);
      if (Math.hypot(point.x - at.x, point.y - at.y) <= NODE_RADIUS + 4) return { kind: 'device', id };
    }
    for (const link of this.scenario.sim.links) {
      const { start, end } = this.span(link.a.owner.id, link.b.owner.id);
      if (distanceToSegment(point, start, end) <= 9) return { kind: 'link', link };
    }
    return null;
  }

  private pointerDown(event: PointerEvent): void {
    const point = this.local(event);
    const hit = this.pick(point);
    if (hit?.kind === 'device') {
      this.drag = { id: hit.id, moved: false, startX: point.x, startY: point.y };
      this.canvas.setPointerCapture(event.pointerId);
    }
  }

  private pointerMove(event: PointerEvent): void {
    const point = this.local(event);
    if (!this.drag) {
      this.hover = this.pick(point);
      return;
    }
    if (!this.drag.moved && Math.hypot(point.x - this.drag.startX, point.y - this.drag.startY) < 4) return;
    this.drag.moved = true;
    const place = this.scenario.places[this.drag.id]!;
    place.x = (clamp(point.x, 30, this.width - 30) - this.origin.x) / this.scale;
    place.y = (clamp(point.y, 30, this.height - 50) - this.origin.y) / this.scale;
  }

  private pointerUp(event: PointerEvent): void {
    const dragged = this.drag?.moved === true;
    this.drag = null;
    if (dragged) return; // moving a device is not a click on it
    this.selection = this.pick(this.local(event));
    this.onSelect(this.selection);
  }
}

function sameEnds(a: Arc, b: Arc): boolean {
  return (a.a === b.a && a.b === b.b) || (a.a === b.b && a.b === b.a);
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

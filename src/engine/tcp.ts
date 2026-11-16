import { ip, type Ipv4 } from './addr';
import type { IpNode } from './ipnode';
import type { TcpPacket, TcpSegment } from './packets';
import type { Rng } from './rng';
import { MS, SECOND, type Timer } from './sim';

export type TcpState =
  | 'CLOSED'
  | 'LISTEN'
  | 'SYN_SENT'
  | 'SYN_RECEIVED'
  | 'ESTABLISHED'
  | 'FIN_WAIT_1'
  | 'FIN_WAIT_2'
  | 'CLOSE_WAIT'
  | 'CLOSING'
  | 'LAST_ACK'
  | 'TIME_WAIT';

/**
 * Why a connection ended: both sides finished (`closed`), the peer reset it
 * (`reset`), the peer's port was closed (`refused`), the peer stopped
 * answering (`timeout`), the network reported no way through (`unreachable`),
 * or this side gave up on it (`aborted`).
 */
export type TcpCloseReason = 'closed' | 'reset' | 'refused' | 'timeout' | 'unreachable' | 'aborted';

export type TcpDropReason = 'syn-queue-full' | 'rst-out-of-window';

export interface TcpOptions {
  /** Largest amount of data put in one segment, in bytes. */
  mss: number;
  /** The receive window advertised to the peer, in bytes. */
  receiveWindow: number;
  /** Congestion window at the start of a connection, in segments. */
  initialCwndSegments: number;
  /** Retransmission timeout before any round trip has been measured. */
  initialRtoUs: number;
  minRtoUs: number;
  maxRtoUs: number;
  /** Times a SYN is resent before the connection attempt is abandoned. */
  synRetries: number;
  /** Times a SYN-ACK is resent before a half-open connection is discarded. */
  synAckRetries: number;
  /** Times data is resent before the connection is abandoned. */
  dataRetries: number;
  /** How long a closed connection lingers to absorb stray segments. */
  timeWaitUs: number;
  /** Default limit on half-open connections per listening port. */
  backlog: number;
}

export const DEFAULT_TCP_OPTIONS: TcpOptions = {
  mss: 1460,
  receiveWindow: 65535,
  initialCwndSegments: 10,
  initialRtoUs: SECOND,
  minRtoUs: 200 * MS,
  maxRtoUs: 60 * SECOND,
  synRetries: 4,
  synAckRetries: 3,
  dataRetries: 8,
  timeWaitUs: 60 * SECOND,
  backlog: 128,
};

// Sequence numbers live on a circle of 2^32 values, so "before" and "after"
// only make sense as a signed distance between two nearby points.
const SEQ_SPACE = 2 ** 32;

export function seqAdd(seq: number, n: number): number {
  return (((seq + n) % SEQ_SPACE) + SEQ_SPACE) % SEQ_SPACE;
}

/** Signed distance from `b` to `a`: positive when `a` is ahead of `b`. */
export function seqDiff(a: number, b: number): number {
  const d = seqAdd(a, -b);
  return d >= SEQ_SPACE / 2 ? d - SEQ_SPACE : d;
}

const EPHEMERAL_MIN = 49152;
const EPHEMERAL_MAX = 65535;
/** Out-of-order segments held per connection while waiting for a gap to fill. */
const REASSEMBLY_LIMIT = 256;
/** States in which this side may still have data or a FIN to (re)send. */
const SENDING: ReadonlySet<TcpState> = new Set(['ESTABLISHED', 'CLOSE_WAIT', 'FIN_WAIT_1', 'CLOSING', 'LAST_ACK']);
/** States in which the peer may still send data. */
const RECEIVING: ReadonlySet<TcpState> = new Set(['ESTABLISHED', 'FIN_WAIT_1', 'FIN_WAIT_2']);

interface Endpoints {
  localAddr: Ipv4;
  localPort: number;
  remoteAddr: Ipv4;
  remotePort: number;
}

type Flags = { syn?: boolean; fin?: boolean; rst?: boolean; ack?: boolean };

/** A port accepting connections. */
export class TcpListener {
  /** Connections that have sent a SYN but not yet completed the handshake. */
  halfOpen = 0;

  constructor(
    private readonly layer: TcpLayer,
    readonly port: number,
    readonly backlog: number,
    readonly onConnection: (connection: TcpConnection) => void,
  ) {}

  /** Stops accepting new connections. Established ones carry on. */
  close(): void {
    this.layer.unlisten(this);
  }
}

/**
 * One end of a TCP connection. Set the `on…` handlers, then use `send`, `end`
 * and `abort`. Handlers run inside the simulation.
 */
export class TcpConnection {
  /** The handshake completed (the side that called `connect` only). */
  onOpen: (() => void) | null = null;
  onData: ((data: string) => void) | null = null;
  /** The peer has finished sending. This side may still send. */
  onEnd: (() => void) | null = null;
  /** The connection is over. Called once. */
  onClose: ((reason: TcpCloseReason) => void) | null = null;

  readonly localAddr: Ipv4;
  readonly localPort: number;
  readonly remoteAddr: Ipv4;
  readonly remotePort: number;

  private current: TcpState;
  private readonly options: TcpOptions;

  // Sending. Bytes from sndUna up to sndNxt are in flight; sndMax is the
  // furthest ever sent, which differs from sndNxt while retransmitting.
  private readonly iss: number;
  private sndUna: number;
  private sndNxt: number;
  private sndMax: number;
  private sndWnd = 0;
  /** Data not yet acknowledged, sent or not. Its first byte has sequence number `bufferSeq`. */
  private buffer = '';
  private bufferSeq: number;
  private finQueued = false;
  private finSeq: number | null = null;

  // Congestion control.
  private cwndBytes: number;
  private ssthresh = 2 ** 30;
  private dupAcks = 0;

  // Retransmission timing (RFC 6298).
  private srtt: number | null = null;
  private rttvar = 0;
  private rtoBase: number;
  private backoff = 0;
  private timing: { end: number; sentAt: number } | null = null;
  private timer: Timer | null = null;
  private retries = 0;
  private readonly openedAt: number;

  // Receiving.
  private irs = 0;
  private rcvNxt = 0;
  private finReceived = false;
  private readonly reassembly: { seq: number; data: string; fin: boolean }[] = [];
  private ackOwed = false;

  /** Whether the application has been handed this connection. */
  private visible: boolean;
  private notified = false;
  private lingering: Timer | null = null;

  /** @internal Connections are created by `TcpLayer.connect` and by listeners. */
  constructor(
    private readonly layer: TcpLayer,
    endpoints: Endpoints,
    iss: number,
    private readonly listener: TcpListener | null,
    peer?: { irs: number; window: number },
  ) {
    this.localAddr = endpoints.localAddr;
    this.localPort = endpoints.localPort;
    this.remoteAddr = endpoints.remoteAddr;
    this.remotePort = endpoints.remotePort;
    this.options = layer.options;
    this.iss = iss;
    this.sndUna = iss;
    this.sndNxt = seqAdd(iss, 1);
    this.sndMax = this.sndNxt;
    this.bufferSeq = this.sndNxt;
    this.cwndBytes = this.options.initialCwndSegments * this.options.mss;
    this.rtoBase = this.options.initialRtoUs;
    this.openedAt = layer.node.sim.now;
    this.visible = !peer;
    this.current = peer ? 'LISTEN' : 'CLOSED';
    if (peer) {
      this.irs = peer.irs;
      this.rcvNxt = seqAdd(peer.irs, 1);
      this.sndWnd = peer.window;
      this.setState('SYN_RECEIVED');
    } else {
      this.setState('SYN_SENT');
    }
  }

  get state(): TcpState {
    return this.current;
  }

  /** Congestion window: how many bytes may be in flight at once. */
  get cwnd(): number {
    return this.cwndBytes;
  }

  /** Current retransmission timeout. */
  get rtoUs(): number {
    return Math.min(this.rtoBase * 2 ** this.backoff, this.options.maxRtoUs);
  }

  /** Bytes handed to `send` that the peer has not yet acknowledged. */
  get unacknowledged(): number {
    return this.buffer.length;
  }

  /** Queues data for delivery. It may be called before the handshake finishes. */
  send(data: string): void {
    const sendable = this.current === 'SYN_SENT' || this.current === 'ESTABLISHED' || this.current === 'CLOSE_WAIT';
    if (!sendable || this.finQueued) throw new Error(`Cannot send on a TCP connection in state ${this.current}`);
    if (data.length === 0) return;
    this.buffer += data;
    this.flush();
  }

  /**
   * Finishes sending: a FIN follows whatever is still queued. The peer may keep
   * sending. Called while still connecting, it takes effect once connected.
   */
  end(): void {
    switch (this.current) {
      case 'SYN_SENT':
        this.finQueued = true;
        return;
      case 'ESTABLISHED':
        this.setState('FIN_WAIT_1');
        break;
      case 'CLOSE_WAIT':
        this.setState('LAST_ACK');
        break;
      default:
        return;
    }
    this.finQueued = true;
    this.flush();
  }

  /** Tears the connection down at once, telling the peer with a reset. */
  abort(): void {
    if (this.current === 'CLOSED') return;
    if (this.current !== 'SYN_SENT' && this.current !== 'TIME_WAIT') this.emit({ rst: true }, this.sndMax);
    this.terminate('aborted');
  }

  // ------------------------------------------------------------ internal ----

  /** @internal Sends the opening SYN. */
  open(): void {
    this.emit({ syn: true, ack: false }, this.iss);
    this.armTimer();
  }

  /** @internal Sends the SYN-ACK that answers a SYN. */
  answer(): void {
    this.emit({ syn: true }, this.iss);
    this.armTimer();
  }

  /** @internal The network reported that a segment could not be delivered. */
  networkError(): void {
    // Only fatal while connecting. Later on the path may recover, so keep retrying.
    if (this.current === 'SYN_SENT') this.terminate('unreachable');
  }

  /** @internal */
  fail(reason: TcpCloseReason): void {
    this.terminate(reason);
  }

  /** @internal Processes a segment addressed to this connection. */
  handle(packet: TcpPacket): void {
    const segment = packet.payload;
    if (this.current === 'SYN_SENT') {
      this.handleWhileConnecting(segment);
      return;
    }
    const length = segment.data.length + (segment.fin ? 1 : 0);
    const offset = seqDiff(segment.seq, this.rcvNxt);
    const window = this.options.receiveWindow;

    if (segment.rst) {
      // A reset is believed only if it lands inside the receive window, so
      // forging one means guessing where the connection has got to.
      if (offset >= 0 && offset < window) this.terminate('reset');
      else this.layer.drop(packet, 'rst-out-of-window');
      return;
    }
    if (segment.syn) {
      // Our SYN-ACK was lost and the peer is asking again; otherwise a stray SYN.
      if (this.current === 'SYN_RECEIVED' && segment.seq === this.irs) this.emit({ syn: true }, this.iss);
      else this.emit({}, this.sndMax);
      return;
    }
    const acceptable = length === 0 ? offset >= 0 && offset < window : offset < window && offset + length > 0;
    if (!acceptable) {
      this.emit({}, this.sndMax); // tell the peer where we really are
      return;
    }
    if (!segment.ack) return;

    if (this.current === 'SYN_RECEIVED') {
      if (segment.ackNo !== this.sndNxt) {
        this.layer.reset(packet);
        return;
      }
      this.completeHandshake(segment);
      if (this.listener) this.listener.halfOpen--;
      this.visible = true;
      this.setState('ESTABLISHED');
      this.listener?.onConnection(this);
    } else if (!this.processAck(segment)) {
      return;
    }
    if (this.isClosed()) return;

    if (length > 0 && RECEIVING.has(this.current)) this.processData(segment, offset);
    if (this.isClosed()) return;

    this.flush();
    if (this.ackOwed) this.emit({}, this.sndMax);
  }

  private handleWhileConnecting(segment: TcpSegment): void {
    if (segment.ack && segment.ackNo !== this.sndNxt) {
      if (!segment.rst) this.layer.transmit(this.remoteAddr, resetFor(segment, this.localPort), this.localAddr);
      return;
    }
    if (segment.rst) {
      if (segment.ack) this.terminate('refused');
      return;
    }
    if (!segment.syn || !segment.ack) return;

    this.irs = segment.seq;
    this.rcvNxt = seqAdd(segment.seq, 1);
    this.completeHandshake(segment);
    this.setState('ESTABLISHED');
    this.emit({}, this.sndNxt);
    this.onOpen?.();
    if (this.isClosed()) return;
    if (this.finQueued && this.current === 'ESTABLISHED') this.setState('FIN_WAIT_1');
    this.flush();
  }

  /** The peer has acknowledged our SYN. */
  private completeHandshake(segment: TcpSegment): void {
    this.sndUna = segment.ackNo;
    this.sndWnd = segment.window;
    this.stopTimer();
    // A round trip measured across a retransmission is ambiguous, so skip it.
    if (this.retries === 0) this.measured(this.layer.node.sim.now - this.openedAt);
    this.retries = 0;
    this.backoff = 0;
  }

  /** Handles the acknowledgement in a segment. Returns false if the segment should be ignored. */
  private processAck(segment: TcpSegment): boolean {
    const { mss } = this.options;
    if (seqDiff(segment.ackNo, this.sndMax) > 0) {
      this.emit({}, this.sndMax); // it acknowledges something we never sent
      return false;
    }
    const acked = seqDiff(segment.ackNo, this.sndUna);
    if (acked < 0) return true; // an old acknowledgement, overtaken by a newer one

    this.sndWnd = segment.window;
    if (acked === 0) {
      const pureAck = segment.data.length === 0 && !segment.fin;
      if (pureAck && this.sndUna !== this.sndMax && ++this.dupAcks === 3) this.fastRetransmit();
      return true;
    }

    if (this.timing && seqDiff(segment.ackNo, this.timing.end) >= 0) {
      this.measured(this.layer.node.sim.now - this.timing.sentAt);
      this.timing = null;
    }
    const dataAcked = Math.min(this.buffer.length, Math.max(0, seqDiff(segment.ackNo, this.bufferSeq)));
    this.buffer = this.buffer.slice(dataAcked);
    this.bufferSeq = seqAdd(this.bufferSeq, dataAcked);
    this.sndUna = segment.ackNo;
    if (seqDiff(this.sndUna, this.sndNxt) > 0) this.sndNxt = this.sndUna;

    // Slow start doubles the window each round trip; past the threshold it grows by one segment per round trip.
    if (this.cwndBytes < this.ssthresh) this.cwndBytes += Math.min(acked, mss);
    else this.cwndBytes += Math.max(1, Math.floor((mss * mss) / this.cwndBytes));
    this.dupAcks = 0;
    this.retries = 0;
    this.backoff = 0;
    this.stopTimer();
    this.armTimer();

    if (this.finSeq !== null && seqDiff(segment.ackNo, this.finSeq) > 0) this.finAcknowledged();
    return true;
  }

  private finAcknowledged(): void {
    switch (this.current) {
      case 'FIN_WAIT_1':
        this.setState('FIN_WAIT_2');
        return;
      case 'CLOSING':
        this.linger();
        return;
      case 'LAST_ACK':
        this.terminate('closed');
        return;
    }
  }

  private processData(segment: TcpSegment, offset: number): void {
    if (offset > 0) {
      // There is a gap before this segment. Keep it, and repeat the last
      // acknowledgement at once so the sender can tell something went missing.
      const held = this.reassembly.some((entry) => entry.seq === segment.seq);
      if (!held && this.reassembly.length < REASSEMBLY_LIMIT) {
        this.reassembly.push({ seq: segment.seq, data: segment.data, fin: segment.fin });
      }
      this.emit({}, this.sndMax);
      return;
    }
    this.ackOwed = true;
    this.accept(segment.data.slice(-offset), segment.fin);

    // The gap may now be filled: take everything that has become contiguous.
    for (let progressed = true; progressed && !this.isClosed(); ) {
      progressed = false;
      for (let i = 0; i < this.reassembly.length; i++) {
        const entry = this.reassembly[i]!;
        const skip = seqDiff(this.rcvNxt, entry.seq);
        if (skip < 0) continue;
        this.reassembly.splice(i, 1);
        if (skip <= entry.data.length) this.accept(entry.data.slice(skip), entry.fin);
        progressed = true;
        break;
      }
    }
  }

  /** Takes in-order data (and possibly the peer's FIN) and hands it to the application. */
  private accept(data: string, fin: boolean): void {
    if (this.finReceived || this.isClosed()) return;
    if (data.length > 0) {
      this.rcvNxt = seqAdd(this.rcvNxt, data.length);
      this.onData?.(data);
      if (this.isClosed()) return;
    }
    if (!fin) return;
    this.finReceived = true;
    this.rcvNxt = seqAdd(this.rcvNxt, 1);
    const bothDone = this.current === 'FIN_WAIT_2';
    if (this.current === 'ESTABLISHED') this.setState('CLOSE_WAIT');
    else if (this.current === 'FIN_WAIT_1') this.setState('CLOSING'); // both sides closed at once
    this.onEnd?.();
    if (bothDone && !this.isClosed()) {
      this.emit({}, this.sndMax);
      this.linger();
    }
  }

  /** Sends as much queued data as the windows allow, then the FIN if one is due. */
  private flush(): void {
    if (!SENDING.has(this.current)) return;
    const now = this.layer.node.sim.now;
    for (;;) {
      const offset = seqDiff(this.sndNxt, this.bufferSeq);
      const room = Math.min(this.cwndBytes, this.sndWnd) - seqDiff(this.sndNxt, this.sndUna);
      if (offset < this.buffer.length && room > 0) {
        const length = Math.min(this.options.mss, this.buffer.length - offset, room);
        const seq = this.sndNxt;
        const fresh = seqDiff(seq, this.sndMax) >= 0;
        this.sndNxt = seqAdd(seq, length);
        if (fresh && !this.timing) this.timing = { end: this.sndNxt, sentAt: now };
        this.emit({}, seq, this.buffer.slice(offset, offset + length));
        continue;
      }
      const finDue = this.finQueued && offset === this.buffer.length;
      if (finDue && (this.finSeq === null || this.sndNxt === this.finSeq)) {
        this.finSeq = this.sndNxt;
        this.sndNxt = seqAdd(this.sndNxt, 1);
        this.emit({ fin: true }, this.finSeq);
      }
      break;
    }
    this.armTimer();
  }

  private emit(flags: Flags, seq: number, data = ''): void {
    const ack = flags.ack !== false;
    const segment: TcpSegment = {
      srcPort: this.localPort,
      dstPort: this.remotePort,
      seq,
      ackNo: ack ? this.rcvNxt : 0,
      syn: flags.syn === true,
      ack,
      fin: flags.fin === true,
      rst: flags.rst === true,
      window: this.options.receiveWindow,
      data,
    };
    const end = seqAdd(seq, data.length + (segment.syn ? 1 : 0) + (segment.fin ? 1 : 0));
    if (seqDiff(end, this.sndMax) > 0) this.sndMax = end;
    if (ack) this.ackOwed = false;
    this.layer.transmit(this.remoteAddr, segment, this.localAddr);
  }

  // ------------------------------------------------------ retransmission ----

  private armTimer(): void {
    if (this.timer || this.sndUna === this.sndMax || this.isClosed() || this.current === 'TIME_WAIT') return;
    this.timer = this.layer.node.sim.schedule(this.rtoUs, () => this.timedOut());
  }

  private stopTimer(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  private timedOut(): void {
    this.timer = null;
    const { mss, synRetries, synAckRetries, dataRetries } = this.options;
    const limit =
      this.current === 'SYN_SENT' ? synRetries : this.current === 'SYN_RECEIVED' ? synAckRetries : dataRetries;
    if (this.retries >= limit) {
      this.terminate('timeout');
      return;
    }
    this.retries++;
    this.backoff++; // each failure doubles the wait
    this.timing = null;
    this.layer.retransmitted(this, this.sndUna, this.retries, 'timeout');

    if (this.current === 'SYN_SENT') {
      this.emit({ syn: true, ack: false }, this.iss);
    } else if (this.current === 'SYN_RECEIVED') {
      this.emit({ syn: true }, this.iss);
    } else {
      // Silence means the path is badly congested: shrink to one segment and
      // start again from the first byte the peer has not acknowledged.
      this.ssthresh = Math.max(Math.floor(seqDiff(this.sndMax, this.sndUna) / 2), 2 * mss);
      this.cwndBytes = mss;
      this.dupAcks = 0;
      this.sndNxt = this.sndUna;
      this.flush();
    }
    this.armTimer();
  }

  /** Three repeated acknowledgements mean one segment was lost but later ones arrived: resend it now. */
  private fastRetransmit(): void {
    const { mss } = this.options;
    this.ssthresh = Math.max(Math.floor(seqDiff(this.sndMax, this.sndUna) / 2), 2 * mss);
    this.cwndBytes = this.ssthresh;
    this.timing = null;
    this.layer.retransmitted(this, this.sndUna, 1, 'fast');
    if (this.buffer.length > 0) this.emit({}, this.sndUna, this.buffer.slice(0, mss));
    else if (this.finSeq === this.sndUna) this.emit({ fin: true }, this.sndUna);
    this.stopTimer();
    this.armTimer();
  }

  /** Folds a measured round-trip time into the retransmission timeout. */
  private measured(rttUs: number): void {
    if (this.srtt === null) {
      this.srtt = rttUs;
      this.rttvar = rttUs / 2;
    } else {
      this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - rttUs);
      this.srtt = 0.875 * this.srtt + 0.125 * rttUs;
    }
    const rto = Math.round(this.srtt + Math.max(MS, 4 * this.rttvar));
    this.rtoBase = Math.min(Math.max(rto, this.options.minRtoUs), this.options.maxRtoUs);
  }

  // ------------------------------------------------------------ lifecycle ----

  private isClosed(): boolean {
    return this.current === 'CLOSED';
  }

  private setState(to: TcpState, reason?: TcpCloseReason): void {
    const from = this.current;
    this.current = to;
    this.layer.node.sim.record({
      kind: 'tcp-state',
      device: this.layer.node.id,
      localPort: this.localPort,
      remote: this.remoteAddr,
      remotePort: this.remotePort,
      from,
      to,
      ...(reason ? { reason } : {}),
    });
  }

  /** Both directions are finished. Stay around for a while to answer a repeated FIN, then go. */
  private linger(): void {
    this.stopTimer();
    this.setState('TIME_WAIT');
    this.lingering = this.layer.node.sim.schedule(this.options.timeWaitUs, () => this.terminate('closed'));
    this.notifyClosed('closed');
  }

  private terminate(reason: TcpCloseReason): void {
    if (this.isClosed()) return;
    this.stopTimer();
    this.lingering?.cancel();
    if (this.listener && this.current === 'SYN_RECEIVED') this.listener.halfOpen--;
    this.layer.forget(this);
    this.setState('CLOSED', reason);
    this.notifyClosed(reason);
  }

  private notifyClosed(reason: TcpCloseReason): void {
    if (!this.visible || this.notified) return;
    this.notified = true;
    this.onClose?.(reason);
  }
}

/** The reset that answers a segment nobody is waiting for. */
function resetFor(segment: TcpSegment, localPort: number): TcpSegment {
  const base = { srcPort: localPort, dstPort: segment.srcPort, syn: false, fin: false, rst: true, window: 0, data: '' };
  if (segment.ack) return { ...base, seq: segment.ackNo, ackNo: 0, ack: false };
  const consumed = segment.data.length + (segment.syn ? 1 : 0) + (segment.fin ? 1 : 0);
  return { ...base, seq: 0, ackNo: seqAdd(segment.seq, consumed), ack: true };
}

/** A node's TCP layer: its listening ports and its connections. */
export class TcpLayer {
  readonly options: TcpOptions;
  private readonly listeners = new Map<number, TcpListener>();
  private readonly table = new Map<string, TcpConnection>();

  constructor(
    readonly node: IpNode,
    private readonly rng: Rng,
    options: Partial<TcpOptions> = {},
  ) {
    this.options = { ...DEFAULT_TCP_OPTIONS, ...options };
  }

  /** Every connection this node currently holds, including half-open and lingering ones. */
  get connections(): TcpConnection[] {
    return [...this.table.values()];
  }

  /** The ports this node accepts connections on. */
  get listeningPorts(): number[] {
    return [...this.listeners.keys()];
  }

  /** Accepts connections on `port`. `onConnection` is called once each handshake completes. */
  listen(
    port: number,
    onConnection: (connection: TcpConnection) => void,
    options: { backlog?: number } = {},
  ): TcpListener {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid TCP port: ${port}`);
    if (this.listeners.has(port)) throw new Error(`${this.node.id} is already listening on TCP port ${port}`);
    const listener = new TcpListener(this, port, options.backlog ?? this.options.backlog, onConnection);
    this.listeners.set(port, listener);
    return listener;
  }

  /**
   * Starts a connection and returns it straight away, still connecting. Set
   * its handlers before the simulation next runs.
   */
  connect(address: string | Ipv4, port: number): TcpConnection {
    const remoteAddr = typeof address === 'string' ? ip(address) : address;
    const localAddr = this.node.ownsAddress(remoteAddr) ? remoteAddr : this.node.lookupRoute(remoteAddr)?.iface.address;
    let localPort: number;
    do localPort = this.rng.int(EPHEMERAL_MIN, EPHEMERAL_MAX);
    while (this.listeners.has(localPort) || this.connections.some((c) => c.localPort === localPort));

    const endpoints = { localAddr: localAddr ?? 0, localPort, remoteAddr, remotePort: port };
    const connection = new TcpConnection(this, endpoints, this.rng.int(0, SEQ_SPACE - 1), null);
    this.table.set(keyOf(localPort, remoteAddr, port), connection);
    if (localAddr === undefined) this.node.sim.schedule(0, () => connection.fail('unreachable'));
    else connection.open();
    return connection;
  }

  /** Called by the IP layer with a segment addressed to this node. */
  receive(packet: TcpPacket): void {
    if (!this.node.ownsAddress(packet.dst)) return; // TCP has no broadcast
    const segment = packet.payload;
    const connection = this.table.get(keyOf(segment.dstPort, packet.src, segment.srcPort));
    if (connection) {
      connection.handle(packet);
      return;
    }
    const listener = this.listeners.get(segment.dstPort);
    if (!listener || segment.ack) {
      this.reset(packet);
      return;
    }
    if (segment.rst || !segment.syn) return;
    if (listener.halfOpen >= listener.backlog) {
      // Every slot is held by a handshake that has not finished. This is what a SYN flood aims for.
      this.drop(packet, 'syn-queue-full');
      return;
    }
    listener.halfOpen++;
    const endpoints = {
      localAddr: packet.dst,
      localPort: segment.dstPort,
      remoteAddr: packet.src,
      remotePort: segment.srcPort,
    };
    const accepted = new TcpConnection(this, endpoints, this.rng.int(0, SEQ_SPACE - 1), listener, {
      irs: segment.seq,
      window: segment.window,
    });
    this.table.set(keyOf(segment.dstPort, packet.src, segment.srcPort), accepted);
    accepted.answer();
  }

  /** Called by the IP layer when an ICMP error arrives about a segment this node sent. */
  fail(original: TcpPacket): void {
    const segment = original.payload;
    this.table.get(keyOf(segment.srcPort, original.dst, segment.dstPort))?.networkError();
  }

  /** @internal */
  transmit(to: Ipv4, segment: TcpSegment, from: Ipv4): void {
    this.node.sendPacket(to, { protocol: 'tcp', payload: segment }, { src: from });
  }

  /** @internal Answers a segment that belongs to no connection, so its sender stops. */
  reset(packet: TcpPacket): void {
    if (packet.payload.rst) return;
    this.transmit(packet.src, resetFor(packet.payload, packet.payload.dstPort), packet.dst);
  }

  /** @internal */
  drop(packet: TcpPacket, reason: TcpDropReason): void {
    this.node.sim.record({ kind: 'tcp-drop', device: this.node.id, packet, reason });
  }

  /** @internal */
  retransmitted(connection: TcpConnection, seq: number, attempt: number, cause: 'timeout' | 'fast'): void {
    this.node.sim.record({
      kind: 'tcp-retransmit',
      device: this.node.id,
      localPort: connection.localPort,
      remote: connection.remoteAddr,
      remotePort: connection.remotePort,
      seq,
      attempt,
      cause,
    });
  }

  /** @internal */
  forget(connection: TcpConnection): void {
    const key = keyOf(connection.localPort, connection.remoteAddr, connection.remotePort);
    if (this.table.get(key) === connection) this.table.delete(key);
  }

  /** @internal */
  unlisten(listener: TcpListener): void {
    if (this.listeners.get(listener.port) === listener) this.listeners.delete(listener.port);
  }
}

function keyOf(localPort: number, remoteAddr: Ipv4, remotePort: number): string {
  return `${localPort}|${remoteAddr}|${remotePort}`;
}

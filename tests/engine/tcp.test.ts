import { describe, expect, it } from 'vitest';
import {
  MS,
  SECOND,
  seqAdd,
  seqDiff,
  type EthernetFrame,
  type Host,
  type TcpConnection,
  type TcpSegment,
  type TcpState,
} from '../../src/engine';
import { internetwork, lan, ofKind, ping, segmentsFrom } from './helpers';

interface Log {
  data: string;
  events: string[];
}

/** Records everything a connection tells its application. */
function track(connection: TcpConnection): Log {
  const log: Log = { data: '', events: [] };
  connection.onOpen = () => log.events.push('open');
  connection.onData = (data) => (log.data += data);
  connection.onEnd = () => log.events.push('end');
  connection.onClose = (reason) => log.events.push(`close:${reason}`);
  return log;
}

/** A client on `a` connected to a server on `b` port 80, with both ends tracked. */
function connect(net: { a: Host; b: Host }, onAccept?: (connection: TcpConnection) => void) {
  const server: { connection?: TcpConnection; log: Log } = { log: { data: '', events: [] } };
  net.b.tcp.listen(80, (connection) => {
    server.connection = connection;
    server.log = track(connection);
    onAccept?.(connection);
  });
  const client = net.a.tcp.connect(net.b.address, 80);
  return { client, clientLog: track(client), server };
}

function statesOf(sim: { trace: readonly { kind: string }[] }, device: string): TcpState[] {
  return ofKind(sim as never, 'tcp-state')
    .filter((event) => event.device === device)
    .map((event) => event.to);
}

/** Repeatable filler text of a given length. */
const filler = (length: number, salt = 0) =>
  Array.from({ length }, (_, i) => String.fromCharCode(97 + ((i * 7 + salt) % 26))).join('');

const isTcp = (frame: EthernetFrame): frame is EthernetFrame & { etherType: 'ipv4' } =>
  frame.etherType === 'ipv4' && frame.payload.protocol === 'tcp';

function tcpOf(frame: EthernetFrame): TcpSegment | undefined {
  return frame.etherType === 'ipv4' && frame.payload.protocol === 'tcp' ? frame.payload.payload : undefined;
}

describe('Sequence numbers', () => {
  it('wrap around at 2^32', () => {
    expect(seqAdd(2 ** 32 - 1, 2)).toBe(1);
    expect(seqAdd(5, -10)).toBe(2 ** 32 - 5);
    expect(seqDiff(1, 2 ** 32 - 1)).toBe(2);
    expect(seqDiff(2 ** 32 - 1, 1)).toBe(-2);
    expect(seqDiff(7, 7)).toBe(0);
  });
});

describe('TCP handshake', () => {
  it('opens a connection with SYN, SYN-ACK, ACK', () => {
    const net = internetwork();
    const { client, clientLog, server } = connect(net);
    expect(client.state).toBe('SYN_SENT');
    net.sim.runUntilIdle();

    expect(client.state).toBe('ESTABLISHED');
    expect(server.connection?.state).toBe('ESTABLISHED');
    expect(clientLog.events).toEqual(['open']);

    const [syn] = segmentsFrom(net.sim, 'a');
    const [synAck] = segmentsFrom(net.sim, 'b');
    const ack = segmentsFrom(net.sim, 'a')[1]!;
    expect(syn).toMatchObject({ syn: true, ack: false, dstPort: 80, data: '' });
    expect(synAck).toMatchObject({ syn: true, ack: true, ackNo: seqAdd(syn!.seq, 1) });
    expect(ack).toMatchObject({ syn: false, ack: true, seq: seqAdd(syn!.seq, 1), ackNo: seqAdd(synAck!.seq, 1) });
    expect(segmentsFrom(net.sim, 'a')).toHaveLength(2);
    expect(segmentsFrom(net.sim, 'b')).toHaveLength(1);

    expect(statesOf(net.sim, 'a')).toEqual(['SYN_SENT', 'ESTABLISHED']);
    expect(statesOf(net.sim, 'b')).toEqual(['SYN_RECEIVED', 'ESTABLISHED']);
  });

  it('picks unpredictable initial sequence numbers and ports', () => {
    const net = internetwork();
    net.b.tcp.listen(80, () => {});
    const connections = Array.from({ length: 20 }, () => net.a.tcp.connect(net.b.address, 80));
    net.sim.runUntilIdle();
    const syns = segmentsFrom(net.sim, 'a').filter((s) => s.syn);
    expect(new Set(syns.map((s) => s.seq)).size).toBe(20);
    expect(new Set(connections.map((c) => c.localPort)).size).toBe(20);
    expect(connections.every((c) => c.state === 'ESTABLISHED')).toBe(true);
  });

  it('is refused by a closed port', () => {
    const net = internetwork();
    const client = net.a.tcp.connect(net.b.address, 81);
    const log = track(client);
    net.sim.runUntilIdle();

    expect(log.events).toEqual(['close:refused']);
    expect(client.state).toBe('CLOSED');
    const [syn] = segmentsFrom(net.sim, 'a');
    const [reset] = segmentsFrom(net.sim, 'b');
    expect(reset).toMatchObject({ rst: true, ack: true, ackNo: seqAdd(syn!.seq, 1) });
    expect(net.sim.now).toBeLessThan(SECOND);
    expect(net.a.tcp.connections).toEqual([]);
  });

  it('resends the SYN with doubling gaps, then gives up', () => {
    const net = internetwork();
    ping(net.a, '10.0.2.10'); // fill every ARP cache first
    net.sim.runUntilIdle();
    net.edge.filter = (frame) => !isTcp(frame); // TCP silently vanishes on the last hop

    const start = net.sim.now;
    const log = track(net.a.tcp.connect(net.b.address, 80));
    net.sim.runUntilIdle();

    const sent = segmentsFrom(net.sim, 'a').map((s) => (s.t - start) / SECOND);
    expect(sent).toEqual([0, 1, 3, 7, 15]);
    expect(log.events).toEqual(['close:timeout']);
    expect(net.sim.now - start).toBe(31 * SECOND);
    expect(ofKind(net.sim, 'tcp-retransmit').map((e) => e.attempt)).toEqual([1, 2, 3, 4]);
  });

  it('fails when the network reports no way through', () => {
    const net = internetwork();
    const viaRouter = track(net.a.tcp.connect('172.16.0.1', 80));
    net.sim.runUntilIdle();
    expect(viaRouter.events).toEqual(['close:unreachable']);

    const { sim, a } = lan(); // no gateway at all
    const local = a.tcp.connect('8.8.8.8', 80);
    const localLog = track(local);
    expect(localLog.events).toEqual([]); // never synchronously
    sim.runUntilIdle();
    expect(localLog.events).toEqual(['close:unreachable']);
    expect(ofKind(sim, 'frame-tx')).toEqual([]);
  });

  it('recovers when the final ACK is lost', () => {
    const net = internetwork();
    let dropped = false;
    net.backbone.filter = (frame) => {
      const segment = tcpOf(frame);
      if (!dropped && segment && segment.ack && !segment.syn) return !(dropped = true);
      return true;
    };
    const { client, server } = connect(net);
    net.sim.runUntil(500 * MS);
    expect(client.state).toBe('ESTABLISHED');
    expect(server.connection).toBeUndefined(); // the server is still waiting

    net.sim.runUntilIdle();
    // The server asked again after a second, and the client repeated its ACK.
    expect(server.connection?.state).toBe('ESTABLISHED');
    expect(segmentsFrom(net.sim, 'b').filter((s) => s.syn)).toHaveLength(2);
    expect(ofKind(net.sim, 'tcp-retransmit').map((e) => e.device)).toEqual(['b']);
  });

  it('connects a host to itself', () => {
    const { sim, a } = lan();
    let accepted: Log | undefined;
    a.tcp.listen(80, (connection) => {
      accepted = track(connection);
      connection.send('welcome');
    });
    const client = a.tcp.connect(a.address, 80);
    const log = track(client);
    client.send('hello me');
    sim.runUntilIdle();
    expect(log.data).toBe('welcome');
    expect(accepted?.data).toBe('hello me');
    expect(ofKind(sim, 'frame-tx')).toEqual([]);
  });
});

describe('TCP data transfer', () => {
  it('delivers data both ways', () => {
    const net = internetwork();
    const { client, clientLog, server } = connect(net, (connection) => {
      connection.onData = (data) => connection.send(data.toUpperCase());
    });
    client.onOpen = () => client.send('hello');
    net.sim.runUntilIdle();
    expect(clientLog.data).toBe('HELLO');
    expect(client.unacknowledged).toBe(0);
    expect(server.connection?.unacknowledged).toBe(0);
  });

  it('holds data written before the handshake finishes', () => {
    const net = internetwork();
    const { client, server } = connect(net);
    client.send('early');
    net.sim.runUntilIdle();
    expect(server.log.data).toBe('early');
  });

  it('splits a large write into segments and reassembles it exactly', () => {
    const net = internetwork({ tcp: { mss: 1000 } });
    const payload = filler(25_000);
    const { client, server } = connect(net);
    const initialCwnd = client.cwnd;
    client.send(payload);
    net.sim.runUntilIdle();

    expect(server.log.data).toBe(payload);
    const sizes = segmentsFrom(net.sim, 'a').map((s) => s.data.length).filter((n) => n > 0);
    expect(sizes).toHaveLength(25);
    expect(Math.max(...sizes)).toBe(1000);
    expect(ofKind(net.sim, 'tcp-retransmit')).toEqual([]);
    // No loss, so the window only grew, and the timeout settled near its floor.
    expect(client.cwnd).toBeGreaterThan(initialCwnd);
    expect(client.rtoUs).toBe(200 * MS);
  });

  it('never has more in flight than the congestion window allows', () => {
    const net = internetwork({ tcp: { mss: 1000, initialCwndSegments: 2 } });
    const { client, server } = connect(net);
    client.send(filler(20_000));
    while (client.state !== 'ESTABLISHED') net.sim.step();
    // The moment the handshake completes, only two segments' worth may leave.
    const firstFlight = segmentsFrom(net.sim, 'a').filter((s) => s.data.length > 0);
    expect(firstFlight).toHaveLength(2);
    net.sim.runUntilIdle();
    expect(server.log.data).toHaveLength(20_000);
  });

  it.each([1, 2, 3, 4, 5])('survives a lossy link in both directions (seed %i)', (seed) => {
    const net = internetwork({ seed, lossRate: 0.15, tcp: { mss: 500 } });
    const up = filler(20_000, 1);
    const down = filler(20_000, 2);
    const { client, clientLog, server } = connect(net, (connection) => {
      connection.send(down);
      connection.onEnd = () => connection.end();
    });
    client.send(up);
    client.end();
    net.sim.runUntilIdle();

    expect(server.log.data).toBe(up);
    expect(clientLog.data).toBe(down);
    expect(clientLog.events).toEqual(['open', 'end', 'close:closed']);
    expect(client.state).toBe('CLOSED');
    expect(server.connection?.state).toBe('CLOSED');
    expect(ofKind(net.sim, 'tcp-retransmit').length).toBeGreaterThan(0);
    expect(net.a.tcp.connections).toEqual([]);
    expect(net.b.tcp.connections).toEqual([]);
  });

  it('resends one lost segment as soon as three repeated ACKs arrive', () => {
    const net = internetwork({ tcp: { mss: 1000 } });
    const payload = filler(10_000);
    let seen = 0;
    net.backbone.filter = (frame) => {
      const segment = tcpOf(frame);
      return !(segment && segment.data.length > 0 && ++seen === 3); // lose the third data segment once
    };
    const { client, server } = connect(net);
    let sentAt = 0;
    client.onOpen = () => {
      sentAt = net.sim.now;
      client.send(payload);
    };
    const before = client.cwnd;
    net.sim.runUntilIdle();

    expect(server.log.data).toBe(payload);
    expect(ofKind(net.sim, 'tcp-retransmit').map((e) => e.cause)).toEqual(['fast']);
    expect(client.cwnd).toBeLessThan(before); // loss halves the window
    // Recovery took a few round trips, far less than the retransmission timeout.
    const done = ofKind(net.sim, 'ip-deliver').filter((e) => e.device === 'b').at(-1)!.t;
    expect(done - sentAt).toBeLessThan(100 * MS);
  });

  it('falls back to a timeout when nothing comes back, doubling the wait each time', () => {
    const net = internetwork();
    const { client, server } = connect(net);
    net.sim.runUntilIdle();

    let losses = 3;
    net.backbone.filter = (frame) => {
      const segment = tcpOf(frame);
      return !(segment && segment.data.length > 0 && losses-- > 0);
    };
    const start = net.sim.now;
    client.send('x');
    net.sim.runUntilIdle();

    expect(server.log.data).toBe('x');
    const sends = segmentsFrom(net.sim, 'a').filter((s) => s.data === 'x').map((s) => s.t - start);
    const rto = sends[1]!;
    expect(sends).toEqual([0, rto, 3 * rto, 7 * rto]);
    expect(ofKind(net.sim, 'tcp-retransmit').map((e) => [e.cause, e.attempt])).toEqual([
      ['timeout', 1],
      ['timeout', 2],
      ['timeout', 3],
    ]);
    expect(client.cwnd).toBeLessThan(10 * 1460); // a timeout collapses the window
  });

  it('abandons a connection whose peer has gone silent', () => {
    const net = internetwork({ tcp: { dataRetries: 3 } });
    const { client, clientLog } = connect(net);
    net.sim.runUntilIdle();
    net.backbone.filter = () => false;
    client.send('anyone there?');
    net.sim.runUntilIdle();
    expect(clientLog.events).toEqual(['open', 'close:timeout']);
    expect(ofKind(net.sim, 'tcp-retransmit')).toHaveLength(3);
  });

  it('works when sequence numbers wrap around during the transfer', () => {
    const net = internetwork({ tcp: { mss: 700 } });
    for (const host of [net.a, net.b]) {
      const original = host.rng.int.bind(host.rng);
      // Start both sides a few hundred bytes short of 2^32.
      host.rng.int = (min, max) => (max === 2 ** 32 - 1 ? 2 ** 32 - 300 : original(min, max));
    }
    const up = filler(6_000, 3);
    const down = filler(6_000, 4);
    const { client, clientLog, server } = connect(net, (connection) => {
      connection.send(down);
      connection.onEnd = () => connection.end();
    });
    client.send(up);
    client.end();
    net.sim.runUntilIdle();

    expect(segmentsFrom(net.sim, 'a')[0]!.seq).toBe(2 ** 32 - 300);
    expect(server.log.data).toBe(up);
    expect(clientLog.data).toBe(down);
    expect(clientLog.events).toEqual(['open', 'end', 'close:closed']);
    expect(ofKind(net.sim, 'tcp-retransmit')).toEqual([]);
  });

  it('rejects writes that can no longer be sent', () => {
    const net = internetwork();
    const { client } = connect(net);
    net.sim.runUntilIdle();
    client.send(''); // nothing to do
    client.end();
    expect(() => client.send('late')).toThrow(/Cannot send/);
    client.end(); // harmless
    net.sim.runUntilIdle();
    expect(() => client.send('later')).toThrow(/Cannot send/);
  });
});

describe('TCP teardown', () => {
  it('closes in three segments when the peer finishes at once', () => {
    const net = internetwork();
    const { client, clientLog, server } = connect(net, (connection) => {
      connection.onEnd = () => connection.end();
    });
    net.sim.runUntilIdle();
    const mark = net.sim.trace.length;
    client.end();
    net.sim.runUntil(net.sim.now + SECOND);

    expect(clientLog.events).toEqual(['open', 'end', 'close:closed']);
    expect(segmentsFrom(net.sim, 'a', mark).map((s) => [s.fin, s.ack])).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(segmentsFrom(net.sim, 'b', mark).map((s) => [s.fin, s.ack])).toEqual([[true, true]]);
    expect(statesOf(net.sim, 'a').slice(2)).toEqual(['FIN_WAIT_1', 'FIN_WAIT_2', 'TIME_WAIT']);
    expect(statesOf(net.sim, 'b').slice(2)).toEqual(['CLOSE_WAIT', 'LAST_ACK', 'CLOSED']);
    expect(server.connection?.state).toBe('CLOSED');

    // The side that closed first lingers for a minute before forgetting the connection.
    expect(client.state).toBe('TIME_WAIT');
    expect(net.a.tcp.connections).toHaveLength(1);
    net.sim.runUntilIdle();
    expect(client.state).toBe('CLOSED');
    expect(net.a.tcp.connections).toEqual([]);
    expect(clientLog.events).toEqual(['open', 'end', 'close:closed']); // told only once
  });

  it('lets one side finish while the other keeps sending', () => {
    const net = internetwork();
    const { client, clientLog, server } = connect(net, (connection) => {
      connection.onEnd = () => {
        // The request is complete. Answer it a little later, then finish.
        net.sim.schedule(50 * MS, () => {
          connection.send(`you said: ${server.log.data}`);
          connection.end();
        });
      };
    });
    client.send('GET /');
    client.end();
    net.sim.runUntil(45 * MS);
    expect(client.state).toBe('FIN_WAIT_2');
    expect(server.connection?.state).toBe('CLOSE_WAIT');

    net.sim.runUntilIdle();
    expect(clientLog.data).toBe('you said: GET /');
    expect(clientLog.events).toEqual(['open', 'end', 'close:closed']);
    expect(server.log.events).toEqual(['close:closed']); // its own end handler replaced the tracked one
  });

  it('handles both sides closing at the same moment', () => {
    const net = internetwork();
    const { client, clientLog, server } = connect(net);
    net.sim.runUntilIdle();
    client.end();
    server.connection!.end();
    net.sim.runUntilIdle();

    expect(statesOf(net.sim, 'a').slice(2)).toEqual(['FIN_WAIT_1', 'CLOSING', 'TIME_WAIT', 'CLOSED']);
    expect(statesOf(net.sim, 'b').slice(2)).toEqual(['FIN_WAIT_1', 'CLOSING', 'TIME_WAIT', 'CLOSED']);
    expect(clientLog.events).toEqual(['open', 'end', 'close:closed']);
    expect(server.log.events).toEqual(['end', 'close:closed']);
  });

  it('resends a lost FIN', () => {
    const net = internetwork();
    const { client, clientLog, server } = connect(net, (connection) => {
      connection.onEnd = () => connection.end();
    });
    net.sim.runUntilIdle();
    let dropped = false;
    net.backbone.filter = (frame) => {
      const segment = tcpOf(frame);
      if (!dropped && segment?.fin) return !(dropped = true);
      return true;
    };
    client.end();
    net.sim.runUntilIdle();
    expect(clientLog.events).toEqual(['open', 'end', 'close:closed']);
    expect(server.log.events).toEqual(['close:closed']);
    expect(ofKind(net.sim, 'tcp-retransmit')).toHaveLength(1);
  });

  it('tears down at once on abort, and tells the peer', () => {
    const net = internetwork();
    const { client, clientLog, server } = connect(net);
    net.sim.runUntilIdle();
    client.abort();
    expect(clientLog.events).toEqual(['open', 'close:aborted']);
    net.sim.runUntilIdle();
    expect(server.log.events).toEqual(['close:reset']);
    expect(segmentsFrom(net.sim, 'a').at(-1)).toMatchObject({ rst: true });
    expect(net.a.tcp.connections).toEqual([]);
    expect(net.b.tcp.connections).toEqual([]);
    client.abort(); // harmless
  });

  it('finishes after connecting when ended before the handshake completes', () => {
    const net = internetwork();
    const { client, clientLog, server } = connect(net, (connection) => {
      connection.onEnd = () => connection.end();
    });
    client.send('bye');
    client.end();
    expect(client.state).toBe('SYN_SENT');
    net.sim.runUntilIdle();
    expect(server.log.data).toBe('bye');
    expect(clientLog.events).toEqual(['open', 'end', 'close:closed']);
  });

  it('gives up without a word when aborted before the handshake completes', () => {
    const net = internetwork();
    const client = net.a.tcp.connect(net.b.address, 80);
    const log = track(client);
    client.abort();
    expect(log.events).toEqual(['close:aborted']);
    expect(client.state).toBe('CLOSED');
    expect(segmentsFrom(net.sim, 'a').filter((s) => s.rst)).toEqual([]);
  });
});

describe('TCP listeners', () => {
  it('manages the life of a listening port', () => {
    const net = internetwork();
    const { client, clientLog, server } = connect(net);
    net.sim.runUntilIdle();
    expect(() => net.b.tcp.listen(80, () => {})).toThrow(/already listening/);
    expect(() => net.b.tcp.listen(0, () => {})).toThrow(/Invalid TCP port/);

    // Closing the listener turns new callers away but leaves the open connection alone.
    const listener = net.b.tcp.listen(8080, () => {});
    listener.close();
    const late = track(net.a.tcp.connect(net.b.address, 8080));
    client.send('still here');
    net.sim.runUntilIdle();
    expect(late.events).toEqual(['close:refused']);
    expect(server.log.data).toBe('still here');
    expect(clientLog.events).toEqual(['open']);
  });

  it('answers a stray segment with a reset that fits it', () => {
    const { sim, a, b } = lan();
    const segment = { srcPort: 5000, dstPort: 9, seq: 1000, ackNo: 0, syn: false, ack: false, fin: false, rst: false, window: 100, data: '' };
    a.sendPacket(b.address, { protocol: 'tcp', payload: { ...segment, syn: true } }); // how a port scan probes
    a.sendPacket(b.address, { protocol: 'tcp', payload: { ...segment, ack: true, ackNo: 777 } });
    a.sendPacket(b.address, { protocol: 'tcp', payload: { ...segment, rst: true } });
    sim.runUntilIdle();

    const replies = segmentsFrom(sim, 'b');
    expect(replies).toHaveLength(2); // a reset is never answered
    expect(replies[0]).toMatchObject({ rst: true, ack: true, seq: 0, ackNo: 1001, dstPort: 5000 });
    expect(replies[1]).toMatchObject({ rst: true, ack: false, seq: 777 });
    expect(segmentsFrom(sim, 'a')).toHaveLength(3); // and a does not reply to those resets
  });
});

describe('TCP under attack', () => {
  /** Sends a forged segment from `attacker` that claims to come from another address. */
  function forge(attacker: Host, victim: Host, claimedSrc: number, segment: Partial<TcpSegment>): void {
    attacker.nic.send({
      src: attacker.nic.mac,
      dst: victim.nic.mac,
      etherType: 'ipv4',
      payload: {
        src: claimedSrc,
        dst: victim.address,
        ttl: 64,
        id: 1,
        protocol: 'tcp',
        payload: {
          srcPort: 4000,
          dstPort: 80,
          seq: 1,
          ackNo: 0,
          syn: false,
          ack: false,
          fin: false,
          rst: false,
          window: 65535,
          data: '',
          ...segment,
        },
      },
    });
  }

  it('ignores a forged reset unless its sequence number lands in the window', () => {
    const { sim, a, b, c } = lan();
    const { client, clientLog, server } = connect({ a, b });
    sim.runUntilIdle();
    const next = seqAdd(segmentsFrom(sim, 'a')[0]!.seq, 1); // what the server expects from the client next

    forge(c, b, a.address, { srcPort: client.localPort, rst: true, seq: seqAdd(next, 1_000_000) });
    sim.runUntilIdle();
    expect(server.connection?.state).toBe('ESTABLISHED');
    expect(ofKind(sim, 'tcp-drop').map((e) => [e.device, e.reason])).toEqual([['b', 'rst-out-of-window']]);

    forge(c, b, a.address, { srcPort: client.localPort, rst: true, seq: seqAdd(next, 100) });
    sim.runUntilIdle();
    expect(server.log.events).toEqual(['close:reset']);

    // The real client has no idea until it next sends, and is then reset in turn.
    expect(client.state).toBe('ESTABLISHED');
    client.send('hello?');
    sim.runUntilIdle();
    expect(clientLog.events).toEqual(['open', 'close:reset']);
  });

  it('runs out of room for new connections when flooded with unanswered SYNs', () => {
    const { sim, a, b, c } = lan();
    const accepted: TcpConnection[] = [];
    const listener = b.tcp.listen(80, (connection) => accepted.push(connection), { backlog: 3 });

    // Five SYNs from addresses that will never complete the handshake.
    for (let i = 0; i < 5; i++) forge(c, b, a.address + 100 + i, { syn: true, srcPort: 4000 + i });
    sim.runUntil(10 * MS);
    expect(listener.halfOpen).toBe(3);
    expect(ofKind(sim, 'tcp-drop').map((e) => e.reason)).toEqual(['syn-queue-full', 'syn-queue-full']);

    // A real client is now locked out.
    const client = a.tcp.connect(b.address, 80);
    sim.runUntil(5 * SECOND);
    expect(client.state).toBe('SYN_SENT');
    expect(accepted).toEqual([]);
    expect(ofKind(sim, 'tcp-drop').length).toBeGreaterThan(2);

    // The half-open entries expire once their SYN-ACKs have gone unanswered long enough.
    sim.runUntil(20 * SECOND);
    expect(listener.halfOpen).toBe(0);
    expect(b.tcp.connections.filter((x) => x.state === 'SYN_RECEIVED')).toEqual([]);
    const retry = a.tcp.connect(b.address, 80);
    sim.runUntil(21 * SECOND);
    expect(retry.state).toBe('ESTABLISHED');
  });

  it('frees a half-open slot when the claimed source denies having asked', () => {
    const { sim, a, b, c } = lan();
    const listener = b.tcp.listen(80, () => {}, { backlog: 3 });
    // The forged source is a real host. It answers the unexpected SYN-ACK with a reset.
    forge(c, b, a.address, { syn: true });
    sim.runUntilIdle();
    expect(listener.halfOpen).toBe(0);
    expect(segmentsFrom(sim, 'a')).toEqual([expect.objectContaining({ rst: true })]);
  });
});

describe('TCP determinism', () => {
  function run(seed: number) {
    const net = internetwork({ seed, lossRate: 0.1, tcp: { mss: 400 } });
    const { client, clientLog, server } = connect(net, (connection) => {
      connection.send(filler(5_000, 9));
      connection.onEnd = () => connection.end();
    });
    client.send(filler(5_000, 8));
    client.end();
    net.sim.runUntilIdle();
    return { trace: JSON.stringify(net.sim.trace), client: clientLog, server: server.log };
  }

  it('repeats exactly for the same seed', () => {
    expect(run(11)).toEqual(run(11));
  });

  it('delivers the same data under a different seed by a different route', () => {
    const first = run(11);
    const other = run(12);
    expect(other.trace).not.toBe(first.trace);
    expect(other.client.data).toBe(first.client.data);
    expect(other.server.data).toBe(first.server.data);
  });
});

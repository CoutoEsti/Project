// A signalling broker, in one file, with no dependencies.
//
//   node hop/tools/broker.mjs [--port 9000]
//   …then open the game with ?broker=ws://localhost:9000/peerjs
//
// Multiplayer works out of the box against PeerJS's free public broker, so this
// is not required to play. It exists for three reasons, in order of how much
// they matter:
//
//   1. the automated test drives the whole networking stack against it, so the
//      mesh is verified for real rather than mocked;
//   2. it is the plan B if the public broker is down, rate-limited or retired —
//      one file, `node`, done;
//   3. it plays on a LAN with no internet at all.
//
// It speaks the small part of the PeerServer protocol the game uses: claim an
// id, get OPEN or ID-TAKEN, then relay OFFER / ANSWER / CANDIDATE / LEAVE
// messages to `dst` with `src` filled in. WebSocket framing is implemented here
// because pulling in a dependency for a hundred lines of it would be worse.

import http from 'node:http';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---------------------------------------------------------------------------
// The bit of WebSocket we need: an upgrade handshake, text frames, ping/pong.
// ---------------------------------------------------------------------------

/** Wrap a payload in a server frame. Servers never mask. */
function frame(payload, opcode = 0x1) {
  const data = Buffer.from(payload);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

/**
 * Pull whole frames out of a growing buffer.
 * @returns {{frames: Array<{opcode:number, payload:Buffer}>, rest: Buffer}}
 */
function unframe(buf) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const first = buf[off];
    const second = buf[off + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let len = second & 0x7f;
    let cursor = off + 2;

    if (len === 126) {
      if (cursor + 2 > buf.length) break;
      len = buf.readUInt16BE(cursor);
      cursor += 2;
    } else if (len === 127) {
      if (cursor + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(cursor));
      cursor += 8;
    }

    let mask = null;
    if (masked) {
      if (cursor + 4 > buf.length) break;
      mask = buf.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (cursor + len > buf.length) break;

    const payload = Buffer.from(buf.subarray(cursor, cursor + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    frames.push({ opcode, payload });
    off = cursor + len;
  }
  return { frames, rest: buf.subarray(off) };
}

// ---------------------------------------------------------------------------
// The broker
// ---------------------------------------------------------------------------

function send(socket, obj) {
  try { socket.write(frame(JSON.stringify(obj))); } catch { /* peer went away */ }
}

/**
 * Start relaying. Port 0 picks a free one, which is what the test uses.
 * @returns {Promise<{server, port, close()}>}
 */
export function startBroker({ port = 9000, quiet = false } = {}) {
  const log = (...a) => { if (!quiet) console.log(...a); };

  /** id -> {socket} — one seat each, and that is the whole room mechanism. */
  const clients = new Map();

  const handleMessage = (id, socket, text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'HEARTBEAT') return;

    const dst = msg.dst;
    if (!dst) return;
    const target = clients.get(dst);
    if (!target) {
      // Nobody in that seat. PeerServer answers an undeliverable OFFER with
      // EXPIRE, and the game relies on that to prune the seats it dialled blind.
      if (msg.type === 'OFFER') send(socket, { type: 'EXPIRE', src: dst, dst: id });
      return;
    }
    send(target.socket, { type: msg.type, payload: msg.payload, src: id, dst });
  };

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`ruelle broker — ${clients.size} client(s)\n`);
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);

    if (!id) {
      send(socket, { type: 'ERROR', payload: { msg: 'id required' } });
      socket.end();
      return;
    }

    // The whole room mechanism rests on this one answer being honest.
    if (clients.has(id)) {
      send(socket, { type: 'ID-TAKEN', payload: { msg: 'ID is taken' } });
      socket.end();
      return;
    }

    clients.set(id, { socket });
    send(socket, { type: 'OPEN' });
    log(`+ ${id} (${clients.size})`);

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = unframe(buffer);
      buffer = rest;
      for (const f of frames) {
        if (f.opcode === 0x8) { socket.end(); return; }                          // close
        if (f.opcode === 0x9) { socket.write(frame(f.payload, 0xa)); continue; } // ping
        if (f.opcode === 0x1) handleMessage(id, socket, f.payload.toString('utf8'));
      }
    });

    const gone = () => {
      if (clients.get(id)?.socket !== socket) return;
      clients.delete(id);
      log(`- ${id} (${clients.size})`);
      // Tell everyone still connected, so a car disappears immediately rather
      // than waiting for the game's own staleness timeout.
      for (const [otherId, other] of clients) {
        send(other.socket, { type: 'LEAVE', src: id, dst: otherId });
      }
    };
    socket.on('close', gone);
    socket.on('error', gone);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      log(`broker sur ws://localhost:${actual}/peerjs`);
      log(`ouvre le jeu avec ?broker=ws://localhost:${actual}/peerjs`);
      resolve({
        server,
        port: actual,
        close() {
          for (const c of clients.values()) { try { c.socket.destroy(); } catch { /* gone */ } }
          clients.clear();
          server.close();
        },
      });
    });
  });
}

// Run directly — `node hop/tools/broker.mjs` — rather than imported by the test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--port');
  startBroker({
    port: i >= 0 && args[i + 1] ? Number(args[i + 1]) : 9000,
    quiet: args.includes('--quiet'),
  });
}

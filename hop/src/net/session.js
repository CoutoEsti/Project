// The room: who is in it, what they are doing, and where that puts them here.
//
// This layer knows nothing about WebRTC and nothing about three.js. It takes a
// transport that can broadcast JSON, and turns it into a list of cars in *local
// world metres* — which means it owns the one conversion that matters, from the
// latitude and longitude on the wire to this client's own tangent plane.
//
// It also owns the send cadence. The game loop calls publish() every frame and
// this decides that fifteen of those become packets.

import {
  PROTOCOL, SEND_HZ, STALE_AFTER, MAX_PLAYERS,
  StateBuffer, encodeState, decodeState, packFlags, unpackFlags,
  normaliseName, colourForName, makeRoomCode, normaliseRoom,
} from './protocol.js';
import { Mesh } from './transport.js';

const PING_EVERY = 2.0;

export const NetState = {
  OFFLINE: 'offline',
  JOINING: 'joining',
  ONLINE: 'online',
};

export class Multiplayer {
  /**
   * @param {object} opts
   *   name          the local player's display name
   *   palette       car colours to draw names from
   *   getProjection () => Projection|null — the local plane, or null before a hop
   *   onEvent       (event) => void
   *   broker        signalling override, for a self-hosted PeerJS server
   *   iceServers    STUN/TURN override; [] disables them, which a LAN wants
   */
  constructor(opts = {}) {
    this.name = normaliseName(opts.name) || 'Anonyme';
    this.palette = opts.palette || [0xc0392b];
    this.getProjection = opts.getProjection || (() => null);
    this.onEvent = opts.onEvent || (() => {});
    this.broker = opts.broker || undefined;
    this.iceServers = opts.iceServers;

    this.state = NetState.OFFLINE;
    this.room = '';
    this.mesh = null;
    this.players = new Map();   // peer id -> {id, name, colour, buffer, ping, hello}
    this.seq = 0;
    this._sendAcc = 0;
    this._pingAcc = 0;
    this._pingSeq = 0;
    this._out = { lat: 0, lon: 0 };
    this._ll = { lat: 0, lon: 0 };
    this._world = { x: 0, z: 0 };
  }

  get active() { return this.state === NetState.ONLINE; }
  get colour() { return colourForName(this.name, this.palette); }

  /** Everyone with a live connection, us not included. */
  get count() { return this.players.size; }

  setName(name) {
    const clean = normaliseName(name);
    if (!clean || clean === this.name) return;
    this.name = clean;
    if (this.mesh) this.mesh.send(this._hello(), true);
  }

  _hello() {
    return { t: 'hello', v: PROTOCOL, name: this.name, colour: this.colour };
  }

  /**
   * Join a room, or make one up if none was given.
   * @returns {Promise<string>} the room code, or '' if it did not work out
   */
  async join(rawRoom) {
    if (this.state !== NetState.OFFLINE) this.leave();
    const room = normaliseRoom(rawRoom) || makeRoomCode();
    this.state = NetState.JOINING;
    this.room = room;
    this.onEvent({ type: 'joining', room });

    this.mesh = new Mesh({
      broker: this.broker,
      iceServers: this.iceServers,
      onOpen: () => {},
      onPeer: (id) => this._onPeer(id),
      onPeerGone: (id) => this._onPeerGone(id),
      onMessage: (id, msg) => this._onMessage(id, msg),
      onError: (kind, detail) => this.onEvent({ type: 'error', kind, detail }),
    });

    const ok = await this.mesh.join(room);
    if (!ok) {
      this.leave();
      this.onEvent({ type: 'failed', room });
      return '';
    }
    this.state = NetState.ONLINE;
    this.onEvent({ type: 'joined', room, slot: this.mesh.slot });
    return room;
  }

  leave() {
    if (this.mesh) {
      this.mesh.send({ t: 'bye' }, true);
      this.mesh.close();
      this.mesh = null;
    }
    const had = this.state !== NetState.OFFLINE;
    this.players.clear();
    this.state = NetState.OFFLINE;
    this.room = '';
    this.seq = 0;
    if (had) this.onEvent({ type: 'left' });
  }

  // -- incoming --------------------------------------------------------------

  /**
   * The record for one peer, created on demand.
   *
   * On demand matters: prune() drops a player whose tab froze, but the data
   * channel underneath is often perfectly fine and starts delivering again a
   * moment later. Without this, those packets would arrive with no record to
   * put them in and be dropped for the rest of the session — the player is
   * gone for good because their laptop slept for seven seconds.
   */
  _ensurePlayer(id) {
    let player = this.players.get(id);
    if (!player) {
      player = {
        id,
        name: '',
        colour: this.palette[0],
        buffer: new StateBuffer(),
        ping: null,
        seen: now(),
        announced: false,
      };
      this.players.set(id, player);
    }
    return player;
  }

  _onPeer(id) {
    this._ensurePlayer(id);
    // Both sides send this on connect, so neither has to be "the host".
    this.mesh.sendTo(id, this._hello(), true);
  }

  _onPeerGone(id) {
    const player = this.players.get(id);
    if (!player) return;
    this.players.delete(id);
    if (player.announced) this.onEvent({ type: 'peer-left', name: player.name || 'Quelqu’un' });
  }

  _onMessage(id, msg) {
    if (!msg || typeof msg !== 'object') return;
    // Anything arriving on a live channel means that player is back, whether or
    // not prune() gave up on them a moment ago.
    const player = this._ensurePlayer(id);
    const t = now();
    player.seen = t;
    // A record rebuilt after a prune has lost their name, so ask again by
    // sending ours — at most once a second, or a 15 Hz snapshot stream would
    // trigger fifteen of them.
    if (!player.announced && msg.t !== 'hello' && this.mesh && t - (player.asked || 0) > 1) {
      player.asked = t;
      this.mesh.sendTo(id, this._hello(), true);
    }

    switch (msg.t) {
      case 'hello': {
        if (msg.v !== PROTOCOL) {
          this.onEvent({ type: 'error', kind: 'version',
            detail: 'Un joueur utilise une autre version du jeu.' });
          return;
        }
        player.name = normaliseName(msg.name) || 'Anonyme';
        player.colour = Number.isFinite(msg.colour) ? msg.colour : colourForName(player.name, this.palette);
        if (!player.announced) {
          player.announced = true;
          this.onEvent({ type: 'peer-joined', name: player.name });
        }
        break;
      }
      case 'state': {
        const decoded = decodeState(msg.s);
        if (decoded) player.buffer.push(decoded, now());
        break;
      }
      case 'horn':
        this.onEvent({ type: 'horn', id, name: player.name });
        break;
      case 'ping':
        this.mesh.sendTo(id, { t: 'pong', n: msg.n });
        break;
      case 'pong':
        if (msg.n === this._pingSeq) player.ping = Math.round((now() - this._pingSentAt) * 1000);
        break;
      case 'bye':
        this._onPeerGone(id);
        break;
      default: break;
    }
  }

  // -- outgoing --------------------------------------------------------------

  /**
   * Offer the local car to the room. Called every frame; sends fifteen times a
   * second. Positions leave as latitude and longitude — see protocol.js.
   *
   * @param {number} dt seconds since the last frame
   * @param {object} car {x, z, yaw, speed, steer, spin, braking, lights,
   *                      handbrake, skidding, reversing}
   */
  publish(dt, car) {
    if (!this.active) return;
    const proj = this.getProjection();
    if (!proj) return;

    this._pingAcc += dt;
    if (this._pingAcc >= PING_EVERY) {
      this._pingAcc = 0;
      this._pingSeq = (this._pingSeq + 1) & 0xffff;
      this._pingSentAt = now();
      this.mesh.send({ t: 'ping', n: this._pingSeq }, true);
    }

    this._sendAcc += dt;
    if (this._sendAcc < 1 / SEND_HZ) return;
    this._sendAcc = 0;

    proj.toLatLon(car.x, car.z, this._out);
    this.seq = (this.seq + 1) & 0x7fffffff;
    this.mesh.send({
      t: 'state',
      s: encodeState({
        seq: this.seq,
        lat: this._out.lat,
        lon: this._out.lon,
        yaw: car.yaw,
        speed: car.speed,
        steer: car.steer,
        spin: car.spin,
        flags: packFlags(car),
      }),
    });
  }

  /** Tell the room you leaned on the horn. Costs one reliable packet. */
  horn() {
    if (this.active) this.mesh.send({ t: 'horn' }, true);
  }

  // -- reading ---------------------------------------------------------------

  /**
   * Every remote car, interpolated and converted into local world metres.
   *
   * Returns a fresh array each call — it is at most seven entries, and the
   * alternative is a pool that has to be invalidated whenever a player leaves.
   */
  cars() {
    const out = [];
    if (!this.active) return out;
    const proj = this.getProjection();
    if (!proj) return out;

    const t = now();
    for (const player of this.players.values()) {
      const s = player.buffer.sample(t);
      if (!s) continue;
      proj.toWorld(s.lat, s.lon, this._world);
      out.push({
        id: player.id,
        name: player.name || '…',
        colour: player.colour,
        ping: player.ping,
        x: this._world.x,
        z: this._world.z,
        yaw: s.yaw,
        speed: s.speed,
        steer: s.steer,
        spin: s.spin,
        moving: s.moving,
        ...unpackFlags(s.flags),
      });
    }
    return out;
  }

  /**
   * Where a player is, in latitude and longitude.
   *
   * Unlike cars(), this needs no projection — so the menu can offer to take you
   * to somebody before you have hopped anywhere yourself.
   */
  locate(id) {
    const player = this.players.get(id);
    const last = player && player.buffer.last;
    return last ? { lat: last.lat, lon: last.lon, name: player.name || 'Quelqu’un' } : null;
  }

  /** Whatever went wrong most recently, for the panel to show rather than guess. */
  get lastError() { return this.mesh ? this.mesh.lastError : ''; }

  /** Drop anyone whose tab froze; the transport only notices a real disconnect. */
  prune() {
    if (!this.active) return;
    const t = now();
    for (const [id, player] of [...this.players]) {
      if (t - player.seen > STALE_AFTER) this._onPeerGone(id);
    }
  }

  /** One line per player for the HUD, us first. */
  roster(selfSpeedKmh = 0) {
    const rows = [{
      id: 'self', name: this.name, colour: this.colour, ping: null,
      self: true, speedKmh: selfSpeedKmh,
    }];
    for (const p of this.players.values()) {
      const last = p.buffer.last;
      rows.push({
        id: p.id,
        name: p.name || '…',
        colour: p.colour,
        ping: p.ping,
        self: false,
        speedKmh: last ? last.speed * 3.6 : 0,
      });
    }
    return rows;
  }
}

function now() { return performance.now() / 1000; }

export { MAX_PLAYERS };

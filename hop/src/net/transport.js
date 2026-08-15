// Getting two browsers talking, with nobody's server in the middle.
//
// The game is a static site: no backend, no account, nothing to pay for. That
// is worth keeping, so the cars go peer to peer over WebRTC data channels and
// the only thing borrowed from the network is *signalling* — the short exchange
// of SDP and ICE candidates that two browsers need before they can address each
// other directly. That exchange goes through PeerJS's free public broker, which
// is a dumb JSON relay keyed by peer id and never sees a single frame of the
// game.
//
// There is no room concept in that broker, so rooms are built out of the one
// thing it does offer: whoever asks for an id first gets it. A room is eight
// reserved ids, `ruelle-<ROOM>-0` … `-7`; claiming one is your seat, and being
// refused one means that seat is taken. Discovery is then a broadcast to the
// other seven and a reply from whoever is home.
//
// The honest limitation: no TURN server, so two players both behind symmetric
// NAT (rare on home internet, common on corporate wifi) will fail to connect.
// They get told so rather than left staring at an empty street.

import { MAX_PLAYERS } from './protocol.js';

const DEFAULT_BROKER = 'wss://0.peerjs.com/peerjs';
const BROKER_KEY = 'peerjs';

// Google's public STUN is the one piece of infrastructure here, and all it does
// is tell a browser what its own public address looks like.
const DEFAULT_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

const HEARTBEAT_MS = 5000;
const SLOT_TIMEOUT_MS = 6000;

// How long a handshake may take before it is written off, and how many times to
// start it over. Both matter: ICE plus DTLS on a loaded phone or a slow link can
// take a good while, and giving up after one attempt strands a player for the
// rest of the session with nothing but a toast to explain it. Three tries over
// about a minute and a half is patient enough to cover a bad moment, and short
// enough that a genuinely unreachable peer is reported rather than hoped for.
const DIAL_TIMEOUT_MS = 30000;
const DIAL_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

// Discovery repeats. This is the difference between multiplayer that works and
// multiplayer that works *usually*: announcing once on arrival means a single
// dropped message — a hiccup at the broker, two tabs racing, a seat freed a
// second later — leaves two players sitting in the same room, both reporting
// themselves online, permanently invisible to each other with nothing retrying.
// Seven small messages every few seconds costs nothing and makes the room
// self-healing: late arrivals, departures and lost announces all resolve on
// their own.
const ANNOUNCE_EVERY_MS = 4000;

// After several failed handshakes a peer is left alone for a while, so the
// repeat above cannot turn into a permanent retry storm against somebody whose
// network genuinely cannot reach us.
const COOLDOWN_MS = 60000;

/** Ids the broker will accept: letters, digits, single separators. */
function slotId(room, slot) {
  return `ruelle-${room}-${slot}`;
}

/**
 * One player's link to everyone else in a room.
 *
 * Events, all optional:
 *   onOpen(slot)          our seat is claimed and the socket is live
 *   onPeer(id)            a data channel to `id` came up
 *   onPeerGone(id)        …and went away
 *   onMessage(id, msg)    a decoded JSON message from `id`
 *   onError(kind, detail) something the player needs to be told about
 */
export class Mesh {
  constructor(opts = {}) {
    this.broker = opts.broker || DEFAULT_BROKER;
    this.iceServers = opts.iceServers || DEFAULT_ICE;
    this.onOpen = opts.onOpen || (() => {});
    this.onPeer = opts.onPeer || (() => {});
    this.onPeerGone = opts.onPeerGone || (() => {});
    this.onMessage = opts.onMessage || (() => {});
    const report = opts.onError || (() => {});
    this.onError = (kind, detail) => { this.lastError = detail; report(kind, detail); };

    this.room = '';
    this.slot = -1;
    this.id = '';
    this.socket = null;
    this.peers = new Map();     // remote id -> {pc, state, meta, ready}
    this.attempts = new Map();  // remote id -> handshakes tried, reset on success
    this.cooldown = new Map();  // remote id -> don't try again before this time
    this.closed = false;
    this._heartbeat = 0;
    this._discovery = 0;
    this.lastError = '';        // shown in the menu, so a failure is not a guess
  }

  get connected() { return !!this.socket && this.socket.readyState === 1; }

  /** Peers with a live state channel. */
  get peerIds() {
    const out = [];
    for (const [id, p] of this.peers) if (p.ready) out.push(id);
    return out;
  }

  /**
   * Take a seat in `room`, then say hello to the rest of the table.
   * @param {string} room already normalised
   */
  async join(room) {
    this.closed = false;
    this.room = room;

    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      if (this.closed) return false;
      const outcome = await this._claim(room, slot);
      if (outcome === 'taken') continue;
      if (outcome === 'open') {
        this.slot = slot;
        this.id = slotId(room, slot);
        this._startHeartbeat();
        this.onOpen(slot);
        this._announce();
        this._startDiscovery();
        return true;
      }
      // 'failed' — the broker itself is unreachable; trying seat 1 will not help.
      return false;
    }
    this.onError('full', `La salle ${room} est pleine (${MAX_PLAYERS} voitures).`);
    return false;
  }

  /**
   * Try to own one seat. Resolves 'open', 'taken' or 'failed'.
   *
   * The broker answers a claim with OPEN or ID-TAKEN on the socket itself, so
   * this opens a real connection and keeps it only if it was granted.
   */
  _claim(room, slot) {
    return new Promise((resolve) => {
      const token = Math.random().toString(36).slice(2, 12);
      const url = `${this.broker}?key=${BROKER_KEY}&id=${encodeURIComponent(slotId(room, slot))}`
        + `&token=${token}&version=1.5.4`;

      let socket;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        this.onError('broker', `Signalisation injoignable : ${err && err.message}`);
        resolve('failed');
        return;
      }

      let settled = false;
      // Only the broker actually saying ID-TAKEN means the seat is occupied. A
      // socket that dies without answering is a broken connection, and calling
      // that 'taken' walks all eight seats and then reports a full room — the
      // single most misleading thing this code could tell a player who is in
      // fact completely alone and offline.
      let refused = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result !== 'open') { try { socket.close(); } catch { /* already gone */ } }
        resolve(result);
      };

      const timer = setTimeout(() => {
        this.onError('broker', 'La signalisation ne répond pas.');
        done('failed');
      }, SLOT_TIMEOUT_MS);

      socket.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (!settled) {
          if (msg.type === 'OPEN') {
            this.socket = socket;
            socket.addEventListener('close', () => this._onSocketClosed(socket));
            done('open');
            return;
          }
          if (msg.type === 'ID-TAKEN') { refused = true; done('taken'); return; }
          if (msg.type === 'ERROR') {
            this.onError('broker', String((msg.payload && msg.payload.msg) || 'signalisation refusée'));
            done('failed');
            return;
          }
        }
        this._onBrokerMessage(msg);
      });

      socket.addEventListener('error', () => {
        this.onError('broker',
          'Signalisation injoignable. Vérifie ta connexion, ou passe ?broker= sur un serveur PeerJS à toi.');
        done('failed');
      });
      socket.addEventListener('close', () => {
        if (settled) return;
        if (!refused) {
          this.onError('broker', 'La signalisation a coupé la connexion sans répondre.');
        }
        done(refused ? 'taken' : 'failed');
      });
    });
  }

  _startHeartbeat() {
    clearInterval(this._heartbeat);
    this._heartbeat = setInterval(() => {
      if (this.connected) this.socket.send(JSON.stringify({ type: 'HEARTBEAT' }));
    }, HEARTBEAT_MS);
  }

  _startDiscovery() {
    clearInterval(this._discovery);
    this._discovery = setInterval(() => this._announce(), ANNOUNCE_EVERY_MS);
  }

  /**
   * Say hello to every seat we are not already talking to.
   *
   * Dialling a seat nobody is sitting in costs one message and comes back as
   * EXPIRE, which is cheaper than any scheme for knowing in advance who is
   * there — and repeating it is what makes the room heal itself.
   */
  _announce() {
    if (!this.connected || !this.room) return;
    const now = Date.now();
    for (let other = 0; other < MAX_PLAYERS; other++) {
      if (other === this.slot) continue;
      const id = slotId(this.room, other);
      if (this.peers.has(id)) continue;                  // connected or mid-handshake
      const until = this.cooldown.get(id);
      if (until && now < until) continue;                // given up on, for now
      if (until) { this.cooldown.delete(id); this.attempts.delete(id); }
      this._signal(id, 'OFFER', { kind: 'hi' });
    }
  }

  _onSocketClosed(socket) {
    if (this.socket !== socket || this.closed) return;
    this.socket = null;
    this.onError('broker', 'Lien de signalisation perdu — les voitures déjà connectées restent visibles.');
  }

  _signal(dst, type, payload) {
    if (!this.connected) return;
    this.socket.send(JSON.stringify({ type, payload, dst }));
  }

  _onBrokerMessage(msg) {
    const src = msg.src;
    const payload = msg.payload || {};
    switch (msg.type) {
      case 'OFFER':
        if (payload.kind === 'hi') this._onAnnounce(src);
        else this._onOffer(src, payload.sdp);
        break;
      case 'ANSWER': this._onAnswer(src, payload.sdp); break;
      case 'CANDIDATE': this._onCandidate(src, payload.candidate); break;
      case 'EXPIRE':
        // Nobody in that seat. Perfectly normal in a room of two.
        break;
      case 'LEAVE': this._drop(src); break;
      default: break;
    }
  }

  /**
   * Somebody announced themselves.
   *
   * Exactly one side must send the SDP offer or the two half-connections race
   * and neither completes. The tie-break is the seat number: the lower seat
   * always dials. A higher seat answers the announce with its own, so that the
   * newcomer below it learns it exists and dials in turn.
   */
  _onAnnounce(src) {
    if (!src || this.peers.has(src)) return;
    const theirSlot = Number(String(src).split('-').pop());
    if (Number.isFinite(theirSlot) && this.slot < theirSlot) this._dial(src);
    else this._signal(src, 'OFFER', { kind: 'hi' });
  }

  async _dial(id) {
    if (this.peers.has(id)) return;
    const peer = this._makePeer(id, true);
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      this._signal(id, 'OFFER', { kind: 'sdp', sdp: peer.pc.localDescription });
    } catch (err) {
      this.onError('rtc', `Appel vers ${id} échoué : ${err && err.message}`);
      this._drop(id);
    }
  }

  async _onOffer(src, sdp) {
    if (!src || !sdp) return;
    // A second offer from a peer we are already talking to is a reconnect after
    // their tab reloaded: throw the stale side away rather than ignoring it.
    if (this.peers.has(src)) this._drop(src);
    const peer = this._makePeer(src, false);
    try {
      await peer.pc.setRemoteDescription(sdp);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this._signal(src, 'ANSWER', { sdp: peer.pc.localDescription });
      for (const c of peer.pending) await peer.pc.addIceCandidate(c).catch(() => {});
      peer.pending.length = 0;
    } catch (err) {
      this.onError('rtc', `Réponse à ${src} échouée : ${err && err.message}`);
      this._drop(src);
    }
  }

  async _onAnswer(src, sdp) {
    const peer = this.peers.get(src);
    if (!peer || !sdp) return;
    try {
      await peer.pc.setRemoteDescription(sdp);
      for (const c of peer.pending) await peer.pc.addIceCandidate(c).catch(() => {});
      peer.pending.length = 0;
    } catch { /* the connection state watcher will clean up */ }
  }

  async _onCandidate(src, candidate) {
    const peer = this.peers.get(src);
    if (!peer || !candidate) return;
    // Candidates routinely arrive before the description they belong to.
    if (!peer.pc.remoteDescription) { peer.pending.push(candidate); return; }
    await peer.pc.addIceCandidate(candidate).catch(() => {});
  }

  _makePeer(id, initiator) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = {
      pc, state: null, meta: null, ready: false, pending: [], timer: 0,
      // Both channels have to be up before the peer counts as connected. They
      // open a few milliseconds apart in no guaranteed order, and announcing on
      // the first one means the hello — which carries the player's name and
      // colour, and goes out reliably on `meta` — can be dropped on the floor
      // by a channel that is still connecting. That failure is invisible: the
      // car turns up, in the wrong colour, called '…', for ever.
      open: new Set(),
    };
    this.peers.set(id, peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) this._signal(id, 'CANDIDATE', { candidate: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      // 'failed' covers both a handshake that never landed and a live link that
      // broke — a wifi hiccup mid-drive. Both deserve another go; the attempt
      // counter resets on every success, so a long session that stumbles twice
      // an hour never runs out of tries.
      if (s === 'failed') this._retryOrGiveUp(id);
      else if (s === 'closed') this._drop(id);
    };

    if (initiator) {
      // Two channels, because the two kinds of traffic want opposite things.
      // Snapshots are worthless once late, so they go unreliable and unordered —
      // a lost one is replaced 67 ms later by a fresher truth. Names and
      // goodbyes must arrive exactly once, so they go on a reliable channel.
      this._attach(id, peer, pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 }));
      this._attach(id, peer, pc.createDataChannel('meta', { ordered: true }));
    } else {
      pc.ondatachannel = (e) => this._attach(id, peer, e.channel);
    }

    peer.timer = setTimeout(() => {
      if (!peer.ready) this._retryOrGiveUp(id);
    }, DIAL_TIMEOUT_MS);

    return peer;
  }

  /**
   * A connection to `id` did not work, or stopped working.
   *
   * Retry rather than give up: the usual cause is a moment of congestion at
   * exactly the wrong time, not an unreachable peer, and an announce puts both
   * sides back at the top of the sequence — whichever holds the lower seat will
   * dial again. Only after several failures is it worth telling the player
   * something is actually wrong with their network.
   */
  _retryOrGiveUp(id) {
    if (this.closed) return;
    const tries = (this.attempts.get(id) || 0) + 1;
    this.attempts.set(id, tries);
    this._drop(id);

    if (tries >= DIAL_ATTEMPTS) {
      // Stand down for a minute rather than for ever: networks recover, and the
      // periodic announce will pick this seat back up once the window passes.
      this.cooldown.set(id, Date.now() + COOLDOWN_MS);
      this.onError('rtc',
        'Connexion directe impossible avec un joueur (NAT strict). '
        + 'Nouvel essai dans une minute. Un serveur TURN réglerait ça : ?ice=turn:…');
      return;
    }
    setTimeout(() => {
      if (this.closed || this.peers.has(id)) return;
      this._signal(id, 'OFFER', { kind: 'hi' });
    }, RETRY_DELAY_MS);
  }

  _attach(id, peer, channel) {
    peer[channel.label] = channel;
    channel.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.onMessage(id, msg);
    };
    channel.onopen = () => {
      peer.open.add(channel.label);
      if (peer.ready || !peer.open.has('state') || !peer.open.has('meta')) return;
      peer.ready = true;
      clearTimeout(peer.timer);
      this.attempts.delete(id);
      this.onPeer(id);
    };
    channel.onclose = () => this._drop(id);
  }

  _drop(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    clearTimeout(peer.timer);
    try { peer.pc.close(); } catch { /* already closed */ }
    if (peer.ready) this.onPeerGone(id);
  }

  /**
   * Broadcast to everyone.
   * @param {object} msg
   * @param {boolean} reliable meta channel (names, goodbyes) rather than state
   */
  send(msg, reliable = false) {
    const text = JSON.stringify(msg);
    for (const peer of this.peers.values()) {
      const ch = reliable ? peer.meta : peer.state;
      if (ch && ch.readyState === 'open') {
        try { ch.send(text); } catch { /* buffer full: drop, another follows */ }
      }
    }
  }

  /** Send to one peer, used to answer a hello with our own. */
  sendTo(id, msg, reliable = true) {
    const peer = this.peers.get(id);
    if (!peer) return;
    const ch = reliable ? peer.meta : peer.state;
    if (ch && ch.readyState === 'open') {
      try { ch.send(JSON.stringify(msg)); } catch { /* dropped */ }
    }
  }

  close() {
    this.closed = true;
    clearInterval(this._heartbeat);
    clearInterval(this._discovery);
    this.attempts.clear();
    this.cooldown.clear();
    for (const id of [...this.peers.keys()]) this._drop(id);
    if (this.socket) {
      try { this.socket.close(); } catch { /* already closed */ }
      this.socket = null;
    }
    this.slot = -1;
    this.id = '';
    this.room = '';
  }
}

export { DEFAULT_BROKER, DEFAULT_ICE };

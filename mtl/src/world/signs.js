// Overhead highway signs in the Québec style: a gantry over the carriageway,
// green panels, white text, the autoroute shield. Few objects, huge effect on
// "I know where I am" at 150 km/h.

import { textPanel, hasCanvas } from './textures.js';

const HEADING = { north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0] };

export function buildSigns(THREE, map, layout, M) {
  const out = [];
  for (const sign of map.signs) {
    const road = layout.roadById[sign.road];
    if (!road) continue;
    const p = nearest(road.samples, sign.at);
    const [fx, fn] = HEADING[sign.facing] || [0, 1];
    // Readers drive towards `facing`: their carriageway is on their right.
    const along = p.tx * fx + p.tn * fn >= 0 ? 1 : -1;
    const tx = p.tx * along, tn = p.tn * along;
    const rx = tn, rn = -tx;                   // right of the readers
    const half = road.half;
    const inner = road.median ? 0.8 : -half + 0.5, outer = half + 0.6;
    const span = outer - inner;
    const mid = (inner + outer) / 2;
    const cx = p.x + rx * mid, cn = p.n + rn * mid;
    const top = p.y + (p.covered ? 5.2 : 7.2);
    const g = new THREE.Group();
    g.name = 'Panneau';
    g.userData.zone = 'routes';
    const yaw = Math.atan2(rn, rx);            // local +X along (rx, rn)
    g.position.set(cx, 0, -cn);
    g.rotation.y = yaw;
    // Posts and beam.
    if (!p.covered) {
      for (const s of [-span / 2 - 0.3, span / 2 + 0.3]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.45, top + 3.2 - p.y, 0.45), M.Metal);
        post.position.set(s, p.y + (top + 3.2 - p.y) / 2, 0);
        g.add(post);
      }
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span + 1, 0.5, 0.9), M.Metal);
    beam.position.set(0, top + 3.1, 0);
    g.add(beam);
    // Panels, side by side, facing the readers (towards -along).
    const n = sign.panels.length;
    const pw = Math.min(10, (span - 1) / n - 0.4), ph = 3.4;
    sign.panels.forEach((panel, i) => {
      const x = -span / 2 + (span * (i + 0.5)) / n;
      let mat = M.Metal_Green;
      if (hasCanvas()) {
        const tex = textPanel(THREE, panel.text.split('\n'), {
          width: 768, height: 300, bg: panel.closed ? '#7a5a12' : '#0f5a2b', align: 'left', size: 54, top: 0.42,
          draw: (c, W, H) => shield(c, W, H, panel.ref, panel.dir, panel.closed),
        });
        mat = new THREE.MeshBasicMaterial({ map: tex, name: 'Panneau_autoroute', color: new THREE.Color(0xffffff).multiplyScalar(0.9) });
      }
      const face = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), mat);
      face.position.set(x, top + 1.3, 0.47);
      // The plane faces local +Z; readers come from local +Z when their
      // heading is -Z in the group's frame.
      face.rotation.y = 0;
      g.add(face);
      const back = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), M.Metal);
      back.position.set(x, top + 1.3, 0.45);
      back.rotation.y = Math.PI;
      g.add(back);
    });
    // With yaw = atan2(rn, rx), local +X is the readers' right and local +Z
    // points back at them, so the panels face the traffic.
    out.push(g);
  }
  return out;
}

function nearest(S, [x, n]) {
  let best = S[0], bd = Infinity;
  for (const p of S) {
    const d = (p.x - x) ** 2 + (p.n - n) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

/** The autoroute shield and the direction, top left of the panel. */
function shield(c, W, H, ref, dir, closed) {
  const x = W * 0.04, y = H * 0.1, w = H * 0.34, h = H * 0.38;
  c.save();
  if (!ref) {
    // An exit panel: the Québec yellow tab instead of a shield.
    c.fillStyle = '#f6c21c';
    c.fillRect(x, y, W * 0.36, h * 0.62);
    c.fillStyle = '#111111';
    c.font = `800 ${Math.round(h * 0.4)}px Helvetica, Arial, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(dir || 'SORTIE', x + W * 0.18, y + h * 0.33);
    c.restore();
    return;
  }
  c.fillStyle = '#1d3f95';
  c.strokeStyle = '#ffffff';
  c.lineWidth = 4;
  c.beginPath();
  c.moveTo(x, y); c.lineTo(x + w, y); c.lineTo(x + w, y + h * 0.7);
  c.quadraticCurveTo(x + w / 2, y + h * 1.05, x, y + h * 0.7);
  c.closePath();
  c.fill();
  c.stroke();
  c.fillStyle = '#c62828';
  c.fillRect(x + 2, y + 2, w - 4, h * 0.18);
  c.fillStyle = '#ffffff';
  c.font = `800 ${Math.round(h * 0.42)}px Helvetica, Arial, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  if (ref) c.fillText(ref, x + w / 2, y + h * 0.52);
  if (dir) {
    c.font = `700 ${Math.round(h * 0.3)}px Helvetica, Arial, sans-serif`;
    c.textAlign = 'left';
    c.fillText(dir, x + w + 14, y + h * 0.45);
  }
  if (closed) {
    c.fillStyle = '#ffb300';
    c.font = `800 ${Math.round(H * 0.16)}px Helvetica, Arial, sans-serif`;
    c.textAlign = 'right';
    c.fillText('FERMÉ', W * 0.95, H * 0.2);
  }
  c.restore();
}

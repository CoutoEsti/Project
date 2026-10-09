// Rain: a box of falling streaks that travels with the camera, one draw call.
// The streaks live in world space and wrap round the box, so driving through
// them looks right without simulating a drop. How hard it rains (0..1) sets
// how many are drawn; the colour follows the light of the sky.

const BOX = [70, 34, 70];   // metres round the camera

export function createRain(THREE, opts = {}) {
  const count = opts.count ?? 6000;
  const seeds = new Float32Array(count * 2 * 3);
  const ends = new Float32Array(count * 2);
  let s = 12345;
  const rnd = () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5 | 0) >>> 0) / 4294967296;
  for (let i = 0; i < count; i++) {
    const x = rnd(), y = rnd(), z = rnd();
    for (let e = 0; e < 2; e++) {
      seeds.set([x, y, z], (i * 2 + e) * 3);
      ends[i * 2 + e] = e;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(seeds, 3));
  g.setAttribute('end', new THREE.BufferAttribute(ends, 1));

  const uniforms = {
    time: { value: 0 },
    centre: { value: new THREE.Vector3() },
    box: { value: new THREE.Vector3(...BOX) },
    fall: { value: new THREE.Vector3(1.2, -11, 0.6) },   // m/s, with a little wind
    streak: { value: 0.09 },                              // seconds of fall per streak
    colour: { value: new THREE.Color(0x9aa3c0) },
    alpha: { value: 0.35 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    fog: false,
    vertexShader: `
      uniform float time; uniform vec3 centre; uniform vec3 box; uniform vec3 fall; uniform float streak;
      attribute float end;
      varying float vFade;
      void main() {
        // Each drop falls from its seed and wraps round the box, kept centred
        // on the camera: the same drop is always at the same place.
        vec3 p = position * box + fall * time;
        p = centre + mod(p - centre, box) - box * 0.5;
        p += fall * streak * end;
        vec3 d = p - centre;
        // Thin out near the box walls (no plane of rain popping in) and at
        // the camera (no streak across the whole screen).
        vec3 q = abs(d) / (box * 0.5);
        vFade = (1.0 - smoothstep(0.7, 1.0, max(q.x, max(q.y, q.z)))) * smoothstep(1.0, 4.0, length(d));
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 colour; uniform float alpha;
      varying float vFade;
      void main() {
        gl_FragColor = vec4(colour, alpha * vFade);
        #include <colorspace_fragment>
      }`,
  });
  const lines = new THREE.LineSegments(g, mat);
  lines.name = 'Pluie';
  lines.frustumCulled = false;
  lines.renderOrder = 5;
  lines.visible = false;

  return {
    object: lines,
    /**
     * @param {number} amount  0..1, how hard it rains
     * @param {number} night   0..1, for the colour of the light on the drops
     */
    update(time, camera, amount, night) {
      lines.visible = amount > 0.01;
      if (!lines.visible) return;
      g.setDrawRange(0, 2 * Math.round(count * amount));
      uniforms.time.value = time;
      uniforms.centre.value.copy(camera.position);
      // Lit by the street at night (warm grey), by the sky by day.
      uniforms.colour.value.setRGB(0.62 + 0.1 * night, 0.66, 0.78 - 0.1 * night);
      uniforms.alpha.value = 0.22 + 0.2 * night;
    },
    dispose() { g.dispose(); mat.dispose(); },
  };
}

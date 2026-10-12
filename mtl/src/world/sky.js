// Sky, fog and light, for night (the default — this is a street-racing city)
// and for day (to read the map). The sky dome is a gradient shader; the same
// dome is baked into a PMREM environment so glass, water and paint reflect it.

export function createSky(THREE, scene, renderer) {
  const uniforms = {
    top: { value: new THREE.Color() },
    horizon: { value: new THREE.Color() },
    glow: { value: new THREE.Color() },
    glow2: { value: new THREE.Color() },
    stars: { value: 1 },
    haze: { value: new THREE.Color() },
  };
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(9000, 32, 16),
    new THREE.ShaderMaterial({
      uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * p;
          gl_Position.z = gl_Position.w;
        }`,
      fragmentShader: `
        uniform vec3 top; uniform vec3 horizon; uniform vec3 glow; uniform vec3 glow2; uniform float stars; uniform vec3 haze;
        varying vec3 vDir;
        float h(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
        void main() {
          float y = clamp(vDir.y, -0.2, 1.0);
          vec3 c = mix(horizon, top, pow(max(y, 0.0), 0.55));
          // City glow low on the horizon, scattered in the haze: magenta one
          // way, teal the other, slowly turning round the sky.
          float side = 0.5 + 0.5 * sin(atan(vDir.z, vDir.x) * 1.0 + 0.6);
          c += mix(glow, glow2, side) * exp(-max(y, 0.0) * 7.0);
          // Low cloud deck lit from below.
          c += glow * 0.35 * smoothstep(0.08, 0.2, y) * (1.0 - smoothstep(0.2, 0.45, y));
          // The sky meets the ground in the fog's own colour: no seam where
          // the last fogged rooftop ends and the dome begins.
          c = mix(haze, c, smoothstep(-0.01, 0.07, vDir.y));
          if (stars > 0.0 && y > 0.05) {
            vec3 q = floor(vDir * 420.0);
            float s = step(0.9985, h(q)) * smoothstep(0.05, 0.4, y);
            c += vec3(s) * stars * 0.8;
          }
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  );
  dome.name = 'Ciel';
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  scene.add(dome);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(-600, 900, 400);
  scene.add(sun);
  scene.add(sun.target);
  scene.fog = new THREE.FogExp2(0x000000, 0.0005);

  const pmrem = renderer ? new THREE.PMREMGenerator(renderer) : null;
  let envRT = null;
  let carRT = null;

  function set(mode) {
    const night = mode !== 'day';
    if (night) {
      // Not the future: Montréal on a humid night, where the signs win over
      // the sodium. Indigo overhead, a violet haze, the city's glow low on
      // the horizon going from magenta to teal.
      uniforms.top.value.set(0x04030c);
      uniforms.horizon.value.set(0x1a1030);
      uniforms.glow.value.set(0x3a1440);
      uniforms.glow2.value.set(0x0a3a4a);
      uniforms.stars.value = 0.35;
      hemi.color.set(0x5262b0);
      hemi.groundColor.set(0x3e2040);
      hemi.intensity = 0.6;
      sun.color.set(0x8ea6ff);
      sun.intensity = 0.4;
      sun.position.set(900, 1400, -500);
      scene.fog.color.set(0x1a1128);
      scene.fog.density = 0.00058;
    } else {
      uniforms.top.value.set(0x2f6fb8);
      uniforms.horizon.value.set(0xbcd3e6);
      uniforms.glow.value.set(0x000000);
      uniforms.glow2.value.set(0x000000);
      uniforms.stars.value = 0;
      hemi.color.set(0xcfe2ff);
      hemi.groundColor.set(0x5a5043);
      hemi.intensity = 1.15;
      sun.color.set(0xfff1dc);
      sun.intensity = 2.6;
      sun.position.set(-700, 1100, 500);
      scene.fog.color.set(0xa9bfd3);
      scene.fog.density = 0.00022;
    }
    uniforms.haze.value.copy(scene.fog.color);
    if (pmrem) {
      // Bake the dome alone into an environment map — without the stars, or
      // every dark window in the city sparkles with them.
      const stars = uniforms.stars.value;
      uniforms.stars.value = 0;
      const env = new THREE.Scene();
      const clone = dome.clone();
      clone.material = dome.material;
      env.add(clone);
      if (envRT) envRT.dispose();
      envRT = pmrem.fromScene(env, 0, 1, 20000);
      scene.environment = envRT.texture;
      scene.environmentIntensity = night ? 0.45 : 1.0;
      if (carRT) carRT.dispose();
      const cs = carScene(night);
      carRT = pmrem.fromScene(cs, 0, 0.1, 20000);
      cs.traverse((o) => { if (o.geometry && o.material !== dome.material) { o.geometry.dispose(); o.material.dispose(); } });
      uniforms.stars.value = stars;
    }
    return night;
  }

  // The car's own reflections. Under the city's environment alone the body is
  // a near-black blob at night: the dome is dark and nothing else lights it.
  // This one is the same dome over dark asphalt, ringed with what a car on a
  // Montréal street at night actually mirrors — lamp heads, shop fronts,
  // neon — so the paint keeps its colour and the highlights slide along it.
  // Baked once per mode; it costs nothing per frame and lights nothing else.
  function carScene(night) {
    const env = new THREE.Scene();
    const clone = dome.clone();
    clone.material = dome.material;
    env.add(clone);
    const basic = (hex, k) => new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), fog: false });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), basic(night ? 0x08080c : 0x3c3d40, 1));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1;
    env.add(ground);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const put = (mat, a, r, y, w, h) => {
      const m = new THREE.Mesh(box, mat);
      m.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
      m.scale.set(w, h, w);
      m.lookAt(0, y, 0);
      env.add(m);
    };
    if (night) {
      const lamp = basic(0xffd59a, 14), led = basic(0xe8f0ff, 12);
      const neons = [basic(0x2fe6ff, 6), basic(0xff3fb4, 6), basic(0xffb347, 5)];
      const shop = basic(0xffe2b8, 0.35);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + 0.2;
        put(i % 3 ? lamp : led, a, 18 + (i % 4) * 7, 7.5, 1.6, 0.5);
        put(shop, a + 0.26, 16, 2.2, 5, 2);
        put(neons[i % 3], a + 0.13, 15, 4, 0.5, 2.6);
      }
      // A faint overhead softbox: the glow of the sky above the street.
      const sky = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), basic(0x2a2440, 1.2));
      sky.rotation.x = Math.PI / 2;
      sky.position.y = 30;
      env.add(sky);
    } else {
      // By day the dome already does the work; a few building faces break
      // the horizon so the body doesn't read as chrome.
      const wall = basic(0x8a8580, 1), wall2 = basic(0xb9b2a6, 1);
      for (let i = 0; i < 10; i++) put(i % 2 ? wall : wall2, (i / 10) * Math.PI * 2, 30, 6, 14, 14 + (i % 3) * 8);
    }
    return env;
  }

  /** The car's environment map, for the current mode. */
  function carEnvironment() {
    return carRT ? carRT.texture : null;
  }

  function follow(camera) {
    dome.position.copy(camera.position);
  }

  return { set, follow, carEnvironment, sun, hemi, dome };
}

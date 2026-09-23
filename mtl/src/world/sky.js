// Sky, fog and light, for night (the default — this is a street-racing city)
// and for day (to read the map). The sky dome is a gradient shader; the same
// dome is baked into a PMREM environment so glass, water and paint reflect it.

export function createSky(THREE, scene, renderer) {
  const uniforms = {
    top: { value: new THREE.Color() },
    horizon: { value: new THREE.Color() },
    glow: { value: new THREE.Color() },
    stars: { value: 1 },
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
        uniform vec3 top; uniform vec3 horizon; uniform vec3 glow; uniform float stars;
        varying vec3 vDir;
        float h(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
        void main() {
          float y = clamp(vDir.y, -0.2, 1.0);
          vec3 c = mix(horizon, top, pow(max(y, 0.0), 0.55));
          // City glow low on the horizon: sodium light scattered in the haze.
          c += glow * exp(-max(y, 0.0) * 9.0);
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

  function set(mode) {
    const night = mode !== 'day';
    if (night) {
      uniforms.top.value.set(0x03060d);
      uniforms.horizon.value.set(0x0f1624);
      uniforms.glow.value.set(0x22160d);
      uniforms.stars.value = 1;
      hemi.color.set(0x6d82b0);
      hemi.groundColor.set(0x3a2a1c);
      hemi.intensity = 0.9;
      sun.color.set(0x9fb4de);
      sun.intensity = 0.45;
      sun.position.set(900, 1400, -500);
      scene.fog.color.set(0x121419);
      scene.fog.density = 0.00052;
    } else {
      uniforms.top.value.set(0x2f6fb8);
      uniforms.horizon.value.set(0xbcd3e6);
      uniforms.glow.value.set(0x000000);
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
      uniforms.stars.value = stars;
      scene.environment = envRT.texture;
      scene.environmentIntensity = night ? 0.6 : 1.0;
    }
    return night;
  }

  function follow(camera) {
    dome.position.copy(camera.position);
  }

  return { set, follow, sun, hemi, dome };
}

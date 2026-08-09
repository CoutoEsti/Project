// Sky, sun and the day/night cycle.
//
// One shader dome plus one directional light. The palette is keyed off the
// sun's elevation, so dawn, noon, dusk and night all fall out of a single
// number — and the fog is always tinted to match the horizon, which is what
// stops the world ending in a visible wall.

import * as THREE from 'three';

const VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uNight;
varying vec3 vDir;

// Cheap hash for the stars; no texture needed.
float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  vec3 dir = normalize(vDir);
  float h = clamp(dir.y, -1.0, 1.0);

  // Horizon-to-zenith gradient, compressed near the horizon.
  float t = pow(clamp(h * 0.5 + 0.5, 0.0, 1.0), 0.55);
  vec3 col = mix(uHorizon, uZenith, t);

  // Ground half: darken rather than showing sky under the world.
  col = mix(col * 0.62, col, smoothstep(-0.08, 0.05, h));

  float sun = max(dot(dir, uSunDir), 0.0);
  col += uSunColor * pow(sun, 400.0) * 12.0;          // disc
  col += uSunColor * pow(sun, 8.0) * 0.30;            // bloom
  col += uSunColor * pow(sun, 2.0) * 0.06;            // wide wash

  if (uNight > 0.02 && h > -0.02) {
    vec3 cell = floor(dir * 260.0);
    float star = hash(cell);
    float intensity = smoothstep(0.9975, 1.0, star);
    col += vec3(0.85, 0.88, 1.0) * intensity * uNight * (0.35 + 0.65 * h);
  }

  gl_FragColor = vec4(col, 1.0);
}`;

// Key frames of the palette, by sun elevation in degrees.
const STOPS = [
  { el: -14, zenith: [0.020, 0.030, 0.062], horizon: [0.045, 0.058, 0.098], sun: [0.10, 0.12, 0.20], light: [0.10, 0.13, 0.24], intensity: 0.06, ambient: 0.24 },
  { el: -5, zenith: [0.055, 0.075, 0.150], horizon: [0.190, 0.150, 0.190], sun: [0.55, 0.34, 0.30], light: [0.30, 0.26, 0.34], intensity: 0.22, ambient: 0.34 },
  { el: 2, zenith: [0.130, 0.190, 0.330], horizon: [0.780, 0.430, 0.250], sun: [1.00, 0.58, 0.30], light: [1.00, 0.62, 0.42], intensity: 0.85, ambient: 0.45 },
  { el: 12, zenith: [0.190, 0.330, 0.560], horizon: [0.760, 0.700, 0.610], sun: [1.00, 0.86, 0.66], light: [1.00, 0.88, 0.74], intensity: 1.45, ambient: 0.55 },
  { el: 40, zenith: [0.235, 0.450, 0.760], horizon: [0.700, 0.810, 0.900], sun: [1.00, 0.97, 0.90], light: [1.00, 0.97, 0.92], intensity: 1.85, ambient: 0.68 },
  { el: 90, zenith: [0.210, 0.430, 0.780], horizon: [0.720, 0.830, 0.920], sun: [1.00, 0.99, 0.95], light: [1.00, 0.99, 0.96], intensity: 1.95, ambient: 0.72 },
];

function lerp(a, b, t) { return a + (b - a) * t; }
function lerp3(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }

function paletteAt(elevationDeg) {
  if (elevationDeg <= STOPS[0].el) return STOPS[0];
  for (let i = 1; i < STOPS.length; i++) {
    if (elevationDeg <= STOPS[i].el) {
      const a = STOPS[i - 1], b = STOPS[i];
      const t = (elevationDeg - a.el) / (b.el - a.el);
      return {
        zenith: lerp3(a.zenith, b.zenith, t),
        horizon: lerp3(a.horizon, b.horizon, t),
        sun: lerp3(a.sun, b.sun, t),
        light: lerp3(a.light, b.light, t),
        intensity: lerp(a.intensity, b.intensity, t),
        ambient: lerp(a.ambient, b.ambient, t),
      };
    }
  }
  return STOPS[STOPS.length - 1];
}

export class Sky {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.latitude = opts.latitude ?? 45.5;
    this.shadows = opts.shadows !== false;
    this.night = 0;

    this.uniforms = {
      uZenith: { value: new THREE.Color(0.2, 0.4, 0.75) },
      uHorizon: { value: new THREE.Color(0.7, 0.8, 0.9) },
      uSunColor: { value: new THREE.Color(1, 0.97, 0.9) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.6, 0.4) },
      uNight: { value: 0 },
    };

    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(4000, 32, 20),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: VERT,
        fragmentShader: FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    );
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    scene.add(this.dome);

    this.sun = new THREE.DirectionalLight(0xffffff, 1.8);
    this.sun.castShadow = this.shadows;
    if (this.shadows) {
      const s = opts.shadowExtent ?? 150;
      this.sun.shadow.mapSize.set(opts.shadowMap ?? 2048, opts.shadowMap ?? 2048);
      this.sun.shadow.camera.left = -s;
      this.sun.shadow.camera.right = s;
      this.sun.shadow.camera.top = s;
      this.sun.shadow.camera.bottom = -s;
      this.sun.shadow.camera.near = 1;
      this.sun.shadow.camera.far = 700;
      this.sun.shadow.bias = -0.0009;
      this.sun.shadow.normalBias = 0.05;
    }
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.ambient = new THREE.HemisphereLight(0xbdd6f0, 0x6b6455, 0.6);
    scene.add(this.ambient);

    // The sky is also the scene's light source: a second, small dome sharing
    // the same shader material gets baked into a prefiltered environment map.
    // That is what windows, water and car paint reflect — and it carries most
    // of the ambient light, which is why the hemisphere fill stays low.
    this._envScene = new THREE.Scene();
    const envDome = new THREE.Mesh(new THREE.SphereGeometry(50, 24, 16), this.dome.material);
    envDome.frustumCulled = false;
    this._envScene.add(envDome);
    this._pmrem = null;
    this._envRT = null;
    this._envBakedAt = -99;
    this._envWallClock = 0;
    this._hours = 12;

    this.weather = { saturation: 1, brightness: 1, fogScale: 1, sunScale: 1, envScale: 1 };
    this.fog = new THREE.Fog(0xb0c4d8, 60, 620);
    scene.fog = this.fog;
  }

  /**
   * @param {number} hours 0-24
   * @param {number} dayOfYear used only to tilt the sun's arc a little
   */
  setTime(hours, dayOfYear = 180) {
    const h = ((hours % 24) + 24) % 24;
    this._hours = h;
    // A simple solar position: good enough that noon is high and 6pm is low,
    // which is all the renderer needs.
    const decl = 23.44 * Math.PI / 180 * Math.sin((2 * Math.PI * (dayOfYear - 81)) / 365);
    const hourAngle = ((h - 12) / 12) * Math.PI;
    const lat = this.latitude * Math.PI / 180;

    const sinEl = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
    const elevation = Math.asin(Math.max(-1, Math.min(1, sinEl)));
    const azimuth = Math.atan2(
      Math.sin(hourAngle),
      Math.cos(hourAngle) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat),
    );

    const elDeg = elevation * 180 / Math.PI;
    const p = grade(paletteAt(elDeg), this.weather);

    // Sun direction in world space (+X east, -Z north).
    const cosEl = Math.cos(elevation);
    const dir = new THREE.Vector3(
      cosEl * Math.sin(azimuth),
      Math.sin(elevation),
      cosEl * Math.cos(azimuth),
    ).normalize();

    this.uniforms.uSunDir.value.copy(dir);
    this.uniforms.uZenith.value.setRGB(p.zenith[0], p.zenith[1], p.zenith[2]);
    this.uniforms.uHorizon.value.setRGB(p.horizon[0], p.horizon[1], p.horizon[2]);
    this.uniforms.uSunColor.value.setRGB(p.sun[0], p.sun[1], p.sun[2]);

    this.night = 1 - smoothstep(-7, 5, elDeg);
    this.uniforms.uNight.value = this.night;

    this.sun.color.setRGB(p.light[0], p.light[1], p.light[2]);
    this.sun.intensity = p.intensity * 0.85 * this.weather.sunScale;
    this.sun.position.copy(dir).multiplyScalar(320);

    // IBL supplies most of the ambient now; the hemisphere is just fill.
    this.ambient.intensity = p.ambient * 0.38;
    this.ambient.color.setRGB(
      lerp(0.28, 0.74, 1 - this.night), lerp(0.32, 0.84, 1 - this.night), lerp(0.48, 0.94, 1 - this.night),
    );
    this.ambient.groundColor.setRGB(
      lerp(0.10, 0.42, 1 - this.night), lerp(0.10, 0.39, 1 - this.night), lerp(0.14, 0.33, 1 - this.night),
    );

    // Fog takes the horizon colour so distance dissolves into the sky.
    this.fog.color.setRGB(p.horizon[0], p.horizon[1], p.horizon[2]);
    this.fog.near = 120 * this.weather.fogScale;
    this.fog.far = (1250 + (1 - this.night) * 350) * this.weather.fogScale;
  }

  /**
   * Re-bake the environment map when the clock has moved enough to matter.
   * Throttled on both game time and wall clock so dragging the time slider
   * does not re-filter a cubemap every frame.
   */
  updateEnvironment(renderer, scene, force = false) {
    const now = performance.now();
    if (!force) {
      if (Math.abs(this._hours - this._envBakedAt) < 0.1) return;
      if (now - this._envWallClock < 300) return;
    }
    this._envBakedAt = this._hours;
    this._envWallClock = now;
    if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(renderer);
    const rt = this._pmrem.fromScene(this._envScene, 0.03);
    scene.environment = rt.texture;
    // The env map is a light source on top of sun + hemisphere, so it enters
    // at about half strength or the whole scene washes out to pastel.
    scene.environmentIntensity = (0.45 - this.night * 0.12) * this.weather.envScale;
    if (this._envRT) this._envRT.dispose();
    this._envRT = rt;
  }

  /** Apply a weather preset; the next setTime() picks it up. */
  setWeather(spec) {
    this.weather = spec;
    this._envBakedAt = -99;    // force the environment map to be re-cooked
  }

  /** Keep the sun's shadow frustum centred on the car. */
  follow(x, z) {
    this.dome.position.set(x, 0, z);
    this.sun.target.position.set(x, 0, z);
    this.sun.position.set(
      x + this.uniforms.uSunDir.value.x * 320,
      Math.max(40, this.uniforms.uSunDir.value.y * 320),
      z + this.uniforms.uSunDir.value.z * 320,
    );
    this.sun.target.updateMatrixWorld();
  }

  dispose() {
    if (this._envRT) this._envRT.dispose();
    if (this._pmrem) this._pmrem.dispose();
    this.scene.remove(this.dome, this.sun, this.sun.target, this.ambient);
    this.dome.geometry.dispose();
    this.dome.material.dispose();
    this.scene.fog = null;
  }
}

/**
 * Push a palette towards the weather: desaturate, darken, and warm the sky
 * slightly grey. Done on the palette rather than as a post-process so the sun,
 * the fog and the environment map all agree with each other.
 */
function grade(p, w) {
  if (w.saturation === 1 && w.brightness === 1) return p;
  const wash = (c) => {
    const grey = (c[0] + c[1] + c[2]) / 3;
    return [
      (grey + (c[0] - grey) * w.saturation) * w.brightness,
      (grey + (c[1] - grey) * w.saturation) * w.brightness,
      (grey + (c[2] - grey) * w.saturation) * w.brightness,
    ];
  };
  return {
    zenith: wash(p.zenith),
    horizon: wash(p.horizon),
    sun: wash(p.sun),
    light: wash(p.light),
    intensity: p.intensity,
    ambient: p.ambient * (0.85 + 0.15 * w.brightness),
  };
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

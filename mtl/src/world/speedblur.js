// Speed blur: the edges of the picture smear outwards from the middle as the
// car goes fast; the road ahead stays sharp. One full-screen pass of eight
// taps, skipped entirely below the speed where it starts.

export const SpeedBlurShader = {
  name: 'SpeedBlurShader',
  uniforms: {
    tDiffuse: { value: null },
    amount: { value: 0 },
    centre: { value: [0.5, 0.45] },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float amount;
    uniform vec2 centre;
    varying vec2 vUv;
    void main() {
      vec2 d = vUv - centre;
      // Nothing in the middle third, full at the corners.
      float edge = smoothstep(0.12, 0.5, length(d * vec2(1.0, 0.8)));
      vec2 step = d * amount * edge * 0.014;
      // A different start per pixel: thin lines (rain, poles) smear instead
      // of showing eight sharp copies.
      float j = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
      vec4 c = vec4(0.0);
      for (int i = 0; i < 8; i++) c += texture2D(tDiffuse, vUv - step * (float(i) + j));
      gl_FragColor = c / 8.0;
    }`,
};

/** How much blur at a speed (km/h): none below 110, full from 260. */
export function blurAt(kmh) {
  const t = Math.min(1, Math.max(0, (kmh - 110) / 150));
  return t * t;
}

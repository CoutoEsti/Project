// Final grade, after tone mapping, in display space: a touch of contrast and
// saturation (the night haze leaves the image grey), a vignette that pulls the
// eye to the road, and a one-level dither that breaks the bands in the dark
// sky gradient. One full-screen pass; off on phones.

export const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    contrast: { value: 1.06 },
    saturation: { value: 1.12 },
    vignette: { value: 0.32 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float contrast;
    uniform float saturation;
    uniform float vignette;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 t = texture2D(tDiffuse, vUv);
      vec3 c = t.rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, saturation);
      c = (c - 0.5) * contrast + 0.5;
      // Wider than tall: the corners darken, the road ahead does not.
      vec2 d = (vUv - 0.5) * vec2(1.0, 0.75);
      c *= 1.0 - vignette * smoothstep(0.18, 0.62, dot(d, d) * 2.2);
      c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), t.a);
    }`,
};

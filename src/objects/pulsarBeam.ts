import * as THREE from 'three';
import { NOISE } from '../shaders/common';
import { pixelScale, volumeSamples } from '../shared';

/**
 * Volumetric pulsar emission (both magnetic poles), evaluated in the frame of the
 * magnetic axis (+y), with the star at the origin and radius 1 (≈12 km).
 *
 * Emission model, following the empirical picture of radio pulsar beams
 * (Rankin 1983/1993; Ruderman & Sutherland 1975):
 *  - a central "core" component along the magnetic axis,
 *  - an inner hollow "cone" fed by discrete sparks above the polar cap that
 *    circulate around the magnetic axis (E×B drift → drifting subpulses),
 *  - a fainter outer cone.
 *
 * Light-travel delay: the radiation now at radius r left the star r/c ago, when the
 * star was rotated back by Ω·r/c = r / R_LC. A snapshot of the beam is therefore an
 * Archimedean spiral that winds by one radian per light-cylinder radius. For
 * millisecond pulsars (R_LC ≈ 5 stellar radii) this is dramatic; for slow pulsars
 * the beam is almost straight. The angle uses the real period, so it is physical
 * even though the animation is slowed down.
 */

export const BEAM_LENGTH = 20;

export interface BeamUniforms {
  [key: string]: THREE.IUniform;
  uTime: THREE.IUniform<number>;
  uHalf: THREE.IUniform<number>;      // emission cone half-opening angle (rad)
  uSparks: THREE.IUniform<number>;    // number of sparks in the carousel (0 = smooth)
  uDrift: THREE.IUniform<number>;     // carousel angular speed (rad / s, visual)
  uCore: THREE.IUniform<number>;      // core component strength
  uIntensity: THREE.IUniform<number>;
  uLag: THREE.IUniform<number>;       // 1 / R_LC  (rad per stellar radius)
  uSpinAxis: THREE.IUniform<THREE.Vector3>; // spin axis in the magnetic frame
  uCamLocal: THREE.IUniform<THREE.Vector3>; // camera position in the magnetic frame
}

/** Angular emission profile shared by the shader and the JS pulse-profile plot. x = θ / θ_half. */
export function beamProfile(x: number, core: number): number {
  return core * Math.exp(-(x * x) / 0.08) + Math.exp(-(((x - 0.62) / 0.12) ** 2)) + 0.3 * Math.exp(-(((x - 0.95) / 0.07) ** 2));
}

const GLSL_COMMON = /* glsl */ `
vec3 rotAxis(vec3 v, vec3 k, float a){
  float c = cos(a), s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
`;

const GLSL_EMISSION = /* glsl */ `
float sparkMod(float phi, float t){
  if (uSparks < 0.5) return 1.0;
  float s = 0.5 + 0.5 * cos(uSparks * (phi - uDrift * t));
  return mix(0.1, 1.0, pow(s, 6.0));
}
// One pole, axis +y.
float poleEmission(vec3 q, float t){
  float y = q.y;
  if (y <= 0.0) return 0.0;
  float rho = length(q.xz);
  float x = atan(rho, y) / uHalf;
  if (x > 1.25) return 0.0;
  float phi = atan(q.z, q.x);
  float sm = sparkMod(phi, t);
  float core = uCore * exp(-x * x / 0.08);
  float inner = exp(-pow((x - 0.62) / 0.12, 2.0)) * sm;
  float outer = 0.3 * exp(-pow((x - 0.95) / 0.07, 2.0)) * mix(1.0, sm, 0.5);
  // Plasma bunches streaming outward along the open field lines.
  float bunch = 0.7 + 0.3 * snoise(vec3(x * 3.0, phi * 1.5, y * 0.6 - t * 5.0));
  float edge = smoothstep(1.25, 0.9, x);
  float radial = smoothstep(1.0, 2.4, y) * (1.0 - smoothstep(${(BEAM_LENGTH * 0.6).toFixed(1)}, ${BEAM_LENGTH.toFixed(1)}, y)) * 3.0 / (1.0 + 0.08 * y * y);
  return (core * 1.2 + inner + outer) * bunch * radial * edge;
}
float emission(vec3 q, float t, out float xcol){
  float r = length(q);
  // Undo the light-travel lag: find where this radiation was pointing when it left.
  vec3 qe = rotAxis(q, uSpinAxis, uLag * r);
  float e1 = poleEmission(qe, t);
  float e2 = poleEmission(-qe, t + 17.0);
  float y = abs(qe.y);
  xcol = atan(length(qe.xz), y) / uHalf;
  return e1 + e2;
}
`;

export function createBeam(uniforms: BeamUniforms) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uSamples: volumeSamples },
    transparent: true,
    depthWrite: false,
    depthTest: false,           // the ray is clipped against the star analytically
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      void main(){ vLocal = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vLocal;
      uniform float uTime, uHalf, uSparks, uDrift, uCore, uIntensity, uLag;
      uniform vec3 uCamLocal, uSpinAxis;
      uniform float uSamples;
      ${NOISE}
      ${GLSL_COMMON}
      ${GLSL_EMISSION}
      float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      void main(){
        vec3 ro = uCamLocal;
        vec3 rd = normalize(vLocal - ro);
        // Segment of the ray inside the bounding sphere ...
        float b = dot(ro, rd);
        float R = ${BEAM_LENGTH.toFixed(1)};
        float disc = b * b - (dot(ro, ro) - R * R);
        if (disc <= 0.0) discard;
        float sq = sqrt(disc);
        float t0 = max(-b - sq, 0.0);
        float t1 = -b + sq;
        // ... stopped by the neutron star itself.
        float ds = b * b - (dot(ro, ro) - 1.0);
        if (ds > 0.0) { float ts = -b - sqrt(ds); if (ts > 0.0) t1 = min(t1, ts); }
        if (t1 <= t0) discard;

        float N = uSamples;
        float dt = (t1 - t0) / N;
        float jitter = hash12(gl_FragCoord.xy + fract(uTime * 7.0) * 61.0);
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 160; i++) {
          if (float(i) >= N) break;
          vec3 q = ro + rd * (t0 + (float(i) + jitter) * dt);
          float xc;
          float e = emission(q, uTime, xc);
          if (e <= 0.0) continue;
          // False colour: radio emission is invisible; core shown blue-white, cone violet-blue.
          vec3 col = mix(vec3(0.78, 0.9, 1.0), vec3(0.45, 0.5, 1.0), smoothstep(0.2, 0.75, xc));
          acc += col * e * dt;
        }
        // Soft saturation so looking down the beam doesn't blow out to white.
        vec3 e = acc * uIntensity * 2.0;
        gl_FragColor = vec4(1.1 * (1.0 - exp(-e / 1.1)), 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(BEAM_LENGTH, 48, 32), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  return mesh;
}

// Position of an outflowing particle at phase u along the open field lines of one pole,
// then wound back by the light-travel lag so it follows the spiral beam.
const PARTICLE_POS = /* glsl */ `
${GLSL_COMMON}
vec3 particlePos(vec4 seed, float pole, float u){
  float y = 1.0 + u * ${(BEAM_LENGTH - 3).toFixed(1)};
  float x;
  float phi;
  if (seed.z < 0.35) {                // core stream
    x = sqrt(seed.w) * 0.35;
    phi = seed.w * 6.2831853 * 7.0;
  } else {                            // conal streams fed by the sparks
    x = 0.62 + (seed.w - 0.5) * 0.16;
    float n = max(uSparks, 1.0);
    float k = floor(seed.z * 997.0);
    phi = uSparks < 0.5 ? seed.z * 6.2831853 * 13.0
                        : 6.2831853 * mod(k, n) / n + uDrift * uTime + (seed.w - 0.5) * 0.1;
  }
  float r = y * tan(x * uHalf) * (1.0 + 0.015 * y);
  vec3 p = vec3(r * cos(phi), y, r * sin(phi)) * pole;
  return rotAxis(p, uSpinAxis, -uLag * length(p));
}
float particleU(vec4 seed){ return fract(seed.x + uTime * (0.12 + 0.18 * seed.y)); }
`;

/**
 * Charged particles (e± pairs) streaming out along the open field lines of both poles.
 * Rendered as motion-blurred streaks (line segments) plus glowing heads.
 */
export function createParticles(uniforms: BeamUniforms, count = 10000) {
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  const poles = new Float32Array(count);
  for (let i = 0; i < count; i++) poles[i] = i % 2 ? 1 : -1;
  const group = new THREE.Group();

  // Streaks: 2 vertices per particle (head, tail).
  const sSeeds = new Float32Array(count * 8);
  const sPoles = new Float32Array(count * 2);
  const ends = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    sSeeds.set(seeds.subarray(i * 4, i * 4 + 4), i * 8);
    sSeeds.set(seeds.subarray(i * 4, i * 4 + 4), i * 8 + 4);
    sPoles[i * 2] = sPoles[i * 2 + 1] = poles[i];
    ends[i * 2 + 1] = 1;
  }
  const sGeo = new THREE.BufferGeometry();
  sGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 6), 3));
  sGeo.setAttribute('aSeed', new THREE.BufferAttribute(sSeeds, 4));
  sGeo.setAttribute('aPole', new THREE.BufferAttribute(sPoles, 1));
  sGeo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
  const streakMat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed; attribute float aPole; attribute float aEnd;
      uniform float uTime, uHalf, uSparks, uDrift, uLag;
      uniform vec3 uSpinAxis;
      varying float vA;
      ${PARTICLE_POS}
      void main(){
        float u = particleU(aSeed);
        float uu = max(u - aEnd * 0.035, 0.0);
        vec3 p = particlePos(aSeed, aPole, uu);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        vA = (1.0 - aEnd) * smoothstep(0.0, 0.08, u) * (1.0 - smoothstep(0.55, 1.0, u)) * (0.4 + 0.6 * aSeed.w);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main(){ gl_FragColor = vec4(vec3(0.55, 0.75, 1.0) * vA * 0.22, 1.0); }
    `,
  });
  const streaks = new THREE.LineSegments(sGeo, streakMat);
  streaks.frustumCulled = false;
  group.add(streaks);

  // Glowing heads.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  geo.setAttribute('aPole', new THREE.BufferAttribute(poles, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uPixel: pixelScale },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed; attribute float aPole;
      uniform float uTime, uHalf, uSparks, uDrift, uPixel, uLag;
      uniform vec3 uSpinAxis;
      varying float vAlpha;
      ${PARTICLE_POS}
      void main(){
        float u = particleU(aSeed);
        vec3 p = particlePos(aSeed, aPole, u);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float sz = uPixel * 0.05 / -mv.z;
        gl_PointSize = clamp(sz, 1.0, 7.0);
        vAlpha = min(sz * sz, 1.0) * smoothstep(0.0, 0.08, u) * (1.0 - smoothstep(0.6, 1.0, u));
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main(){
        vec2 c = gl_PointCoord - 0.5;
        float f = exp(-dot(c, c) * 14.0);
        gl_FragColor = vec4(vec3(0.75, 0.88, 1.0) * f * vAlpha * 0.5, 1.0);
      }
    `,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  group.add(pts);
  return group;
}

/**
 * Plasma trapped on closed dipole field lines (r = L·sin²θ): particles gyrate,
 * bounce between mirror points near the two poles and slowly drift in longitude.
 */
export function createTrappedParticles(count = 7000) {
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  const uniforms = { uTime: { value: 0 }, uPixel: pixelScale, uIntensity: { value: 1 }, uMaxL: { value: 7.5 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime, uPixel, uMaxL;
      varying float vA;
      void main(){
        // Closed field lines only exist inside the light cylinder.
        float L = mix(1.6, max(min(7.5, uMaxL), 1.7), pow(aSeed.x, 1.3));
        float th0 = asin(sqrt(1.0 / L));
        float mirror = mix(0.35, 0.95, aSeed.z);                // pitch angle → mirror latitude
        float s = sin(uTime * (0.8 + 1.2 * aSeed.y) / sqrt(L) + aSeed.w * 6.2831853);
        float th = 1.5707963 + s * (1.5707963 - th0) * mirror;
        float r = L * sin(th) * sin(th);
        float phi = aSeed.y * 6.2831853 + uTime * 0.15 / L * (aSeed.z > 0.5 ? 1.0 : -1.0);
        vec3 p = vec3(r * sin(th) * cos(phi), r * cos(th), r * sin(th) * sin(phi));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float sz = uPixel * 0.03 / -mv.z;
        gl_PointSize = clamp(sz, 1.0, 5.0);
        vA = min(sz * sz, 1.0) * (0.35 + 0.65 * aSeed.w) * smoothstep(1.0, 1.15, r);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uIntensity;
      varying float vA;
      void main(){
        vec2 c = gl_PointCoord - 0.5;
        float f = exp(-dot(c, c) * 14.0);
        gl_FragColor = vec4(vec3(0.4, 0.8, 1.0) * f * vA * 0.45 * uIntensity, 1.0);
      }
    `,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return { points: pts, uniforms };
}

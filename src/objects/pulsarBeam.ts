import * as THREE from 'three';
import { NOISE } from '../shaders/common';
import { pixelScale } from '../shared';

/**
 * Volumetric pulsar emission beam (one magnetic pole), in the local frame of the
 * magnetic axis (+y, apex at the stellar surface).
 *
 * Emission model, following the empirical picture of radio pulsar beams
 * (Rankin 1983/1993; Ruderman & Sutherland 1975):
 *  - a central "core" component along the magnetic axis,
 *  - an inner hollow "cone" fed by discrete sparks above the polar cap that
 *    circulate around the magnetic axis (E×B drift → drifting subpulses),
 *  - a fainter outer cone.
 * The beam is ray-marched through its bounding cone so it looks volumetric from
 * any angle, including from inside the beam.
 */

export const BEAM_LENGTH = 18;

export interface BeamUniforms {
  [key: string]: THREE.IUniform;
  uTime: THREE.IUniform<number>;
  uHalf: THREE.IUniform<number>;      // emission cone half-opening angle (rad)
  uSparks: THREE.IUniform<number>;    // number of sparks in the carousel (0 = smooth)
  uDrift: THREE.IUniform<number>;     // carousel angular speed (rad / s, visual)
  uCore: THREE.IUniform<number>;      // core component strength
  uIntensity: THREE.IUniform<number>;
  uCamLocal: THREE.IUniform<THREE.Vector3>;
}

/** Angular emission profile shared by the shader and the JS pulse-profile plot. x = θ / θ_half. */
export function beamProfile(x: number, core: number): number {
  return core * Math.exp(-(x * x) / 0.08) + Math.exp(-(((x - 0.62) / 0.12) ** 2)) + 0.3 * Math.exp(-(((x - 0.95) / 0.07) ** 2));
}

const GLSL_PROFILE = /* glsl */ `
float sparkMod(float phi, float t){
  if (uSparks < 0.5) return 1.0;
  float s = 0.5 + 0.5 * cos(uSparks * (phi - uDrift * t));
  return mix(0.12, 1.0, pow(s, 6.0));
}
float emission(vec3 q, float t){
  float y = q.y;
  if (y <= 0.0) return 0.0;
  float rho = length(q.xz);
  float x = atan(rho, y) / uHalf;
  if (x > 1.2) return 0.0;
  float phi = atan(q.z, q.x);
  float sm = sparkMod(phi, t);
  float core = uCore * exp(-x * x / 0.08);
  float inner = exp(-pow((x - 0.62) / 0.12, 2.0)) * sm;
  float outer = 0.3 * exp(-pow((x - 0.95) / 0.07, 2.0)) * mix(1.0, sm, 0.5);
  // Plasma bunches streaming outward along the open field lines.
  float bunch = 0.65 + 0.35 * snoise(vec3(x * 3.0, phi * 1.5, y * 0.7 - t * 5.0));
  float radial = smoothstep(0.9, 2.2, y) * (1.0 - smoothstep(${(BEAM_LENGTH * 0.65).toFixed(1)}, ${BEAM_LENGTH.toFixed(1)}, y)) * 3.0 / (1.0 + 0.1 * y * y);
  return (core * 1.2 + inner + outer) * bunch * radial;
}
`;

export function createBeam(uniforms: BeamUniforms) {
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      void main(){ vLocal = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vLocal;
      uniform float uTime, uHalf, uSparks, uDrift, uCore, uIntensity;
      uniform vec3 uCamLocal;
      ${NOISE}
      ${GLSL_PROFILE}
      float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      void main(){
        vec3 ro = uCamLocal;
        vec3 d = vLocal - ro;
        float tExit = length(d);
        vec3 rd = d / tExit;
        // Entry point: intersect the ray with the bounding cone (half-angle 1.25·θ) and its cap.
        float k = pow(tan(uHalf * 1.25), 2.0);
        float a = rd.x * rd.x + rd.z * rd.z - k * rd.y * rd.y;
        float b = 2.0 * (ro.x * rd.x + ro.z * rd.z - k * ro.y * rd.y);
        float c = ro.x * ro.x + ro.z * ro.z - k * ro.y * ro.y;
        float tEnter = tExit;
        float disc = b * b - 4.0 * a * c;
        if (disc >= 0.0 && abs(a) > 1e-6) {
          float sq = sqrt(disc);
          for (int i = 0; i < 2; i++) {
            float t = (-b + (i == 0 ? -sq : sq)) / (2.0 * a);
            float y = ro.y + rd.y * t;
            if (t >= 0.0 && t < tEnter - 1e-3 && y >= 0.0 && y <= ${BEAM_LENGTH.toFixed(1)}) tEnter = t;
          }
        }
        if (abs(rd.y) > 1e-5) {
          float t = (${BEAM_LENGTH.toFixed(1)} - ro.y) / rd.y;
          vec3 p = ro + rd * t;
          if (t >= 0.0 && t < tEnter - 1e-3 && dot(p.xz, p.xz) <= k * ${(BEAM_LENGTH * BEAM_LENGTH).toFixed(1)}) tEnter = t;
        }
        // Camera inside the beam volume: start at the camera.
        float yc = ro.y;
        if (yc > 0.0 && dot(ro.xz, ro.xz) < k * yc * yc && yc < ${BEAM_LENGTH.toFixed(1)}) tEnter = 0.0;
        if (tEnter >= tExit) tEnter = max(tExit - ${BEAM_LENGTH.toFixed(1)}, 0.0);

        const int N = 48;
        float len = tExit - tEnter;
        float dt = len / float(N);
        float jitter = hash12(gl_FragCoord.xy + fract(uTime) * 61.0);
        vec3 acc = vec3(0.0);
        for (int i = 0; i < N; i++) {
          vec3 q = ro + rd * (tEnter + (float(i) + jitter) * dt);
          float e = emission(q, uTime);
          // False colour: radio emission is invisible; core shown blue-white, cone violet-blue.
          float x = atan(length(q.xz), q.y) / uHalf;
          vec3 col = mix(vec3(0.75, 0.88, 1.0), vec3(0.45, 0.5, 1.0), smoothstep(0.2, 0.7, x));
          acc += col * e * dt;
        }
        // Soft saturation so looking down the beam doesn't blow out to white.
        vec3 e = acc * uIntensity * 2.2;
        gl_FragColor = vec4(1.1 * (1.0 - exp(-e / 1.1)), 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(boundingCone(uniforms.uHalf.value), mat);
  mesh.frustumCulled = false;
  return mesh;
}

export function boundingCone(half: number): THREE.BufferGeometry {
  const r = Math.tan(half * 1.25) * BEAM_LENGTH;
  const geo = new THREE.ConeGeometry(r, BEAM_LENGTH, 64, 1, false);
  geo.rotateX(Math.PI);                 // apex down
  geo.translate(0, BEAM_LENGTH / 2, 0); // apex at origin, opening along +y
  return geo;
}

// Position of an outflowing particle at phase u along the open field lines of one pole.
const PARTICLE_POS = /* glsl */ `
vec3 particlePos(vec4 seed, float u){
  float y = 1.0 + u * ${(BEAM_LENGTH - 2).toFixed(1)};
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
  // Field lines flare slightly with altitude: open lines are not exactly straight.
  float r = y * tan(x * uHalf) * (1.0 + 0.015 * y);
  return vec3(r * cos(phi), y, r * sin(phi));
}
float particleU(vec4 seed){ return fract(seed.x + uTime * (0.12 + 0.18 * seed.y)); }
`;

/**
 * Charged particles (e± pairs) streaming out along the open field lines of one pole.
 * Rendered as motion-blurred streaks (line segments) plus glowing heads.
 */
export function createParticles(uniforms: BeamUniforms, count = 5000) {
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  const group = new THREE.Group();

  // Streaks: 2 vertices per particle (head, tail).
  const sSeeds = new Float32Array(count * 8);
  const ends = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    sSeeds.set(seeds.subarray(i * 4, i * 4 + 4), i * 8);
    sSeeds.set(seeds.subarray(i * 4, i * 4 + 4), i * 8 + 4);
    ends[i * 2 + 1] = 1;
  }
  const sGeo = new THREE.BufferGeometry();
  sGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 6), 3));
  sGeo.setAttribute('aSeed', new THREE.BufferAttribute(sSeeds, 4));
  sGeo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
  const streakMat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed; attribute float aEnd;
      uniform float uTime, uHalf, uSparks, uDrift;
      varying float vA;
      ${PARTICLE_POS}
      void main(){
        float u = particleU(aSeed);
        float uu = max(u - aEnd * 0.035, 0.0);
        vec3 p = particlePos(aSeed, uu);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        vA = (1.0 - aEnd) * smoothstep(0.0, 0.08, u) * (1.0 - smoothstep(0.55, 1.0, u)) * (0.4 + 0.6 * aSeed.w);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main(){ gl_FragColor = vec4(vec3(0.55, 0.75, 1.0) * vA * 0.4, 1.0); }
    `,
  });
  const streaks = new THREE.LineSegments(sGeo, streakMat);
  streaks.frustumCulled = false;
  group.add(streaks);

  // Glowing heads.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uPixel: pixelScale },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime, uHalf, uSparks, uDrift, uPixel;
      varying float vAlpha;
      ${PARTICLE_POS}
      void main(){
        float u = particleU(aSeed);
        vec3 p = particlePos(aSeed, u);
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
        gl_FragColor = vec4(vec3(0.75, 0.88, 1.0) * f * vAlpha * 0.75, 1.0);
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
  const uniforms = { uTime: { value: 0 }, uPixel: pixelScale, uIntensity: { value: 1 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime, uPixel;
      varying float vA;
      void main(){
        float L = mix(1.6, 7.5, pow(aSeed.x, 1.3));
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

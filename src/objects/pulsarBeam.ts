import * as THREE from 'three';
import { NOISE } from '../shaders/common';

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
        gl_FragColor = vec4(acc * uIntensity * 2.2, 1.0);
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

/** Charged particles streaming out along the open field lines of one pole. */
export function createParticles(uniforms: BeamUniforms, count = 1400) {
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime, uHalf, uSparks, uDrift;
      varying float vAlpha;
      void main(){
        float speed = 0.12 + 0.18 * aSeed.y;
        float u = fract(aSeed.x + uTime * speed);
        float y = 1.0 + u * ${(BEAM_LENGTH - 2).toFixed(1)};
        float x;            // θ / θ_half
        float phi;
        if (aSeed.z < 0.35) {               // core stream
          x = sqrt(aSeed.w) * 0.35;
          phi = aSeed.w * 6.2831853 * 7.0;
        } else {                            // conal streams fed by sparks
          x = 0.62 + (aSeed.w - 0.5) * 0.18;
          float n = max(uSparks, 1.0);
          float k = floor(aSeed.z * 997.0);
          phi = uSparks < 0.5 ? aSeed.z * 6.2831853 * 13.0
                              : 6.2831853 * mod(k, n) / n + uDrift * uTime + (aSeed.w - 0.5) * 0.12;
        }
        float r = y * tan(x * uHalf);
        vec3 p = vec3(r * cos(phi), y, r * sin(phi));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(40.0 / -mv.z, 1.0, 4.0);
        vAlpha = smoothstep(0.0, 0.08, u) * (1.0 - smoothstep(0.6, 1.0, u));
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main(){
        vec2 c = gl_PointCoord - 0.5;
        float f = exp(-dot(c, c) * 14.0);
        gl_FragColor = vec4(vec3(0.7, 0.85, 1.0) * f * vAlpha * 0.9, 1.0);
      }
    `,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

import * as THREE from 'three';
import { BLACKBODY } from '../shaders/common';
import { pixelScale } from '../shared';

/**
 * Prominences: plasma held in magnetic arcades above the photosphere. Particles
 * drain along each loop (siphon flow / coronal rain) and glow in H-alpha (656 nm,
 * pink-red). Built entirely on the GPU from per-particle attributes.
 */
export function createProminences(loops = 9, perLoop = 1400) {
  const n = loops * perLoop;
  const aC = new Float32Array(n * 3);
  const aT = new Float32Array(n * 3);
  const aP = new Float32Array(n * 4);
  const aJ = new Float32Array(n * 4);
  const v = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (let l = 0; l < loops; l++) {
    v.randomDirection();
    v.y *= 0.6; // prefer active latitudes
    v.normalize();
    t.randomDirection().cross(v).normalize();
    const beta = 0.05 + Math.random() * 0.12;   // half footpoint separation (rad)
    const h = 0.06 + Math.random() * 0.22;      // loop height (stellar radii)
    const speed = (0.04 + Math.random() * 0.06) * (Math.random() < 0.5 ? 1 : -1);
    const strands = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < perLoop; i++) {
      const k = l * perLoop + i;
      aC.set([v.x, v.y, v.z], k * 3);
      aT.set([t.x, t.y, t.z], k * 3);
      aP.set([beta, h, Math.random(), speed * (0.7 + 0.6 * Math.random())], k * 4);
      const strand = Math.floor(Math.random() * strands) / strands - 0.5;
      aJ.set([strand, Math.random() - 0.5, Math.random() - 0.5, Math.random()], k * 4);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aC', new THREE.BufferAttribute(aC, 3));
  geo.setAttribute('aT', new THREE.BufferAttribute(aT, 3));
  geo.setAttribute('aP', new THREE.BufferAttribute(aP, 4));
  geo.setAttribute('aJ', new THREE.BufferAttribute(aJ, 4));
  const uniforms = { uTime: { value: 0 }, uIntensity: { value: 1 }, uPixel: pixelScale };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 aC; attribute vec3 aT; attribute vec4 aP; attribute vec4 aJ;
      uniform float uTime, uPixel;
      varying float vA;
      void main(){
        float beta = aP.x, h = aP.y;
        float s = fract(aP.z + uTime * aP.w);
        float a = (s - 0.5) * 2.0 * beta;
        vec3 b = normalize(aC * cos(a) + aT * sin(a));
        vec3 side = normalize(cross(aC, aT));
        float arch = sin(3.14159265 * s);
        float r = 1.0 + h * arch * (0.85 + 0.3 * aJ.x) ;
        vec3 pos = b * r + side * (aJ.x * 0.035 + aJ.y * 0.008) * (0.3 + arch) + b * aJ.z * 0.006;
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mv;
 float sz = uPixel * 0.006 / -mv.z;
        gl_PointSize = clamp(sz, 1.0, 10.0);
        // Seen against the bright disc, prominences appear as dark filaments (absorption);
        // additive emission can't darken, so they are faded out there and glow only off-limb.
        vec3 cv = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 rd = normalize(mv.xyz);
        float tc = dot(cv, rd);
        float bImpact = length(cv - rd * tc);
        float offLimb = smoothstep(0.97, 1.03, bImpact);
        vA = clamp(offLimb, 0.06, 1.0) * min(sz * sz, 1.0) * smoothstep(0.0, 0.06, s) * smoothstep(1.0, 0.94, s) * (0.5 + 0.5 * aJ.w) * smoothstep(0.0, 0.02, r - 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uIntensity;
      varying float vA;
      void main(){
        vec2 c = gl_PointCoord - 0.5;
        float f = exp(-dot(c, c) * 16.0);
        gl_FragColor = vec4(vec3(1.0, 0.32, 0.38) * f * vA * uIntensity * 0.6, 1.0);
      }
    `,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, uniforms };
}

/** Stellar wind: particles accelerated radially outward, wound into a Parker spiral by rotation. */
export function createStellarWind(count = 9000) {
  const seeds = new Float32Array(count * 4);
  const dirs = new Float32Array(count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.randomDirection();
    dirs.set([v.x, v.y, v.z], i * 3);
    seeds.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  const uniforms = { uTime: { value: 0 }, uTemp: { value: 5772 }, uIntensity: { value: 1 }, uPixel: pixelScale, uTwist: { value: 0.35 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 aDir; attribute vec4 aSeed;
      uniform float uTime, uTemp, uPixel, uTwist;
      varying vec3 vCol; varying float vA;
      ${BLACKBODY}
      void main(){
        float u = fract(aSeed.x + uTime * (0.025 + 0.035 * aSeed.y));
        float r = 1.02 + 4.5 * pow(u, 1.4);
        float ang = -uTwist * (r - 1.0);
        float c = cos(ang), s = sin(ang);
        vec3 d = vec3(c * aDir.x + s * aDir.z, aDir.y, -s * aDir.x + c * aDir.z);
        vec4 mv = modelViewMatrix * vec4(d * r, 1.0);
        gl_Position = projectionMatrix * mv;
        float sz = uPixel * 0.004 / -mv.z;
        gl_PointSize = clamp(sz, 1.0, 5.0);
        vCol = blackbody(uTemp);
        vA = min(sz * sz, 1.0) * smoothstep(0.0, 0.05, u) * (1.0 - smoothstep(0.35, 1.0, u)) * (0.3 + 0.7 * aSeed.z);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uIntensity;
      varying vec3 vCol; varying float vA;
      void main(){
        vec2 c = gl_PointCoord - 0.5;
        float f = exp(-dot(c, c) * 14.0);
        gl_FragColor = vec4(vCol * f * vA * uIntensity * 0.35, 1.0);
      }
    `,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, uniforms };
}

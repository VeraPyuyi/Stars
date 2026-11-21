import * as THREE from 'three';
import { BLACKBODY, NOISE } from '../shaders/common';
import { pixelScale } from '../shared';

/**
 * Prominences: cool, dense plasma (~10⁴ K) held up in the hot corona by magnetic
 * fields, glowing in H-alpha off the limb. Two shapes:
 *  - quiescent "hedgerows": a thin curtain standing on a polarity-inversion line,
 *    made of fine vertical threads, with knots slowly draining down;
 *  - an active arch: a twisted flux rope whose two legs sit in the photosphere.
 * Rendered as a volume: each pixel's ray is marched only through the bounding
 * spheres of the prominences it passes, and the density is an analytic shape
 * (sheet / rope) modulated by anisotropic noise. That stays smooth and filamentary
 * at any zoom, unlike particles.
 */
const MAX_PROM = 8;

/** Small deterministic PRNG so every visit shows the same prominences. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createProminences(camLocal: THREE.IUniform<THREE.Vector3>, count = 7, seedValue = 7) {
  const rand = mulberry32(seedValue);
  const dir = (out: THREE.Vector3) => {
    const z = rand() * 2 - 1, a = rand() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    return out.set(r * Math.cos(a), r * Math.sin(a), z);
  };
  const pc: THREE.Vector4[] = [];
  const pt: THREE.Vector4[] = [];
  const ps: THREE.Vector2[] = [];
  const v = new THREE.Vector3(), t = new THREE.Vector3();
  let maxH = 0;
  for (let i = 0; i < MAX_PROM; i++) {
    const arch = i === 0;
    dir(v); v.y *= 0.55; v.normalize();                 // active latitudes
    dir(t).cross(v).normalize();
    const size = arch ? 0.09 + rand() * 0.04 : 0.07 + rand() * 0.12;   // half length / half leg separation (rad)
    const H = arch ? 0.18 + rand() * 0.08 : 0.035 + rand() * 0.055;     // height (radii)
    if (i < count) maxH = Math.max(maxH, H);
    pc.push(new THREE.Vector4(v.x, v.y, v.z, arch ? 1 : 0));
    pt.push(new THREE.Vector4(t.x, t.y, t.z, rand() * 50));
    ps.push(new THREE.Vector2(size, H));
  }
  const uniforms = {
    uTime: { value: 0 }, uIntensity: { value: 1 }, uCamLocal: camLocal, uCount: { value: count },
    uPC: { value: pc }, uPT: { value: pt }, uPS: { value: ps },
  };
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
      uniform float uTime, uIntensity;
      uniform vec3 uCamLocal;
      uniform int uCount;
      uniform vec4 uPC[${MAX_PROM}];
      uniform vec4 uPT[${MAX_PROM}];
      uniform vec2 uPS[${MAX_PROM}];
      varying vec3 vLocal;
      ${NOISE}

      float density(vec3 C, vec3 T, float type, float seed, float size, float H, vec3 P){
        float r = length(P);
        float h = r - 1.0;
        if (h < 0.0) return 0.0;
        vec3 d = P / r;
        vec3 N = cross(C, T);
        float x = atan(dot(d, T), dot(d, C));          // angle along the spine
        float y = asin(clamp(dot(d, N), -1.0, 1.0));   // angle across it
        if (type < 0.5) {
          float u = x / size;
          if (abs(u) > 1.0) return 0.0;
          float top = H * pow(max(cos(1.5707963 * u), 0.0), 0.6)
                    * (0.6 + 0.4 * snoise(vec3(u * 4.0, seed, uTime * 0.02)) + 0.25 * snoise(vec3(u * 13.0, seed, 1.0)));
          if (top <= 0.0 || h > top) return 0.0;
          float z = h / top;
          float w = 0.003 + 0.01 * z;                    // the curtain is thin, a little thicker up high
          float sheet = exp(-y * y / (w * w));
          float threads = snoise(vec3(x * 170.0, h * 16.0 - uTime * 0.05, seed));   // fine vertical threads
          float knots = snoise(vec3(x * 45.0, h * 45.0 + uTime * 0.04, seed + 3.0));
          return sheet * smoothstep(-0.15, 0.75, threads) * (0.45 + 0.55 * smoothstep(-0.4, 0.6, knots))
               * smoothstep(1.0, 0.65, z);
        }
        // Arch: elliptical flux rope through both footpoints.
        float ex = x / size, eh = h / H;
        float q = sqrt(ex * ex + eh * eh);
        float s = atan(eh, ex) / 3.14159265;            // 0 → 1 from one leg to the other
        float scale = 0.5 * (size + H);
        float rope = 0.01 + 0.018 * sin(3.14159265 * clamp(s, 0.0, 1.0));
        float rr = (q - 1.0) * scale;
        float core = exp(-(rr * rr + y * y) / (rope * rope));
        // Twisted strands: noise in the rope's cross-section, rotated along its length.
        float tw = s * 9.0;
        vec2 xs = mat2(cos(tw), -sin(tw), sin(tw), cos(tw)) * vec2(rr, y) / rope;
        float strands = snoise(vec3(xs * 1.4, s * 3.0 + seed));
        float knots = snoise(vec3(s * 16.0 - uTime * 0.08, xs * 0.3 + seed));        // plasma flowing along
        return core * smoothstep(-0.25, 0.6, strands) * (0.3 + 0.7 * smoothstep(-0.3, 0.7, knots));
      }

      // Interleaved gradient noise: a dither that hides banding without white-noise speckle.
      float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

      void main(){
        vec3 ro = uCamLocal;
        vec3 rd = normalize(vLocal - ro);
        // Rays that hit the disc: there a prominence is a dark filament in absorption,
        // which additive emission cannot show, so only the off-limb part is rendered.
        float b = dot(ro, rd);
        float disc = b * b - (dot(ro, ro) - 1.0);
        if (disc > 0.0 && -b - sqrt(disc) > 0.0) discard;
        float jitter = ign(gl_FragCoord.xy);
        float sum = 0.0;
        for (int i = 0; i < ${MAX_PROM}; i++) {
          if (i >= uCount) break;
          vec3 C = uPC[i].xyz, T = uPT[i].xyz;
          float size = uPS[i].x, H = uPS[i].y;
          vec3 M = C * (1.0 + 0.5 * H);
          float R = max(size, H) * 1.15 + 0.03;
          float tc = dot(M - ro, rd);
          vec3 cp = ro + rd * tc - M;
          float d2 = dot(cp, cp);
          if (d2 > R * R) continue;
          float half_ = sqrt(R * R - d2);
          float t0 = max(tc - half_, 0.0), t1 = tc + half_;
          if (t1 <= t0) continue;
          const int STEPS = 40;
          float dt = (t1 - t0) / float(STEPS);
          for (int k = 0; k < STEPS; k++) {
            vec3 P = ro + rd * (t0 + (float(k) + jitter) * dt);
            sum += density(C, T, uPC[i].w, uPT[i].w, size, H, P) * dt;
          }
        }
        if (sum <= 0.0) discard;
        float e = 1.0 - exp(-sum * 45.0);
        // H-alpha red with some H-beta: faint parts deep pink-red, dense parts paler.
        vec3 col = mix(vec3(1.0, 0.16, 0.24), vec3(1.0, 0.55, 0.62), e * e) * e * 0.9 * uIntensity;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1.06 + maxH * 1.2, 64, 32), mat);
  mesh.frustumCulled = false;
  return { mesh, uniforms };
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

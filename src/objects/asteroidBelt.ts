import * as THREE from 'three';
import type { SimObject } from '../types';

/** Orbit radius in the tour's solar system (not to scale: compressed so the planets fit). */
export const orbitRadius = (au: number) => 6 + 9 * Math.pow(au, 0.6);
/** Displayed orbital period in seconds (Earth: four minutes), Kepler's third law in display time. */
export const orbitSeconds = (au: number) => 240 * Math.pow(au, 0.75);

/** Kirkwood gaps: resonances with Jupiter (3:1, 5:2, 7:3, 2:1) empty these semi-major axes (AU). */
const GAPS = [2.5, 2.82, 2.95, 3.27];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The main asteroid belt between Mars and Jupiter: every rock follows its own
 * Keplerian orbit (inner ones overtake outer ones), with the Kirkwood gaps carved out,
 * a spread of inclinations and eccentricities, and Ceres and Vesta among them.
 * Each point is drawn as a small lumpy rock, lit from the Sun at the group's origin.
 */
export function createAsteroidBelt(count = 16000): SimObject {
  const rnd = mulberry32(2718);
  const aAxis = new Float32Array(count);
  const orbit = new Float32Array(count * 4); // phase, eccentricity, inclination, node
  const look = new Float32Array(count * 2);  // size (world units), seed
  const position = new Float32Array(count * 3);
  let n = 0;
  const add = (a: number, phase: number, e: number, inc: number, node: number, size: number) => {
    aAxis[n] = a;
    orbit.set([phase, e, inc, node], n * 4);
    look.set([size, rnd() * 100], n * 2);
    n++;
  };
  // Ceres (2.77 AU, 940 km) and Vesta (2.36 AU, 525 km) first, drawn much larger.
  add(2.77, 0.3, 0.076, 0.185, 1.4, 0.16);
  add(2.36, 1.1, 0.089, 0.124, 1.8, 0.11);
  while (n < count) {
    // Most asteroids are between 2.1 and 3.3 AU, densest around 2.3–3.0.
    const a = 2.1 + 1.25 * Math.pow(rnd(), 1.15);
    const gap = GAPS.some((g) => Math.abs(a - g) < 0.035 * (g > 3 ? 1.4 : 1));
    if (gap && rnd() < 0.93) continue;
    const e = 0.08 * Math.pow(rnd(), 1.5);
    const inc = 0.3 * Math.pow(rnd(), 2.2);
    // Size distribution: many small rocks, a few large (power law).
    const size = 0.012 + 0.05 * Math.pow(rnd(), 6);
    add(a, rnd() * Math.PI * 2, e, inc, rnd() * Math.PI * 2, size);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('aAxis', new THREE.BufferAttribute(aAxis, 1));
  geo.setAttribute('aOrbit', new THREE.BufferAttribute(orbit, 4));
  geo.setAttribute('aLook', new THREE.BufferAttribute(look, 2));

  const uniforms = {
    uTime: { value: 0 },
    uPx: { value: 800 },
    uSun: { value: new THREE.Vector3() },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      attribute float aAxis; attribute vec4 aOrbit; attribute vec2 aLook;
      uniform float uTime, uPx; uniform vec3 uSun;
      varying vec3 vLight; varying float vSeed; varying float vFade; varying float vAlbedo;
      void main(){
        float a = aAxis;
        float R = 6.0 + 9.0 * pow(a, 0.6);
        float T = 240.0 * pow(a, 0.75);
        float M = aOrbit.x + uTime * 6.2831853 / T;
        // First-order eccentric orbit: radius and speed vary along it.
        float e = aOrbit.y;
        float th = M + 2.0 * e * sin(M);
        float r = R * (1.0 - e * cos(M));
        float node = aOrbit.w, inc = aOrbit.z;
        vec3 p = vec3(cos(th), 0.0, sin(th)) * r;
        // Tilt the orbit by its inclination about the line of nodes.
        vec3 k = vec3(cos(node), 0.0, sin(node));
        p = p * cos(inc) + cross(k, p) * sin(inc) + k * dot(k, p) * (1.0 - cos(inc));
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vec4 mv = viewMatrix * wp;
        gl_Position = projectionMatrix * mv;
        float px = aLook.x * projectionMatrix[1][1] * 0.5 * uPx / max(-mv.z, 1e-3);
        // Sub-pixel rocks are drawn one pixel wide and dimmed instead, so they do not flicker.
        vFade = clamp(px * px / 2.25, 0.0, 1.0) * (1.0 - 0.92 * smoothstep(4.0, 20.0, -mv.z)) * (1.0 - smoothstep(60.0, 120.0, -mv.z));
        gl_PointSize = max(px * 2.0, 1.5);
        vLight = normalize((viewMatrix * vec4(uSun - wp.xyz, 0.0)).xyz);
        vSeed = aLook.y;
        vAlbedo = 0.75 + 0.5 * fract(aLook.y * 7.13);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vLight; varying float vSeed; varying float vFade; varying float vAlbedo;
      float h(float x){ return fract(sin(x) * 43758.5453); }
      void main(){
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        p.y = -p.y;
        float ang = atan(p.y, p.x);
        // Irregular outline: a few lobes with a random phase per rock.
        float lobes = 0.13 * sin(ang * 2.0 + vSeed) + 0.07 * sin(ang * 3.0 + vSeed * 1.7) + 0.04 * sin(ang * 5.0 + vSeed * 2.3);
        float rr = 0.8 + lobes;
        float d = length(p) / rr;
        if (d > 1.0) discard;
        vec3 n = normalize(vec3(p / rr, sqrt(max(0.0, 1.0 - d * d))));
        // Lumps and craters perturb the normal.
        n.xy += 0.25 * vec2(sin(p.x * 7.0 + vSeed) * cos(p.y * 5.0 + vSeed * 0.7), cos(p.x * 6.0 - vSeed) * sin(p.y * 8.0 + vSeed * 1.3));
        n = normalize(n);
        float diff = max(dot(n, vLight), 0.0);
        vec3 base = mix(vec3(0.42, 0.38, 0.34), vec3(0.55, 0.5, 0.44), h(vSeed)) * vAlbedo;
        vec3 c = base * (diff * 1.6 + 0.03);
        gl_FragColor = vec4(c * vFade, 1.0);
      }
    `,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  const size = new THREE.Vector2();
  points.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(size);
    uniforms.uPx.value = size.y;
  };
  const group = new THREE.Group();
  group.add(points);

  return {
    id: 'belt',
    name: '小行星带',
    group,
    params: [],
    info: '',
    camera: { distance: 3, min: 0.5, max: 12 },
    bloom: { strength: 0.25, radius: 0.4, threshold: 1.2 },
    update(_dt, time) {
      uniforms.uTime.value = time;
      group.getWorldPosition(uniforms.uSun.value);
    },
  };
}

import * as THREE from 'three';
import type { TourStop } from './stops';

/** Tanner Helland's fit of blackbody colour, for 1000–40000 K. */
function kelvin(T: number): THREE.Color {
  const t = Math.min(40000, Math.max(1000, T)) / 100;
  const c = (x: number) => Math.min(255, Math.max(0, x)) / 255;
  const r = t <= 66 ? 1 : c(329.698727446 * Math.pow(t - 60, -0.1332047592));
  const g = t <= 66 ? c(99.4708025861 * Math.log(t) - 161.1195681661) : c(288.1221695283 * Math.pow(t - 60, -0.0755148492));
  const b = t >= 66 ? 1 : t <= 19 ? 0 : c(138.5177312231 * Math.log(t - 10) - 305.0447927307);
  return new THREE.Color(r, g, b);
}

/** Colour of a planet seen as a point of light. */
const PLANET_TINT: Record<string, number> = {
  rocky: 0x8cb3ff, mercury: 0xb8b0a8, venus: 0xfff0c8, mars: 0xff9c6a,
  jupiter: 0xf3dcc0, saturn: 0xf5e3b0, uranus: 0xa8e8f0, neptune: 0x7aa0ff,
};

/**
 * Every stop seen from afar is a point of light: the route ahead reads as a string of
 * stars, and the next object is visible long before it resolves into a disc.
 * Points fade out as the camera gets close, where the real object takes over.
 */
export function createBeacons(stops: TourStop[], centers: THREE.Vector3[]) {
  const pos = new Float32Array(stops.length * 3);
  const col = new Float32Array(stops.length * 3);
  stops.forEach((s, i) => {
    pos.set([centers[i].x, centers[i].y, centers[i].z], i * 3);
    const c = s.kind === 'belt' ? new THREE.Color(0, 0, 0)
      : s.kind === 'planet' ? new THREE.Color(PLANET_TINT[String(s.preset.values.type)] ?? 0x8cb3ff)
      : s.kind === 'pulsar' ? new THREE.Color(0.8, 0.88, 1.0)
      : s.kind === 'blackhole' ? kelvin(Number(s.preset.values.temp ?? 6000)).multiplyScalar(0.7)
      : kelvin(Number(s.preset.values.temp ?? 5772));
    col.set([c.r, c.g, c.b], i * 3);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    uniforms: { uScale: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform float uScale;
      varying vec3 vCol; varying float vA;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = -mv.z;
        vA = smoothstep(18.0, 70.0, d) * (0.55 + 0.45 * smoothstep(3000.0, 300.0, d));
        vCol = color;
        gl_PointSize = 18.0 * uScale;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vCol; varying float vA;
      void main(){
        vec2 p = gl_PointCoord - 0.5;
        float r = length(p);
        float core = exp(-r * r * 260.0);
        float halo = exp(-r * r * 40.0) * 0.25;
        float spikes = (exp(-abs(p.x) * 60.0) + exp(-abs(p.y) * 60.0)) * exp(-r * 9.0) * 0.35;
        gl_FragColor = vec4(vCol * (core * 1.6 + halo + spikes) * vA, 1.0);
      }
    `,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  const attr = geo.getAttribute('position') as THREE.BufferAttribute;
  return {
    points,
    uniforms: mat.uniforms as { uScale: { value: number } },
    /** Planets move along their orbits: follow them. */
    setPositions(centers: THREE.Vector3[]) {
      centers.forEach((c, i) => attr.setXYZ(i, c.x, c.y, c.z));
      attr.needsUpdate = true;
    },
  };
}

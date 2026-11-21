import * as THREE from 'three';
import { orbitRadius } from '../objects/asteroidBelt';
import type { TourStop } from './stops';

/** Faint circles along the planets' orbits, around the Sun at the origin. */
export function createOrbitLines(stops: TourStop[]) {
  const group = new THREE.Group();
  // Fade out close to the camera, where an orbit seen edge-on would cut across the view.
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying float vA;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        vA = smoothstep(2.0, 14.0, -mv.z);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main(){ gl_FragColor = vec4(vec3(0.32, 0.42, 0.6) * 0.3 * vA, 1.0); }
    `,
  });
  for (const s of stops) {
    if (!s.orbit || s.kind !== 'planet') continue;
    const R = orbitRadius(s.orbit.au);
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k < 384; k++) {
      const a = (k / 384) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * R, 0, Math.sin(a) * R));
    }
    group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), mat));
  }
  return { lines: group };
}

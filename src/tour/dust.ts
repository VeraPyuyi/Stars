import * as THREE from 'three';

/**
 * Faint interstellar dust around the camera, drawn as short streaks along the
 * direction of motion: invisible at rest, it gives the flight its sense of speed.
 * The particles live in a box that wraps around the camera, so there are always some.
 */
export function createDust(count = 1600, box = 60) {
  const seeds = new Float32Array(count * 2 * 3);
  const ends = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = Math.random() * box, y = Math.random() * box, z = Math.random() * box;
    seeds.set([x, y, z, x, y, z], i * 6);
    ends[i * 2 + 1] = 1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(seeds, 3));
  geo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
  const uniforms = {
    uCam: { value: new THREE.Vector3() },
    uVel: { value: new THREE.Vector3() },
    uAlpha: { value: 0 },
    uBox: { value: box },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aEnd;
      uniform vec3 uCam, uVel; uniform float uBox;
      varying float vFade; varying float vEnd;
      void main(){
        vec3 rel = mod(position - uCam, uBox) - 0.5 * uBox;
        vec3 p = uCam + rel - uVel * 0.06 * aEnd;
        float d = length(rel);
        vFade = smoothstep(1.0, 6.0, d) * (1.0 - smoothstep(0.3 * uBox, 0.5 * uBox, d));
        vEnd = aEnd;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uAlpha;
      varying float vFade; varying float vEnd;
      void main(){
        gl_FragColor = vec4(vec3(0.75, 0.82, 1.0) * vFade * (1.0 - vEnd) * uAlpha * 0.5, 1.0);
      }
    `,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  return {
    lines,
    update(cam: THREE.Vector3, vel: THREE.Vector3, travelling: number, dt: number) {
      uniforms.uCam.value.copy(cam);
      uniforms.uVel.value.copy(vel);
      const target = travelling * THREE.MathUtils.smoothstep(vel.length(), 4, 40);
      uniforms.uAlpha.value += (target - uniforms.uAlpha.value) * (1 - Math.exp(-dt * 4));
      lines.visible = uniforms.uAlpha.value > 0.005;
    },
  };
}

import * as THREE from 'three';

/**
 * Compact point-source flash with diffraction spikes, drawn on top of the scene.
 * Used for the moment a pulsar beam sweeps across the observer: the pulse is short
 * and sharp (a few % of the period), so it reads as a flash, not a slow blink.
 */
export class Flare {
  mesh: THREE.Mesh;
  uniforms = {
    uIntensity: { value: 0 },
    uColor: { value: new THREE.Color(0.8, 0.9, 1.0) },
    uSize: { value: 14 },
    uRot: { value: 0 },
  };

  constructor(size = 14) {
    this.uniforms.uSize.value = size;
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform float uIntensity, uSize, uRot;
        uniform vec3 uColor;
        void main(){
          if (uIntensity <= 0.001) discard;
          vec2 p = (vUv * 2.0 - 1.0) * uSize;            // in stellar radii
          float c = cos(uRot), s = sin(uRot);
          p = mat2(c, -s, s, c) * p;
          float r = length(p);
          float core = exp(-r * r * 0.6) * 2.0 + 0.6 / (1.0 + r * r * 0.4);
          // Six-armed diffraction spikes (hexagonal-aperture-like), thin and long.
          float spikes = 0.0;
          for (int i = 0; i < 3; i++) {
            float a = float(i) * 1.0471976;
            vec2 d = vec2(cos(a), sin(a));
            float along = abs(dot(p, d));
            float across = abs(dot(p, vec2(-d.y, d.x)));
            spikes += exp(-across * across * 6.0) * exp(-along * 0.35);
          }
          float fade = 1.0 - smoothstep(uSize * 0.6, uSize, r);
          vec3 col = uColor * (core + spikes * 0.9) * fade * uIntensity;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2 * size, 2 * size), mat);
    this.mesh.renderOrder = 20;
    this.mesh.frustumCulled = false;
  }

  update(camera: THREE.Camera) {
    this.mesh.quaternion.copy(camera.quaternion);
  }
}

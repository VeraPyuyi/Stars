import * as THREE from 'three';
import { BLACKBODY, NOISE } from '../shaders/common';

/** Camera-facing additive halo (corona / scattered light) around a sphere of radius 1. */
export class Glow {
  mesh: THREE.Mesh;
  uniforms = {
    uTemp: { value: 5772 },
    uTime: { value: 0 },
    uSize: { value: 6 },
    uIntensity: { value: 1 },
    uStreaks: { value: 1 },
  };

  constructor(size = 6) {
    this.uniforms.uSize.value = size;
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform float uTemp, uTime, uSize, uIntensity, uStreaks;
        ${NOISE}
        ${BLACKBODY}
        void main(){
          vec2 p = (vUv * 2.0 - 1.0) * uSize;   // in units of the sphere radius
          float r = length(p);
          if (r < 1.0) discard;
          float a = atan(p.y, p.x);
          float streak = fbm(vec3(cos(a) * 4.0, sin(a) * 4.0, uTime * 0.05 + r * 0.15), 4);
          // Starts at about the limb-darkened edge brightness and only decreases outward,
          // so the limb never looks outlined by a brighter ring.
          float inner = 0.42 * exp(-(r - 1.0) * 5.0);
          float outer = 0.35 / (r * r) * (1.0 + uStreaks * 0.8 * streak) * smoothstep(1.0, 1.6, r);
          float fade = 1.0 - smoothstep(uSize * 0.6, uSize, r);
          // The halo is drawn a little more saturated than the disk: faint light of a nearly
          // neutral colour (the Sun's) otherwise reads as a grey-brown haze, not a warm glow.
          vec3 bb = blackbody(uTemp);
          float lum = dot(bb, vec3(0.2126, 0.7152, 0.0722));
          vec3 c = max(mix(vec3(lum), bb, 2.0), 0.0) * (inner + outer) * fade * uIntensity;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2 * size, 2 * size), mat);
  }

  update(camera: THREE.Camera, time: number) {
    this.uniforms.uTime.value = time;
    // Billboard: keep facing the camera while staying centred on the parent.
    const parent = this.mesh.parent;
    this.mesh.quaternion.copy(camera.quaternion);
    if (parent) {
      const pq = new THREE.Quaternion();
      parent.getWorldQuaternion(pq);
      this.mesh.quaternion.premultiply(pq.invert());
    }
  }
}

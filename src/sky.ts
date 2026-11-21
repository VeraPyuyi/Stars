import * as THREE from 'three';
import { BLACKBODY, FULLSCREEN_VERT, NOISE } from './shaders/common';

/**
 * Fullscreen background pass.
 *  - mode 0: procedural star field + Milky Way band.
 *  - mode 1: Schwarzschild black hole. Each pixel's photon is integrated backwards
 *    through curved space-time (null geodesic, units r_s = 1) and may cross a
 *    thin accretion disk lying in the y = 0 plane, or escape to the sky.
 */
const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform float uTime;
uniform int uMode;
uniform float uDiskInner;
uniform float uDiskOuter;
uniform float uDiskTemp;
uniform float uDoppler;
uniform float uDiskBright;
uniform int uSteps;

${NOISE}
${BLACKBODY}

float hash13(vec3 p){
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec3 hash33(vec3 p){
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}

vec3 starLayer(vec3 d, float scale, float density, float size){
  vec3 p = d * scale;
  vec3 base = floor(p);
  vec3 col = vec3(0.0);
  for (int x = -1; x <= 1; x++)
  for (int y = -1; y <= 1; y++)
  for (int z = -1; z <= 1; z++) {
    vec3 c = base + vec3(x, y, z);
    float h = hash13(c);
    if (h > density) continue;
    vec3 sp = normalize(c + 0.5 + (hash33(c) - 0.5) * 0.8);
    float ang = length(cross(d, sp)) * scale; // small-angle distance in cell units
    if (dot(d, sp) < 0.0) continue;
    float b = pow(h / density, 6.0);               // steep luminosity function
    float T = mix(2800.0, 15000.0, pow(hash13(c + 7.0), 2.0));
    col += blackbody(T) * (0.04 + 3.0 * b) * exp(-pow(ang / size, 2.0));
  }
  return col;
}

vec3 sky(vec3 d){
  vec3 col = vec3(0.0);
  col += starLayer(d, 70.0, 0.06, 0.05);
  col += starLayer(d, 180.0, 0.08, 0.10) * 0.5;
  // Milky Way: a tilted great-circle band with dust lanes.
  vec3 galN = normalize(vec3(0.3, 1.0, 0.45));
  float b = dot(d, galN);
  float band = exp(-b * b * 18.0);
  float n = fbm(d * 3.0, 5) * 0.5 + 0.5;
  float dust = smoothstep(0.35, 0.75, fbm(d * 6.0 + 4.0, 4) * 0.5 + 0.5);
  col += vec3(0.55, 0.5, 0.45) * band * n * (1.0 - 0.7 * dust * exp(-b * b * 120.0)) * 0.02;
  return col;
}

// Thin accretion disk: Novikov–Thorne-like temperature profile, Keplerian rotation,
// relativistic Doppler beaming and gravitational redshift.
vec4 disk(vec3 hit, vec3 rayDir){
  float r = length(hit.xz);
  if (r < uDiskInner || r > uDiskOuter) return vec4(0.0);
  float x = uDiskInner / r;
  float Tprof = pow(x, 0.75) * pow(max(1.0 - sqrt(x), 0.0), 0.25) / 0.488; // ~1 at peak
  // Orbital speed of a circular orbit as seen by a static observer (r_s = 1).
  float beta = clamp(sqrt(0.5 / max(r - 1.0, 0.01)), 0.0, 0.99);
  float gamma = 1.0 / sqrt(1.0 - beta * beta);
  vec3 vdir = normalize(vec3(-hit.z, 0.0, hit.x));
  vec3 emit = -normalize(rayDir);                       // photon travels toward the camera
  float D = 1.0 / (gamma * (1.0 - beta * dot(vdir, emit)));
  float g = D * sqrt(max(1.0 - 1.0 / r, 0.0));
  g = mix(1.0, g, uDoppler);

  float omega = beta / r;
  float phi = atan(hit.z, hit.x) - omega * uTime * 3.0;
  vec3 q = vec3(cos(phi) * r * 0.5, sin(phi) * r * 0.5, r * 1.1);
  float n = fbm(q, 4);
  float dens = clamp(0.55 + 0.7 * n, 0.0, 1.0);
  dens *= smoothstep(uDiskInner, uDiskInner + 0.6, r) * (1.0 - smoothstep(uDiskOuter * 0.6, uDiskOuter, r));

  float T = uDiskTemp * Tprof * g;
  float I = uDiskBright * pow(Tprof, 4.0) * pow(g, 4.0) * (0.4 + 0.6 * dens);
  vec3 c = blackbody(T) * I;
  float a = clamp(dens * 0.95, 0.0, 1.0);
  return vec4(c, a);
}

void main(){
  vec4 wp = uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(wp.xyz / wp.w - uCamPos);

  if (uMode == 0) { gl_FragColor = vec4(sky(dir), 1.0); return; }

  vec3 pos = uCamPos;
  vec3 vel = dir;
  vec3 h = cross(pos, vel);
  float h2 = dot(h, h);
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  bool captured = false;
  for (int i = 0; i < 1000; i++) {
    if (i >= uSteps) break;
    float r = length(pos);
    if (r < 1.0) { captured = true; break; }
    if (r > 80.0 && dot(pos, vel) > 0.0) break;
    float dt = clamp(0.06 * (r - 0.9) * r, 0.012, 1.5);
    vec3 prev = pos;
    // Photon geodesic in Schwarzschild space-time written as a Newtonian-like ODE:
    // d²x/dλ² = -3/2 · h² · x / r⁵  (exact for the orbit shape).
    vec3 acc = -1.5 * h2 * pos / pow(r, 5.0);
    vel += acc * dt;
    pos += vel * dt;
    if (prev.y * pos.y < 0.0) {
      float t = prev.y / (prev.y - pos.y);
      vec4 d = disk(mix(prev, pos, t), vel);
      col += (1.0 - alpha) * d.rgb * d.a;
      alpha += (1.0 - alpha) * d.a;
      if (alpha > 0.99) break;
    }
  }
  if (!captured && alpha < 0.99) col += (1.0 - alpha) * sky(normalize(vel));
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Sky {
  mesh: THREE.Mesh;
  uniforms = {
    uInvViewProj: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    uMode: { value: 0 },
    uDiskInner: { value: 3.0 },
    uDiskOuter: { value: 14.0 },
    uDiskTemp: { value: 5500 },
    uDoppler: { value: 1.0 },
    uDiskBright: { value: 1.6 },
    uSteps: { value: 400 },
  };
  private m = new THREE.Matrix4();

  constructor() {
    const mat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }

  update(camera: THREE.PerspectiveCamera, time: number) {
    camera.updateMatrixWorld();
    this.m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
    this.uniforms.uInvViewProj.value.copy(this.m);
    this.uniforms.uCamPos.value.copy(camera.position);
    this.uniforms.uTime.value = time;
  }
}

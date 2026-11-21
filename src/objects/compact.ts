import * as THREE from 'three';
import { BLACKBODY, NOISE } from '../shaders/common';
import type { SimObject } from '../types';
import { Glow } from './glow';

/** Dipole magnetic field lines r = L·sin²θ, magnetic axis along +y. */
function fieldLines(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({
    color: new THREE.Color(0.35, 0.6, 1.0),
    transparent: true,
    opacity: 0.18,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  for (const L of [1.8, 2.8, 4.5, 7.5]) {
    const th0 = Math.asin(Math.sqrt(1 / L));
    for (let k = 0; k < 8; k++) {
      const phi = (k / 8) * Math.PI * 2 + L;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 120; i++) {
        const th = th0 + (Math.PI - 2 * th0) * (i / 120);
        const r = L * Math.sin(th) ** 2;
        pts.push(new THREE.Vector3(r * Math.sin(th) * Math.cos(phi), r * Math.cos(th), r * Math.sin(th) * Math.sin(phi)));
      }
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }
  }
  return g;
}

function surfaceMaterial() {
  const uniforms = {
    uTime: { value: 0 },
    uMagAxis: { value: new THREE.Vector3(0, 1, 0) }, // in the body's local frame
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vObj; varying vec3 vN; varying vec3 vV;
      void main(){
        vObj = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vObj; varying vec3 vN; varying vec3 vV;
      uniform float uTime; uniform vec3 uMagAxis;
      ${NOISE}
      ${BLACKBODY}
      void main(){
        vec3 p = normalize(vObj);
        float mu = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
        float c = abs(dot(p, normalize(uMagAxis)));
        float cap = smoothstep(0.9, 0.99, c);                 // polar caps heated by returning currents
        float n = fbm(p * 12.0 + vec3(uTime * 0.2), 4) * 0.5 + 0.5;
        float T = mix(30000.0, 40000.0, cap);                  // ~10^6 K saturates to blue-white
        float I = (0.9 + 0.2 * n) * (0.75 + 0.25 * mu) * (1.6 + 4.0 * cap);
        gl_FragColor = vec4(blackbody(T) * I, 1.0);
      }
    `,
  });
  return { mat, uniforms };
}

function beamMaterial() {
  const uniforms = { uTime: { value: 0 }, uIntensity: { value: 1 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vLocal; varying vec3 vN; varying vec3 vV;
      void main(){
        vLocal = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vLocal; varying vec3 vN; varying vec3 vV;
      uniform float uTime; uniform float uIntensity;
      ${NOISE}
      void main(){
        float y = vLocal.y;                                     // 0 at the pole, grows outward
        float along = exp(-y * 0.18) * smoothstep(0.0, 1.2, y);
        float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.5); // brighter through the cone centre
        float flicker = 0.75 + 0.25 * snoise(vec3(y * 0.6 - uTime * 6.0, 0.0, 0.0));
        vec3 c = vec3(0.45, 0.7, 1.0) * along * edge * flicker * uIntensity * 0.9;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  return { mat, uniforms };
}

function makeBeam(mat: THREE.Material): THREE.Mesh {
  const h = 16;
  const geo = new THREE.ConeGeometry(2.8, h, 64, 32, true);
  geo.rotateX(Math.PI);        // apex down
  geo.translate(0, h / 2, 0);  // apex at the origin, opening along +y
  return new THREE.Mesh(geo, mat);
}

function buildCompact(pulsar: boolean): SimObject {
  const group = new THREE.Group();
  const spinNode = new THREE.Group();          // rotates about the spin axis (+y)
  const magNode = new THREE.Group();           // magnetic axis, tilted by α
  group.add(spinNode);
  spinNode.add(magNode);

  const { mat, uniforms } = surfaceMaterial();
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 72), mat);
  spinNode.add(body);

  const lines = fieldLines();
  magNode.add(lines);

  const glow = new Glow(pulsar ? 9 : 7);
  glow.uniforms.uTemp.value = 40000;
  glow.uniforms.uIntensity.value = 1.2;
  glow.uniforms.uStreaks.value = 0.3;
  group.add(glow.mesh);

  const beam = beamMaterial();
  const beams: THREE.Mesh[] = [];
  if (pulsar) {
    const b1 = makeBeam(beam.mat);
    const b2 = makeBeam(beam.mat);
    b2.rotation.z = Math.PI;
    beams.push(b1, b2);
    magNode.add(b1, b2);
  }

  let alpha = pulsar ? 35 : 20;
  let spin = pulsar ? 1.2 : 0.3;
  const setAlpha = (deg: number) => {
    alpha = deg;
    magNode.rotation.z = THREE.MathUtils.degToRad(deg);
    const axis = new THREE.Vector3(0, 1, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), magNode.rotation.z);
    uniforms.uMagAxis.value.copy(axis);
  };
  setAlpha(alpha);

  const tmp = new THREE.Vector3();
  const camDir = new THREE.Vector3();

  const params: SimObject['params'] = [
    { kind: 'range', key: 'alpha', label: '磁倾角 α', min: 0, max: 90, step: 1, value: alpha, unit: '°',
      format: (v) => `${v.toFixed(0)}°`, onChange: setAlpha },
    { kind: 'range', key: 'spin', label: pulsar ? '自转速度（慢放）' : '自转速度（演示）', min: 0, max: 6, step: 0.05, value: spin,
      onChange: (v) => (spin = v) },
    { kind: 'toggle', key: 'lines', label: '显示磁力线', value: true, onChange: (v) => (lines.visible = v) },
  ];

  return {
    id: pulsar ? 'pulsar' : 'neutron',
    name: pulsar ? '脉冲星' : '中子星',
    group,
    camera: { distance: pulsar ? 22 : 7, min: 1.4, max: 60 },
    bloom: { strength: pulsar ? 1.1 : 0.9, radius: 0.7, threshold: 0.8 },
    params,
    info: pulsar
      ? `
      <p><b>脉冲星</b>是快速自转、强磁化的中子星。辐射沿<b>磁轴</b>方向的两束锥形光束射出。</p>
      <p>磁轴与自转轴有夹角 α，光束像灯塔一样扫过空间；光束扫过观察者时就看到一次“脉冲”（转到光束对准镜头时星体会闪亮）。</p>
      <p>真实周期 1.4 ms – 数秒（如蟹状星云脉冲星每秒 30 转），这里大幅慢放。</p>
      <p class="approx">近似：光束为几何锥体；未模拟光速圆柱、等离子体与相对论性开放磁力线。</p>`
      : `
      <p><b>中子星</b>是大质量恒星核心坍缩的遗骸：约 1.4 倍太阳质量压缩在半径 ~12 km 的球内，密度与原子核相当。</p>
      <p>新生中子星表面温度可达 10⁶ K，主要辐射 X 射线，可见光部分呈蓝白色。磁场可达 10⁸–10¹¹ T，图中为偶极磁力线；磁极处的热斑更亮。</p>
      <p class="approx">近似：尚未加入强引力光线弯曲（真实中子星可看到超过一半的表面），计划在后续版本加入。</p>`,
    update(dt, time, camera) {
      uniforms.uTime.value = time;
      beam.uniforms.uTime.value = time;
      spinNode.rotation.y += spin * dt;
      glow.update(camera, time);
      let boost = 1;
      if (pulsar) {
        // Lighthouse effect: brighten when a beam points at the camera.
        tmp.set(0, 1, 0).applyQuaternion(magNode.getWorldQuaternion(new THREE.Quaternion()));
        camDir.copy(camera.position).normalize();
        const c = Math.abs(tmp.dot(camDir));
        const halfAngle = Math.atan2(2.8, 16);
        const a = Math.acos(Math.min(1, c));
        boost = 1 + 5 * Math.exp(-((a / halfAngle) ** 2) * 1.5);
      }
      glow.uniforms.uIntensity.value = 1.2 * boost;
    },
  };
}

export const createNeutronStar = () => buildCompact(false);
export const createPulsar = () => buildCompact(true);

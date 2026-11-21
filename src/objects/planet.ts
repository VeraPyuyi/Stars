import * as THREE from 'three';
import { NOISE } from '../shaders/common';
import type { SimObject } from '../types';

const SUN_DIR = new THREE.Vector3(1, 0.25, 0.6).normalize();

const COMMON_VERT = /* glsl */ `
  varying vec3 vObj; varying vec3 vWorldN; varying vec3 vWorldPos;
  void main(){
    vObj = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vWorldN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export function createPlanet(): SimObject {
  const uniforms = {
    uSun: { value: SUN_DIR.clone() },
    uType: { value: 0 }, // 0 rocky, 1 gas giant
    uTime: { value: 0 },
    uSea: { value: 0.0 },
    uSeed: { value: new THREE.Vector3(0.0, 0.0, 0.0) },
  };

  const surface = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: COMMON_VERT,
    fragmentShader: /* glsl */ `
      varying vec3 vObj; varying vec3 vWorldN; varying vec3 vWorldPos;
      uniform vec3 uSun; uniform int uType; uniform float uTime; uniform float uSea; uniform vec3 uSeed;
      ${NOISE}
      vec3 rocky(vec3 p, vec3 N, vec3 V, out float ocean, out float height){
        vec3 q = p + uSeed;
        // Domain-warped continents.
        vec3 w = vec3(fbm(q * 1.2, 3), fbm(q * 1.2 + 5.2, 3), fbm(q * 1.2 + 9.7, 3));
        float h = fbm(q * 1.6 + w * 0.6, 8);
        // Extra detail octaves fade in as the camera gets close (LOD by pixel footprint).
        float px = length(fwidth(p));
        h += fbm(q * 26.0 + w, 4) * 0.05 * (1.0 - smoothstep(0.02, 0.08, px * 26.0));
        h += fbm(q * 110.0, 3) * 0.015 * (1.0 - smoothstep(0.02, 0.08, px * 110.0));
        height = h;
        float lat = abs(p.y);
        ocean = step(h, uSea);
        float depth = clamp((uSea - h) * 4.0, 0.0, 1.0);
        vec3 sea = mix(vec3(0.02, 0.09, 0.16), vec3(0.004, 0.02, 0.07), depth);
        float e = clamp((h - uSea) * 3.0, 0.0, 1.0);
        float arid = smoothstep(0.1, 0.4, fbm(q * 2.5 + 3.0, 4) + 0.6 - abs(lat - 0.3) * 3.0);
        vec3 green = vec3(0.06, 0.13, 0.04);
        vec3 desert = vec3(0.42, 0.33, 0.2);
        vec3 rock = vec3(0.22, 0.19, 0.16);
        vec3 land = mix(mix(green, desert, arid), rock, smoothstep(0.25, 0.6, e));
        land = mix(land, vec3(0.85), smoothstep(0.65, 0.8, e));
        vec3 c = mix(land, sea, ocean);
        float ice = smoothstep(0.82, 0.88, lat + 0.08 * fbm(q * 5.0, 3));
        c = mix(c, vec3(0.9, 0.93, 0.97), ice);
        ocean *= 1.0 - ice;
        return c;
      }
      vec3 gas(vec3 p){
        float lat = p.y;
        vec3 q = p + uSeed;
        float turb = fbm(vec3(q.x * 2.0, q.y * 10.0, q.z * 2.0) + vec3(uTime * 0.01, 0.0, 0.0), 6);
        float band = sin(lat * 22.0 + turb * 2.2) * 0.5 + 0.5;
        float fine = fbm(vec3(q.x * 6.0, lat * 40.0, q.z * 6.0), 4) * 0.5 + 0.5;
        vec3 light = vec3(0.86, 0.78, 0.64);
        vec3 dark = vec3(0.55, 0.33, 0.19);
        vec3 c = mix(dark, light, band);
        c *= 0.85 + 0.3 * fine;
        // A long-lived anticyclone (storm oval).
        vec2 sp = vec2(atan(p.z, p.x) - 1.0, (lat + 0.35) * 2.6);
        float oval = exp(-dot(sp, sp) * 14.0);
        c = mix(c, vec3(0.7, 0.3, 0.18), oval * 0.8);
        return c;
      }
      void main(){
        vec3 p = normalize(vObj);
        vec3 N = normalize(vWorldN);
        vec3 V = normalize(cameraPosition - vWorldPos);
        float ocean = 0.0;
        float height = 0.0;
        vec3 albedo = uType == 0 ? rocky(p, N, V, ocean, height) : gas(p);
        if (uType == 0) {
          // Bump mapping from the procedural height field (screen-space derivatives).
          float hb = max(height, uSea);
          vec3 dpdx = dFdx(vWorldPos), dpdy = dFdy(vWorldPos);
          float dhdx = dFdx(hb), dhdy = dFdy(hb);
          vec3 R1 = cross(dpdy, N), R2 = cross(N, dpdx);
          float det = dot(dpdx, R1);
          vec3 grad = sign(det) * (dhdx * R1 + dhdy * R2);
          // Slope limited, and eased off right at the terminator, where per-pixel
          // derivatives would otherwise flip whole 2×2 pixel blocks between lit and dark.
          vec3 g = 0.06 * grad / max(abs(det), 1e-12);
          g /= max(1.0, length(g) / 0.35);
          N = normalize(N - g * smoothstep(-0.05, 0.35, dot(N, uSun)));
        }
        float NL = dot(N, uSun);
        float diff = max(NL, 0.0);
        // Soft terminator from atmospheric refraction/scattering.
        float term = smoothstep(-0.08, 0.15, NL);
        vec3 col = albedo * (diff * 0.9 + 0.1 * term) * 2.2;
        // Specular sun glint on oceans.
        vec3 H = normalize(uSun + V);
        col += ocean * pow(max(dot(N, H), 0.0), 220.0) * 1.2 * term;
        // City lights on the night side.
        if (uType == 0) {
          float city = smoothstep(0.55, 0.85, snoise(p * 55.0 + uSeed)) * smoothstep(0.3, 0.6, fbm(p * 4.0 + uSeed, 3) + 0.5);
          col += (1.0 - ocean) * city * (1.0 - smoothstep(-0.15, 0.02, NL)) * vec3(1.0, 0.6, 0.25) * 0.5;
        } else {
          // Limb darkening for the deep atmosphere of a gas giant.
          col *= 0.55 + 0.45 * pow(max(dot(N, V), 0.0), 0.4);
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const cloudUniforms = { uSun: uniforms.uSun, uTime: uniforms.uTime, uCloud: { value: 0.6 }, uSeed: uniforms.uSeed };
  const clouds = new THREE.ShaderMaterial({
    uniforms: cloudUniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: COMMON_VERT,
    fragmentShader: /* glsl */ `
      varying vec3 vObj; varying vec3 vWorldN; varying vec3 vWorldPos;
      uniform vec3 uSun; uniform float uTime; uniform float uCloud; uniform vec3 uSeed;
      ${NOISE}
      void main(){
        vec3 p = normalize(vObj);
        vec3 q = p * 2.5 + uSeed + vec3(0.0, 0.0, uTime * 0.01);
        vec3 w = vec3(fbm(q, 3), fbm(q + 3.3, 3), 0.0);
        float n = fbm(q * 1.5 + w * 0.8, 8) * 0.5 + 0.5;
        n += fbm(q * 18.0 + w, 3) * 0.06 * (1.0 - smoothstep(0.02, 0.1, length(fwidth(p)) * 18.0));
        // Fewer clouds in the subtropical high-pressure belts.
        float lat = abs(p.y);
        float belt = 1.0 - 0.5 * exp(-pow((lat - 0.45) * 6.0, 2.0));
        float a = smoothstep(1.0 - uCloud * 0.75, 1.0 - uCloud * 0.75 + 0.25, n * belt);
        float NL = dot(normalize(vWorldN), uSun);
        float lit = smoothstep(-0.1, 0.25, NL) * (0.15 + 0.85 * max(NL, 0.0));
        gl_FragColor = vec4(vec3(1.05) * lit, a * 0.95);
      }
    `,
  });

  // World position of the planet's centre (it is not at the origin during the tour).
  const center = { value: new THREE.Vector3() };
  const atmoUniforms = {
    uSun: uniforms.uSun,
    uCenter: center,
    uScale: { value: 0.018 },
    uRayleigh: { value: new THREE.Color(0.28, 0.55, 1.0) },
    uStrength: { value: 1.4 },
  };
  // Atmosphere: column density of an exponential atmosphere along each view ray,
  // tinted with a Rayleigh-like colour that reddens near the terminator.
  const atmosphere = new THREE.ShaderMaterial({
    uniforms: atmoUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: COMMON_VERT,
    fragmentShader: /* glsl */ `
      varying vec3 vObj; varying vec3 vWorldN; varying vec3 vWorldPos;
      uniform vec3 uSun; uniform float uScale; uniform vec3 uRayleigh; uniform float uStrength; uniform vec3 uCenter;
      void main(){
        vec3 ro = cameraPosition - uCenter;          // planet-centred coordinates
        vec3 rd = normalize(vWorldPos - cameraPosition);
        float tc = -dot(ro, rd);
        vec3 closest = ro + rd * tc;
        float b = length(closest);
        float column = b >= 1.0
          ? exp(-(b - 1.0) / uScale)
          : min(1.0, uScale * 2.5 / max(sqrt(1.0 - b * b), 1e-3));
        vec3 at = b >= 1.0 ? closest : ro + rd * (tc - sqrt(max(1.0 - b * b, 0.0)));
        float mu = dot(normalize(at), uSun);
        float sunlit = smoothstep(-0.18, 0.2, mu);
        vec3 tint = mix(vec3(1.0, 0.42, 0.18), uRayleigh, smoothstep(-0.05, 0.35, mu));
        float forward = pow(max(dot(rd, uSun), 0.0), 10.0) * 2.0; // forward scattering when back-lit
        vec3 c = tint * column * (sunlit + forward * smoothstep(-0.4, 0.0, mu)) * uStrength;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });

  const ringUniforms = { uSun: uniforms.uSun, uCenter: center };
  const rings = new THREE.ShaderMaterial({
    uniforms: ringUniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vLocal; varying vec3 vWorldPos;
      void main(){
        vLocal = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vLocal; varying vec3 vWorldPos;
      uniform vec3 uSun; uniform vec3 uCenter;
      ${NOISE}
      void main(){
        float r = length(vLocal.xy);
        float bands = snoise(vec3(r * 30.0, 0.5, 0.0)) * 0.5 + snoise(vec3(r * 90.0, 2.0, 0.0)) * 0.3;
        float dens = clamp(0.55 + bands, 0.0, 1.0);
        dens *= smoothstep(1.35, 1.45, r) * (1.0 - smoothstep(2.25, 2.35, r));
        dens *= 1.0 - 0.85 * smoothstep(1.92, 1.95, r) * (1.0 - smoothstep(2.0, 2.03, r)); // Cassini-like gap
        // Planet shadow on the rings.
        vec3 P = vWorldPos - uCenter;
        float t = -dot(P, uSun);
        float shadow = (t > 0.0 && length(P + uSun * t) < 1.0) ? 0.05 : 1.0;
        vec3 c = vec3(0.82, 0.74, 0.6) * (0.6 + 0.4 * dens) * shadow * 1.6;
        gl_FragColor = vec4(c, dens * 0.85);
      }
    `,
  });

  const group = new THREE.Group();
  const tilt = new THREE.Group();
  tilt.rotation.z = THREE.MathUtils.degToRad(23.4);
  group.add(tilt);
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 192), surface);
  const cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(1.008, 256, 192), clouds);
  const atmoMesh = new THREE.Mesh(new THREE.SphereGeometry(1.1, 96, 72), atmosphere);
  const ringMesh = new THREE.Mesh(new THREE.RingGeometry(1.3, 2.4, 256, 1), rings);
  ringMesh.rotation.x = -Math.PI / 2;
  ringMesh.visible = false;
  tilt.add(body, cloudMesh, ringMesh);
  group.add(atmoMesh); // spherical; no need to rotate

  let spin = 0.08;
  const setType = (t: string) => {
    const gasGiant = t === 'gas';
    uniforms.uType.value = gasGiant ? 1 : 0;
    cloudMesh.visible = !gasGiant;
    ringMesh.visible = gasGiant;
    tilt.rotation.z = THREE.MathUtils.degToRad(gasGiant ? 26.7 : 23.4);
    atmoUniforms.uRayleigh.value.set(...((gasGiant ? [0.8, 0.75, 0.6] : [0.28, 0.55, 1.0]) as [number, number, number]));
    atmoUniforms.uScale.value = gasGiant ? 0.03 : 0.018;
    atmoUniforms.uStrength.value = gasGiant ? 0.6 : 1.4;
  };

  return {
    id: 'planet',
    name: '行星',
    group,
    camera: { distance: 3.6, min: 1.15, max: 30 },
    bloom: { strength: 0.25, radius: 0.4, threshold: 1.2 },
    params: [
      {
        kind: 'select', key: 'type', label: '类型', value: 'rocky',
        options: [ { value: 'rocky', label: '类地行星' }, { value: 'gas', label: '气态巨行星（带环）' } ],
        onChange: setType,
      },
      { kind: 'range', key: 'sea', label: '海平面', min: -0.4, max: 0.4, step: 0.01, value: 0, onChange: (v) => (uniforms.uSea.value = v) },
      { kind: 'range', key: 'cloud', label: '云量', min: 0, max: 1, step: 0.01, value: 0.6, onChange: (v) => (cloudUniforms.uCloud.value = v) },
      { kind: 'range', key: 'seed', label: '地形种子', min: 0, max: 100, step: 1, value: 0, onChange: (v) => uniforms.uSeed.value.set(v * 3.17, v * 1.91, v * 2.53) },
      { kind: 'range', key: 'spin', label: '自转速度（演示）', min: 0, max: 1, step: 0.01, value: spin, onChange: (v) => (spin = v) },
    ],
    info: `
      <p><b>光照</b>来自固定方向的“恒星”，旋转视角可看到昼夜两侧、晨昏线和夜面城市灯光。</p>
      <p><b>大气</b>按指数大气计算视线柱密度：边缘更厚更亮；瑞利散射使其偏蓝，晨昏线附近偏红；逆光时有前向散射亮边。</p>
      <p><b>海洋</b>有太阳镜面反光；气态巨行星有纬向云带、风暴涡旋，光环会被行星投影。</p>
      <p class="approx">近似：未做多次散射与真实地形高度；云层无体积。</p>`,
    setLightDir(d) { uniforms.uSun.value.copy(d).normalize(); },
    update(dt, time) {
      group.getWorldPosition(center.value);
      uniforms.uTime.value = time;
      body.rotation.y += spin * dt * 0.3;
      cloudMesh.rotation.y += spin * dt * 0.36;
    },
  };
}

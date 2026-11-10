// "X-ray" look for the anatomy model (the user's reference dashboard): bright edges,
// see-through centres (a fresnel term), additive glow so overlapping bones/organs read
// like a radiograph. One small shader, shared by bones, organs, skin and muscles; each
// gets its own color/opacity uniforms so a region can turn yellow/red and pulse.
import * as THREE from "three";

const vertexShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uPower;
  uniform float uCore;
  uniform float uGlow;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float facing = abs(dot(normalize(vNormal), normalize(vView)));
    float rim = pow(1.0 - facing, uPower);
    float a = clamp((uCore + rim) * uOpacity, 0.0, 1.0);
    gl_FragColor = vec4(uColor * (uCore + rim * 1.6) * uGlow, a);
  }
`;

export function xrayMaterial({ color = "#dfe8ff", opacity = 0.6, power = 2.2, core = 0.08, glow = 1 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uPower: { value: power },
      uCore: { value: core },
      uGlow: { value: glow },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

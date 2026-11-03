// GLSL for the galaxy: all procedural, no textures.

const NOISE = /* glsl */ `
  float h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float vnoise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
`;

// ── Star: boiling surface, white-hot core, HDR so bloom makes the glow ──
export const STAR_VERT = /* glsl */ `
  varying vec3 vObjN;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vObjN = normal;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vV = cameraPosition - wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
export const STAR_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uHeat;
  varying vec3 vObjN;
  varying vec3 vN;
  varying vec3 vV;
  ${NOISE}
  void main() {
    float n = fbm(vObjN * 3.2 + vec3(uTime * 0.06, uTime * 0.04, 0.0));
    float g = fbm(vObjN * 10.0 - vec3(0.0, uTime * 0.1, uTime * 0.07));
    float facing = max(dot(normalize(vN), normalize(vV)), 0.0);
    // Hue stays readable: colored granulation, only the very center runs white-hot
    vec3 col = uColor * (0.4 + 0.85 * n + 0.35 * g) * (0.7 + 0.5 * pow(facing, 0.7));
    col += mix(uColor, vec3(1.0), 0.5) * pow(facing, 8.0) * (0.25 + 0.25 * n);
    gl_FragColor = vec4(col * uHeat, 1.0);
  }
`;

// ── Planet: banded surface tinted by status, lit by its own star ──
export const PLANET_VERT = /* glsl */ `
  varying vec3 vObjN;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vObjN = normal;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
export const PLANET_FRAG = /* glsl */ `
  uniform vec3 uStar;
  uniform vec3 uA;
  uniform vec3 uB;
  uniform vec3 uBandColor;
  uniform float uBand;
  uniform float uTime;
  uniform float uSeed;
  uniform float uLift;
  varying vec3 vObjN;
  varying vec3 vN;
  varying vec3 vW;
  ${NOISE}
  void main() {
    vec3 N = normalize(vN);
    vec3 L = normalize(uStar - vW);
    vec3 V = normalize(cameraPosition - vW);
    vec3 o = normalize(vObjN);
    float lat = o.y;
    float lon = atan(o.z, o.x);
    float warp = fbm(o * 2.4 + uSeed);
    float bands = sin(lat * 10.0 + warp * 4.0 + uSeed * 6.0);
    vec3 albedo = mix(uB, uA, 0.5 + 0.5 * bands);
    albedo *= 0.7 + 0.6 * fbm(o * 7.0 + uSeed * 3.0);
    float ndl = dot(N, L);
    float light = smoothstep(-0.2, 0.75, ndl);
    vec3 col = albedo * (0.06 + 1.2 * light) + albedo * uLift;
    // Working: a bright equator band with dashes drifting around the planet
    float eqd = lat * 11.0;
    float eq = exp(-eqd * eqd);
    float dash = 0.5 + 0.5 * sin(lon * 7.0 - uTime * 1.4);
    col += uBandColor * eq * (0.35 + 0.65 * dash) * uBand * 1.8;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ── Atmosphere: Fresnel rim, additive. alpha = 0.05 + 0.6 * pow(1 - |N.V|, 2.4) ──
export const ATMO_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
export const ATMO_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uStar;
  uniform float uStrength;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec3 N = normalize(vN);
    vec3 V = normalize(cameraPosition - vW);
    vec3 L = normalize(uStar - vW);
    float a = 0.05 + 0.6 * pow(clamp(1.0 - abs(dot(N, V)), 0.0, 1.0), 2.4);
    float lit = 0.3 + 0.7 * smoothstep(-0.35, 0.6, dot(N, L));
    gl_FragColor = vec4(uColor * a * lit * uStrength, 1.0);
  }
`;

// ── Orbit line: faint ring with a bright trail just behind the planet ──
export const ORBIT_VERT = /* glsl */ `
  attribute float aAngle;
  varying float vAngle;
  void main() {
    vAngle = aAngle;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
export const ORBIT_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uPlanet;
  uniform float uBase;
  uniform float uTrail;
  varying float vAngle;
  void main() {
    float d = mod(uPlanet - vAngle, 6.2831853) / 6.2831853;
    float trail = exp(-d * 7.0) * step(0.0005, d);
    gl_FragColor = vec4(uColor * (uBase + uTrail * trail), 1.0);
  }
`;

// ── Nebula sky: faint colored clouds on a sphere that follows the camera ──
export const NEBULA_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;
export const NEBULA_FRAG = /* glsl */ `
  uniform vec3 uA;
  uniform vec3 uB;
  uniform vec3 uC;
  varying vec3 vDir;
  ${NOISE}
  void main() {
    vec3 d = normalize(vDir);
    float bd = d.y * 2.6 + 0.25 * sin(d.x * 3.0);
    float band = exp(-bd * bd);
    float n1 = fbm(d * 2.2 + 3.0);
    float n2 = fbm(d * 4.5 - 7.0);
    float n3 = fbm(d * 9.0 + 1.0);
    vec3 col = vec3(0.0);
    // pow() bases must never go negative: Direct3D returns NaN and bloom spreads it
    col += uA * pow(max(n1, 0.0), 3.0) * (0.35 + band) * 0.9;
    col += uB * pow(max(n2, 0.0), 3.5) * band * 1.2;
    col += uC * pow(max(n1 * n2, 0.0), 2.0) * band * 0.9;
    col *= (0.6 + 0.4 * n3) * 2.2;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ── Particles (comets, sparks, dust): soft round points ──
export const POINTS_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  uniform float uScale;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // World-sized, but capped so particles never balloon right in front of the lens
    gl_PointSize = min(aSize * uScale / max(0.5, -mv.z), 26.0);
    gl_Position = projectionMatrix * mv;
  }
`;
export const POINTS_FRAG = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c) * 2.0;
    if (r > 1.0) discard;
    float core = exp(-r * r * 6.0);
    float halo = (1.0 - r) * 0.35;
    gl_FragColor = vec4(vColor * (core + halo) * vAlpha, 1.0);
  }
`;

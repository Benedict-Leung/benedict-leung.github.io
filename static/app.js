import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

/* ============================================================
   MOBILE MENU
   ============================================================ */
const menuBtn = document.getElementById('menu-btn');
const mobileMenu = document.getElementById('mobile-menu');
const mobileLinks = document.querySelectorAll('.mobile-link');

if (menuBtn && mobileMenu) {
    menuBtn.addEventListener('click', () => {
        mobileMenu.classList.toggle('open');
        menuBtn.classList.toggle('active');
    });
    mobileLinks.forEach(link => {
        link.addEventListener('click', () => {
            mobileMenu.classList.remove('open');
            menuBtn.classList.remove('active');
        });
    });
}

/* ============================================================
   QUALITY SETTINGS
   ============================================================ */
const IS_MOBILE = /Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && Math.min(window.innerWidth, window.innerHeight) < 900);
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Tuned for a steady frame rate. Past 2x, extra pixels are invisible on
// a moving 3D background but cost 2.25x the GPU work of 2x.
const MAX_DPR = IS_MOBILE ? 1 : 1.5;
const MAX_TEX_SIZE = IS_MOBILE ? 1024 : 2048;    // 4K maps were ~45MB of VRAM each
const SPHERE_SEG_W = IS_MOBILE ? 64 : 128;
const SPHERE_SEG_H = IS_MOBILE ? 32 : 64;
const RING_SEG = IS_MOBILE ? 128 : 256;
const SKY_SIZE = IS_MOBILE ? 512 : 1024;   // 2048 half-float cube was ~200MB

/* ============================================================
   SHARED GLSL
   3D simplex noise (Ashima Arts / Stefan Gustavson, MIT)
   ============================================================ */
const NOISE_GLSL = /* glsl */`
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
                i.z + vec4(0.0, i1.z, i2.z, 1.0))
              + i.y + vec4(0.0, i1.y, i2.y, 1.0))
              + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
// Returns roughly 0..1
float fbm(vec3 p, int octaves){
    float sum = 0.0, amp = 0.5, norm = 0.0;
    for (int i = 0; i < 8; i++){
        if (i >= octaves) break;
        sum += amp * snoise(p);
        norm += amp;
        p = p * 2.03 + vec3(1.7, 9.2, 3.1);
        amp *= 0.5;
    }
    return 0.5 + 0.5 * (sum / norm);
}
float hash13(vec3 p){
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}
`;

/* ============================================================
   RENDERER + POST
   ============================================================ */
const EXTRA_HEIGHT = 100;
const canvas = document.getElementById("bg");

const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,            // MSAA happens on the composer's render target
    alpha: false,
    stencil: false,
    powerPreference: "high-performance"
});

const PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, MAX_DPR);

renderer.setPixelRatio(PIXEL_RATIO);
// Sharpest texture filtering the GPU supports, so planet surfaces stay crisp at glancing angles.
const ANISO = Math.min(IS_MOBILE ? 4 : 8, renderer.capabilities.getMaxAnisotropy());
renderer.setSize(window.innerWidth, window.innerHeight + EXTRA_HEIGHT);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x000000, 0.0006);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / (window.innerHeight + EXTRA_HEIGHT), 0.1, 50000);

// HDR pipeline: everything renders linear into a half-float target, bloom
// picks up only what is genuinely brighter than white (the sun, streak cores),
// then OutputPass applies ACES + sRGB once at the end.
const _drawSize = renderer.getDrawingBufferSize(new THREE.Vector2());
const composerTarget = new THREE.WebGLRenderTarget(_drawSize.x, _drawSize.y, {
    type: THREE.HalfFloatType,
    samples: IS_MOBILE ? 0 : Math.min(4, renderer.capabilities.maxSamples || 4)
});
const composer = new EffectComposer(renderer, composerTarget);
composer.setPixelRatio(PIXEL_RATIO);
composer.setSize(window.innerWidth, window.innerHeight + EXTRA_HEIGHT);

const renderPass = new RenderPass(scene, camera);
const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight + EXTRA_HEIGHT),
    0.3,   // strength
    0.45,  // radius
    1.1    // threshold (linear luminance)
);
const outputPass = new OutputPass();
composer.addPass(renderPass);
composer.addPass(bloomPass);
composer.addPass(outputPass);

/* ============================================================
   INTRO STATE
   ============================================================ */
let isIntroPlaying = true;
const introLookAt = new THREE.Vector3(0, 55, 0);
camera.position.set(0, 55, 45);
camera.lookAt(introLookAt);

// Uniform blocks that the intro timeline animates.
const starUniforms = {
    time: { value: 0 },
    introProgress: { value: 0.0 }
};
const sunUniforms = {
    uTime: { value: 0 },
    uIgnite: { value: 0.9 }
};

/* ============================================================
   LOADING + CINEMATIC
   ============================================================ */
const loadingManager = new THREE.LoadingManager();
const progressBar = document.getElementById('progress-bar');
const preloader = document.getElementById('preloader');

loadingManager.onProgress = (url, loaded, total) => {
    if (progressBar) progressBar.style.width = (loaded / total) * 100 + '%';
};

loadingManager.onLoad = () => {
    document.querySelectorAll('#hero .content-block, .planet-horizon').forEach(el => {
        el.style.transition = 'none';
    });

    gsap.set("nav", { y: -30, opacity: 0 });
    gsap.set("#hero .content-block", { y: 30, opacity: 0 });
    gsap.set(".deco-line-vertical", { scaleY: 0, opacity: 0, transformOrigin: "top" });
    gsap.set(".sys-status", { x: 20, opacity: 0 });
    gsap.set(".hud-footer", { y: 20, opacity: 0 });
    gsap.set(".scroll-indicator", { opacity: 0 });
    gsap.set("#planet-horizon", { opacity: 0, scale: 0.8 });

    if (preloader) preloader.classList.add('loaded');
    document.documentElement.style.overflow = 'hidden';

    const tl = gsap.timeline({
        onComplete: () => {
            isIntroPlaying = false;
            document.documentElement.style.overflow = '';
            document.querySelectorAll('#hero .content-block, .planet-horizon').forEach(el => {
                el.style.transition = '';
                el.style.transform = '';
            });
            gsap.set("#hero .content-block", { clearProps: "all" });
            camPos.copy(camera.position);
            camLook.copy(introLookAt);
            prevPos.copy(camPos);
            initScroll();
        }
    });

    // PHASE 1 — darkness fills with stars and the Milky Way; the sun is an ember below frame.
    tl.to(starUniforms.introProgress, { value: 1.0, duration: 2.4, ease: "power2.inOut" }, 0)
      .to(scene, { backgroundIntensity: 1.0, duration: 3.0, ease: "power1.inOut" }, 0.2)

    // PHASE 2 — the camera sinks, the sun rises into frame and ignites as it does.
      .to(sunUniforms.uIgnite, { value: 0.7, duration: 1.0, ease: "power2.in" }, 1.6)
      .to(camera.position, {
          y: 0,
          duration: 2.0,
          ease: "sine.inOut",
          onUpdate: () => {
              introLookAt.y = camera.position.y;
              camera.lookAt(introLookAt);
          }
      }, 2)

    // PHASE 3 — pull back to reveal the system.
      .to(camera.position, {
          x: views.overview.pos.x,
          y: views.overview.pos.y,
          z: views.overview.pos.z,
          duration: 3.0,
          ease: "sine.inOut",
          onUpdate: () => camera.lookAt(introLookAt)
      }, 4.0)
      .to(introLookAt, {
          x: views.overview.lookAt.x,
          y: views.overview.lookAt.y,
          z: views.overview.lookAt.z,
          duration: 3.0,
          ease: "sine.inOut"
      }, 4.0)

    // SYSTEM ONLINE — interface arrives as the camera settles.
      .to("#planet-horizon", { opacity: 0.6, scale: 1, duration: 1.5, ease: "power1.out" }, 5.0)
      .to("nav", { y: 0, opacity: 1, duration: 1.0, ease: "power1.out" }, 5.3)
      .to("#hero .content-block", { y: 0, opacity: 1, duration: 1.0, ease: "power1.out" }, 5.5)
      .to(".deco-line-vertical", { scaleY: 1, opacity: 1, duration: 0.8, ease: "power1.out" }, 5.7)
      .to(".sys-status", { x: 0, opacity: 1, duration: 0.8, ease: "power1.out" }, 5.9)
      .to(".hud-footer", { y: 0, opacity: 1, duration: 0.8, ease: "power1.out" }, 6.1)
      .to(".scroll-indicator", { opacity: 0.5, duration: 1.0, ease: "power1.out" }, 6.3);

    if (REDUCED_MOTION) tl.progress(1);
};

const textureLoader = new THREE.TextureLoader(loadingManager);
const IMAGE_BASE = "static/img/";

function fitTexture(tex) {
    const img = tex.image;
    if (img && img.width) {
        const largest = Math.max(img.width, img.height);
        if (largest > MAX_TEX_SIZE) {
            const scale = MAX_TEX_SIZE / largest;
            const c = document.createElement("canvas");
            c.width = Math.max(1, Math.round(img.width * scale));
            c.height = Math.max(1, Math.round(img.height * scale));
            const ctx = c.getContext("2d");
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(img, 0, 0, c.width, c.height);
            tex.image = c;
        }
    }
    tex.anisotropy = ANISO;
    tex.needsUpdate = true;
    if (typeof renderer.initTexture === 'function') renderer.initTexture(tex);
    return tex;
}

const loadTex = (path, srgb = true) => {
    const t = textureLoader.load(path, fitTexture);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return t;
};

/* ============================================================
   SKY — Milky Way band, dust lanes and faint nebulae, rendered
   once into a cubemap at load. Zero per-frame cost.
   ============================================================ */
function buildSky() {
    const cubeRT = new THREE.WebGLCubeRenderTarget(SKY_SIZE, {
        type: THREE.HalfFloatType,
        generateMipmaps: false
    });

    const skyMat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        vertexShader: /* glsl */`
            varying vec3 vDir;
            void main() {
                vDir = position;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: NOISE_GLSL + /* glsl */`
            varying vec3 vDir;
            void main() {
                vec3 d = normalize(vDir);

                // Galactic plane, tilted against the ecliptic.
                vec3 bn = normalize(vec3(0.30, 0.90, 0.30));
                float lat = dot(d, bn);
                float band = exp(-lat * lat * 26.0);
                float wide = exp(-lat * lat * 5.0);

                float n  = fbm(d * 2.2, 6);
                float n2 = fbm(d * 6.5 + 11.0, 6);
                float lanes = smoothstep(0.42, 0.72, n2) * exp(-lat * lat * 120.0);

                // Brighter, warmer galactic core in one direction.
                vec3 coreDir = normalize(vec3(-0.55, -0.22, -0.80));
                float core = pow(max(dot(d, coreDir), 0.0), 4.0);

                vec3 cool = vec3(0.34, 0.42, 0.66);
                vec3 warm = vec3(1.00, 0.76, 0.50);
                vec3 col = mix(cool, warm, clamp(core * 0.8, 0.0, 1.0));

                float dens = band * (0.35 + 1.1 * n * n) * (1.0 - 0.85 * lanes) + wide * 0.1 * n;
                col *= dens * (0.035 + 0.05 * core);

                // Very faint coloured gas so the black is never flat.
                float neb1 = smoothstep(0.55, 0.85, fbm(d * 1.4 + 4.0, 5));
                float neb2 = smoothstep(0.58, 0.88, fbm(d * 1.9 - 7.0, 5));
                col += vec3(0.22, 0.10, 0.20) * neb1 * 0.035;
                col += vec3(0.08, 0.16, 0.26) * neb2 * 0.03;


                // Sparse star dust, a little denser along the band.
                vec3 cell = floor(d * 900.0);
                float h = hash13(cell);
                float dust = step(0.999, h) * fract(h * 113.0);
                col += vec3(0.85, 0.9, 1.0) * dust * (0.012 + band * (0.02 + 0.06 * n));

                gl_FragColor = vec4(col, 1.0);
            }
        `
    });

    const skyScene = new THREE.Scene();
    const skyGeo = new THREE.SphereGeometry(10, 64, 32);
    skyScene.add(new THREE.Mesh(skyGeo, skyMat));

    const cubeCam = new THREE.CubeCamera(0.1, 100, cubeRT);
    cubeCam.update(renderer, skyScene);

    skyGeo.dispose();
    skyMat.dispose();

    scene.background = cubeRT.texture;
    scene.backgroundIntensity = 0;
}

/* ============================================================
   SUN — animated plasma surface + billboard corona
   ============================================================ */
const SUN_R = 15;
let sun;

function createSun() {
    const octaves = IS_MOBILE ? 3 : 4;

    const surfaceMat = new THREE.ShaderMaterial({
        uniforms: sunUniforms,
        vertexShader: /* glsl */`
            varying vec3 vObj;
            varying vec3 vN;
            varying vec3 vV;
            void main() {
                vObj = normalize(position);
                vN = normalize(normalMatrix * normal);
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                vV = -mv.xyz;
                gl_Position = projectionMatrix * mv;
            }
        `,
        fragmentShader: NOISE_GLSL + /* glsl */`
            uniform float uTime;
            uniform float uIgnite;
            varying vec3 vObj;
            varying vec3 vN;
            varying vec3 vV;

            vec3 ramp(float h) {
                h = clamp(h, 0.0, 1.0);
                // Linear-space versions of the page's horizon colours.
                // Matched to how .planet-horizon actually appears on screen (a soft,
                // desaturated warm glow), pre-compensated for ACES tone mapping.
                vec3 a = vec3(0.061, 0.018, 0.013);   // #3A1410  ember
                vec3 b = vec3(0.546, 0.113, 0.068);   // #D66D50  --horizon-red
                vec3 c = vec3(0.862, 0.226, 0.102);   // #dc8149  red/gold blend
                vec3 d = vec3(2.132, 0.508, 0.107);   // #dba048  --horizon-gold
                if (h < 0.40) return mix(a, b, h / 0.40);
                if (h < 0.75) return mix(b, c, (h - 0.40) / 0.35);
                return mix(c, d, (h - 0.75) / 0.25);
            }

            void main() {
                float mu = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
                float t = uTime * 0.035;

                // Large convective flow, warped by itself so it churns rather than scrolls.
                vec3 p = vObj * 2.2;
                float warpN = snoise(p * 0.8 + vec3(t, -t * 0.7, t * 0.4)) * 0.5 + 0.5;
                float n1 = fbm(p + warpN * 0.7 + vec3(-t * 0.5, t, 0.0), ${octaves});
                // Granulation.
                float g = snoise(vObj * 30.0 + vec3(0.0, t * 8.0, t * 3.0) + n1 * 1.5);
                // Sparse sunspots.
                float spots = smoothstep(0.62, 0.8, snoise(vObj * 1.7 + vec3(7.0, t * 0.4, 3.0)));

                float heat = 0.68 + 0.8 * (n1 - 0.5) + 0.08 * g;
                heat -= spots * 0.12;

                vec3 col = ramp(heat);
                // Limb darkening: the edge is deeper and redder than the centre.
                float limb = pow(mu, 0.55);
                col *= mix(0.35, 1.0, limb);
                col = mix(vec3(0.072, 0.043, 0.032), col, smoothstep(0.0, 0.35, mu));   // #463026 edge
                // Chromosphere rim.
                col += vec3(0.218, 0.120, 0.078) * pow(1.0 - mu, 4.0) * 0.4;

                col *= uIgnite;
                gl_FragColor = vec4(col, 1.0);
            }
        `
    });

    sun = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, SPHERE_SEG_W, SPHERE_SEG_H), surfaceMat);

    // Corona: one camera-facing quad, billboarded in the vertex shader.
    const CORONA_SCALE = 1.6; // in sun radii — a thin halo, like the planet atmospheres
    const coronaMat = new THREE.ShaderMaterial({
        uniforms: {
            uTime: sunUniforms.uTime,
            uIgnite: sunUniforms.uIgnite,
            uSize: { value: SUN_R * CORONA_SCALE },
            uRatio: { value: CORONA_SCALE }
        },
        vertexShader: /* glsl */`
            uniform float uSize;
            varying vec2 vP;
            void main() {
                vP = position.xy;
                vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
                mv.xy += position.xy * uSize;
                gl_Position = projectionMatrix * mv;
            }
        `,
        fragmentShader: NOISE_GLSL + /* glsl */`
            uniform float uTime;
            uniform float uIgnite;
            uniform float uRatio;
            varying vec2 vP;
            void main() {
                float r = length(vP) * uRatio;   // in sun radii
                float e = max(r - 1.0, 0.0);

                float glow = exp(-e * 16.0) * 0.45 + exp(-e * 6.0) * 0.12;

                // Streamers: noise sampled on a circle so there is no seam at atan's wrap.
                float ang = atan(vP.y, vP.x + 1e-6);
                vec2 cs = vec2(cos(ang), sin(ang));
                float s = snoise(vec3(cs * 3.5, uTime * 0.05 - e * 0.7));
                float rays = 1.0 + s * smoothstep(0.02, 0.2, e) * 0.35;
                glow *= max(rays, 0.0);

                glow *= 1.0 - smoothstep(uRatio * 0.8, uRatio, r);

                vec3 col = mix(vec3(0.218, 0.120, 0.078), vec3(0.104, 0.061, 0.043), smoothstep(0.0, 0.4, e));
                gl_FragColor = vec4(col * glow * uIgnite, 1.0);
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    const corona = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), coronaMat);
    corona.frustumCulled = false;
    corona.renderOrder = 3;
    sun.add(corona);

    const sunLight = new THREE.PointLight(0xffe2c0, 3.0, 0, 0);
    sun.add(sunLight);
    scene.add(sun);

    // Cool, very low fill so night sides read as shape, not holes.
    scene.add(new THREE.AmbientLight(0x6a7a96, 1.1));
}

/* ============================================================
   PLANET BUILDING BLOCKS
   ============================================================ */
const planets = {};

// Atmosphere shell. The glow is computed from where each view ray passes
// the planet centre, so it is a soft halo outside the limb and a thin rim
// inside it — and only on the sunlit side, with a warm band at the terminator.
function makeAtmosphere(center, R, shellR, color, intensity) {
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uCenter: { value: center.clone() },
            uR: { value: R },
            uShell: { value: shellR },
            uColor: { value: new THREE.Color(color) },
            uIntensity: { value: intensity }
        },
        vertexShader: /* glsl */`
            varying vec3 vWorld;
            void main() {
                vec4 w = modelMatrix * vec4(position, 1.0);
                vWorld = w.xyz;
                gl_Position = projectionMatrix * viewMatrix * w;
            }
        `,
        fragmentShader: /* glsl */`
            uniform vec3 uCenter;
            uniform float uR;
            uniform float uShell;
            uniform vec3 uColor;
            uniform float uIntensity;
            varying vec3 vWorld;
            void main() {
                vec3 rd = normalize(vWorld - cameraPosition);
                vec3 oc = uCenter - cameraPosition;
                float t = dot(oc, rd);
                vec3 closest = cameraPosition + rd * t;
                float b = length(closest - uCenter);

                float glow;
                if (b > uR) {
                    float h = 1.0 - clamp((b - uR) / (uShell - uR), 0.0, 1.0);
                    glow = h * h * h;
                } else {
                    glow = pow(b / uR, 9.0) * 0.9;
                }

                vec3 n = (closest - uCenter) / max(b, 1e-4);
                vec3 L = normalize(-uCenter);     // sun sits at the origin
                float d = dot(n, L);
                float lit = smoothstep(-0.30, 0.45, d);
                float term = smoothstep(-0.30, 0.05, d) * (1.0 - smoothstep(0.05, 0.45, d));
                vec3 col = mix(uColor, vec3(1.0, 0.52, 0.28), term * 0.55);

                gl_FragColor = vec4(col * glow * lit * uIntensity, 1.0);
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(shellR, SPHERE_SEG_W, SPHERE_SEG_H), mat);
    mesh.renderOrder = 2;
    return mesh;
}

function makeRingGeometry(inner, outer) {
    const geo = new THREE.RingGeometry(inner, outer, RING_SEG, 1);
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    const v3 = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
        v3.fromBufferAttribute(pos, i);
        uv.setXY(i, (v3.length() - inner) / (outer - inner), 0.5);
    }
    return geo;
}

// Rings lit by the sun, with the planet's shadow falling across them and a
// forward-scatter glow when you look through them toward the light.
function makeRingMaterial(tex, center, R, brightness, opacity) {
    return new THREE.ShaderMaterial({
        uniforms: {
            map: { value: tex },
            uCenter: { value: center.clone() },
            uR: { value: R },
            uBright: { value: brightness },
            uOpacity: { value: opacity }
        },
        vertexShader: /* glsl */`
            varying vec2 vUv;
            varying vec3 vWorld;
            void main() {
                vUv = uv;
                vec4 w = modelMatrix * vec4(position, 1.0);
                vWorld = w.xyz;
                gl_Position = projectionMatrix * viewMatrix * w;
            }
        `,
        fragmentShader: /* glsl */`
            uniform sampler2D map;
            uniform vec3 uCenter;
            uniform float uR;
            uniform float uBright;
            uniform float uOpacity;
            varying vec2 vUv;
            varying vec3 vWorld;
            void main() {
                vec4 tex = texture2D(map, vec2(vUv.x, 0.5));
                // Works for strips with real alpha and for ones on a black background.
                float lum = dot(tex.rgb, vec3(0.299, 0.587, 0.114));
                float a = tex.a < 0.99 ? tex.a : smoothstep(0.0, 0.25, lum);

                vec3 L = normalize(-vWorld);
                vec3 oc = uCenter - vWorld;
                float t = dot(oc, L);
                float d = length(oc - L * t);
                float shadow = t > 0.0 ? smoothstep(uR * 0.97, uR * 1.03, d) : 1.0;

                vec3 V = normalize(cameraPosition - vWorld);
                float scatter = pow(max(dot(-V, L), 0.0), 6.0) * 0.8;

                vec3 col = tex.rgb * uBright * (0.10 + (0.95 + scatter) * shadow);
                gl_FragColor = vec4(col, a * uOpacity);
            }
        `,
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false
    });
}

function makeRingTexture(path) {
    const tex = textureLoader.load(path, fitTexture);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
}

/* ============================================================
   PLANETS
   ============================================================ */
const createEarth = () => {
    const grp = new THREE.Group();
    grp.position.set(200, 0, 0);
    const tilt = new THREE.Group();
    tilt.rotation.z = THREE.MathUtils.degToRad(23.4);
    grp.add(tilt);

    const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(10, SPHERE_SEG_W, SPHERE_SEG_H),
        new THREE.MeshStandardMaterial({
            map: loadTex(IMAGE_BASE + "Earth/2_no_clouds_4k.jpg"),
            bumpMap: loadTex(IMAGE_BASE + "Earth/elev_bump_4k.jpg", false),
            bumpScale: 0.5,
            roughness: 0.75,
            metalness: 0.05
        })
    );
    tilt.add(mesh);

    const clouds = new THREE.Mesh(
        new THREE.SphereGeometry(10.12, SPHERE_SEG_W, SPHERE_SEG_H),
        new THREE.MeshStandardMaterial({
            map: loadTex(IMAGE_BASE + "Earth/fair_clouds_4k.png"),
            transparent: true,
            opacity: 0.85,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            roughness: 1.0
        })
    );
    tilt.add(clouds);

    grp.add(makeAtmosphere(grp.position, 10, 11.6, 0x5c9bff, 1.35));

    scene.add(grp);
    planets.earth = { group: grp, mesh, clouds, r: 10 };
};

const createMars = () => {
    const grp = new THREE.Group();
    grp.position.set(400, 0, 0);
    const tilt = new THREE.Group();
    tilt.rotation.z = THREE.MathUtils.degToRad(25.2);
    grp.add(tilt);

    const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(8, SPHERE_SEG_W, SPHERE_SEG_H),
        new THREE.MeshStandardMaterial({
            map: loadTex(IMAGE_BASE + "Mars/Mars.png"),
            normalMap: loadTex(IMAGE_BASE + "Mars/MarsNormal.png", false),
            normalScale: new THREE.Vector2(1.5, 1.5),
            roughness: 0.85,
            metalness: 0.0
        })
    );
    tilt.add(mesh);

    grp.add(makeAtmosphere(grp.position, 8, 8.7, 0xff9a6b, 0.55));

    scene.add(grp);
    planets.mars = { group: grp, mesh, r: 8 };
};

const createJupiter = () => {
    const grp = new THREE.Group();
    grp.position.set(600, 0, 0);
    const tilt = new THREE.Group();
    tilt.rotation.z = THREE.MathUtils.degToRad(3.1);
    grp.add(tilt);

    const R = 18;
    const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(R, SPHERE_SEG_W, SPHERE_SEG_H),
        new THREE.MeshStandardMaterial({
            map: loadTex(IMAGE_BASE + "Jupiter/realj2k.jpg"),
            bumpMap: loadTex(IMAGE_BASE + "Jupiter/jupiter-hubble-2015-bump.jpg", false),
            roughness: 0.6,
            metalness: 0.0
        })
    );
    tilt.add(mesh);

    const clouds = new THREE.Mesh(
        new THREE.SphereGeometry(R + 0.1, SPHERE_SEG_W, SPHERE_SEG_H),
        new THREE.MeshStandardMaterial({
            map: loadTex(IMAGE_BASE + "Jupiter/jupiterclouds.png"),
            transparent: true,
            opacity: 0.55,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            roughness: 1.0,
            metalness: 0.0
        })
    );
    tilt.add(clouds);

    const ring = new THREE.Mesh(
        makeRingGeometry(R * 1.3, R * 3.2),
        makeRingMaterial(makeRingTexture(IMAGE_BASE + "Jupiter/JupiterRings.png"), grp.position, R, 1.35, 1.0)
    );
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 1;
    tilt.add(ring);

    grp.add(makeAtmosphere(grp.position, R, R * 1.07, 0xffd9a8, 0.5));

    scene.add(grp);
    planets.jupiter = { group: grp, mesh, clouds, r: R };
};

const createSaturn = () => {
    const grp = new THREE.Group();
    grp.position.set(800, 0, 0);
    // Real obliquity, leaned toward the camera so the rings open up.
    const tilt = new THREE.Group();
    tilt.rotation.set(THREE.MathUtils.degToRad(18), 0, THREE.MathUtils.degToRad(20));
    grp.add(tilt);

    const R = 16;
    const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(R, SPHERE_SEG_W, SPHERE_SEG_H),
        new THREE.MeshStandardMaterial({
            map: loadTex(IMAGE_BASE + "Saturn/th_saturn.png"),
            bumpMap: loadTex(IMAGE_BASE + "Saturn/th_saturnbump.png", false),
            bumpScale: 0.2,
            roughness: 0.65
        })
    );
    tilt.add(mesh);

    const ring = new THREE.Mesh(
        makeRingGeometry(22, 42),
        makeRingMaterial(makeRingTexture(IMAGE_BASE + "Saturn/t00fri_gh_saturnrings.png"), grp.position, R, 1.15, 0.92)
    );
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 1;
    tilt.add(ring);

    grp.add(makeAtmosphere(grp.position, R, R * 1.06, 0xffe2a8, 0.45));

    scene.add(grp);
    planets.saturn = { group: grp, mesh, r: R };
};

/* ============================================================
   STARFIELD
   ============================================================ */
let starField;
function createStars() {
    const starCount = IS_MOBILE ? 4000 : 9000;
    const starPos = new Float32Array(starCount * 3);
    const starColors = new Float32Array(starCount * 3);
    const starSizes = new Float32Array(starCount);
    const starPhases = new Float32Array(starCount);

    // Stellar temperatures, weighted toward white/yellow.
    const palette = [
        [new THREE.Color(0xcad7ff), 0.10],
        [new THREE.Color(0xf4f6ff), 0.35],
        [new THREE.Color(0xfff4e8), 0.30],
        [new THREE.Color(0xffd9a8), 0.17],
        [new THREE.Color(0xffbb7a), 0.08]
    ];
    const pick = () => {
        let r = Math.random();
        for (const [col, w] of palette) { if ((r -= w) <= 0) return col; }
        return palette[1][0];
    };

    for (let i = 0; i < starCount; i++) {
        const r = 600 + Math.random() * 1400;
        const theta = 2 * Math.PI * Math.random();
        const phi = Math.acos(2 * Math.random() - 1);
        starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        starPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        starPos[i * 3 + 2] = r * Math.cos(phi);

        const hero = Math.random() < 0.025;
        const color = pick();
        const brightness = hero ? 1.6 + Math.random() * 0.8 : 0.3 + Math.pow(Math.random(), 2) * 0.7;
        starColors[i * 3] = color.r * brightness;
        starColors[i * 3 + 1] = color.g * brightness;
        starColors[i * 3 + 2] = color.b * brightness;

        starSizes[i] = hero ? 16 + Math.random() * 10 : 5 + Math.random() * 9;
        starPhases[i] = Math.random() * Math.PI * 2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(starColors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(starSizes, 1));
    geo.setAttribute('phase', new THREE.BufferAttribute(starPhases, 1));

    const mat = new THREE.ShaderMaterial({
        uniforms: starUniforms,
        vertexColors: true,
        vertexShader: /* glsl */`
            attribute float size;
            attribute float phase;
            varying vec3 vColor;
            varying float vPhase;
            void main() {
                vColor = color;
                vPhase = phase;
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = max(size * (300.0 / -mv.z), 1.5);
                gl_Position = projectionMatrix * mv;
            }
        `,
        fragmentShader: /* glsl */`
            uniform float time;
            uniform float introProgress;
            varying vec3 vColor;
            varying float vPhase;
            void main() {
                float d = length(gl_PointCoord - 0.5) * 2.0;
                if (d > 1.0) discard;
                // Sharp core with a faint halo — reads as a point of light, not a disc.
                float core = exp(-d * d * 16.0);
                float halo = exp(-d * d * 4.0) * 0.22;
                float a = (core + halo) * (1.0 - smoothstep(0.75, 1.0, d));

                float speed = 0.6 + fract(vPhase * 7.13) * 1.8;
                float twinkle = 0.72 + 0.28 * sin(time * speed + vPhase * 5.0);

                float randOffset = fract(sin(vPhase * 123.456) * 789.123);
                float introAlpha = smoothstep(randOffset * 0.8, randOffset * 0.8 + 0.2, introProgress);

                gl_FragColor = vec4(vColor, a * twinkle * introAlpha);
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });

    starField = new THREE.Points(geo, mat);
    scene.add(starField);
}

/* ============================================================
   CAMERA VIEWS + CINEMATIC FLIGHT
   ============================================================ */
const views = {
    overview: { pos: new THREE.Vector3(0, 20, 90),     lookAt: new THREE.Vector3(0, 0, 0) },
    earth:    { pos: new THREE.Vector3(185, 5, 35),    lookAt: new THREE.Vector3(200, 0, 15) },
    mars:     { pos: new THREE.Vector3(375, 5, 20),    lookAt: new THREE.Vector3(400, 0, 0) },
    jupiter:  { pos: new THREE.Vector3(605, 10, 65),   lookAt: new THREE.Vector3(600, 0, 0) },
    saturn:   { pos: new THREE.Vector3(770, 10, 40),   lookAt: new THREE.Vector3(800, 0, 0) }
};
const VIEW_ORDER = ['overview', 'earth', 'mars', 'jupiter', 'saturn'];

const BASE_FOV = camera.fov;

const camPos = new THREE.Vector3().copy(camera.position);
const camLook = new THREE.Vector3().copy(introLookAt);
const camVel = new THREE.Vector3();
const prevPos = new THREE.Vector3().copy(camPos);
let warp = 0;
let bank = 0;
let orbitPhase = 0;
let currentViewKey = 'overview';
let flight = null;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

function easeFlight(t) {
    return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;
}
function smoothstep01(e0, e1, x) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

function flyTo(key) {
    const view = views[key];
    if (!view || key === currentViewKey) return;

    const fromIdx = VIEW_ORDER.indexOf(currentViewKey);
    const toIdx = VIEW_ORDER.indexOf(key);
    currentViewKey = key;

    const from = camPos.clone();
    const dist = from.distanceTo(view.pos);

    const dur = REDUCED_MOTION ? 0.9 : THREE.MathUtils.clamp(1.15 + dist / 280, 1.3, 3.4);
    const arcH = THREE.MathUtils.clamp(dist * 0.22, 14, 95);

    _a.subVectors(view.pos, from);
    const flatDir = new THREE.Vector3(_a.x, 0, _a.z);
    if (flatDir.lengthSq() < 1e-6) flatDir.set(0, 0, 1);
    flatDir.normalize();

    const side = new THREE.Vector3(-flatDir.z, 0, flatDir.x);
    const weaveSign = (Math.min(fromIdx, toIdx) % 2 === 0 ? 1 : -1) * (toIdx > fromIdx ? 1 : -1);
    const weave = dist * 0.14;

    const p1 = from.clone()
        .addScaledVector(camVel, 0.18)
        .addScaledVector(flatDir, dist * 0.12)
        .addScaledVector(WORLD_UP, arcH * 0.35);

    const mid = from.clone().lerp(view.pos, 0.5)
        .addScaledVector(WORLD_UP, arcH)
        .addScaledVector(side, weave * weaveSign);

    _b.subVectors(view.pos, view.lookAt).normalize();
    const approach = view.pos.clone()
        .addScaledVector(_b, dist * 0.10)
        .addScaledVector(WORLD_UP, arcH * 0.30)
        .addScaledVector(side, weave * weaveSign * 0.25);

    const posCurve = new THREE.CatmullRomCurve3(
        [from, p1, mid, approach, view.pos.clone()], false, 'centripetal'
    );

    const lookFrom = camLook.clone();
    const lookMid = lookFrom.clone().lerp(view.lookAt, 0.55)
        .addScaledVector(flatDir, dist * 0.20)
        .addScaledVector(WORLD_UP, -arcH * 0.22);
    const lookCurve = new THREE.CatmullRomCurve3(
        [lookFrom, lookMid, view.lookAt.clone()], false, 'centripetal'
    );

    posCurve.getLengths(48);
    lookCurve.getLengths(24);

    flight = { posCurve, lookCurve, t: 0, dur, bankDir: -weaveSign };
    orbitPhase = 0;
}

/* --- Drag to look around -------------------------------------------------
   The scene no longer follows the mouse. It only moves while you press and
   drag on empty background (not on text, cards, links or the nav). On
   release it eases back to the framed view. Touch is left alone so swiping
   still scrolls the page on phones and tablets. */
let dragX = 0, dragY = 0;          // target offset, -1..1
let parX = 0, parY = 0;            // smoothed offset applied to the camera
let dragging = false;
let dragPointerId = null;

function isBackground(el) {
    return el === canvas || el === document.body || el === document.documentElement ||
        (el instanceof Element && el.matches('main, section'));
}

window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.button !== 0 || isIntroPlaying) return;
    if (!isBackground(e.target)) return;
    dragging = true;
    dragPointerId = e.pointerId;
    document.documentElement.classList.add('is-dragging');
    e.preventDefault();              // no text selection while dragging
});

window.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragPointerId) return;
    dragX = THREE.MathUtils.clamp(dragX + (e.movementX / window.innerWidth) * 2.4, -1, 1);
    dragY = THREE.MathUtils.clamp(dragY + (e.movementY / window.innerHeight) * 2.4, -1, 1);
}, { passive: true });

function endDrag(e) {
    if (!dragging || (e && e.pointerId !== dragPointerId)) return;
    dragging = false;
    dragPointerId = null;
    document.documentElement.classList.remove('is-dragging');
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', () => endDrag());

/* ============================================================
   WARP STREAKS — simple lines of light that stretch along the
   direction of travel while the camera is moving.
   ============================================================ */
let warpField = null;
const warpUniforms = {
    uCam: { value: new THREE.Vector3() },
    uDir: { value: new THREE.Vector3(0, 0, 1) },
    uLen: { value: 0 },
    uBox: { value: 300 },
    uOpacity: { value: 0 }
};

function createWarpField() {
    const COUNT = IS_MOBILE ? 350 : 800;
    const BOX = warpUniforms.uBox.value;

    // Two vertices per streak: aEnd 0 = head, 1 = tail.
    const positions = new Float32Array(COUNT * 2 * 3);
    const ends = new Float32Array(COUNT * 2);
    const seeds = new Float32Array(COUNT * 2);

    for (let i = 0; i < COUNT; i++) {
        const x = Math.random() * BOX, y = Math.random() * BOX, z = Math.random() * BOX;
        const seed = Math.random();
        for (let k = 0; k < 2; k++) {
            const j = i * 2 + k;
            positions[j * 3] = x;
            positions[j * 3 + 1] = y;
            positions[j * 3 + 2] = z;
            ends[j] = k;
            seeds[j] = seed;
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

    const mat = new THREE.ShaderMaterial({
        uniforms: warpUniforms,
        vertexShader: /* glsl */`
            attribute float aEnd;
            attribute float aSeed;
            uniform vec3 uCam;
            uniform vec3 uDir;
            uniform float uLen;
            uniform float uBox;
            varying float vAlpha;
            void main() {
                // Wrap each streak into a box around the camera so the field never runs out.
                vec3 rel = mod(position - uCam, uBox) - uBox * 0.5;
                vec3 p = uCam + rel - uDir * uLen * (0.4 + aSeed * 0.8) * aEnd;

                float d = length(rel);
                float fade = smoothstep(uBox * 0.05, uBox * 0.15, d) * (1.0 - smoothstep(uBox * 0.3, uBox * 0.5, d));
                vAlpha = fade * (1.0 - aEnd) * (0.4 + 0.6 * aSeed);

                gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
            }
        `,
        fragmentShader: /* glsl */`
            uniform float uOpacity;
            varying float vAlpha;
            void main() {
                gl_FragColor = vec4(vec3(1.0) * vAlpha * uOpacity, 1.0);
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });

    warpField = new THREE.LineSegments(geo, mat);
    warpField.frustumCulled = false;
    warpField.visible = false;
    warpField.renderOrder = 4;
    scene.add(warpField);
}

/* ============================================================
   SCROLL → SECTION → FLIGHT
   ============================================================ */
function initScroll() {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            const id = entry.target.id;
            document.querySelectorAll('.nav-links a').forEach(a => {
                a.classList.toggle('active', a.getAttribute('href') === '#' + id);
            });
            const planetKey = entry.target.dataset.planet;
            if (planetKey && views[planetKey]) {
                flyTo(planetKey);
                document.querySelectorAll('section').forEach(s => s.classList.remove('active'));
                entry.target.classList.add('active');
            }
        });
    }, { root: null, rootMargin: '-60% 0px -60% 0px', threshold: 0 });

    document.querySelectorAll('section').forEach(section => observer.observe(section));
}

/* ============================================================
   RENDER LOOP
   ============================================================ */
const clock = new THREE.Clock();
const planetHorizon = document.getElementById('planet-horizon');

let scrollYCached = window.scrollY;
let viewportH = window.innerHeight;
let lastHorizonScroll = -1;
window.addEventListener('scroll', () => { scrollYCached = window.scrollY; }, { passive: true });

function animate() {
    requestAnimationFrame(animate);

    const dt = Math.min(clock.getDelta(), 0.1);

    const motion = REDUCED_MOTION ? 0.25 : 1;

    // Planet spin
    if (planets.earth) {
        planets.earth.mesh.rotation.y += 0.05 * dt * motion;
        planets.earth.clouds.rotation.y += 0.065 * dt * motion;
    }
    if (planets.mars) planets.mars.mesh.rotation.y += 0.04 * dt * motion;
    if (planets.jupiter) {
        planets.jupiter.mesh.rotation.y += 0.03 * dt * motion;
        planets.jupiter.clouds.rotation.y += 0.036 * dt * motion;
    }
    if (planets.saturn) planets.saturn.mesh.rotation.y += 0.028 * dt * motion;

    if (starField) starField.rotation.y -= 0.004 * dt * motion;
    starUniforms.time.value += dt * motion;
    sunUniforms.uTime.value += dt * motion;

    // Horizon flare parallax
    if (planetHorizon && !isIntroPlaying && scrollYCached !== lastHorizonScroll) {
        lastHorizonScroll = scrollYCached;
        const maxTranslateY = viewportH * 0.6;
        const maxScroll = maxTranslateY / 0.15;
        const t = Math.min(scrollYCached, maxScroll) / maxScroll;
        const eased = 1 - Math.pow(1 - t, 20);
        planetHorizon.style.transform = `translateY(${eased * maxTranslateY}px) scale(${1 + eased * 0.35})`;
    }

    if (!isIntroPlaying) {
        prevPos.copy(camPos);

        if (flight) {
            flight.t += dt / flight.dur;
            const clamped = Math.min(1, flight.t);
            const e = easeFlight(clamped);
            flight.posCurve.getPointAt(e, camPos);
            flight.lookCurve.getPointAt(e, camLook);

            const turn = Math.sin(clamped * Math.PI);
            bank += (flight.bankDir * 0.11 * turn * motion - bank) * (1 - Math.exp(-5 * dt));
            if (flight.t >= 1) flight = null;
        } else {
            const view = views[currentViewKey];
            orbitPhase += dt * 0.18 * motion;
            _a.subVectors(view.pos, view.lookAt)
                .applyAxisAngle(WORLD_UP, Math.sin(orbitPhase) * 0.045)
                .add(view.lookAt);
            _a.y += Math.sin(orbitPhase * 0.7) * 1.2;
            const settle = 1 - Math.exp(-1.6 * dt);
            camPos.lerp(_a, settle);
            camLook.lerp(view.lookAt, settle);
            bank += (0 - bank) * (1 - Math.exp(-3 * dt));
        }

        camVel.subVectors(camPos, prevPos).divideScalar(Math.max(dt, 1e-4));
        const speed = camVel.length();
        const targetWarp = REDUCED_MOTION ? 0 : smoothstep01(30, 380, speed);
        warp += (targetWarp - warp) * (1 - Math.exp(-(targetWarp > warp ? 7.5 : 2.2) * dt));

        _fwd.subVectors(camLook, camPos).normalize();
        _right.crossVectors(_fwd, WORLD_UP).normalize();

        const parAmt = (1 - warp) * (1 - warp);   // user-driven, so not scaled down for reduced motion
        // Released: drift back to the composed shot.
        if (!dragging) {
            const back = Math.exp(-2.2 * dt);
            dragX *= back;
            dragY *= back;
        }
        parX += (dragX - parX) * (1 - Math.exp(-8 * dt));
        parY += (dragY - parY) * (1 - Math.exp(-8 * dt));

        camera.position.copy(camPos)
            .addScaledVector(_right, -parX * 7 * parAmt)
            .addScaledVector(WORLD_UP, parY * 4.5 * parAmt);

        _camUp.copy(WORLD_UP).applyAxisAngle(_fwd, bank);
        camera.up.copy(_camUp);
        camera.lookAt(camLook);

        const fov = BASE_FOV + warp * 8;
        if (Math.abs(camera.fov - fov) > 0.02) {
            camera.fov = fov;
            camera.updateProjectionMatrix();
        }

        if (warpField) {
            warpField.visible = warp > 0.01;
            if (warpField.visible) {
                warpUniforms.uCam.value.copy(camera.position);
                if (speed > 1) warpUniforms.uDir.value.copy(camVel).divideScalar(speed);
                warpUniforms.uLen.value = 4 + warp * 90;
                warpUniforms.uOpacity.value = warp * 0.45;
            }
        }
    }

    composer.render(dt);
}

/* ============================================================
   RESIZE
   ============================================================ */
function setCanvasHeight() {
    const w = window.innerWidth;
    const h = window.innerHeight + EXTRA_HEIGHT;
    viewportH = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
}

let windowWidth = window.innerWidth;
let windowHeight = window.innerHeight;
let heightUnlocked = false;
let resizeScheduled = false;

function scheduleResize() {
    if (resizeScheduled) return;
    resizeScheduled = true;
    requestAnimationFrame(() => {
        resizeScheduled = false;
        setCanvasHeight();
    });
}

window.addEventListener('resize', () => {
    const newWidth = window.innerWidth;
    const newHeight = window.innerHeight;
    const heightDelta = Math.abs(newHeight - windowHeight);

    if (newWidth !== windowWidth) {
        windowWidth = newWidth;
        windowHeight = newHeight;
        scheduleResize();
        heightUnlocked = true;
        return;
    }
    if (!heightUnlocked) {
        if (heightDelta < EXTRA_HEIGHT) return;
        heightUnlocked = true;
    }
    windowHeight = newHeight;
    scheduleResize();
});

window.addEventListener('orientationchange', () => {
    windowWidth = window.innerWidth;
    windowHeight = window.innerHeight;
    scheduleResize();
});

/* ============================================================
   BOOT
   ============================================================ */
function initSystem() {
    buildSky();
    createSun();
    createStars();
    createWarpField();
    createEarth();
    createMars();
    createJupiter();
    createSaturn();

    renderer.compile(scene, camera);
    animate();
}

initSystem();
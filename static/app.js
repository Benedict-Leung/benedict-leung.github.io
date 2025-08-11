import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// =============================
// Utilities (helpers first)
// =============================
// Note: These reference globals like MAX_ANISO, textureLoader, etc.
// They are only called after those variables are defined below.

// Common constants
const TAU = Math.PI * 2;
// Baseline pixel size for overlay typography/pills (do NOT scale beyond this)
const BASE_OVERLAY_PX = 128;

// Idle scheduling helper (falls back to setTimeout)
function __idle(fn, timeout = 0) {
    const ric = typeof requestIdleCallback !== "undefined" ? requestIdleCallback : cb => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 16 }), timeout);
    ric(
        () => {
            try {
                fn();
            } catch (e) {}
        },
        { timeout: 200 }
    );
}

// Math/color helpers
function toRGBA(n, a = 255) {
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}
function lerp(a, b, t) {
    return a + (b - a) * t;
}
function lerpColor(c1, c2, t) {
    const r = Math.round(lerp((c1 >> 16) & 255, (c2 >> 16) & 255, t));
    const g = Math.round(lerp((c1 >> 8) & 255, (c2 >> 8) & 255, t));
    const b = Math.round(lerp(c1 & 255, c2 & 255, t));
    return (r << 16) | (g << 8) | b;
}
// Simple easing for animations
function easeOutCubic(t) {
    t = Math.min(1, Math.max(0, t));
    return 1 - Math.pow(1 - t, 3);
}
// Build a direction on an orbit plane from an angle and its orthonormal basis
function dirFromAngle(angle, right, up) {
    const c = Math.cos(angle),
        s = Math.sin(angle);
    return new THREE.Vector3().addScaledVector(right, c).addScaledVector(up, s).normalize();
}
// Shortest signed angle difference b - a in [-PI, PI]
function angleDiffShortest(a, b) {
    const TAU = Math.PI * 2;
    return ((((b - a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}
// Cubic Hermite between 0 and 1 with endpoint slopes m0 at 0 and m1 at 1
function hermite01(t, m0, m1) {
    t = Math.min(1, Math.max(0, t));
    const t2 = t * t;
    const t3 = t2 * t;
    // Interpolate from 0 to 1 with specified endpoint tangents
    return (2 * t3 - 3 * t2 + 1) * 0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * 1 + (t3 - t2) * m1;
}

// Noise helpers
function hash3(xi, yi, zi, seed) {
    let h = xi * 374761393 + yi * 668265263 + zi * 2147483647 + seed * 144269;
    h = (h ^ (h >>> 13)) * 1274126177;
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
}
function valueNoise3(x, y, z, seed) {
    const xi = Math.floor(x),
        yi = Math.floor(y),
        zi = Math.floor(z);
    const xf = x - xi,
        yf = y - yi,
        zf = z - zi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const w = zf * zf * (3 - 2 * zf);
    const c000 = hash3(xi, yi, zi, seed);
    const c100 = hash3(xi + 1, yi, zi, seed);
    const c010 = hash3(xi, yi + 1, zi, seed);
    const c110 = hash3(xi + 1, yi + 1, zi, seed);
    const c001 = hash3(xi, yi, zi + 1, seed);
    const c101 = hash3(xi + 1, yi, zi + 1, seed);
    const c011 = hash3(xi, yi + 1, zi + 1, seed);
    const c111 = hash3(xi + 1, yi + 1, zi + 1, seed);
    const x00 = c000 + (c100 - c000) * u;
    const x10 = c010 + (c110 - c010) * u;
    const x01 = c001 + (c101 - c001) * u;
    const x11 = c011 + (c111 - c011) * u;
    const y0 = x00 + (x10 - x00) * v;
    const y1 = x01 + (x11 - x01) * v;
    return y0 + (y1 - y0) * w;
}

// Fractal noise on the sphere (periodic)
function fbmPeriodic3D(u, v, seed, scaleU = 1, scaleV = 1, octaves = 5, lac = 2, gain = 0.5) {
    const t = u * TAU;
    const phi = v * Math.PI;
    const sinPhi = Math.sin(phi);
    const sx = Math.cos(t) * sinPhi;
    const sy = Math.sin(t) * sinPhi;
    const sz = Math.cos(phi);
    const baseScale = (scaleU + scaleV) * 0.5;
    let amp = 1,
        freq = 1,
        sum = 0,
        norm = 0;
    for (let i = 0; i < octaves; i++) {
        sum += amp * valueNoise3(sx * baseScale * freq + i * 0.73, sy * baseScale * freq + i * 1.11, sz * baseScale * freq + i * 0.57, seed + i * 101);
        norm += amp;
        amp *= gain;
        freq *= lac;
    }
    return sum / norm;
}

// Texture/canvas helpers
function makeCanvasTexture(w, h, draw, colorSpace = THREE.SRGBColorSpace) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(w, h);
    draw(img.data, w, h);
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = MAX_ANISO;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    tex.colorSpace = colorSpace;
    return tex;
}

// Approximate a height (bump) map from a tangent-space normal map by integrating gradients.
function normalToHeightTexture(normalTex, strength = 1.0) {
    try {
        const img = normalTex?.image;
        const W = img?.width || 0,
            H = img?.height || 0;
        if (!W || !H) return null;
        const c = document.createElement("canvas");
        c.width = W;
        c.height = H;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, W, H);
        const src = ctx.getImageData(0, 0, W, H);
        const pGrad = new Float32Array(W * H);
        const qGrad = new Float32Array(W * H);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                const nx = (src.data[i] / 255) * 2 - 1;
                const ny = (src.data[i + 1] / 255) * 2 - 1;
                const nz = Math.max(1e-3, (src.data[i + 2] / 255) * 2 - 1);
                pGrad[y * W + x] = (nx / nz) * strength;
                qGrad[y * W + x] = (ny / nz) * strength;
            }
        }
        const Hx = new Float32Array(W * H);
        const Hy = new Float32Array(W * H);
        for (let y = 0; y < H; y++) {
            let h = 0;
            for (let x = 0; x < W; x++) {
                if (x > 0) h += pGrad[y * W + x];
                Hx[y * W + x] = h;
            }
        }
        for (let x = 0; x < W; x++) {
            let h = 0;
            for (let y = 0; y < H; y++) {
                if (y > 0) h += qGrad[y * W + x];
                Hy[y * W + x] = h;
            }
        }
        const out = ctx.createImageData(W, H);
        let minV = Infinity,
            maxV = -Infinity;
        for (let i = 0; i < W * H; i++) {
            const v = 0.5 * (Hx[i] + Hy[i]);
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
        }
        const range = Math.max(1e-6, maxV - minV);
        for (let i = 0; i < W * H; i++) {
            const t = (0.5 * (Hx[i] + Hy[i]) - minV) / range;
            const g = Math.round(Math.min(255, Math.max(0, t * 255)));
            const j = i * 4;
            out.data[j] = g;
            out.data[j + 1] = g;
            out.data[j + 2] = g;
            out.data[j + 3] = 255;
        }
        ctx.putImageData(out, 0, 0);
        const tex = new THREE.CanvasTexture(c);
        tex.anisotropy = MAX_ANISO;
        tex.needsUpdate = true;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.colorSpace = THREE.LinearSRGBColorSpace;
        return tex;
    } catch {
        return null;
    }
}

// Kepler/orbit helpers
function solveKeplerE(M, e, iters = 6) {
    // Normalize M into [-PI, PI]
    let m = Math.atan2(Math.sin(M), Math.cos(M));
    // Initial guess
    let E = e < 0.8 ? m : Math.PI;
    for (let k = 0; k < iters; k++) {
        const f = E - e * Math.sin(E) - m;
        const fp = 1 - e * Math.cos(E);
        E = E - f / fp;
    }
    return E;
}
function trueAnomalyFromE(E, e) {
    const s = Math.sqrt(1 + e);
    const t = Math.sqrt(1 - e);
    const tanHalfNu = (s / t) * Math.tan(E / 2);
    return 2 * Math.atan(tanHalfNu);
}
function elementsToWorldPosition(a, e, incDeg, OmegaDeg, omegaDeg, nu) {
    // Radius from true anomaly
    const r = (a * (1 - e * e)) / (1 + e * Math.cos(nu));
    const u = omegaDeg * (Math.PI / 180) + nu; // argument of latitude
    const cosO = Math.cos(OmegaDeg * (Math.PI / 180));
    const sinO = Math.sin(OmegaDeg * (Math.PI / 180));
    const cosi = Math.cos(incDeg * (Math.PI / 180));
    const sini = Math.sin(incDeg * (Math.PI / 180));
    const cu = Math.cos(u);
    const su = Math.sin(u);
    // Ecliptic coordinates (x_ecl,y_ecl,z_ecl)
    const x = r * (cosO * cu - sinO * su * cosi);
    const y = r * (sinO * cu + cosO * su * cosi);
    const z = r * (su * sini);
    // Map ecliptic to our world axes: worldX=x, worldZ=y (in-plane), worldY=z (out-of-plane)
    return new THREE.Vector3(x, z, y);
}

// Fast texture loader using ImageBitmap to reduce decode/upload jank
function loadTextureFast(url, { color = true, wrapRepeat = true, preferMipmaps = true } = {}) {
    return new Promise(resolve => {
        bitmapLoader.load(
            url,
            bitmap => {
                try {
                    const tex = new THREE.Texture(bitmap);
                    if (wrapRepeat) {
                        tex.wrapS = THREE.RepeatWrapping;
                        tex.wrapT = THREE.RepeatWrapping;
                    } else {
                        tex.wrapS = THREE.RepeatWrapping;
                        tex.wrapT = THREE.ClampToEdgeWrapping;
                    }
                    tex.anisotropy = MAX_ANISO;
                    // Tiered mipmaps: disable on low-tier or very large images
                    const large = bitmap.width >= 2048 || bitmap.height >= 2048;
                    const useMips = preferMipmaps && !__isLowTier && !large;
                    tex.generateMipmaps = !!useMips;
                    tex.minFilter = useMips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
                    tex.magFilter = THREE.LinearFilter;
                    tex.needsUpdate = true;
                    tex.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
                    resolve(tex);
                } catch {
                    resolve(null);
                }
            },
            undefined,
            () => {
                // Fallback: TextureLoader
                try {
                    const t = textureLoader.load(
                        url,
                        tex => {
                            if (wrapRepeat) {
                                tex.wrapS = THREE.RepeatWrapping;
                                tex.wrapT = THREE.RepeatWrapping;
                            } else {
                                tex.wrapS = THREE.RepeatWrapping;
                                tex.wrapT = THREE.ClampToEdgeWrapping;
                            }
                            tex.anisotropy = MAX_ANISO;
                            tex.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
                            tex.needsUpdate = true;
                            resolve(tex);
                        },
                        undefined,
                        () => resolve(null)
                    );
                } catch {
                    resolve(null);
                }
            }
        );
    });
}

function generateSunTexture(w, h) {
    return makeCanvasTexture(w, h, (data, W, H) => {
        for (let y = 0; y < H; y++) {
            const v = y / (H - 1);
            for (let x = 0; x < W; x++) {
                const u = x / (W - 1);
                const n1 = fbmPeriodic3D(u, v, 9001, 6.0, 4.5, 5, 2.2, 0.55);
                const n2 = fbmPeriodic3D(u + n1 * 0.15, v - n1 * 0.1, 9031, 10.0, 8.0, 4, 2.1, 0.5);
                let t = Math.min(1, Math.max(0, n1 * 0.7 + n2 * 0.5));
                const cA = 0x8a2a00,
                    cB = 0xff7a00,
                    cC = 0xffe066;
                const mid = lerpColor(cA, cB, t);
                const col = lerpColor(mid, cC, t * t * 0.7);
                const i = (y * W + x) * 4;
                const [r, g, b, a] = toRGBA(col);
                data[i] = r;
                data[i + 1] = g;
                data[i + 2] = b;
                data[i + 3] = a;
            }
        }
    });
}

// Performance helpers: low-mode toggles and dynamic pixel ratio
function __setRendererPixelRatio(pr) {
    const clamped = Math.max(__PR_MIN, Math.min(__PR_MAX, pr));
    if (Math.abs(clamped - renderer.getPixelRatio?.()) > 0.01) {
        renderer.setPixelRatio(clamped);
        onResize();
    }
}

function __enterLowMode() {
    planets.forEach(p => {
        if (!p || !p.mesh) return;
        const mat = p.mesh.material;
        if (mat) {
            if (mat.displacementMap && !mat.userData?._savedDisp) {
                mat.userData = mat.userData || {};
                mat.userData._savedDisp = mat.displacementMap;
                mat.displacementMap = null;
                mat.needsUpdate = true;
            }
            if (mat.bumpMap && !mat.userData?._savedBump) {
                mat.userData = mat.userData || {};
                mat.userData._savedBump = mat.bumpMap;
                // keep bumpMap but reduce influence to cut normal work
                mat.bumpScale = (mat.bumpScale || 1) * 0.5;
            }
        }
        if (p.clouds && p.clouds.visible) {
            if (!p.clouds.userData) p.clouds.userData = {};
            if (!p.clouds.userData._savedVis) p.clouds.userData._savedVis = true;
            p.clouds.visible = false;
        }
    });
}

function __exitLowMode() {
    planets.forEach(p => {
        if (!p || !p.mesh) return;
        const mat = p.mesh.material;
        if (mat && mat.userData) {
            if (mat.userData._savedDisp) {
                mat.displacementMap = mat.userData._savedDisp;
                mat.userData._savedDisp = null;
                mat.needsUpdate = true;
            }
            if (mat.userData._savedBump) {
                mat.bumpMap = mat.userData._savedBump;
                mat.userData._savedBump = null;
                mat.bumpScale = (mat.bumpScale || 1) * 2.0; // restore approx
            }
        }
        if (p.clouds && p.clouds.userData?._savedVis) {
            p.clouds.visible = true;
            p.clouds.userData._savedVis = null;
        }
    });
}

// =============================
// Variables and setup (after utilities)
// =============================
// Renderer + scene
const canvas = document.getElementById("bg");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.autoClear = true;
renderer.setClearColor(0x000000, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.8;
renderer.shadowMap.enabled = false;

// Perf heuristics decided at startup
const __PR = Math.min(window.devicePixelRatio || 1, 2);
const __isSmallScreen = Math.min(window.innerWidth, window.innerHeight) < 900;
const __isLowTier = __PR <= 1.25 || __isSmallScreen;

// Dynamic Resolution Scaling (DRS) + Low-FPS adaptive mode state
const __PR_MAX = __PR;
const __PR_MIN = __isLowTier ? 0.66 : 0.8;
let __targetPR = __PR_MAX;
let __fpsEMA = 60; // smoothed fps estimate
let __lastDRSChange = 0;
let __lowMode = false;
let __lastLowModeToggleAt = 0;

const scene = new THREE.Scene();
// Track texture load promises to gate animation start
const __loadPromises = [];
// Freeze planet orbital motion until initial textures finish loading
let __orbitsFrozen = true;

// Cameras & controls
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 5000);
camera.position.set(0, 800, 0);
camera.lookAt(0, 0, 0);
// Ensure camera sees both default layer 0 and our Mars-only lighting layer 1
try {
    camera.layers.enable(1);
} catch (e) {}

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.rotateSpeed = 0.6;
controls.zoomSpeed = 0.9;
controls.target.set(0, 0, 0);
controls.update();

// follow tuning: temporarily disable damping while following to avoid micro jitter
let __savedDampingFactor = controls.dampingFactor;
let __followDampingAdjusted = false;
function __startFollowingMode() {
    if (!__followDampingAdjusted) {
        __savedDampingFactor = controls.dampingFactor;
        controls.enableDamping = false;
        __followDampingAdjusted = true;
    }
}
function __stopFollowingMode() {
    if (__followDampingAdjusted) {
        controls.enableDamping = true;
        controls.dampingFactor = __savedDampingFactor;
        __followDampingAdjusted = false;
    }
}

// Loading manager to track progress for the preloader ring
const __loadingManager = new THREE.LoadingManager();
// DOM elements for progress UI
const __preText = typeof document !== "undefined" ? document.getElementById("preloader-text") : null;
const __preRing = typeof document !== "undefined" ? document.getElementById("preloader-ring-fg") : null; // may be an SVG root now
// Preloader mode detection and setup
let __ringCirc = 0;
let __isMoonPreloader = false;
if (__preRing) {
    // If the element has an 'r' attribute, it's the old circle ring; otherwise treat as moon SVG root
    const rAttr = __preRing.getAttribute && __preRing.getAttribute("r");
    if (rAttr) {
        const r = parseFloat(rAttr || "54");
        __ringCirc = 2 * Math.PI * r;
        __preRing.style.strokeDasharray = `${__ringCirc}`;
        __preRing.style.strokeDashoffset = `${__ringCirc}`;
    } else {
        __isMoonPreloader = true;
        // Initialize progress variable to new moon
        try {
            __preRing.style.setProperty("--p", "0");
        } catch {}
    }
}

// Smooth progress updates (phase + text)
let __preProg = { v: 0 };
__loadingManager.onProgress = (url, loaded, total) => {
    const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
    const next = Math.max(0, Math.min(100, pct));
    // Animate numeric value and visual state over fixed 1s
    const dur = 1.0;
    if (typeof gsap !== "undefined") {
        gsap.to(__preProg, {
            v: next,
            duration: dur,
            ease: "power2.out",
            onUpdate: () => {
                const val = Math.round(__preProg.v);
                if (__preText) __preText.textContent = `${val}%`;
                if (__preRing) {
                    if (__isMoonPreloader) {
                        __preRing.style.setProperty("--p", String((__preProg.v || 0) / 100));
                        __preRing.setAttribute?.("aria-valuenow", String(val));
                    } else if (__ringCirc > 0) {
                        const offset = __ringCirc * (1 - (__preProg.v || 0) / 100);
                        __preRing.style.strokeDashoffset = `${offset}`;
                        (__preRing.parentElement || __preRing).setAttribute?.("aria-valuenow", String(val));
                    }
                }
            },
            overwrite: true,
        });
    } else {
        // Fallback: immediate update
        __preProg.v = next;
        if (__preText) __preText.textContent = `${next}%`;
        if (__preRing) {
            if (__isMoonPreloader) {
                __preRing.style.setProperty("--p", String(next / 100));
                __preRing.setAttribute?.("aria-valuenow", String(next));
            } else if (__ringCirc > 0) {
                const offset = __ringCirc * (1 - next / 100);
                __preRing.style.strokeDashoffset = `${offset}`;
                (__preRing.parentElement || __preRing).setAttribute?.("aria-valuenow", String(next));
            }
        }
    }
};

// shared texture loader (hooked to manager)
const textureLoader = new THREE.TextureLoader(__loadingManager);
textureLoader.crossOrigin = "anonymous";
const IMAGE_BASE = "static/img/";

// Fast texture loader using ImageBitmap to reduce decode/upload jank
const bitmapLoader = new THREE.ImageBitmapLoader(__loadingManager);
// Important: When using ImageBitmap, WebGL ignores UNPACK_FLIP_Y. Do the flip at decode time
// and disable GPU-side flip on the Texture to avoid inverted maps.
bitmapLoader.setOptions?.({ imageOrientation: "flipY", premultiplyAlpha: "none" });

const EARTH_LOCAL_TEX = {
    albedo: IMAGE_BASE + "Earth/2_no_clouds_4k.jpg",
    bump: IMAGE_BASE + "Earth/elev_bump_4k.jpg",
    clouds: IMAGE_BASE + "Earth/fair_clouds_4k.png",
};
const EARTH_WATER_MASK = IMAGE_BASE + "Earth/water_4k.png";
function loadRealEarthTextures(planet) {
    if (!planet || planet.spec?.name !== "Earth") return;
    try {
        const pAlbedo = loadTextureFast(EARTH_LOCAL_TEX.albedo, { color: true, wrapRepeat: false, preferMipmaps: true }).then(tex => {
            if (tex) {
                planet.mesh.material.map = tex;
                planet.mesh.material.needsUpdate = true;
            }
        });
        __loadPromises.push(pAlbedo);
        loadTextureFast(EARTH_LOCAL_TEX.bump, { color: false, wrapRepeat: false, preferMipmaps: false }).then(tex => {
            if (tex) {
                planet.mesh.material.bumpMap = tex;
                planet.mesh.material.displacementMap = tex;
                planet.mesh.material.bumpScale = 1.0;
                planet.mesh.material.displacementScale = 0.35;
                planet.mesh.material.displacementBias = -0.1;
                planet.mesh.material.needsUpdate = true;
            }
        });
        const pCloud = loadTextureFast(EARTH_LOCAL_TEX.clouds, { color: true, wrapRepeat: true, preferMipmaps: false }).then(tex => {
            if (tex && planet.clouds) {
                planet.clouds.material.map = tex;
                planet.clouds.material.transparent = true;
                planet.clouds.material.opacity = 0.9;
                planet.clouds.material.needsUpdate = true;
            }
        });
        __loadPromises.push(pCloud);

        // Defer CPU-heavy roughness-map generation to idle time
        textureLoader.load(EARTH_WATER_MASK, tex => {
            const img = tex.image;
            __idle(() => {
                try {
                    const w = img.width,
                        h = img.height;
                    const c = document.createElement("canvas");
                    c.width = w;
                    c.height = h;
                    const ctx = c.getContext("2d");
                    ctx.drawImage(img, 0, 0, w, h);
                    const src = ctx.getImageData(0, 0, w, h);
                    const out = ctx.createImageData(w, h);
                    const roughWater = 0.15,
                        roughLand = 0.92;
                    for (let i = 0; i < src.data.length; i += 4) {
                        const r = src.data[i],
                            g = src.data[i + 1],
                            b = src.data[i + 2];
                        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
                        const val = Math.round(255 * (lum > 0.5 ? roughWater : roughLand));
                        out.data[i] = val;
                        out.data[i + 1] = val;
                        out.data[i + 2] = val;
                        out.data[i + 3] = 255;
                    }
                    ctx.putImageData(out, 0, 0);
                    const roughTex = new THREE.CanvasTexture(c);
                    roughTex.wrapS = THREE.RepeatWrapping;
                    roughTex.wrapT = THREE.ClampToEdgeWrapping;
                    roughTex.anisotropy = MAX_ANISO;
                    roughTex.needsUpdate = true;
                    roughTex.colorSpace = THREE.LinearSRGBColorSpace;
                    planet.mesh.material.roughness = 1.0;
                    planet.mesh.material.roughnessMap = roughTex;
                    planet.mesh.material.needsUpdate = true;
                } catch (e) {}
            });
        });
    } catch (e) {}
}

function createProjectSprite(imgPath, onReady) {
    const mat = new THREE.SpriteMaterial({ map: null, color: 0xffffff, transparent: true });
    mat.toneMapped = false;
    const sprite = new THREE.Sprite(mat);
    sprite.frustumCulled = false;
    // Default link target: the source image itself; can be overridden later via sprite.userData.href
    sprite.userData = sprite.userData || {};
    textureLoader.load(
        imgPath,
        tex => {
            const img = tex.image;
            const size = Math.max(2, Math.min(img?.width || 256, img?.height || 256));
            const c = document.createElement("canvas");
            c.width = size;
            c.height = size;
            const ctx = c.getContext("2d");
            ctx.clearRect(0, 0, size, size);
            ctx.save();
            ctx.beginPath();
            ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            const s = Math.min(img.width, img.height);
            const sx = Math.max(0, (img.width - s) / 2);
            const sy = Math.max(0, (img.height - s) / 2);
            ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
            ctx.fillStyle = "rgba(0,0,0,0.18)";
            ctx.fillRect(0, 0, size, size);
            ctx.restore();
            const circTex = new THREE.CanvasTexture(c);
            circTex.minFilter = THREE.LinearMipmapLinearFilter;
            circTex.magFilter = THREE.LinearFilter;
            circTex.generateMipmaps = true;
            circTex.anisotropy = Math.min(MAX_ANISO, 2);
            circTex.needsUpdate = true;
            circTex.colorSpace = THREE.SRGBColorSpace;
            mat.map = circTex;
            mat.needsUpdate = true;
            const baseD = 8;
            const baseScale = new THREE.Vector2(baseD, baseD);
            sprite.scale.set(baseScale.x, baseScale.y, 1);
            sprite.userData.baseScale = baseScale;
            // Desired on-screen size in pixels for this moon sprite
            sprite.userData.basePx = 128;
            sprite.renderOrder = 10;
            sprite.material.depthTest = true;
            sprite.material.depthWrite = false;
            sprite.userData.isReady = true;
            if (onReady) onReady(sprite);
        },
        undefined,
        () => {
            const c = document.createElement("canvas");
            c.width = 256;
            c.height = 256;
            const ctx = c.getContext("2d");
            ctx.fillStyle = "#444";
            ctx.beginPath();
            ctx.arc(128, 128, 120, 0, Math.PI * 2);
            ctx.fill();
            const circTex = new THREE.CanvasTexture(c);
            circTex.minFilter = THREE.LinearMipmapLinearFilter;
            circTex.magFilter = THREE.LinearFilter;
            circTex.generateMipmaps = true;
            circTex.colorSpace = THREE.SRGBColorSpace;
            mat.map = circTex;
            mat.needsUpdate = true;
            const baseScale = new THREE.Vector2(16, 16);
            sprite.scale.set(baseScale.x, baseScale.y, 1);
            sprite.userData.baseScale = baseScale;
            sprite.userData.basePx = 128;
            sprite.userData.isReady = true;
            if (onReady) onReady(sprite);
        }
    );
    return sprite;
}

// Load single-file textures for Venus (no tiling)
function loadRealVenusTextures(planet) {
    if (!planet || planet.spec?.name !== "Venus") return;
    const mat = planet.mesh.material;
    const base = IMAGE_BASE + "Venus/";
    const tune = (tex, isColor = false) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = MAX_ANISO;
        tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
        tex.needsUpdate = true;
        return tex;
    };
    // Color priority: venussurface__praesepe.jpg -> venus-fagr.jpg -> topo/elevation
    const colorCandidates = [base + "venussurface__praesepe.jpg", base + "venus-fagr.jpg", base + "venus_base_elevation_2k.jpg", base + "venus_topo_2k.jpg"];
    const normalCandidates = [base + "VenusNormal2k.png"];
    const bumpCandidates = [base + "venus_base_elevation_2k.jpg", base + "venus_topo_2k.jpg"];
    const loadList = async (arr, isColor) => {
        for (let i = 0; i < arr.length; i++) {
            const tex = await loadTextureFast(arr[i], { color: isColor, wrapRepeat: true, preferMipmaps: isColor });

            if (tex) {
                return tex;
            }
        }
        return null;
    };
    (async () => {
        const colPromise = loadList(colorCandidates, true);
        __loadPromises.push(colPromise);
        const col = await colPromise;
        if (col) {
            mat.map = tune(col, true);
            mat.needsUpdate = true;
        }
        const nor = await loadList(normalCandidates, false);
        if (nor) {
            mat.normalMap = tune(nor, false);
            mat.normalScale = new THREE.Vector2(0.6, 0.6);
            mat.needsUpdate = true;
        }
        const bmp = await loadList(bumpCandidates, false);
        if (bmp) {
            mat.bumpMap = tune(bmp, false);
            mat.bumpScale = 0.22;
            mat.needsUpdate = true;
        }
    })();
    mat.roughness = 0.95;
    mat.metalness = 0.0;
}

function loadRealMercuryTextures(planet) {
    if (!planet || planet.spec?.name !== "Mercury") return;
    const mat = planet.mesh.material;
    const base = IMAGE_BASE + "Mercury/";
    const tune = (tex, isColor = false) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = MAX_ANISO;
        // IMPORTANT: normal/height maps must not be color-corrected
        tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.needsUpdate = true;
        return tex;
    };
    const pMercCol = loadTextureFast(base + "mercurymap.jpg", { color: true, wrapRepeat: true, preferMipmaps: true }).then(tex => {
        if (tex) {
            mat.map = tex;
            mat.needsUpdate = true;
        }
    });
    __loadPromises.push(pMercCol);
    loadTextureFast(base + "mercurynormal.png", { color: false, wrapRepeat: true, preferMipmaps: false }).then(tex => {
        if (!tex) return;
        mat.normalMap = tex;
        mat.normalScale = new THREE.Vector2(2.6, 2.6);
        __idle(() => {
            try {
                const bumpTex = normalToHeightTexture(tex, 2.2);
                if (bumpTex) {
                    mat.bumpMap = bumpTex;
                    mat.bumpScale = 1.8;
                    mat.needsUpdate = true;
                }
            } catch {}
        });
        mat.needsUpdate = true;
    });
    mat.roughness = 1.0;
    mat.metalness = 0.02;
}

function loadRealMarsTextures(planet) {
    if (!planet || planet.spec?.name !== "Mars") return;
    const mat = planet.mesh.material;
    const base = IMAGE_BASE + "Mars/";
    const tune = (tex, isColor = false) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = MAX_ANISO;
        // IMPORTANT: normal/height maps must not be color-corrected
        tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.needsUpdate = true;
        return tex;
    };
    // Prefer 1k color/normal; fallbacks present too
    const pMarsCol = loadTextureFast(base + "Mars.png", { color: true, wrapRepeat: true, preferMipmaps: true }).then(tex => {
        if (tex) {
            mat.map = tex;
            mat.needsUpdate = true;
        }
    });
    __loadPromises.push(pMarsCol);
    loadTextureFast(base + "MarsNormal.png", { color: false, wrapRepeat: true, preferMipmaps: false }).then(tex => {
        if (!tex) return;
        mat.normalMap = tex;
        mat.normalScale = new THREE.Vector2(3.0, 3.0);
        __idle(() => {
            try {
                const bumpTex = normalToHeightTexture(tex, 2.6);
                if (bumpTex) {
                    mat.bumpMap = bumpTex;
                    mat.bumpScale = 2.2;
                    mat.needsUpdate = true;
                }
            } catch {}
        });
        mat.needsUpdate = true;
    });
    // Lower roughness a bit to emphasize lighting contrast and surface normals
    mat.roughness = 0.7;
    mat.metalness = 0.0;
}

function attachOverlayToSprite(sprite, label, description, links) {
    try {
        // Determine desired overlay pixel size from sprite hint (matches moon target px)
        const desiredPx = Math.max(BASE_OVERLAY_PX, Math.min(512, Math.round(sprite?.userData?.overlayPx || sprite?.userData?.basePx || BASE_OVERLAY_PX)));
        const size = desiredPx; // overlay canvas resolution in pixels
        const c = document.createElement("canvas");
        // Increase backing resolution for sharper text (HiDPI); cap at 2x for perf
        const DPR = 3;
        c.width = Math.round(size * DPR);
        c.height = Math.round(size * DPR);
        const ctx = c.getContext("2d");
        // Draw in CSS pixel coordinates while the bitmap is HiDPI
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        // Ratio so circle scales with moon, but text/pills stay at 128px baseline
        const S = BASE_OVERLAY_PX; // baseline design space for typography/pills
        const ratio = size / S; // how much larger/smaller than 128px the moon/overlay is
        // Draw function so we can re-render on hover state
        const drawOverlay = (hoverIndex = -1) => {
            ctx.save();
            ctx.clearRect(0, 0, size, size);
            // 1) Background circle: scale with moon using ratio
            ctx.save();
            ctx.scale(ratio, ratio);
            ctx.fillStyle = "rgba(12,24,52,0.62)";
            ctx.beginPath();
            ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();

            // 2) Typography and pills: lock to baseline 128px regardless of overlay size
            ctx.fillStyle = "#fff";
            ctx.textAlign = "center";
            ctx.textBaseline = "alphabetic";
            // keep light shadow for main title/desc only (reduce cost)
            ctx.shadowColor = "rgba(0,0,0,0.55)";
            ctx.shadowBlur = Math.max(1, Math.round(S * 0.01));
            ctx.shadowOffsetY = Math.round(S * 0.01);
            // Label: move slightly higher and auto-shrink font until it fits within 4 lines
            const maxWLabel = Math.round(S * ratio * 0.78);
            const maxLabelLines = 4;
            const minFontPx = Math.round(S * 0.02);
            let fontPx = Math.round(S * 0.12);
            let labelLines = [];
            const wrapWithFont = (text, fontPxLocal) => {
                ctx.font = `${fontPxLocal}px sans-serif`;
                const words = String(text || "").split(/\s+/);
                const lines = [];
                let cur = "";
                for (let i = 0; i < words.length; i++) {
                    const test = cur ? cur + " " + words[i] : words[i];
                    if (ctx.measureText(test).width > maxWLabel && cur) {
                        lines.push(cur);
                        cur = words[i];
                    } else {
                        cur = test;
                    }
                }
                if (cur) lines.push(cur);
                return lines;
            };
            // Try to fit within maxLabelLines by shrinking fontPx
            for (;;) {
                labelLines = wrapWithFont(label, fontPx);
                if (labelLines.length <= maxLabelLines || fontPx <= minFontPx) break;
                fontPx = Math.max(minFontPx, fontPx - 1);
            }
            // If still overflowing at min font size, do NOT ellipsize; render all lines (may overflow)
            const labelLineH = Math.round(fontPx * 1.15);
            let yLabel = Math.round(size * 0.26); // moved higher vs 0.48
            for (let i = 0; i < labelLines.length; i++) {
                ctx.fillText(labelLines[i], size / 2, yLabel + i * labelLineH);
            }
            const labelEndY = yLabel + Math.max(1, labelLines.length) * labelLineH;

            // Description: start below label block (or fallback to baseline position)
            if (description) {
                ctx.font = `${Math.min(Math.round(fontPx - 2), Math.round(S * 0.07))}px sans-serif`;
                const words = String(description).split(" ");
                let line = "";
                const maxW = Math.round(S * ratio * 0.78); // wrap width in baseline pixels
                const descLineH = Math.round(S * 0.095);
                let y = Math.max(Math.round(size * 0.62), labelEndY + Math.round(S * 0.08));
                for (let i = 0; i < words.length; i++) {
                    const test = line ? line + " " + words[i] : words[i];
                    if (ctx.measureText(test).width > maxW) {
                        ctx.fillText(line, size / 2, y);
                        line = words[i];
                        y += descLineH;
                    } else {
                        line = test;
                    }
                }
                if (line) ctx.fillText(line, size / 2, y);
            }
            // Optional link badges at the bottom (e.g., PDF, Poster, Code)
            let linkHotspotsLocal = null;
            if (Array.isArray(links) && links.length) {
                const padX = Math.round(S * 0.034);
                const gap = Math.round(S * 0.02);
                const pillH = Math.round(labelLineH);
                ctx.font = `${Math.min(Math.round(fontPx - 2), Math.round(S * 0.07))}px sans-serif`;
                const metrics = links.map(l => {
                    const t = String(l?.text ?? "");
                    const w = Math.ceil(ctx.measureText(t).width) + padX * 2;
                    return { text: t, href: l?.href, w };
                });
                const totalW = metrics.reduce((a, m) => a + m.w, 0) + gap * Math.max(0, metrics.length - 1);
                let x = Math.round((size - totalW) / 2);
                const yTop = Math.round(size * 0.82);
                linkHotspotsLocal = [];
                // Pills: draw without shadows to keep hover cheap
                const savedShadowBlur = ctx.shadowBlur;
                const savedShadowColor = ctx.shadowColor;
                const savedBaseline = ctx.textBaseline;
                ctx.shadowBlur = 0;
                ctx.shadowColor = "transparent";
                ctx.lineWidth = Math.max(1, Math.round(S * 0.006));
                metrics.forEach((m, i) => {
                    const r = Math.round(pillH / 2);
                    const w = m.w;
                    const h = pillH;
                    const y = yTop;
                    // hover styles
                    const isHover = i === hoverIndex;
                    ctx.fillStyle = isHover ? "rgba(255,255,255,0.30)" : "rgba(255,255,255,0.12)";
                    ctx.strokeStyle = isHover ? "#ffffff" : "rgba(255,255,255,0.28)";
                    // rounded rect
                    ctx.beginPath();
                    ctx.moveTo(x + r, y);
                    ctx.lineTo(x + w - r, y);
                    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
                    ctx.lineTo(x + w, y + h - r);
                    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
                    ctx.lineTo(x + r, y + h);
                    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
                    ctx.lineTo(x, y + r);
                    ctx.quadraticCurveTo(x, y, x + r, y);
                    ctx.closePath();
                    ctx.fill();
                    if (isHover) ctx.stroke();
                    // text
                    ctx.fillStyle = "#fff";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText(m.text, x + w / 2, y + h / 2 + 1);
                    linkHotspotsLocal.push({ x, y, w, h, href: m.href, text: m.text });
                    x += w + gap;
                });
                // restore shadow
                ctx.shadowBlur = savedShadowBlur;
                ctx.shadowColor = savedShadowColor;
                ctx.textBaseline = savedBaseline;
            }
            ctx.restore();
            return linkHotspotsLocal;
        };
        // Initial draw
        let linkHotspots = drawOverlay(-1) || null;
        const overlayTex = new THREE.CanvasTexture(c);
        overlayTex.colorSpace = THREE.SRGBColorSpace;
        // Keep overlay light-weight: no mipmaps and minimal anisotropy
        overlayTex.generateMipmaps = false;
        overlayTex.minFilter = THREE.LinearFilter;
        overlayTex.magFilter = THREE.LinearFilter;
        overlayTex.anisotropy = 1;
        const overlayMat = new THREE.SpriteMaterial({ map: overlayTex, transparent: true, opacity: 0, depthTest: true, depthWrite: false });
        overlayMat.toneMapped = false;
        const overlay = new THREE.Sprite(overlayMat);
        overlay.frustumCulled = false;
        overlay.scale.set(1, 1, 1);
        overlay.position.z = 0.01;
        overlay.userData.baseSprite = sprite;
        overlay.userData.canvas = c;
        overlay.userData.canvasSize = size;
        overlay.userData.label = label;
        overlay.userData.description = description;
        overlay.userData.links = Array.isArray(links) ? links : null;
        overlay.userData.draw = hoverIndex => {
            const hs = drawOverlay(hoverIndex);
            overlay.userData.linkHotspots = hs;
            overlay.material.map.needsUpdate = true;
            // mirror to sprite
            sprite.userData.linkHotspots = hs;
        };
        if (linkHotspots) {
            overlay.userData.linkHotspots = linkHotspots;
            sprite.userData = sprite.userData || {};
            sprite.userData.linkHotspots = linkHotspots;
            sprite.userData.overlayCanvasSize = size;
            sprite.userData.links = links;
        }
        overlay.renderOrder = (sprite.renderOrder || 10) + 1;
        sprite.add(overlay);
        sprite.userData.overlay = overlay;
    } catch (e) {}
}

let __resizeTimer = null;
function onResize() {
    if (__resizeTimer) clearTimeout(__resizeTimer);
    __resizeTimer = setTimeout(() => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    }, 100);
}
window.addEventListener("resize", onResize);

// lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.28));

// starfield
(function makeStarField() {
    const geo = new THREE.BufferGeometry();
    const count = __isLowTier ? 1200 : 3000;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        pos[i * 3 + 0] = (Math.random() - 0.5) * 3000;
        pos[i * 3 + 1] = (Math.random() - 0.5) * 3000;
        pos[i * 3 + 2] = (Math.random() - 0.5) * 3000;
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ size: __isLowTier ? 1.0 : 1.2, color: 0xffffff, transparent: true, opacity: 0.95 });
    scene.add(new THREE.Points(geo, mat));
})();

// (Removed legacy keyStars/keyData; navigation uses planet focus directly)

// Clamp anisotropy to avoid very expensive sampling on some GPUs (esp. mobile)
const MAX_ANISO = Math.min(renderer.capabilities.getMaxAnisotropy?.() || 1, 8);

// planet system
const planetGroup = new THREE.Group();
scene.add(planetGroup);
planetGroup.visible = false; // keep hidden until initial assets are ready

// Geometry cache for spheres
const __sphereGeoCache = new Map();
function getSphereGeometry(radius, w, h) {
    const key = `${radius}|${w}|${h}`;
    let g = __sphereGeoCache.get(key);
    if (!g) {
        g = new THREE.SphereGeometry(radius, w, h);
        __sphereGeoCache.set(key, g);
    }
    return g;
}

// Simple LOD for sphere segments based on radius
function sphereSegmentsForRadius(r) {
    if (r <= 10) return { w: 56, h: 40 };
    if (r <= 12) return { w: 72, h: 52 };
    if (r <= 14) return { w: 88, h: 60 };
    return { w: 96, h: 64 };
}

// Orbit line material (thin line to show elliptical path)
const orbitLineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 });

const sunTex = generateSunTexture(1024, 512);
sunTex.wrapS = THREE.RepeatWrapping;
sunTex.wrapT = THREE.RepeatWrapping;
const sunMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffc35b, emissiveMap: sunTex, emissiveIntensity: 0.5, roughness: 1.0, metalness: 0.0 });
const sun = new THREE.Mesh(getSphereGeometry(30, 48, 48), sunMat);
planetGroup.add(sun);
const sunLight = new THREE.PointLight(0xffeecc, 5.5, 6000, 2.0);
sun.add(sunLight);

const planets = [];
// Planet sizes (r), orbit radii (dist), and speeds are set to real-world ratios:
// - Radii: relative to Earth (Mercury 0.383, Venus 0.949, Earth 1.0, Mars 0.532), scaled by Earth r=13 scene units
// - Distances: semi-major axes in AU relative to Earth (Mercury 0.387, Venus 0.723, Earth 1.0, Mars 1.524), scaled by Earth dist=160
// - Orbital speeds: proportional to 1 / orbital period (days). Earth visual period kept the same (speed=0.012), others derived.
//   Periods (days): Mercury 87.969, Venus 224.701, Earth 365.256, Mars 686.980
const planetSpecs = [
    // Elements: eccentricity (e), inclination (incDeg), longitude of ascending node (OmegaDeg), argument of periapsis (omegaDeg)
    // Axis tilt (tiltDeg) and sidereal day length (dayLengthDays). Venus tilt > 90 implies retrograde spin.
    { name: "Mercury", r: 13 * 0.383, dist: Math.round(160 * 0.387), speed: 0.012 * (365.256 / 87.969), color: 0x8b8b8b, e: 0.2056, incDeg: 7.005, OmegaDeg: 48.331, omegaDeg: 29.124, tiltDeg: 0.034, dayLengthDays: 58.646 },
    { name: "Venus", r: 13 * 0.949, dist: Math.round(160 * 0.723), speed: 0.012 * (365.256 / 224.701), color: 0xe8c07a, e: 0.0068, incDeg: 3.394, OmegaDeg: 76.68, omegaDeg: 54.884, tiltDeg: 177.36, dayLengthDays: 243.025 },
    { name: "Earth", r: 13, dist: 160, speed: 0.012, color: 0x6ea8ff, e: 0.0167, incDeg: 0.0, OmegaDeg: 0.0, omegaDeg: 102.937, tiltDeg: 23.44, dayLengthDays: 0.99726968 },
    { name: "Mars", r: 13 * 0.532, dist: Math.round(160 * 1.524), speed: 0.012 * (365.256 / 686.98), color: 0xff6f4c, e: 0.0934, incDeg: 1.85, OmegaDeg: 49.558, omegaDeg: 286.5, tiltDeg: 25.19, dayLengthDays: 1.025957 },
];
function pickTextureSizes() {
    return __isLowTier ? { cloudW: 512, cloudH: 256 } : { cloudW: 1024, cloudH: 512 };
}
const TEX_SIZES = pickTextureSizes();
// Feature flag to toggle cloud generation globally
const ENABLE_CLOUDS = true;

function buildOrbitLine(spec, segments = 256) {
    const positions = new Float32Array((segments + 1) * 3);
    for (let i = 0; i <= segments; i++) {
        const t = (i / segments) * TAU;
        // Convert parameter t (true anomaly) directly
        const v = t;
        const pos = elementsToWorldPosition(spec.dist, spec.e, spec.incDeg, spec.OmegaDeg, spec.omegaDeg, v);
        positions[i * 3 + 0] = pos.x;
        positions[i * 3 + 1] = pos.y;
        positions[i * 3 + 2] = pos.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.computeBoundingSphere?.();
    return new THREE.LineLoop(geo, orbitLineMaterial);
}
const EARTH_DAY_VISUAL_SECONDS = 20; // Earth completes one spin in ~20s (others scale by real day length)
// Time anchors: __t0 is set on the first animation frame; lastTime is for per-frame dt
let __t0 = null;
let lastTime = performance.now();

planetSpecs.forEach((spec, i) => {
    const g = new THREE.Group();
    // Initial mean anomaly (randomized starting position)
    const M0 = Math.random() * TAU;

    // Use texture-based materials for all planets (no geometry sculpting or procedural color maps)
    let mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.02 });

    // Defaults
    let bumpScale = 1.0;
    let normalScale = 1.0;
    let displaceScale = 0.4;

    if (spec.name === "Mercury") {
        // Image-based Mercury; displacement off by default
        displaceScale = 0.0;
        mat.roughness = 1.0;
        mat.metalness = 0.02;
    } else if (spec.name === "Venus") {
        // Image-based Venus; displacement off by default
        displaceScale = 0.0;
        mat.roughness = 0.95;
        mat.metalness = 0.0;
    } else if (spec.name === "Earth") {
        // Placeholder; will be replaced with real textures later
        bumpScale = 1.5;
        normalScale = 1.2;
        displaceScale = 1.1;
        mat.roughness = 0.92;
    } else if (spec.name === "Mars") {
        bumpScale = 1.4;
        normalScale = 1.1;
        displaceScale = 0.7;
        mat.roughness = 0.9; // dusty surface
        mat.metalness = 0.0;
    }

    mat.bumpScale = bumpScale;
    mat.normalScale = new THREE.Vector2(normalScale, normalScale);
    mat.displacementScale = displaceScale;
    mat.displacementBias = -displaceScale * 0.5;
    let seg = sphereSegmentsForRadius(spec.r);
    const tiltGroup = new THREE.Group();
    tiltGroup.rotation.z = THREE.MathUtils.degToRad(spec.tiltDeg || 0);
    g.add(tiltGroup);
    // Increase tessellation: helps when normal/bump maps emphasize fine relief
    if (spec.name === "Mercury" || spec.name === "Venus") {
        seg = { w: 128, h: 96 };
    } else if (spec.name === "Mars") {
        seg = { w: 256, h: 192 };
    }
    let sphereGeo = getSphereGeometry(spec.r, seg.w, seg.h);
    // Keep default sphere geometry for image-based Mercury, Venus, Mars
    const mesh = new THREE.Mesh(sphereGeo, mat);
    mesh.position.set(0, 0, 0);
    tiltGroup.add(mesh);
    // Brighten Mars slightly without affecting other planets by using a Mars-only light layer
    if (spec.name === "Mars") {
        // Enable layer 1 on Mars so a light restricted to layer 1 only affects Mars
        try {
            mesh.layers.enable(1);
        } catch (e) {}
    }

    let clouds = null;
    let cloudRotSpeed = 0;
    if (ENABLE_CLOUDS && spec.name === "Earth") {
        // Use file-based cloud texture for Earth
        const cloudTex = textureLoader.load(EARTH_LOCAL_TEX.clouds);
        cloudTex.wrapS = THREE.RepeatWrapping;
        cloudTex.wrapT = THREE.RepeatWrapping;
        const cloudMat = new THREE.MeshStandardMaterial({ map: cloudTex, transparent: true, opacity: 0.9, depthWrite: false, roughness: 1.0, metalness: 0.0 });
        const cw = Math.max(24, seg.w - 16),
            ch = Math.max(16, seg.h - 12);
        clouds = new THREE.Mesh(getSphereGeometry(spec.r * 1.015, cw, ch), cloudMat);
        clouds.position.set(0, 0, 0);
        tiltGroup.add(clouds);
        cloudRotSpeed = 0.6; // legacy fallback; will be scaled by spin below
    } else if (ENABLE_CLOUDS && spec.name === "Venus") {
        const cloudTex = textureLoader.load(IMAGE_BASE + "Venus/venus_clouds__NASA_JPL_Seal_Mariner10_Oct21_2001.jpg");
        cloudTex.wrapS = THREE.RepeatWrapping;
        cloudTex.wrapT = THREE.RepeatWrapping;
        const cloudMat = new THREE.MeshStandardMaterial({ map: cloudTex, color: 0xfbf8ea, transparent: true, opacity: 0.9, depthWrite: false, roughness: 1.0, metalness: 0.0 });
        const cw = Math.max(24, seg.w - 10),
            ch = Math.max(16, seg.h - 8);
        clouds = new THREE.Mesh(getSphereGeometry(spec.r * 1.04, cw, ch), cloudMat);
        clouds.position.set(0, 0, 0);
        tiltGroup.add(clouds);
        cloudRotSpeed = 80;
    } else if (ENABLE_CLOUDS && spec.name === "Mars") {
        // Add subtle, thin cloud/dust layer for Mars using provided texture
        const cloudTex = textureLoader.load(IMAGE_BASE + "Mars/MarsClouds.png");
        cloudTex.wrapS = THREE.RepeatWrapping;
        cloudTex.wrapT = THREE.RepeatWrapping;
        const cloudMat = new THREE.MeshStandardMaterial({
            map: cloudTex,
            transparent: true,
            opacity: 0.72,
            depthWrite: false,
            roughness: 1.0,
            metalness: 0.0,
        });
        const cw = Math.max(24, seg.w - 14),
            ch = Math.max(16, seg.h - 10);
        clouds = new THREE.Mesh(getSphereGeometry(spec.r * 1.012, cw, ch), cloudMat);
        clouds.position.set(0, 0, 0);
        // Ensure Mars-only fill light (layer 1) can affect clouds too
        try {
            clouds.layers.enable(1);
        } catch {}
        tiltGroup.add(clouds);
        cloudRotSpeed = 0.5;
    }
    // Elliptical orbit line
    const orbitLine = buildOrbitLine(spec);
    planetGroup.add(orbitLine);

    // No legacy keyData assignment; kept minimal userData
    // Place planet at initial Keplerian position
    const E0 = solveKeplerE(M0, spec.e);
    const nu0 = trueAnomalyFromE(E0, spec.e);
    const p0 = elementsToWorldPosition(spec.dist, spec.e, spec.incDeg, spec.OmegaDeg, spec.omegaDeg, nu0);
    g.position.set(p0.x, p0.y, p0.z);

    planetGroup.add(g);
    // Compute spin rate from day length (retrograde if tilt > 90)
    const retro = (spec.tiltDeg || 0) > 90 ? -1 : 1;
    const spinRate = (retro * (2 * Math.PI)) / (EARTH_DAY_VISUAL_SECONDS * (spec.dayLengthDays || 1));
    const planetObj = { group: g, tiltGroup, mesh, clouds, cloudRotSpeed, spec, M0, orbitLine, spinRate };
    planets.push(planetObj);

    if (spec.name === "Earth") {
        loadRealEarthTextures(planetObj);
    } else if (spec.name === "Venus") {
        loadRealVenusTextures(planetObj);
    } else if (spec.name === "Mercury") {
        loadRealMercuryTextures(planetObj);
        // Add a gentle ambient fill that only lights Mercury (layer 1)
        try {
            const existing = scene.getObjectByName?.("__MercuryFillLight");
            if (!existing) {
                const mercuryFill = new THREE.AmbientLight(0xffffff, 0.35);
                mercuryFill.name = "__MercuryFillLight";
                // Restrict this light to layer 1 only so it only affects Mercury (mesh has layer 1 enabled)
                mercuryFill.layers.set(1);
                scene.add(mercuryFill);
            }
            // Ensure Mercury receives layer-1 lighting
            try {
                mesh.layers.enable(1);
            } catch (e) {}
        } catch (e) {}
    } else if (spec.name === "Mars") {
        loadRealMarsTextures(planetObj);
        // Add a gentle ambient fill that only lights Mars (layer 1)
        try {
            const existing = scene.getObjectByName?.("__MarsFillLight");
            if (!existing) {
                const marsFill = new THREE.AmbientLight(0xffffff, 0.35);
                marsFill.name = "__MarsFillLight";
                // Restrict this light to layer 1 only so it only affects Mars (mesh has layer 1 enabled)
                marsFill.layers.set(1);
                scene.add(marsFill);
            }
        } catch (e) {}
    }
});

// Camera helpers
let __isAnimatingCam = false;
const __tmpCam = new THREE.PerspectiveCamera();
// Temp vectors to avoid allocations per frame
const __vTemp3 = new THREE.Vector3();
function animateCameraTo(destPos, destTarget, duration = 1.6, onComplete = null, destQuat = null) {
    const startPos = camera.position.clone();
    const startQuat = camera.quaternion.clone();
    const startTarget = controls.target.clone();
    controls.enabled = false;
    __isAnimatingCam = true;
    const o = { t: 0 };
    gsap.to(o, {
        t: 1,
        duration,
        ease: "power2.inOut",
        onUpdate() {
            const currTarget = typeof destTarget === "function" ? destTarget() : destTarget;
            const currPos = typeof destPos === "function" ? destPos(currTarget) : destPos;
            let finalQ = destQuat;
            if (!finalQ || !finalQ.isQuaternion) {
                __tmpCam.position.copy(currPos);
                __tmpCam.lookAt(currTarget);
                finalQ = __tmpCam.quaternion;
            }
            camera.position.lerpVectors(startPos, currPos, o.t);
            camera.quaternion.copy(startQuat).slerp(finalQ, o.t);
            controls.target.lerpVectors(startTarget, currTarget, o.t);
            controls.update();
        },
        onComplete() {
            controls.enabled = true;
            __isAnimatingCam = false;
            if (onComplete) onComplete();
        },
    });
}

const centerTitle = document.getElementById("centerTitle");
const centerText = document.getElementById("centerText");
function setCenter(title, text) {
    if (centerTitle) centerTitle.textContent = title;
    if (centerText) {
        const s = String(text ?? "");
        if (/<\s*[^>]+>/i.test(s)) {
            centerText.innerHTML = s;
        } else {
            centerText.textContent = s;
        }
    }
}

let followTarget = null;
let followOffset = new THREE.Vector3(0, 18, 60);

function focusPlanet(i, onFocused) {
    if (i === "overview") {
        followTarget = null;
        __stopFollowingMode();
        animateCameraTo(new THREE.Vector3(0, 800, 0), new THREE.Vector3(0, 0, 0), 1.4);
        return;
    }
    const p = planets[i];
    if (!p) return;
    // Make the camera closer for smaller planets by scaling the follow offset with radius
    const r = p.spec && p.spec.r ? p.spec.r : 13; // fallback to Earth scale if missing
    const oy = Math.max(4, Math.min(24, r * 1.5));
    const oz = Math.max(18, Math.min(110, r * 5.0));
    followOffset.set(0, oy, oz);
    followTarget = p.mesh;
    __startFollowingMode();
    const getTarget = () => p.mesh.getWorldPosition(new THREE.Vector3());
    const getPos = tgt => tgt.clone().add(followOffset);
    animateCameraTo(getPos, getTarget, 1.2, () => {
        const tgt = getTarget();
        camera.position.copy(getPos(tgt));
        controls.target.copy(tgt);
        if (typeof onFocused === "function") onFocused();
    });
}

let projectMoons = [];
let projectMoonsInitialized = false;

// Generic helpers to avoid duplication across moon sprite sets
function randomizeMoonsOffsets(arr, planetIndex, frontDir, thetaPhase = 0) {
    const host = planets[planetIndex];
    if (!host || !arr.length) return;
    const Rmin = host.spec.r * 2.1;
    const Rmax = host.spec.r * 2.2;
    const Rmid = (Rmin + Rmax) * 0.5;
    const forward = frontDir.clone().normalize();
    // Persist front direction for this set so animations don't depend on camera
    arr.__frontDir = forward.clone();
    const upGuess = Math.abs(forward.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const right = new THREE.Vector3().crossVectors(upGuess, forward).normalize();
    const up = new THREE.Vector3().crossVectors(forward, right).normalize();

    // Prepare a temporary camera posed at the predicted final follow-camera for this planet
    // so we can ensure randomly placed moons will appear on-screen when focused.
    const planetWorld = host.mesh.getWorldPosition(new THREE.Vector3());
    const camFinalPos = computeFinalCameraPosForPlanet(planetIndex) || camera.position.clone();
    __tmpCam.fov = camera.fov;
    __tmpCam.aspect = camera.aspect;
    __tmpCam.near = camera.near;
    __tmpCam.far = camera.far;
    __tmpCam.updateProjectionMatrix();
    __tmpCam.position.copy(camFinalPos);
    __tmpCam.lookAt(planetWorld);
    // Prepare camera basis for projecting sprite-aligned quads
    const camX = new THREE.Vector3();
    const camY = new THREE.Vector3();
    const camZ = new THREE.Vector3();
    __tmpCam.matrixWorld.extractBasis(camX, camY, camZ);
    const NDC_PAD = 0.98; // keep a small border so pills don’t clip

    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const n = arr.length;
    for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const y = 1 - t;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = k * goldenAngle + thetaPhase;
        const dir = new THREE.Vector3()
            .addScaledVector(right, r * Math.cos(theta))
            .addScaledVector(up, r * Math.sin(theta))
            .addScaledVector(forward, y)
            .normalize();
        let radius = Rmid * (0.9 + Math.random() * 0.2);
        let offset = dir.clone().multiplyScalar(radius);
        // If the projected sprite quad would be off-screen, gently push it toward the planet
        // by shrinking the radius until it fits, but never below a safe minimum.
        const minRadius = host.spec.r * 1.7; // don’t let moons get too close to the surface
        let attempts = 24;
        while (attempts-- > 0) {
            // Estimate the sprite’s world half-size at this camera distance using its target pixel size
            const sprite = arr[k];
            const pxTarget = Math.max(48, Math.min(512, (sprite?.userData?.overlayPx || sprite?.userData?.basePx || 128) * 1.15));
            const centerWorld = planetWorld.clone().add(offset);
            const dist = __tmpCam.position.distanceTo(centerWorld);
            const viewH = Math.max(1, renderer?.domElement?.clientHeight || window.innerHeight || 1);
            const worldPerPixel = (2 * dist * Math.tan((__tmpCam.fov * Math.PI) / 180 / 2)) / viewH;
            const halfW = pxTarget * worldPerPixel * 0.6;
            const halfH = halfW; // sprites are square
            // Build four corners aligned to camera axes
            const c = centerWorld;
            const r = camX.clone().multiplyScalar(halfW);
            const u = camY.clone().multiplyScalar(halfH);
            const corners = [c.clone().add(r).add(u), c.clone().add(r).sub(u), c.clone().sub(r).add(u), c.clone().sub(r).sub(u)];
            let minX = Infinity,
                maxX = -Infinity,
                minY = Infinity,
                maxY = -Infinity;
            let allDepthOk = true;
            for (let ci = 0; ci < corners.length; ci++) {
                const v = corners[ci].clone().project(__tmpCam);
                if (v.z < -1 || v.z > 1) {
                    allDepthOk = false;
                    break;
                }
                if (v.x < minX) minX = v.x;
                if (v.x > maxX) maxX = v.x;
                if (v.y < minY) minY = v.y;
                if (v.y > maxY) maxY = v.y;
            }
            const fits = allDepthOk && minX >= -NDC_PAD && maxX <= NDC_PAD && minY >= -NDC_PAD && maxY <= NDC_PAD;
            if (fits) break;
            const next = Math.max(minRadius, offset.length() * 0.92);
            if (next >= offset.length() - 1e-6) break; // no further progress
            offset.setLength(next);
        }
        arr[k].userData.offset = offset;
    }
}
// Back-compat convenience wrappers referenced in handlers
function randomizeProjectMoonOffsets(frontDir) {
    randomizeMoonsOffsets(projectMoons, 1, frontDir, 0);
}
function randomizePublicationsMoonOffsets(frontDir) {
    randomizeMoonsOffsets(publicationsMoons, 3, frontDir, 0);
}
function showMoons(arr) {
    const prevRaycastPauseUntil = performance.now() + 450;
    __raycastPauseUntil = Math.max(__raycastPauseUntil || 0, prevRaycastPauseUntil);
    arr.forEach((m, idx) => {
        // Ensure sprite is renderable before fading in
        m.visible = true;
        // Unfreeze any previously frozen position so the entry animation can proceed
        if (!m.userData) m.userData = {};
        m.userData.freezePos = false;
        // Defer fade-in until the entry animation actually starts
        if (m.material) {
            m.material.transparent = true;
            m.material.opacity = 0;
        }
        // Reset fade flag so update loop can trigger it once
        m.userData.fadeStarted = false;
        if (m.userData?.overlay?.material) m.userData.overlay.material.opacity = 0;
    });
    // Kick off entry animation from behind the planet toward their target offsets
    try {
        startMoonsEntryAnimation(arr);
    } catch (e) {}
    pointerDirty = true;
}
function hideMoons(arr) {
    arr.forEach(m => {
        // Cancel any in-flight entry animation
        if (m.userData) m.userData.anim = null;
        // Freeze position at current location so it doesn't snap to final offset while fading
        if (!m.userData) m.userData = {};
        m.userData.freezePos = true;
        if (m.userData) m.userData.fadeStarted = false;
        if (m.userData?.overlay?.material) m.userData.overlay.material.opacity = 0;
        if (m.material) {
            gsap.to(m.material, {
                opacity: 0,
                duration: 0.3,
                overwrite: true,
                onComplete: () => {
                    // Fully hide after fade-out completes
                    m.visible = false;
                },
            });
        }
    });
    pointerDirty = true;
}

// Create an entry animation where moons start hidden behind the planet and arc to surround it
function startMoonsEntryAnimation(arr) {
    if (!arr || !arr.length) return;
    const host = arr[0].parent; // planet group
    if (!host) return;
    // Find planet index for radius lookup
    const hostIndex = planets.findIndex(p => p && p.group === host);
    const hostPlanet = hostIndex >= 0 ? planets[hostIndex] : null;
    if (!hostPlanet) return;
    const planetR = hostPlanet.spec?.r || 12;
    // Use stored front direction for this set (fallback to +Z); do not rely on camera position
    const frontLocal = (arr.__frontDir && arr.__frontDir.isVector3 ? arr.__frontDir.clone() : new THREE.Vector3(0, 0, 1)).normalize();
    // We want orbit around the Y axis: i.e., motion in the XZ plane, rotating around +Y.
    // Build fixed basis vectors for XZ plane in host local space.
    const right = new THREE.Vector3(1, 0, 0);
    const orbitUp = new THREE.Vector3(0, 0, 1); // acts as the second basis vector in XZ plane
    // Determine a start direction "behind" the planet relative to the camera, but constrained to XZ plane.
    const frontPlanar = new THREE.Vector3(frontLocal.x, 0, frontLocal.z);
    let startDir = frontPlanar.lengthSq() > 1e-6 ? frontPlanar.clone().negate().normalize() : new THREE.Vector3(-1, 0, 0);
    const now = performance.now();
    // Phases: orbit while appearing (one turn around Z) -> settle to exact target offset
    const entryDur = 800; // ms for one full turn while appearing
    const settleDur = 600; // ms to align with target offset smoothly
    const n = arr.length;
    // Reset sequential settle state for this moon set
    arr.__settleCursor = 0;
    arr.__settleActive = false;
    const orderData = [];
    arr.forEach((m, i) => {
        if (!m) return;
        const target = m.userData?.offset ? m.userData.offset.clone() : new THREE.Vector3(0, 0, planetR * 2.2);
        const targetR = target.length();
        // Reduce target to XZ plane for y-axis orbit angle
        const targetPlanar = new THREE.Vector3(target.x, 0, target.z);
        const targetDirPlane = targetPlanar.lengthSq() > 1e-6 ? targetPlanar.clone().normalize() : new THREE.Vector3(1, 0, 0);
        const targetDir3D = target.clone().normalize();
        const targetPlaneR = Math.sqrt(target.x * target.x + target.z * target.z);
        const targetY = target.y;
        // Angles on XZ plane (atan2(z, x))
        const startAngle = Math.atan2(startDir.z, startDir.x);
        const targetAngle = Math.atan2(targetDirPlane.z, targetDirPlane.x);
        const orbitStartAngle = startAngle; // begin from start
        const orbitEndAngle = startAngle + Math.PI * 2; // one full revolution
        // Start at the same radius as the orbit to guarantee no intersection
        const startR = planetR * 2.2;
        // Uniform start time spacing across the entry duration
        const delay = (i / Math.max(1, n)) * entryDur;
        m.userData = m.userData || {};
        m.userData.anim = {
            phase: "entryOrbit",
            startTime: now + delay,
            entryDur: entryDur, // consistent duration to keep uniform timing
            settleDur,
            startDir: startDir.clone(),
            targetDir: targetDirPlane.clone(),
            targetDir3D: targetDir3D.clone(),
            targetPlaneR,
            targetY,
            startR,
            targetR,
            right: right.clone(),
            up: orbitUp.clone(),
            orbitStartAngle,
            orbitEndAngle,
            targetAngle,
            // no angle phase; spacing is achieved via start time offsets
        };
        // Track for settle ordering by final angle
        const ang = ((targetAngle % TAU) + TAU) % TAU; // normalize to [0, 2PI)
        orderData.push({ i, ang });
        // Set initial position immediately for a smooth start
        m.position.copy(startDir).multiplyScalar(startR);
    });
    // Sort clockwise: descending angle (assuming CCW increases angle)
    orderData.sort((a, b) => b.ang - a.ang);
    arr.__settleOrder = orderData.map(o => o.i);
}

function ensureMoons(arr, planetIndex, images, labels, descriptions, hrefs, frontDir, show = true, thetaPhase = 0, linkGroups = null) {
    const host = planets[planetIndex];
    if (!host) return;
    if (!arr.length) {
        for (let idx = 0; idx < images.length; idx++) {
            const sprite = createProjectSprite(IMAGE_BASE + images[idx], spr => {
                attachOverlayToSprite(spr, labels[idx], descriptions[idx], Array.isArray(linkGroups) ? linkGroups[idx] : null);
            });
            host.group.add(sprite);
            sprite.userData.label = labels[idx];
            sprite.userData.description = descriptions[idx];
            sprite.userData.href = hrefs[idx];
            sprite.material.opacity = 0;
            // Default to hidden until explicitly shown
            sprite.visible = true;
            arr.push(sprite);
        }
    }
    // Persist a deterministic front direction for this set and randomize offsets accordingly
    arr.__frontDir = frontDir && frontDir.isVector3 ? frontDir.clone() : new THREE.Vector3(0, 0, 1);
    randomizeMoonsOffsets(arr, planetIndex, arr.__frontDir, thetaPhase);
    if (show) showMoons(arr);
    else
        arr.forEach(m => {
            if (m.material) m.material.opacity = 0;
            if (m.userData?.overlay?.material) m.userData.overlay.material.opacity = 0;
            m.visible = true;
        });
}

let publicationsMoons = [];
let publicationsMoonsInitialized = false;
function ensureProjectMoons(frontDir, show = true) {
    const images = ["Instagram.png", "ongoingGame.PNG", "Slide2.png", "SpamDetection.png"];
    const labels = ["Instagram Mock", "Battleship", "Game Blog", "Spam Detection"];
    const descriptions = ["Mocks the basic features of Instagram.", "Made using JavaFX and Java Sockets.", "A tank-based shooter game made using Three.js.", "Simple spam detection using three simple heuristics."];
    const hrefs = ["https://github.com/Benedict-Leung/Instagram-Mock", "https://github.com/Benedict-Leung/Battleship", "https://github.com/Benedict-Leung/GameBlog", "https://github.com/Benedict-Leung/Spam-Detection"];
    ensureMoons(projectMoons, 1, images, labels, descriptions, hrefs, frontDir, show, /*thetaPhase*/ 0, /*linkGroups*/ null);
    projectMoonsInitialized = true;
}
function ensurePublicationsMoons(frontDir, show = true) {
    const images = ["NeuroSight.png", "GazeQuestGPT.png", "SwipeSense.png"];
    const labels = ["NeuroSight: Combining Eye-Tracking and Brain-Computer Interfaces for Context-Aware Hand-Free Camera Interaction", "GazeQ-GPT: Gaze-Driven Question Generation for Personalized Learning from Short Educational Videos", "SwipeSense: Exploring the Feasibility of Back-of-Device Swipe Interaction Using Built-In IMU Sensors"];
    const descriptions = ["Benedict Leung, Mariana Shimabukuro, Christopher Collins, UIST Adjunct '24", "Benedict Leung, Mariana Shimabukuro, Christopher Collins, Graphics Interface '25", "Neel Shah, Benedict Leung, Mariana Shimabukuro, Ali Neshati, MobileHCI '25"];

    // Optional: per-publication link labels at the bottom of the overlay (provide your own URLs)
    const linkGroups = [
        [
            { text: "PDF", href: "static/pdf/NeuroSight.pdf" },
            { text: "Paper", href: "https://dl.acm.org/doi/10.1145/3672539.3686312" },
            { text: "Poster", href: "static/pdf/NeuroSight Poster.pdf" },
        ],
        [
            { text: "PDF", href: "static/pdf/GazeQ.pdf" },
            { text: "Code", href: "https://github.com/vialab/gazeq-gpt" },
        ],
        [{ text: "Published Soon", href: "" }],
    ];

    ensureMoons(publicationsMoons, 3, images, labels, descriptions, [], frontDir, show, /*thetaPhase*/ 0, linkGroups);
    publicationsMoonsInitialized = true;
}

// Preload moons at startup to avoid first-click lag by creating sprites and loading textures
function preloadMoons() {
    const defaultFront = new THREE.Vector3(0, 0, 1);
    if (planets[1]) ensureProjectMoons(defaultFront, false);
    if (planets[3]) ensurePublicationsMoons(defaultFront, false);
}

// Wait until all sprites in arr have userData.isReady = true (or time out)
function waitForSpritesReady(arr, timeoutMs = 1200) {
    return new Promise(resolve => {
        const start = performance.now();
        const check = () => {
            const allReady = arr.length > 0 && arr.every(m => m?.userData?.isReady);
            const timedOut = performance.now() - start > timeoutMs;
            if (allReady || timedOut) resolve();
            else requestAnimationFrame(check);
        };
        check();
    });
}

// Predict the final camera position for a given planet index using the same logic as focusPlanet
function computeFinalCameraPosForPlanet(i) {
    const p = planets[i];
    if (!p) return null;
    const r = p.spec && p.spec.r ? p.spec.r : 13;
    const oy = Math.max(4, Math.min(24, r * 1.5));
    const oz = Math.max(18, Math.min(110, r * 5.0));
    const tgt = p.mesh.getWorldPosition(new THREE.Vector3());
    return tgt.clone().add(new THREE.Vector3(0, oy, oz));
}

// Precompute and lock each moon's world size so that at the anticipated final camera
// position it appears about pixelTarget pixels tall on screen (default 96px).
function setMoonsBaseSizeForFinalCamera(arr, planetIndex, pixelTarget = 96) {
    const camFinalPos = computeFinalCameraPosForPlanet(planetIndex);
    const planet = planets[planetIndex];
    if (!planet || !camFinalPos) return;
    const planetWorld = planet.mesh.getWorldPosition(new THREE.Vector3());
    const fovRad = (camera.fov * Math.PI) / 180;
    const viewH = Math.max(1, renderer?.domElement?.clientHeight || window.innerHeight || 1);
    arr.forEach(m => {
        const offset = m.userData && m.userData.offset ? m.userData.offset : new THREE.Vector3();
        const moonWorld = planetWorld.clone().add(offset);
        const dist = camFinalPos.distanceTo(moonWorld);
        const worldPerPixel = (2 * dist * Math.tan(fovRad / 2)) / viewH;
        const worldSize = pixelTarget * worldPerPixel;
        if (!m.userData) m.userData = {};
        m.userData.baseWorldSize = worldSize;
        // Also store the desired overlay pixel size so the overlay circle matches the moon target
        m.userData.overlayPx = pixelTarget;
        m.userData.lockScale = true;
        // Apply immediately; hover effect applied per-frame as a multiplier
        m.scale.set(worldSize, worldSize, 1);
        // If an overlay exists with a different canvas size, recreate it with the new size
        const ov = m.userData?.overlay;
        const needsResize = !!ov && typeof ov.userData?.canvasSize === "number" && ov.userData.canvasSize !== pixelTarget;
        if (needsResize) {
            try {
                const label = ov.userData?.label;
                const description = ov.userData?.description;
                const links = ov.userData?.links;
                m.remove(ov);
                m.userData.overlay = null;
                attachOverlayToSprite(m, label, description, links);
            } catch (e) {}
        }
    });
}

// UI bindings
const navButtons = {
    about: document.getElementById("nav-about"),
    projects: document.getElementById("nav-projects"),
    publications: document.getElementById("nav-publications"),
    contact: document.getElementById("nav-contact"),
    planets: document.getElementById("nav-planets"),
};
let activeSection = "planets";
function setActive(section) {
    activeSection = section;
    Object.entries(navButtons).forEach(([k, btn]) => {
        if (btn) btn.disabled = k === section;
    });
}
setActive("planets");

navButtons.about?.addEventListener("click", () => {
    if (activeSection === "about") return;
    setActive("about");
    hideMoons(projectMoons);
    hideMoons(publicationsMoons);
    setCenter(
        "About Me",
        `<div style="text-align: justify;"> <div style="margin-bottom: 12px; text-align: center; width: 100%;"> <a href='static/pdf/Resume.pdf' target='_blank'>CV</a> </div> Hi! My name is Benedict, but you can call me Ben for short. I am a Master computer science student at Ontario Tech University. My research area is human-computer interaction, focusing on novel interactions with hardware like pen-based devices, eye-tracking, and brain computer interfaces. Recently, my research has been creating interactions with Large Language Models.<br><br>
    When I was young, around third grade, I was passionate about being an inventor, in the sense that I wanted to create something never made before and use it to help people who couldn't do a specific task. But that morphed when I was introduced to computer programming. I was amused by how you can put your “heart and soul” into a program and do exactly what you envisioned, meaning your legacy can be imprinted into your programs for generations. My desired legacy is to give to people worldwide, like aiding the blind or advancing neural interfaces. These “dreams” may seem distant, but someone must take the first step, even if no one is willing.
    </div>`
    );
    focusPlanet(0);
});
navButtons.projects?.addEventListener("click", () => {
    if (activeSection === "projects") return;
    setActive("projects");
    hideMoons(publicationsMoons);
    setCenter("Projects", "Click for more info. More repos <a href='https://github.com/Benedict-Leung?tab=repositories' target='_blank'>here</a>.");
    // Start moons immediately using a deterministic front (+Z), independent of camera
    {
        const frontDir = new THREE.Vector3(0, 0, 1);
        if (projectMoonsInitialized) {
            randomizeProjectMoonOffsets(frontDir);
            // Pre-size moons so they are ~128px at the camera's final position
            setMoonsBaseSizeForFinalCamera(projectMoons, 1, 128);
            waitForSpritesReady(projectMoons).then(() => showMoons(projectMoons));
        } else {
            ensureProjectMoons(frontDir, false);
            // Pre-size moons so they are ~128px at the camera's final position
            setMoonsBaseSizeForFinalCamera(projectMoons, 1, 128);
            waitForSpritesReady(projectMoons).then(() => showMoons(projectMoons));
        }
    }
    // Move camera in parallel without delaying moons
    focusPlanet(1);
});
navButtons.publications?.addEventListener("click", () => {
    if (activeSection === "publications") return;
    setActive("publications");
    hideMoons(projectMoons);
    setCenter("Publications", "2 in progress - <a href='https://scholar.google.com/citations?user=ofhVl3wAAAAJ&hl=en&oi=ao' target='_blank'>Google Scholar</a>");
    // Start moons immediately using a deterministic front (+Z), independent of camera
    {
        const frontDir = new THREE.Vector3(0, 0, 1);
        if (publicationsMoonsInitialized) {
            randomizePublicationsMoonOffsets(frontDir);
            // Pre-size moons so they are ~96px at the camera's final position
            setMoonsBaseSizeForFinalCamera(publicationsMoons, 3, Math.min(window.innerWidth / 4, 256));
            waitForSpritesReady(publicationsMoons).then(() => showMoons(publicationsMoons));
        } else {
            ensurePublicationsMoons(frontDir, false);
            // Pre-size moons so they are ~96px at the camera's final position
            setMoonsBaseSizeForFinalCamera(publicationsMoons, 3, Math.min(window.innerWidth / 4, 256));
            waitForSpritesReady(publicationsMoons).then(() => showMoons(publicationsMoons));
        }
    }
    // Move camera in parallel without delaying moons
    focusPlanet(3);
});
navButtons.contact?.addEventListener("click", () => {
    if (activeSection === "contact") return;
    setActive("contact");
    hideMoons(projectMoons);
    hideMoons(publicationsMoons);
    setCenter("Contact", "<div><a href='mailto:benedict.leung1@ontariotechu.net' target='_blank'>Email</a> - benedict.leung1@ontariotechu.net</div><div><a href='https://www.linkedin.com/in/ben--leung' target='_blank'>LinkedIn</a></div>");
    focusPlanet(2);
});
navButtons.planets?.addEventListener("click", () => {
    if (activeSection === "planets") return;
    setActive("planets");
    hideMoons(projectMoons);
    hideMoons(publicationsMoons);
    setCenter("Benedict Leung", "Computer Science, MSc");
    focusPlanet("overview");
});

// hover handling for project/publications moons
// Preload moon sprites/textures once after UI wiring
try {
    preloadMoons();
} catch (e) {}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2(2, 2);
let hoveredMoon = null;
let pointerDirty = false;
let __lastRaycastAt = 0;
let __raycastPauseUntil = 0;
let __lastCursor = "default";
renderer.domElement.addEventListener("pointermove", ev => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    pointerDirty = true;
});
renderer.domElement.addEventListener("pointerleave", () => {
    pointer.set(2, 2);
    pointerDirty = true;
});
// Open the hovered moon's link on click, like an anchor tag
renderer.domElement.addEventListener("click", ev => {
    const rect = renderer.domElement.getBoundingClientRect();
    const mx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const my = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    const candidates = [...projectMoons.filter(m => m?.material?.opacity > 0), ...publicationsMoons.filter(m => m?.material?.opacity > 0)];
    if (!candidates.length) return;
    raycaster.setFromCamera({ x: mx, y: my }, camera);
    const hits = raycaster.intersectObjects(candidates, false);
    if (!hits.length) return;
    let obj = hits[0].object;
    if (obj && obj.userData?.baseSprite) obj = obj.userData.baseSprite;

    // First, if overlay link hotspots exist, check if the click hits one of them
    const hotspots = obj?.userData?.linkHotspots;
    const canvasSize = obj?.userData?.overlayCanvasSize;
    if (Array.isArray(hotspots) && hotspots.length && typeof canvasSize === "number" && canvasSize > 0) {
        const openHotspotLinkIfAny = (sprite, clientX, clientY) => {
            // Compute sprite's screen-space rect in pixels
            const centerWorld = sprite.getWorldPosition(new THREE.Vector3());
            const toScreen = v3 => {
                const v = v3.clone().project(camera);
                return {
                    x: (v.x * 0.5 + 0.5) * rect.width,
                    y: (-v.y * 0.5 + 0.5) * rect.height,
                };
            };
            // Camera basis (world space)
            const camX = new THREE.Vector3();
            const camY = new THREE.Vector3();
            const camZ = new THREE.Vector3();
            camera.matrixWorld.extractBasis(camX, camY, camZ);
            const halfW = (sprite.scale.x || 1) * 0.5;
            const halfH = (sprite.scale.y || 1) * 0.5;
            const pC = toScreen(centerWorld);
            const pR = toScreen(centerWorld.clone().add(camX.clone().multiplyScalar(halfW)));
            const pU = toScreen(centerWorld.clone().add(camY.clone().multiplyScalar(halfH)));
            const hwPx = Math.abs(pR.x - pC.x);
            const hhPx = Math.abs(pU.y - pC.y);
            const left = pC.x - hwPx;
            const top = pC.y - hhPx;
            const width = hwPx * 2;
            const height = hhPx * 2;
            const px = clientX - rect.left;
            const py = clientY - rect.top;
            if (px < left || px > left + width || py < top || py > top + height) return null;
            // Map to overlay canvas coordinates
            const u = (px - left) / Math.max(1, width);
            const v = (py - top) / Math.max(1, height);
            const cx = u * canvasSize;
            const cy = v * canvasSize;
            const pad = Math.max(2, Math.round(canvasSize * 0.012));
            for (let i = 0; i < hotspots.length; i++) {
                const h = hotspots[i];
                if (cx >= h.x - pad && cx <= h.x + h.w + pad && cy >= h.y - pad && cy <= h.y + h.h + pad) {
                    return h.href || null;
                }
            }
            return null;
        };
        const link = openHotspotLinkIfAny(obj, ev.clientX, ev.clientY);
        if (link && typeof link === "string") {
            try {
                window.open(link, "_blank", "noopener,noreferrer");
            } catch (e) {}
            return;
        }
    }
    // If pills exist, disable default moon click (only buttons are clickable)
    const hasPills = Array.isArray(obj?.userData?.linkHotspots) && obj.userData.linkHotspots.length;
    if (!hasPills) {
        // Fallback: open the sprite's default link
        const href = obj?.userData?.href;
        if (href && typeof href === "string") {
            try {
                window.open(href, "_blank", "noopener,noreferrer");
            } catch (e) {}
        }
    }
});
// Keyboard activate when a moon is hovered (Enter/Space)
window.addEventListener("keydown", ev => {
    if (!hoveredMoon) return;
    if (ev.key === "Enter" || ev.key === " ") {
        // If pills exist, do not trigger default link via keyboard
        const hasPills = Array.isArray(hoveredMoon?.userData?.linkHotspots) && hoveredMoon.userData.linkHotspots.length;
        if (!hasPills) {
            const href = hoveredMoon?.userData?.href;
            if (href && typeof href === "string") {
                try {
                    window.open(href, "_blank", "noopener,noreferrer");
                } catch (e) {}
            }
        }
    }
});
function render(now) {
    // Initialize time origin and avoid a large first-frame dt
    if (__t0 === null) {
        __t0 = now;
        lastTime = now;
    }
    const dt = Math.max(0, (now - lastTime) / 1000);
    lastTime = now;
    // Update smoothed FPS estimate
    const fps = dt > 0 ? 1 / dt : 60;
    __fpsEMA = __fpsEMA * 0.9 + fps * 0.1;
    // Skip heavy updates when the page is hidden
    if (document.hidden) {
        controls.update();
        renderer.render(scene, camera);
        requestAnimationFrame(render);
        return;
    }
    planetSpecs.forEach((spec, idx) => {
        const p = planets[idx];
        // Update elliptical orbit only when not frozen; keep initial placement otherwise
        if (!__orbitsFrozen) {
            // Mean anomaly progresses based on time elapsed since unfreeze to avoid initial jump
            const elapsedSec = (now - __t0) / 1000;
            const M = (p?.M0 || 0) + elapsedSec * spec.speed * TAU;
            const E = solveKeplerE(M, spec.e);
            const nu = trueAnomalyFromE(E, spec.e);
            const pos = elementsToWorldPosition(spec.dist, spec.e, spec.incDeg, spec.OmegaDeg, spec.omegaDeg, nu);
            p.group.position.set(pos.x, pos.y, pos.z);
        }
        // Spin based on sidereal day length (retrograde handled by sign)
        p.mesh.rotation.y += (p.spinRate || 0) * dt;
        if (p.clouds) {
            let cloudSpin;
            if (p.spec.name === "Venus") {
                // Venus super-rotation: opposite sign to surface (retrograde), much faster
                // If spinRate is negative (retrograde), make clouds positive and ~60x magnitude
                const base = Math.abs(p.spinRate || 0) * (p.cloudRotSpeed || 60);
                cloudSpin = base; // rotate eastward
            } else {
                cloudSpin = (p.spinRate || 0) * 0.9; // slight drift for Earth-like clouds
            }
            p.clouds.rotation.y += cloudSpin * dt;
        }
    });

    sun.rotation.y += 0.05 * (Math.PI / 180) * dt;
    if (sun.material && sun.material.emissiveMap) {
        const off = sun.material.emissiveMap.offset;
        off.x = (off.x + dt * 0.003) % 1;
        off.y = 0;
        // No needsUpdate or wrap changes required each frame
    }

    // (Removed duplicate cloud rotation; handled in planet update above)

    const updateMoonPositions = arr => {
        arr.forEach(m => {
            if (!m) return;
            // If frozen (e.g., during fade-out), keep current position unchanged
            if (m.userData?.freezePos) return;
            const anim = m.userData?.anim;
            if (anim) {
                const tNow = now - anim.startTime;
                // Start fade-in exactly when the animation begins
                if (tNow > 0 && m.material && !m.userData?.fadeStarted) {
                    if (!m.userData) m.userData = {};
                    m.userData.fadeStarted = true;
                    m.material.transparent = true;
                    gsap.to(m.material, { opacity: 1, duration: 0.3, overwrite: true });
                }
                if (tNow <= 0) {
                    // Not started yet
                    m.position.copy(anim.startDir).multiplyScalar(anim.startR);
                } else if (anim.phase === "entryOrbit") {
                    const t = Math.min(1, tNow / anim.entryDur);
                    const kRad = easeOutCubic(t);
                    // Keep angular velocity constant during the orbit for smoothness; spacing comes from staggered start times
                    const angle = lerp(anim.orbitStartAngle, anim.orbitEndAngle, t);
                    const dir = dirFromAngle(angle, anim.right, anim.up);
                    // Keep a fixed safe radius during the orbit to avoid intersecting the planet
                    const rad = anim.startR;
                    m.position.copy(dir.multiplyScalar(rad));
                    if (t >= 1) {
                        // Immediately start settling after completing exactly one orbit
                        anim.phase = "settle";
                        anim.settleStartTime = now;
                        anim.settleStartAngle = angle;
                        // Start settling from the orbit radius toward the target plane radius
                        anim.settleStartPlaneR = anim.startR;
                        anim.settleStartY = 0;
                    }
                } else if (anim.phase === "orbit") {
                    // Legacy path no longer used when settling immediately after one orbit; keep as fallback
                    const omega = (anim.orbitEndAngle - anim.orbitStartAngle) / Math.max(1, anim.entryDur);
                    const angle = (anim.orbitLoopStartAngle ?? anim.orbitEndAngle) + omega * (now - (anim.orbitLoopStartTime || now));
                    const dir = dirFromAngle(angle, anim.right, anim.up);
                    m.position.copy(dir.multiplyScalar(anim.targetPlaneR));
                } else if (anim.phase === "settle") {
                    const t = Math.min(1, (now - anim.settleStartTime) / anim.settleDur);
                    // Smooth angular deceleration using cubic Hermite with initial slope matched to orbit
                    const startAng = anim.settleStartAngle ?? anim.orbitEndAngle;
                    const delta = angleDiffShortest(startAng, anim.targetAngle);
                    const omegaEntry = (anim.orbitEndAngle - anim.orbitStartAngle) / Math.max(1, anim.entryDur); // rad/ms
                    // Normalize initial slope to the segment length
                    const vNormRaw = (omegaEntry * (anim.settleDur || 1)) / Math.max(1e-3, Math.abs(delta));
                    const vNorm = Math.sign(delta) * Math.min(1.0, Math.abs(vNormRaw)); // clamp to avoid overshoot
                    const s = hermite01(t, vNorm, 0);
                    const angle = startAng + delta * s;
                    // Ease planar radius and vertical height for a soft transition
                    const kPos = easeOutCubic(t);
                    const rPlane = lerp(anim.settleStartPlaneR ?? anim.targetPlaneR, anim.targetPlaneR ?? anim.targetPlaneR, kPos);
                    const y = lerp(anim.settleStartY ?? 0, anim.targetY ?? 0, kPos);
                    const dirXZ = dirFromAngle(angle, anim.right, anim.up);
                    m.position.set(dirXZ.x * rPlane, y, dirXZ.z * rPlane);
                    if (t >= 1) {
                        // Done: snap to final offset and clear anim
                        if (m.userData?.offset) m.position.copy(m.userData.offset);
                        m.userData.anim = null;
                        // Release sequencer to allow next moon to settle
                        if (arr && typeof arr.__settleCursor === "number") {
                            arr.__settleActive = false;
                            const total = Array.isArray(arr.__settleOrder) ? arr.__settleOrder.length : arr.length;
                            arr.__settleCursor = Math.min((arr.__settleCursor || 0) + 1, total);
                        }
                    }
                }
            } else if (m.userData?.offset && !m.userData?.freezePos) {
                m.position.copy(m.userData.offset);
            }
        });
    };
    const runSettleSequencer = (list, nowMs) => {
        if (!list || !list.length) return;
        if (list.__settleActive) return;
        const cursor = list.__settleCursor || 0;
        if (cursor >= list.length) return;
        const idx = Array.isArray(list.__settleOrder) ? list.__settleOrder[cursor] : cursor;
        const m = list[idx];
        const anim = m && m.userData && m.userData.anim;
        if (anim && anim.phase === "orbit") {
            // Capture current angle to ensure seamless transition
            const omega = (anim.orbitEndAngle - anim.orbitStartAngle) / Math.max(1, anim.entryDur); // rad/ms
            const currAngle = (anim.orbitLoopStartAngle ?? anim.orbitEndAngle) + omega * (nowMs - (anim.orbitLoopStartTime || nowMs));
            anim.phase = "settle";
            anim.settleStartTime = nowMs;
            anim.settleStartAngle = currAngle;
            anim.settleStartPlaneR = anim.targetR;
            anim.settleStartY = 0;
            list.__settleActive = true;
        }
    };
    if (projectMoons.length && planets[1]) {
        updateMoonPositions(projectMoons);
        runSettleSequencer(projectMoons, now);
    }
    if (publicationsMoons.length && planets[3]) {
        updateMoonPositions(publicationsMoons);
        runSettleSequencer(publicationsMoons, now);
    }

    if (projectMoons.length || publicationsMoons.length) {
        const inside = pointer.x >= -1 && pointer.x <= 1 && pointer.y >= -1 && pointer.y <= 1;
        if (pointerDirty && inside && performance.now() > __raycastPauseUntil) {
            if (now - __lastRaycastAt >= 12) {
                // ~30Hz
                const hoverCandidates = [...projectMoons.filter(m => m.material.opacity > 0), ...publicationsMoons.filter(m => m.material.opacity > 0)];
                if (hoverCandidates.length) {
                    raycaster.setFromCamera(pointer, camera);
                    const intersects = raycaster.intersectObjects(hoverCandidates, false);
                    let obj = intersects.length ? intersects[0].object : null;
                    if (obj && obj.userData?.baseSprite) obj = obj.userData.baseSprite;
                    // Determine pill hover for overlays with link buttons
                    let pillHoverIndex = -1;
                    if (obj) {
                        const hotspots = obj?.userData?.linkHotspots;
                        const canvasSize = obj?.userData?.overlayCanvasSize;
                        if (Array.isArray(hotspots) && hotspots.length && typeof canvasSize === "number") {
                            const rect = renderer.domElement.getBoundingClientRect();
                            const clientX = (pointer.x + 1) * 0.5 * rect.width + rect.left;
                            const clientY = (-pointer.y + 1) * 0.5 * rect.height + rect.top;
                            const toScreen = v3 => {
                                const v = v3.clone().project(camera);
                                return { x: (v.x * 0.5 + 0.5) * rect.width, y: (-v.y * 0.5 + 0.5) * rect.height };
                            };
                            const centerWorld = obj.getWorldPosition(new THREE.Vector3());
                            const camX = new THREE.Vector3();
                            const camY = new THREE.Vector3();
                            const camZ = new THREE.Vector3();
                            camera.matrixWorld.extractBasis(camX, camY, camZ);
                            const halfW = (obj.scale.x || 1) * 0.5;
                            const halfH = (obj.scale.y || 1) * 0.5;
                            const pC = toScreen(centerWorld);
                            const pR = toScreen(centerWorld.clone().add(camX.clone().multiplyScalar(halfW)));
                            const pU = toScreen(centerWorld.clone().add(camY.clone().multiplyScalar(halfH)));
                            const hwPx = Math.abs(pR.x - pC.x);
                            const hhPx = Math.abs(pU.y - pC.y);
                            const left = pC.x - hwPx;
                            const top = pC.y - hhPx;
                            const width = hwPx * 2;
                            const height = hhPx * 2;
                            const px = clientX - rect.left;
                            const py = clientY - rect.top;
                            if (px >= left && px <= left + width && py >= top && py <= top + height) {
                                const u = (px - left) / Math.max(1, width);
                                const v = (py - top) / Math.max(1, height);
                                const cx = u * canvasSize;
                                const cy = v * canvasSize;
                                const pad = Math.max(2, Math.round(canvasSize * 0.012));
                                for (let i = 0; i < hotspots.length; i++) {
                                    const h = hotspots[i];
                                    if (cx >= h.x - pad && cx <= h.x + h.w + pad && cy >= h.y - pad && cy <= h.y + h.h + pad) {
                                        pillHoverIndex = i;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    if (obj !== hoveredMoon) {
                        if (hoveredMoon) {
                            if (hoveredMoon.userData) hoveredMoon.userData.isHovered = false;
                            if (hoveredMoon.userData?.overlay?.material) gsap.to(hoveredMoon.userData.overlay.material, { opacity: 0, duration: 0.2, overwrite: true });
                            // Clear previous pill hover highlight if any
                            if (hoveredMoon.userData?.overlay?.userData?.draw) {
                                hoveredMoon.userData.overlay.userData.hoverIndex = -1;
                                hoveredMoon.userData.overlay.userData.draw(-1);
                            }
                        }
                        hoveredMoon = obj;
                        if (hoveredMoon) {
                            if (hoveredMoon.userData) hoveredMoon.userData.isHovered = true;
                            if (hoveredMoon.userData?.overlay?.material) gsap.to(hoveredMoon.userData.overlay.material, { opacity: 1, duration: 0.2, overwrite: true });
                        }
                    }
                    // Redraw overlay with hover style for pills (if present)
                    if (obj && obj.userData?.overlay && typeof obj.userData.overlay.userData?.draw === "function") {
                        const prevIdx = typeof obj.userData.overlay.userData.hoverIndex === "number" ? obj.userData.overlay.userData.hoverIndex : -1;
                        if (prevIdx !== pillHoverIndex) {
                            obj.userData.overlay.userData.hoverIndex = pillHoverIndex;
                            obj.userData.overlay.userData.draw(pillHoverIndex);
                        }
                    }
                    // Update cursor: pointer on pills; pointer on moon without pills; default otherwise
                    try {
                        const hasPills = Array.isArray(obj?.userData?.linkHotspots) && obj.userData.linkHotspots.length;
                        const desired = hasPills ? (pillHoverIndex >= 0 ? "pointer" : "default") : obj ? "pointer" : "default";
                        if (desired !== __lastCursor) {
                            renderer.domElement.style.cursor = desired;
                            __lastCursor = desired;
                        }
                    } catch (e) {}
                }
                __lastRaycastAt = now;
                pointerDirty = false;
            }
        } else if (!inside && hoveredMoon) {
            if (hoveredMoon.userData) hoveredMoon.userData.isHovered = false;
            if (hoveredMoon.userData?.overlay?.material) gsap.to(hoveredMoon.userData.overlay.material, { opacity: 0, duration: 0.2, overwrite: true });
            if (hoveredMoon.userData?.overlay?.userData?.draw) {
                hoveredMoon.userData.overlay.userData.hoverIndex = -1;
                hoveredMoon.userData.overlay.userData.draw(-1);
            }
            hoveredMoon = null;
            try {
                if (__lastCursor !== "default") {
                    renderer.domElement.style.cursor = "default";
                    __lastCursor = "default";
                }
            } catch (e) {}
        }
    }

    // Keep moons a constant size on screen: compute world scale from camera FOV and distance
    const fovRad = (camera.fov * Math.PI) / 180;
    const pxToWorld = dist => {
        // worldUnitsPerPixel = (2 * dist * tan(fov/2)) / viewportHeightPixels
        const worldPerPixel = (2 * dist * Math.tan(fovRad / 2)) / renderer.domElement.clientHeight;
        return worldPerPixel;
    };
    const applyScreenSpaceScale = (arr, planetIndex) => {
        if (!arr.length) return;
        const planet = planets[planetIndex];
        if (!planet) return;
        arr.forEach(m => {
            const bs = m.userData?.baseScale;
            if (!bs) return;
            const hf = m.userData?.isHovered ? 1.35 : 1.0;
            if (m.userData?.lockScale && typeof m.userData.baseWorldSize === "number") {
                // Keep the world size fixed (computed for final camera position), only apply hover multiplier
                const w = m.userData.baseWorldSize * hf;
                m.scale.set(w, w, 1);
            } else {
                // Fallback: constant-pixel sizing if not locked
                const basePx = m.userData?.basePx || 64;
                const camToMoon = camera.position.distanceTo(m.getWorldPosition(__vTemp3.set(0, 0, 0)));
                const wpp = pxToWorld(camToMoon);
                const targetWorldSize = basePx * wpp;
                const sx = targetWorldSize * hf;
                const sy = targetWorldSize * hf;
                m.scale.set(sx, sy, 1);
            }
        });
    };
    applyScreenSpaceScale(projectMoons, 1);
    applyScreenSpaceScale(publicationsMoons, 3);

    if (followTarget && !__isAnimatingCam) {
        const targetPos = followTarget.getWorldPosition(__vTemp3.set(0, 0, 0));
        const desiredCamPos = targetPos.clone().add(followOffset);
        const lambda = 6.0;
        const k = 1 - Math.exp(-lambda * dt);
        camera.position.lerp(desiredCamPos, k);
        controls.target.lerp(targetPos, k);
    }
    if (!followTarget && !__isAnimatingCam) {
        __stopFollowingMode();
    }

    // Dynamic resolution scaling (DRS) with hysteresis
    {
        const tNow = now;
        const canChange = tNow - __lastDRSChange > 1200; // 1.2s guard
        const lowThresh = 40;
        const highThresh = 55;
        if (canChange) {
            let nextPR = __targetPR;
            if (__fpsEMA < lowThresh) nextPR = Math.max(__PR_MIN, __targetPR * 0.9);
            else if (__fpsEMA > highThresh) nextPR = Math.min(__PR_MAX, __targetPR * 1.05);
            nextPR = Math.max(__PR_MIN, Math.min(__PR_MAX, nextPR));
            if (Math.abs(nextPR - __targetPR) > 0.02) {
                __targetPR = nextPR;
                __setRendererPixelRatio(__targetPR);
                __lastDRSChange = tNow;
            }
        }
    }

    // Low-FPS adaptive mode: disable clouds and displacement when very slow; re-enable after recovery
    {
        const tNow = now;
        const canToggle = tNow - __lastLowModeToggleAt > 1500; // 1.5s guard
        const enterThresh = 24;
        const exitThresh = 36;
        if (canToggle) {
            if (!__lowMode && __fpsEMA < enterThresh) {
                __lowMode = true;
                __enterLowMode();
                __lastLowModeToggleAt = tNow;
            } else if (__lowMode && __fpsEMA > exitThresh) {
                __lowMode = false;
                __exitLowMode();
                __lastLowModeToggleAt = tNow;
            }
        }
    }

    controls.update();
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.render(scene, camera);
    requestAnimationFrame(render);
}

// Start animation immediately; unfreeze orbital motion once initial textures finish loading
(function gateStart() {
    // Begin rendering right away (keeps group hidden to avoid jank)
    planetGroup.visible = true;
    requestAnimationFrame(t => {
        render(t);
    });
    const reveal = () => {
        // Snap progress UI to 100% just before hiding for a clean finish
        if (__preRing) {
            if (__isMoonPreloader) {
                try {
                    __preRing.style.setProperty("--p", "1");
                } catch {}
                __preRing.setAttribute?.("aria-valuenow", "100");
            } else if (typeof __ringCirc === "number" && __ringCirc > 0) {
                __preRing.style.strokeDashoffset = "0";
                (__preRing.parentElement || __preRing).setAttribute?.("aria-valuenow", "100");
            }
        }
        if (__preText) __preText.textContent = "100%";
        setTimeout(() => {
            // Unfreeze and reveal scene, fade out preloader if present
            __orbitsFrozen = false;
            const t = performance.now();
            __t0 = t;
            lastTime = t;
            try {
                const pre = document.getElementById("preloader");
                if (pre) pre.classList.add("hide");
                document.body?.classList?.remove?.("is-loading");
            } catch {}
        }, 1000);
    };

    if (!__loadPromises.length) {
        // Also wait a microtask to let layout settle, then reveal
        Promise.resolve().then(() => reveal());
        return;
    }
    // When all tracked loads settle, enable orbital motion and reset time anchor to avoid a jump
    Promise.allSettled(__loadPromises).then(() => {
        // Next frame to avoid popping mid-frame
        requestAnimationFrame(() => reveal());
    });
})();

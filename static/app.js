import * as THREE from "three";

const menuBtn = document.getElementById('menu-btn');
const mobileMenu = document.getElementById('mobile-menu');
const mobileLinks = document.querySelectorAll('.mobile-link');

if(menuBtn && mobileMenu) {
    menuBtn.addEventListener('click', () => {
        mobileMenu.classList.toggle('open');
        // Animate hamburger to X
        menuBtn.classList.toggle('active');
    });

    // Close menu when link is clicked
    mobileLinks.forEach(link => {
        link.addEventListener('click', () => {
            mobileMenu.classList.remove('open');
            menuBtn.classList.remove('active');
        });
    });
}

// --- 1. UTILITIES FOR PROCEDURAL TEXTURES (Sun) ---
function generateGlowTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.2, 'rgba(255, 200, 100, 0.6)');
    gradient.addColorStop(0.5, 'rgba(100, 50, 0, 0.2)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
}

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
function hash3(xi, yi, zi, seed) {
    let h = xi * 374761393 + yi * 668265263 + zi * 2147483647 + seed * 144269;
    h = (h ^ (h >>> 13)) * 1274126177;
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
}
function valueNoise3(x, y, z, seed) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
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
function fbmPeriodic3D(u, v, seed, scaleU = 1, scaleV = 1, octaves = 5, lac = 2, gain = 0.5) {
    const TAU = Math.PI * 2;
    const t = u * TAU;
    const phi = v * Math.PI;
    const sinPhi = Math.sin(phi);
    const sx = Math.cos(t) * sinPhi;
    const sy = Math.sin(t) * sinPhi;
    const sz = Math.cos(phi);
    const baseScale = (scaleU + scaleV) * 0.5;
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
        sum += amp * valueNoise3(sx * baseScale * freq + i * 0.73, sy * baseScale * freq + i * 1.11, sz * baseScale * freq + i * 0.57, seed + i * 101);
        norm += amp;
        amp *= gain;
        freq *= lac;
    }
    return sum / norm;
}
function makeCanvasTexture(w, h, draw) {
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
    tex.anisotropy = ANISO;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
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
                const cA = 0x8a2a00, cB = 0xff7a00, cC = 0xffe066;
                const mid = lerpColor(cA, cB, t);
                const col = lerpColor(mid, cC, t * t * 0.7);
                const i = (y * W + x) * 4;
                const [r, g, b, a] = toRGBA(col);
                data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
            }
        }
    });
}

// --- 2. SETUP ---
const EXTRA_HEIGHT = 100; // pixels beyond viewport
const canvas = document.getElementById("bg");

// PERF: single place to tune how expensive the scene is.
const IS_MOBILE = /Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && Math.min(window.innerWidth, window.innerHeight) < 900);

const MAX_DPR = IS_MOBILE ? 1.5 : 2;          // hard ceiling on render resolution
const ANISO = IS_MOBILE ? 2 : 4;              // 16x anisotropy costs a lot for no visible gain here
const MAX_TEX_SIZE = IS_MOBILE ? 1024 : 2048; // 4K planet maps get downscaled once at load
const SPHERE_SEG_W = IS_MOBILE ? 32 : 48;     // 64x64 spheres were ~8k triangles each
const SPHERE_SEG_H = IS_MOBILE ? 16 : 32;
const RING_SEG = IS_MOBILE ? 64 : 96;

const renderer = new THREE.WebGLRenderer({
    canvas,
    // MSAA at DPR 2 is the most expensive single setting on mobile GPUs
    antialias: !IS_MOBILE,
    alpha: false,
    stencil: false,
    powerPreference: "high-performance"
});

// PERF: adaptive resolution. If the GPU falls behind, step the pixel ratio down
// (and back up when it recovers) instead of dropping frames.
const DPR_STEPS = [Math.min(window.devicePixelRatio || 1, MAX_DPR), 1.5, 1.25, 1.0, 0.75]
    .filter((v, i, arr) => i === 0 || v < arr[0]);
let dprIndex = 0;

renderer.setPixelRatio(DPR_STEPS[0]);
renderer.setSize(window.innerWidth, window.innerHeight + EXTRA_HEIGHT);

let qualityAccum = 0;
let qualitySamples = 0;
let warmupFrames = 90;  // ignore the first ~1.5s (texture uploads, GSAP intro)
let upgradeBudget = 2;  // limits flip-flopping between two levels

function updateAdaptiveQuality(dt) {
    if (warmupFrames > 0) { warmupFrames--; return; }

    qualityAccum += dt;
    qualitySamples++;
    if (qualitySamples < 45) return;

    const avg = qualityAccum / qualitySamples;
    qualityAccum = 0;
    qualitySamples = 0;

    if (avg > 1 / 45 && dprIndex < DPR_STEPS.length - 1) {
        dprIndex++;                                   // below 45fps -> drop resolution
        renderer.setPixelRatio(DPR_STEPS[dprIndex]);
    } else if (avg < 1 / 58 && dprIndex > 0 && upgradeBudget > 0) {
        dprIndex--;                                   // comfortably above 58fps -> give it back
        upgradeBudget--;
        renderer.setPixelRatio(DPR_STEPS[dprIndex]);
    }
}

// Using ACESFilmicToneMapping to handle bright highlights on planets nicely
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// Faint fog to blend distant planets into darkness
scene.fog = new THREE.FogExp2(0x000000, 0.0008);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / (window.innerHeight + EXTRA_HEIGHT), 0.1, 50000);

// --- Intro Animation State ---
let isIntroPlaying = true;
let introLookAt = new THREE.Vector3(0, 55, 0); 

// Cinematic Initial Camera Position
// By starting high and looking straight ahead, the sun (at 0,0,0) starts at the bottom of the screen.
camera.position.set(0, 55, 45);
camera.lookAt(introLookAt);

// --- 3. ASSETS & TEXTURES ---
const loadingManager = new THREE.LoadingManager();
const progressBar = document.getElementById('progress-bar');
const preloader = document.getElementById('preloader');

loadingManager.onProgress = (url, loaded, total) => {
    const progress = (loaded / total) * 100;
    if (progressBar) progressBar.style.width = progress + '%';
};

loadingManager.onLoad = () => {
    // Prevent CSS transitions from fighting GSAP during initial load
    document.querySelectorAll('#hero .content-block, .planet-horizon').forEach(el => {
        el.style.transition = 'none';
    });

    // Setup initial hidden states for UI components
    gsap.set("nav", { y: -30, opacity: 0 });
    gsap.set("#hero .content-block", { y: 30, opacity: 0 });
    gsap.set(".deco-line-vertical", { scaleY: 0, opacity: 0, transformOrigin: "top" });
    gsap.set(".sys-status", { x: 20, opacity: 0 });
    gsap.set(".hud-footer", { y: 20, opacity: 0 });
    gsap.set(".scroll-indicator", { opacity: 0 });
    gsap.set("#planet-horizon", { opacity: 0, scale: 0.8 });

    if (preloader) {
        // Fade out preloader
        preloader.classList.add('loaded');
    }

    // Lock scrolling until cinematic is done
    // Not body html to prevent weird mobile issues where scroll still happens on some browsers
    document.documentElement.style.overflow = 'hidden';

    // Cinematic GSAP Timeline
     const tl = gsap.timeline({
        onComplete: () => {
            isIntroPlaying = false;
            document.documentElement.style.overflow = ''; // Restore scroll
            
            // Clean up inline transitions so normal CSS styling takes back over
            document.querySelectorAll('#hero .content-block, .planet-horizon').forEach(el => {
                el.style.transition = '';
                el.style.transform = '';
            });
            gsap.set("#hero .content-block", { clearProps: "all" });

            // Initialize intersection observers to track normal scroll
            initScroll();
        }
    });

    // --- PHASE 1: THE RISE (0s to 2s) ---
    // Camera literally moves down on the Y axis, causing the sun to physically rise into the center of the frame
    tl.to(starUniforms.introProgress, {
        value: 1.0,
        duration: 2.0,
        ease: "power2.inOut"
    }, 0)
    
    .to(camera.position, {
        y: 0,
        duration: 2.0,
        ease: "sine.inOut",
        onUpdate: () => {
            introLookAt.y = camera.position.y;
            camera.lookAt(introLookAt);
        }
    }, 2)

    // --- PHASE 2: THE PULLBACK (2s to 5s) ---
    // Smoothly backs out into the system overview position
    .to(camera.position, {
        x: views.overview.pos.x,
        y: views.overview.pos.y,
        z: views.overview.pos.z,
        duration: 3.0,
        ease: "sine.inOut", 
        onUpdate: () => {
            camera.lookAt(introLookAt);
            camPos.copy(camera.position); 
            camLook.copy(introLookAt);
        }
    }, 4.0)
    .to(introLookAt, {
        x: views.overview.lookAt.x,
        y: views.overview.lookAt.y,
        z: views.overview.lookAt.z,
        duration: 3.0,
        ease: "sine.inOut"
    }, 4.0)

    // --- SYSTEM ONLINE (UI Cascade) ---
    // UI elements fade in elegantly as the camera settles at the end of the 5s window
    .to("#planet-horizon", { opacity: 0.6, scale: 1, duration: 1.5, ease: "power1.out" }, 5.0)
    .to("nav", { y: 0, opacity: 1, duration: 1.0, ease: "power1.out" }, 5.3)
    .to("#hero .content-block", { y: 0, opacity: 1, duration: 1.0, ease: "power1.out" }, 5.5)
    .to(".deco-line-vertical", { scaleY: 1, opacity: 1, duration: 0.8, ease: "power1.out" }, 5.7)
    .to(".sys-status", { x: 0, opacity: 1, duration: 0.8, ease: "power1.out" }, 5.9)
    .to(".hud-footer", { y: 0, opacity: 1, duration: 0.8, ease: "power1.out" }, 6.1)
    .to(".scroll-indicator", { opacity: 0.5, duration: 1.0, ease: "power1.out" }, 6.3);
};

const textureLoader = new THREE.TextureLoader(loadingManager);
const IMAGE_BASE = "static/img/";

// Helper to load texture with correct settings
// PERF: a 4K map costs ~45MB of VRAM (more with mipmaps) and thrashes the
// texture cache on integrated/mobile GPUs. Downscale once, then upload it
// straight away so nothing has to be streamed in mid-scroll.
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
    // upload now rather than on the frame it first becomes visible
    if (typeof renderer.initTexture === 'function') renderer.initTexture(tex);
    return tex;
}

const loadTex = (path, srgb = true) => {
    const t = textureLoader.load(path, fitTexture);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return t;
};

// --- 4. SCENE OBJECTS ---

const planets = {};
let sun;
let starField;
let starUniforms = { 
    time: { value: 0 },
    introProgress: { value: 0.0 },
    warpFade: { value: 0.0 }   // stars recede while the streaks take over
};

// --- PLANET CREATION LOGIC ---

// Earth: Base + Bump + Clouds
const createEarth = () => {
    const grp = new THREE.Group();
    grp.position.set(200, 0, 0);

    // 1. Base Sphere (Albedo + Bump)
    const geo = new THREE.SphereGeometry(10, SPHERE_SEG_W, SPHERE_SEG_H);
    const mat = new THREE.MeshStandardMaterial({
        map: loadTex(IMAGE_BASE + "Earth/2_no_clouds_4k.jpg"),
        bumpMap: loadTex(IMAGE_BASE + "Earth/elev_bump_4k.jpg", false),
        bumpScale: 0.5,
        roughness: 0.8,
        metalness: 0.1
    });
    const mesh = new THREE.Mesh(geo, mat);
    grp.add(mesh);

    // 2. Clouds (Slightly larger sphere)
    const cloudGeo = new THREE.SphereGeometry(10.15, SPHERE_SEG_W, SPHERE_SEG_H);
    const cloudMat = new THREE.MeshStandardMaterial({
        map: loadTex(IMAGE_BASE + "Earth/fair_clouds_4k.png"),
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false // additive layer should never write depth
    });
    const cloudMesh = new THREE.Mesh(cloudGeo, cloudMat);
    grp.add(cloudMesh);

    scene.add(grp);
    planets['earth'] = { group: grp, mesh: mesh, clouds: cloudMesh, r: 10 };
};

// Mars: Base + Normal Map
const createMars = () => {
    const grp = new THREE.Group();
    grp.position.set(400, 0, 0);

    const geo = new THREE.SphereGeometry(8, SPHERE_SEG_W, SPHERE_SEG_H);
    const mat = new THREE.MeshStandardMaterial({
        map: loadTex(IMAGE_BASE + "Mars/Mars.png"),
        normalMap: loadTex(IMAGE_BASE + "Mars/MarsNormal.png", false),
        normalScale: new THREE.Vector2(1.5, 1.5),
        roughness: 0.7, // Dusty look
        metalness: 0.0
    });
    const mesh = new THREE.Mesh(geo, mat);
    grp.add(mesh);

    scene.add(grp);
    planets['mars'] = { group: grp, mesh: mesh, r: 8 };
};

// Jupiter: Simple Texture
const createJupiter = () => {
    const grp = new THREE.Group();
    grp.position.set(600, 0, 0);

    // ---- Jupiter sphere ----
    const geo = new THREE.SphereGeometry(18, SPHERE_SEG_W, SPHERE_SEG_H);
    const mat = new THREE.MeshStandardMaterial({
        map: loadTex(IMAGE_BASE + "Jupiter/realj2k.jpg"),
        bumpMap: loadTex(IMAGE_BASE + "Jupiter/jupiter-hubble-2015-bump.jpg", false),
        roughness: 0.5,
        metalness: 0.0
    });

    const mesh = new THREE.Mesh(geo, mat);
    grp.add(mesh);

    // ---- Rings geometry ----
    const innerRadius = 18 * 1.3;
    const outerRadius = 18 * 3.2;
    const ringGeo = new THREE.RingGeometry(innerRadius, outerRadius, RING_SEG);

    // UV remap for strip texture
    const pos = ringGeo.attributes.position;
    const uv = ringGeo.attributes.uv;
    const v3 = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
        v3.fromBufferAttribute(pos, i);
        const len = v3.length();
        const u = (len - innerRadius) / (outerRadius - innerRadius);
        uv.setXY(i, u, 0.5);
    }

    // ---- Rings texture ----
    // PERF (critical): this used to configure the texture inside tex.onUpdate and
    // set tex.needsUpdate / ringMat.needsUpdate from within that callback. three.js
    // fires onUpdate at the end of every upload, so it re-uploaded the ring texture
    // AND recompiled the ring shader on every frame, forever. Filter/wrap settings
    // are applied here instead - three reads them when it first uploads the texture.
    const tex = textureLoader.load(IMAGE_BASE + "Jupiter/JupiterRings.png", fitTexture);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.premultiplyAlpha = false;

    const ringMat = new THREE.MeshStandardMaterial({
        map: tex,
        side: THREE.DoubleSide,
        transparent: true,

        // Visibility tuning
        opacity: 1.0,
        alphaTest: 0.0,
        depthWrite: false,

        roughness: 0.5,
        metalness: 0.0,

        // Subtle brightness lift
        emissive: new THREE.Color(0x444444),
        emissiveIntensity: 0.8
    });

    // ---- Rings mesh ----
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.rotation.x = -Math.PI / 2;
    ringMesh.renderOrder = 1;

    mesh.add(ringMesh);

    const cloudGeo = new THREE.SphereGeometry(18.1, SPHERE_SEG_W, SPHERE_SEG_H);
    const cloudMat = new THREE.MeshStandardMaterial({
        map: loadTex(IMAGE_BASE + "Jupiter/jupiterclouds.png"),
        transparent: true,
        opacity: 0.55, // was declared twice; 0.55 was the one that applied
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
        roughness: 1.0,
        metalness: 0.0
    });
    const cloudMesh = new THREE.Mesh(cloudGeo, cloudMat);
    grp.add(cloudMesh);

    scene.add(grp);
    planets["jupiter"] = { group: grp, mesh: mesh, clouds: cloudMesh, r: 18 };
};

// Saturn: Base + Rings
const createSaturn = () => {
    const grp = new THREE.Group();
    grp.position.set(800, 0, 0);

    // 1. Planet
    const geo = new THREE.SphereGeometry(16, SPHERE_SEG_W, SPHERE_SEG_H);
    const mat = new THREE.MeshStandardMaterial({
        map: loadTex(IMAGE_BASE + "Saturn/th_saturn.png"),
        bumpMap: loadTex(IMAGE_BASE + "Saturn/th_saturnbump.png", false),
        bumpScale: 0.2,
        roughness: 0.6,
    });
    const mesh = new THREE.Mesh(geo, mat);
    grp.add(mesh); // shadow flags removed: renderer.shadowMap is disabled, so they did nothing

    // 2. Rings
    const ringGeo = new THREE.RingGeometry(22, 42, RING_SEG);
    const ringMat = new THREE.MeshStandardMaterial({
        map: loadTex(IMAGE_BASE + "Saturn/t00fri_gh_saturnrings.png"),
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85,
        roughness: 0.8
    });

    // Fix UVs for ring texture (radial mapping)
    const pos = ringGeo.attributes.position;
    const uv = ringGeo.attributes.uv;
    const v3 = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
        v3.fromBufferAttribute(pos, i);
        const len = v3.length();
        // Map radius to V coordinate (0 to 1)
        const u = (len - 22) / (42 - 22);
        uv.setXY(i, u, 0.5);
    }

    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    grp.add(ring);

    scene.add(grp);
    planets['saturn'] = { group: grp, mesh: mesh, r: 16 };
};

// --- 5. SCROLL INTERACTION LOGIC ---

// Define Camera States for each section
// We shift the lookAt target slightly left/right to make room for text
const views = {
    overview: {
        pos: new THREE.Vector3(0, 20, 90),
        lookAt: new THREE.Vector3(0, 0, 0)
    },
    earth: {
        pos: new THREE.Vector3(185, 5, 35), // Camera right of planet
        lookAt: new THREE.Vector3(200, 0, 15) // Look at Earth center
    },
    mars: {
        pos: new THREE.Vector3(375, 5, 20), // Camera left of planet
        lookAt: new THREE.Vector3(400, 0, 0)
    },
    jupiter: {
        pos: new THREE.Vector3(605, 10, 65),
        lookAt: new THREE.Vector3(600, 0, 0)
    },
    saturn: {
        pos: new THREE.Vector3(770, 10, 40),
        lookAt: new THREE.Vector3(800, 0, 0)
    }
};

// Section order, so the system knows whether you're travelling outward or inward
// and how many orbits a single jump crosses.
const VIEW_ORDER = ['overview', 'earth', 'mars', 'jupiter', 'saturn'];

// --- CINEMATIC FLIGHT SYSTEM ------------------------------------------------
// The old behaviour was a straight lerp toward a target, which reads as a flat
// slide: no departure, no arrival, no sense of speed. Instead each section change
// now builds a one-off flight path - a curve that lifts off the ecliptic, weaves
// past the planets in between, and settles into the destination from above.
// Everything else (FOV punch, star streaks, banking, vignette) is driven by the
// camera's actual velocity, so it stays in sync no matter how the path is built.

const BASE_FOV = camera.fov;
const BASE_EXPOSURE = renderer.toneMappingExposure;

// Smooth camera movement vars synced to intro lookAt initially
const camPos = new THREE.Vector3().copy(camera.position);
const camLook = new THREE.Vector3().copy(introLookAt);

const camVel = new THREE.Vector3();                      // world units / second
const prevPos = new THREE.Vector3().copy(camPos);
let warp = 0;              // 0..1 smoothed "how fast are we moving", drives all FX
let bank = 0;              // radians of roll into the turn
let orbitPhase = 0;        // idle drift once parked at a planet
let currentViewKey = 'overview';
let flight = null;

// Scratch vectors - allocating inside the render loop is the one thing that
// reliably causes GC hitches in a scroll-driven scene.
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

// Symmetric quart: gentle undock, hard acceleration through the middle
// (peak speed is 4x the average, which is what sells the warp), soft docking.
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

    // Long jumps (nav clicks that skip sections) get a bigger, slower arc than
    // neighbour-to-neighbour scrolling.
    const dur = THREE.MathUtils.clamp(1.15 + dist / 280, 1.3, 3.4);
    const arcH = THREE.MathUtils.clamp(dist * 0.22, 14, 95);

    // Direction of travel, flattened onto the ecliptic.
    _a.subVectors(view.pos, from);
    const flatDir = new THREE.Vector3(_a.x, 0, _a.z);
    if (flatDir.lengthSq() < 1e-6) flatDir.set(0, 0, 1);
    flatDir.normalize();

    // In-plane perpendicular: the path bows out to one side instead of running
    // dead straight down the orbit line, and alternates side per hop so a long
    // multi-planet run weaves rather than repeating the same curve.
    const side = new THREE.Vector3(-flatDir.z, 0, flatDir.x);
    const weaveSign = (Math.min(fromIdx, toIdx) % 2 === 0 ? 1 : -1) * (toIdx > fromIdx ? 1 : -1);
    const weave = dist * 0.14;

    // P1 leaves along the CURRENT velocity, so interrupting a flight mid-arc
    // (fast scrolling) blends instead of snapping.
    const p1 = from.clone()
        .addScaledVector(camVel, 0.18)
        .addScaledVector(flatDir, dist * 0.12)
        .addScaledVector(WORLD_UP, arcH * 0.35);

    const mid = from.clone().lerp(view.pos, 0.5)
        .addScaledVector(WORLD_UP, arcH)
        .addScaledVector(side, weave * weaveSign);

    // Approach from above and slightly behind the final framing, so the planet
    // rises into frame as the camera drops into place.
    _b.subVectors(view.pos, view.lookAt).normalize();
    const approach = view.pos.clone()
        .addScaledVector(_b, dist * 0.10)
        .addScaledVector(WORLD_UP, arcH * 0.30)
        .addScaledVector(side, weave * weaveSign * 0.25);

    const posCurve = new THREE.CatmullRomCurve3(
        [from, p1, mid, approach, view.pos.clone()], false, 'centripetal'
    );

    // The gaze leads the flight: it swings ahead into the direction of travel at
    // the midpoint - you see where you're going, not just where you were - then
    // settles onto the destination.
    const lookFrom = camLook.clone();
    const lookMid = lookFrom.clone().lerp(view.lookAt, 0.55)
        .addScaledVector(flatDir, dist * 0.20)
        .addScaledVector(WORLD_UP, -arcH * 0.22);
    const lookCurve = new THREE.CatmullRomCurve3(
        [lookFrom, lookMid, view.lookAt.clone()], false, 'centripetal'
    );

    // getPointAt() is arc-length parameterised, so the easing curve controls the
    // speed profile exactly instead of the control-point spacing doing it for us.
    posCurve.getLengths(48);
    lookCurve.getLengths(24);

    flight = { posCurve, lookCurve, t: 0, dur, bankDir: -weaveSign };
    orbitPhase = 0;
}

// --- Pointer parallax (desktop only) ---
let pointerX = 0, pointerY = 0, parX = 0, parY = 0;
if (!IS_MOBILE) {
    window.addEventListener('pointermove', (e) => {
        pointerX = (e.clientX / window.innerWidth) * 2 - 1;
        pointerY = (e.clientY / window.innerHeight) * 2 - 1;
    }, { passive: true });
}

// --- Speed vignette -------------------------------------------------------
// One fixed, compositor-only layer whose opacity tracks --warp. Move this into
// app.css if you'd rather keep styling out of the JS.
const warpVeil = document.createElement('div');
warpVeil.className = 'warp-veil';
const warpStyle = document.createElement('style');
warpStyle.textContent = `
:root { --warp: 0; --warp-x: 50%; --warp-y: 50%; }
.warp-veil {
    position: fixed;
    inset: 0;
    z-index: 50;
    pointer-events: none;
    opacity: var(--warp);
    background:
        radial-gradient(circle at var(--warp-x) var(--warp-y),
            rgba(198, 216, 255, 0.30) 0%,
            rgba(143, 169, 198, 0.10) 9%,
            rgba(3, 3, 5, 0) 30%),
        radial-gradient(ellipse at var(--warp-x) var(--warp-y),
            rgba(3, 3, 5, 0) 34%, rgba(3, 3, 5, 0.72) 100%);
    will-change: opacity;
}
@media (prefers-reduced-motion: reduce) {
    .warp-veil { display: none; }
}
`;
document.head.appendChild(warpStyle);
document.body.appendChild(warpVeil);
let lastWarpVar = -1;
let vanishX = 50, vanishY = 50;

// --- Warp streak field ----------------------------------------------------
// Camera-facing ribbons, not GL lines: line width is capped at 1px on nearly
// every driver, which is why the hairline version never read as cinematic.
// Each streak is a quad expanded in screen space along its own projected
// direction, so it has real thickness, a soft glow and a hot core.
let warpField = null;
const warpUniforms = {
    uCam: { value: new THREE.Vector3() },
    uDir: { value: new THREE.Vector3(0, 0, 1) },
    uLen: { value: 0 },
    uBox: { value: 300 },
    uThick: { value: 0.003 },
    uWarp: { value: 0 },
    uRes: { value: new THREE.Vector2(window.innerWidth, window.innerHeight + EXTRA_HEIGHT) },
    uOpacity: { value: 0 }
};

function createWarpField() {
    const COUNT = IS_MOBILE ? 700 : 2200;
    const BOX = warpUniforms.uBox.value;

    const positions = new Float32Array(COUNT * 4 * 3);
    const sides = new Float32Array(COUNT * 4);
    const alongs = new Float32Array(COUNT * 4);
    const seeds = new Float32Array(COUNT * 4);
    const indices = new Uint32Array(COUNT * 6);

    // quad corners: (side, along)
    const CORNER = [[-1, 0], [1, 0], [1, 1], [-1, 1]];

    for (let i = 0; i < COUNT; i++) {
        const x = Math.random() * BOX;
        const y = Math.random() * BOX;
        const z = Math.random() * BOX;
        // Bias the seed low so most streaks are fine and a few are fat and bright,
        // which is what stops the field looking like uniform noise.
        const seed = Math.pow(Math.random(), 1.6);

        for (let k = 0; k < 4; k++) {
            const j = i * 4 + k;
            positions[j * 3] = x;
            positions[j * 3 + 1] = y;
            positions[j * 3 + 2] = z;
            sides[j] = CORNER[k][0];
            alongs[j] = CORNER[k][1];
            seeds[j] = seed;
        }

        const o = i * 4;
        const t = i * 6;
        indices[t] = o; indices[t + 1] = o + 1; indices[t + 2] = o + 2;
        indices[t + 3] = o; indices[t + 4] = o + 2; indices[t + 5] = o + 3;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSide', new THREE.BufferAttribute(sides, 1));
    geo.setAttribute('aAlong', new THREE.BufferAttribute(alongs, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));

    const mat = new THREE.ShaderMaterial({
        uniforms: warpUniforms,
        vertexShader: `
            attribute float aSide;
            attribute float aAlong;
            attribute float aSeed;

            uniform vec3 uCam;
            uniform vec3 uDir;
            uniform float uLen;
            uniform float uBox;
            uniform float uThick;
            uniform float uWarp;
            uniform vec2 uRes;

            varying float vSide;
            varying float vAlong;
            varying float vSeed;
            varying float vFade;

            const float NEAR_Z = -0.5;

            void main() {
                // Infinite tiling: wrap the streak's anchor into a cube centred on
                // the camera, so the field always surrounds us without respawning.
                vec3 rel = mod(position - uCam, uBox) - uBox * 0.5;
                vec3 head = uCam + rel;
                float len = uLen * (0.5 + aSeed * 1.3);
                vec3 tail = head - uDir * len;

                vec4 vH = viewMatrix * vec4(head, 1.0);
                vec4 vT = viewMatrix * vec4(tail, 1.0);

                // Clip the tail against the near plane rather than dropping the whole
                // streak - otherwise long streaks pop out as they sweep past the lens.
                if (vT.z > NEAR_Z && vH.z < NEAR_Z) {
                    float k = (NEAR_Z - vH.z) / (vT.z - vH.z);
                    vT.xyz = mix(vH.xyz, vT.xyz, clamp(k, 0.0, 1.0));
                }

                vec4 cH = projectionMatrix * vH;
                vec4 cT = projectionMatrix * vT;

                // Build the ribbon in screen space so it holds a constant pixel width
                // however far away it is. This is what gives it body instead of the
                // hairline you get from GL_LINES.
                float aspect = uRes.x / max(uRes.y, 1.0);
                vec2 sH = cH.xy / max(cH.w, 1e-4);
                vec2 sT = cT.xy / max(cT.w, 1e-4);
                vec2 seg = vec2((sT.x - sH.x) * aspect, sT.y - sH.y);
                vec2 dir2 = normalize(seg + vec2(1e-5));
                vec2 nrm = vec2(-dir2.y / aspect, dir2.x);

                vec4 clip = projectionMatrix * mix(vH, vT, aAlong);
                float thick = uThick * (0.45 + aSeed * 1.0) * mix(1.0, 0.22, aAlong);
                clip.xy += nrm * aSide * thick * clip.w;

                float d = length(rel);
                float fade = smoothstep(uBox * 0.03, uBox * 0.16, d) *
                             (1.0 - smoothstep(uBox * 0.30, uBox * 0.50, d));

                // Thin out the vanishing point. Real warp shots keep the centre of
                // frame clear and throw the density out to the edges.
                float r = length(vec2(sH.x * aspect, sH.y));
                fade *= 0.18 + 0.82 * smoothstep(0.04, 0.50, r);

                // Staggered ignition: streaks light up in waves as speed builds
                // instead of the whole field switching on at once.
                fade *= smoothstep(aSeed * 0.5, aSeed * 0.5 + 0.3, uWarp);
                fade *= step(vH.z, NEAR_Z);

                vSide = aSide;
                vAlong = aAlong;
                vSeed = aSeed;
                vFade = fade;

                gl_Position = clip;
            }
`,
        fragmentShader: `
            uniform float uOpacity;
            varying float vSide;
            varying float vAlong;
            varying float vSeed;
            varying float vFade;

            void main() {
                // Soft glow across the ribbon with a blown-out core down the middle.
                float a = 1.0 - abs(vSide);
                float glow = pow(a, 2.2);
                float core = smoothstep(0.70, 1.0, a);
                float taper = pow(1.0 - vAlong, 1.5);
                float spark = smoothstep(0.88, 1.0, 1.0 - vAlong) * core;

                vec3 cool = vec3(0.55, 0.70, 1.00);
                vec3 gold = vec3(1.00, 0.82, 0.55);
                vec3 tint = mix(cool, gold, smoothstep(0.78, 1.0, vSeed));

                // Fake doppler: the leading end runs blue, the trail warms as it goes.
                vec3 col = mix(tint, tint * vec3(1.20, 0.94, 0.76), vAlong);
                col += vec3(core * 0.85 + spark * 1.3);

                float alpha = (glow * 0.50 + core * 0.85 + spark * 0.6) * taper * vFade * uOpacity;
                gl_FragColor = vec4(col, alpha);
            }
`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        // The screen-space expansion winds every quad clockwise, so FrontSide
        // (three's default) culls the entire field. Nothing to cull here anyway:
        // these are flat, additive and never write depth.
        side: THREE.DoubleSide
    });

    warpField = new THREE.Mesh(geo, mat);
    warpField.frustumCulled = false;   // positions are computed on the GPU
    warpField.visible = false;
    warpField.renderOrder = 2;
    scene.add(warpField);
}

function initScroll() {
    // Using IntersectionObserver to detect which section is active
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                // Highlight Nav
                const id = entry.target.id;
                document.querySelectorAll('.nav-links a').forEach(a => {
                    a.classList.remove('active');
                    if (a.getAttribute('href') === '#' + id) a.classList.add('active');
                });

                // Trigger Camera Move
                const planetKey = entry.target.dataset.planet;
                if (planetKey && views[planetKey]) {
                    flyTo(planetKey);

                    // Highlight Content
                    document.querySelectorAll('section').forEach(s => s.classList.remove('active'));
                    entry.target.classList.add('active');
                }
            }
        });
    }, {
        root: null,
        rootMargin: '-60% 0px -60% 0px', // reduce the root box to the middle 20% vertically
        threshold: 0
    });

    document.querySelectorAll('section').forEach(section => {
        observer.observe(section);
    });
}

// --- 6. RENDER LOOP ---
const clock = new THREE.Clock();
const planetHorizon = document.getElementById('planet-horizon');

// PERF: read scroll position from a passive listener. Reading window.scrollY /
// innerHeight inside the loop can force a style+layout flush every frame.
let scrollYCached = window.scrollY;
let viewportH = window.innerHeight;
let lastHorizonScroll = -1;
window.addEventListener('scroll', () => { scrollYCached = window.scrollY; }, { passive: true });

// Set to 60 if a high-refresh display gives you an unstable rate that feels
// worse than a locked 60. 0 = follow the display.
const MAX_FPS = 0;
let lastFrameTime = 0;

function animate(now = 0) {
    requestAnimationFrame(animate);

    if (MAX_FPS > 0 && now - lastFrameTime < (1000 / MAX_FPS) - 0.5) return;
    lastFrameTime = now;

    const dt = Math.min(clock.getDelta(), 0.1);
    updateAdaptiveQuality(dt);

    // 1. Rotate Planets for life
    if (planets.earth) {
        planets.earth.mesh.rotation.y += 0.05 * dt;
        // Rotate clouds slightly faster
        if (planets.earth.clouds) planets.earth.clouds.rotation.y += 0.07 * dt;
    }
    if (planets.mars) planets.mars.mesh.rotation.y += 0.04 * dt;
    if (planets.jupiter) {
        planets.jupiter.mesh.rotation.y += 0.02 * dt;
        if (planets.jupiter.clouds) planets.jupiter.clouds.rotation.y += 0.03 * dt;
    }
    if (planets.saturn) planets.saturn.mesh.rotation.y += 0.02 * dt;

    // 2. Rotate Starfield slowly
    if (starField) starField.rotation.y -= 0.02 * dt;
    starUniforms.time.value += dt;

    // 3. Horizon Parallax (Handled exclusively here if cinematic is finished)
    // PERF: only touch the DOM when the scroll position actually changed. This
    // is a full-screen blurred, screen-blended layer - re-transforming it every
    // frame forces the compositor to redo that work even when nothing moved.
    if (planetHorizon && !isIntroPlaying && scrollYCached !== lastHorizonScroll) {
        lastHorizonScroll = scrollYCached;
        const maxTranslateY = viewportH * 0.6;
        const maxScroll = maxTranslateY / 0.15;

        const rawScroll = Math.min(scrollYCached, maxScroll);
        const t = rawScroll / maxScroll;
        const eased = 1 - Math.pow(1 - t, 20);

        const translateY = eased * maxTranslateY;

        planetHorizon.style.transform = `translateY(${translateY}px) scale(${1 + eased * 0.35})`;
    }

    // 4. Camera flight (only runs once the cinematic ends)
    if (!isIntroPlaying) {
        prevPos.copy(camPos);

        if (flight) {
            flight.t += dt / flight.dur;
            const clamped = Math.min(1, flight.t);
            const e = easeFlight(clamped);

            flight.posCurve.getPointAt(e, camPos);
            flight.lookCurve.getPointAt(e, camLook);

            // Roll into the turn, strongest through the middle of the arc.
            const turn = Math.sin(clamped * Math.PI);
            bank += (flight.bankDir * 0.11 * turn - bank) * (1 - Math.exp(-5 * dt));

            if (flight.t >= 1) flight = null;
        } else {
            // Parked: a very slow orbital drift so the frame is never frozen.
            const view = views[currentViewKey];
            orbitPhase += dt * 0.18;
            _a.subVectors(view.pos, view.lookAt)
                .applyAxisAngle(WORLD_UP, Math.sin(orbitPhase) * 0.045)
                .add(view.lookAt);
            _a.y += Math.sin(orbitPhase * 0.7) * 1.2;

            const settle = 1 - Math.exp(-1.6 * dt);
            camPos.lerp(_a, settle);
            camLook.lerp(view.lookAt, settle);
            bank += (0 - bank) * (1 - Math.exp(-3 * dt));
        }

        // --- Velocity drives every speed effect below ---
        camVel.subVectors(camPos, prevPos).divideScalar(Math.max(dt, 1e-4));
        const speed = camVel.length();
        // Asymmetric attack/release. Trails ignite hard but relax slowly, so the
        // streaks stretch out and settle rather than blinking off at the dock -
        // a symmetric filter here is the single thing that reads most "demo".
        const targetWarp = smoothstep01(30, 380, speed);
        warp += (targetWarp - warp) * (1 - Math.exp(-(targetWarp > warp ? 7.5 : 2.2) * dt));

        // Forward / right basis for banking and parallax.
        _fwd.subVectors(camLook, camPos).normalize();
        _right.crossVectors(_fwd, WORLD_UP).normalize();

        // Pointer parallax, suppressed while moving fast.
        const parAmt = (1 - warp) * (1 - warp);
        parX += (pointerX - parX) * (1 - Math.exp(-3 * dt));
        parY += (pointerY - parY) * (1 - Math.exp(-3 * dt));

        camera.position.copy(camPos)
            .addScaledVector(_right, parX * 2.5 * parAmt)
            .addScaledVector(WORLD_UP, -parY * 1.8 * parAmt);

        // Bank the horizon by rotating the up vector around the view axis.
        _camUp.copy(WORLD_UP).applyAxisAngle(_fwd, bank);
        camera.up.copy(_camUp);
        camera.lookAt(camLook);

        // FOV punch: widening the lens with speed is what makes the middle of a
        // jump actually feel fast rather than just look fast.
        const fov = BASE_FOV + warp * 16;
        if (Math.abs(camera.fov - fov) > 0.02) {
            camera.fov = fov;
            camera.updateProjectionMatrix();
        }

        // Lift exposure at speed so highlights bloom out, and pull the starfield
        // down so the streaks are unambiguously the subject.
        renderer.toneMappingExposure = BASE_EXPOSURE + warp * 0.22;
        starUniforms.warpFade.value = warp;

        // Warp streaks. Length ramps super-linearly so the middle of a jump
        // stretches hard while the ends stay calm.
        if (warpField) {
            warpField.visible = warp > 0.01;
            if (warpField.visible) {
                warpUniforms.uCam.value.copy(camera.position);
                if (speed > 1) warpUniforms.uDir.value.copy(camVel).divideScalar(speed);
                warpUniforms.uLen.value = 6 + Math.pow(warp, 1.45) * 210;
                warpUniforms.uThick.value = 0.0022 + warp * 0.0018;
                warpUniforms.uWarp.value = warp;
                warpUniforms.uOpacity.value = warp;
            }
        }

        // Park the veil's glow on the vanishing point, so the tunnel mouth sits
        // where we're actually heading rather than dead centre during a turn.
        if (speed > 1) {
            _b.copy(camera.position).addScaledVector(camVel, 40 / speed).project(camera);
            vanishX += ((_b.x * 0.5 + 0.5) * 100 - vanishX) * (1 - Math.exp(-5 * dt));
            vanishY += ((-_b.y * 0.5 + 0.5) * 100 - vanishY) * (1 - Math.exp(-5 * dt));
        }

        // Speed vignette. Only touch CSSOM when it would visibly change.
        if (Math.abs(warp - lastWarpVar) > 0.01) {
            lastWarpVar = warp;
            const rs = document.documentElement.style;
            rs.setProperty('--warp', warp.toFixed(3));
            rs.setProperty('--warp-x', vanishX.toFixed(1) + '%');
            rs.setProperty('--warp-y', vanishY.toFixed(1) + '%');
        }
    }

    renderer.render(scene, camera);
}

function setCanvasHeight() {
    // renderer.setSize owns canvas.width/height - setting them by hand first just
    // caused an extra (discarded) drawing-buffer allocation.
    const w = window.innerWidth;
    const h = window.innerHeight + EXTRA_HEIGHT;

    viewportH = window.innerHeight;
    warpUniforms.uRes.value.set(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
}

// Handle Resize
let windowWidth = window.innerWidth;
let windowHeight = window.innerHeight;

let heightUnlocked = false;

// PERF: resizing reallocates the drawing buffer, so coalesce bursts of resize
// events (mobile URL bar, window drags) into one resize per frame.
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

    // Width change → always resize
    if (newWidth !== windowWidth) {
        windowWidth = newWidth;
        windowHeight = newHeight;
        scheduleResize();
        heightUnlocked = true;
        return;
    }

    // Height logic
    if (!heightUnlocked) {
        // Ignore until threshold exceeded
        if (heightDelta < EXTRA_HEIGHT) return;
        heightUnlocked = true;
    }

    // Once unlocked → always resize
    windowHeight = newHeight;
    scheduleResize();
});

window.addEventListener('orientationchange', () => {
    windowWidth = window.innerWidth;
    windowHeight = window.innerHeight;
    scheduleResize();
});

// --- 7. SYSTEM INITIALIZATION ---
function initSystem() {
    // Sun (Central Light) - Visual representation with Procedural Noise
    const sunTex = generateSunTexture(512, 256);
    const sunGeo = new THREE.SphereGeometry(15, SPHERE_SEG_W, SPHERE_SEG_H);
    // PERF: the sun was a PBR material with a black base colour, so all the
    // lighting maths resolved to zero and only the emissive map was visible.
    // MeshBasicMaterial renders the identical image without the lighting pass.
    const sunMat = new THREE.MeshBasicMaterial({
        map: sunTex,
        color: new THREE.Color(0xffc35b).multiplyScalar(0.8) // matches emissiveIntensity 0.8
    });
    sun = new THREE.Mesh(sunGeo, sunMat);

    const glowTex = generateGlowTexture();
    const spriteMat = new THREE.SpriteMaterial({ 
        map: glowTex, 
        color: 0xffaa00, 
        transparent: true, 
        blending: THREE.AdditiveBlending,
        opacity: 1,
        depthWrite: false,
        depthTest: true
    });
    const sprite = new THREE.Sprite( spriteMat );
    sprite.scale.set(80, 80, 1.0); /* Increased glow radius */

    sun.add(sprite);
    scene.add(sun);

    // Point light for sharp shadows and planet illumination
    const sunLight = new THREE.PointLight(0xffffff, 1.0, 0, 0);
    sun.add(sunLight);
    // Ambient light INCREASED to light up dark sides
    scene.add(new THREE.AmbientLight(0x404040, 2.0));

    // Starfield
    const starGeo = new THREE.BufferGeometry();
    const starCount = IS_MOBILE ? 4000 : 8000;
    const starPos = new Float32Array(starCount * 3);
    const starColors = new Float32Array(starCount * 3);
    const starSizes = new Float32Array(starCount);
    const starPhases = new Float32Array(starCount);

    // Realistic color palette based on star temperatures
    const colors = [
        // new THREE.Color(0x9db4ff), // Hot blue
        new THREE.Color(0xffffff), // White
        new THREE.Color(0xffffff), // White
        new THREE.Color(0xfff4e8), // Yellow-white
        new THREE.Color(0xffd2a1), // Orange
        new THREE.Color(0xffcc6f)  // Red/Orange
    ];

    for (let i = 0; i < starCount; i++) {
        // Spherical distribution for better immersion
        const r = 600 + Math.random() * 1400; // Radius between 600 and 2000
        const theta = 2 * Math.PI * Math.random();
        const phi = Math.acos(2 * Math.random() - 1);
        
        starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        starPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        starPos[i * 3 + 2] = r * Math.cos(phi);

        // Randomize color and brightness
        const color = colors[Math.floor(Math.random() * colors.length)];
        const brightness = 0.4 + Math.random() * 0.6;
        starColors[i * 3] = color.r * brightness;
        starColors[i * 3 + 1] = color.g * brightness;
        starColors[i * 3 + 2] = color.b * brightness;

        // Size & Twinkle Phase
        starSizes[i] = Math.random() < 0.1 ? 10.0 + Math.random() * 10.0 : 5.0 + Math.random() * 10.0;
        starPhases[i] = Math.random() * Math.PI * 2;
    }

    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3));
    starGeo.setAttribute('size', new THREE.BufferAttribute(starSizes, 1));
    starGeo.setAttribute('phase', new THREE.BufferAttribute(starPhases, 1));

    const starMat = new THREE.ShaderMaterial({
        uniforms: starUniforms,
        vertexColors: true,
        vertexShader: `
            attribute float size;
            attribute float phase;
            varying vec3 vColor;
            varying float vPhase;
            void main() {
                vColor = color;
                vPhase = phase;
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = size * (300.0 / -mvPosition.z);
                gl_Position = projectionMatrix * mvPosition;
            }
        `,
        fragmentShader: `
            uniform float time;
            uniform float introProgress;
            uniform float warpFade;
            varying vec3 vColor;
            varying float vPhase;
            void main() {
                float dist = length(gl_PointCoord - vec2(0.5));
                if (dist > 0.5) discard;
                
                // Soft glow edge
                float alpha = smoothstep(0.5, 0.1, dist);
                
                // Twinkle
                float twinkle = 0.5 + 0.5 * sin(time * 1.5 + vPhase);
                
                // Stagger the appearance of stars based on their random phase
                float randOffset = fract(sin(vPhase * 123.456) * 789.123);
                float introAlpha = smoothstep(randOffset * 0.8, randOffset * 0.8 + 0.2, introProgress);

                gl_FragColor = vec4(vColor, alpha * twinkle * introAlpha * (1.0 - warpFade * 0.45));
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });

    starField = new THREE.Points(starGeo, starMat);
    scene.add(starField);

    // Warp streak field (invisible until the camera actually moves)
    createWarpField();

    // Initialize Planets
    createEarth();
    createMars();
    createJupiter();
    createSaturn();

    // Preload/Compile shaders to prevent stutter on first frame
    renderer.compile(scene, camera);

    // Start Animation Loop
    animate();
}

// Boot the system
initSystem();
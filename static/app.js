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
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
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
const canvas = document.getElementById("bg");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
// Using ACESFilmicToneMapping to handle bright highlights on planets nicely
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// Faint fog to blend distant planets into darkness
scene.fog = new THREE.FogExp2(0x000000, 0.0008);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 50000);

// Initial Camera Position (Overview)
camera.position.set(0, 30, 120);
camera.lookAt(0, 0, 0);

// --- 3. ASSETS & TEXTURES ---
const loadingManager = new THREE.LoadingManager();
const progressBar = document.getElementById('progress-bar');
const preloader = document.getElementById('preloader');

loadingManager.onProgress = (url, loaded, total) => {
    const progress = (loaded / total) * 100;
    if (progressBar) progressBar.style.width = progress + '%';
};

loadingManager.onLoad = () => {
    // Initialize scroll logic immediately so interactions are responsive
    initScroll();

    if (preloader) {
        // Fade out preloader
        preloader.classList.add('loaded');
    }
};

const textureLoader = new THREE.TextureLoader(loadingManager);
const IMAGE_BASE = "static/img/";

// Helper to load texture with correct settings
const loadTex = (path, srgb = true) => {
    const t = textureLoader.load(path);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return t;
};

// --- 4. SCENE OBJECTS ---

const planets = {};
let sun;
let starField;

// --- PLANET CREATION LOGIC ---

// Earth: Base + Bump + Clouds
const createEarth = () => {
    const grp = new THREE.Group();
    grp.position.set(200, 0, 0);

    // 1. Base Sphere (Albedo + Bump)
    const geo = new THREE.SphereGeometry(10, 64, 64);
    const mat = new THREE.MeshStandardMaterial({
        map: loadTex(IMAGE_BASE + "Earth/2_no_clouds_4k.jpg"),
        bumpMap: loadTex(IMAGE_BASE + "Earth/elev_bump_4k.jpg", false),
        bumpScale: 0.5,
        roughness: 0.8,
        metalness: 0.1
    });
    const mesh = new THREE.Mesh(geo, mat);
    // Optimization: Keep active even when off-screen to prevent wake-up lag
    mesh.frustumCulled = false;
    grp.add(mesh);

    // 2. Clouds (Slightly larger sphere)
    const cloudGeo = new THREE.SphereGeometry(10.15, 64, 64);
    const cloudMat = new THREE.MeshStandardMaterial({
        map: loadTex(IMAGE_BASE + "Earth/fair_clouds_4k.png"),
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
    });
    const cloudMesh = new THREE.Mesh(cloudGeo, cloudMat);
    cloudMesh.frustumCulled = false;
    grp.add(cloudMesh);

    scene.add(grp);
    planets['earth'] = { group: grp, mesh: mesh, clouds: cloudMesh, r: 10 };
};

// Mars: Base + Normal Map
const createMars = () => {
    const grp = new THREE.Group();
    grp.position.set(400, 0, 0);

    const geo = new THREE.SphereGeometry(8, 64, 64);
    const mat = new THREE.MeshStandardMaterial({
        map: loadTex(IMAGE_BASE + "Mars/Mars.png"),
        normalMap: loadTex(IMAGE_BASE + "Mars/MarsNormal.png", false),
        normalScale: new THREE.Vector2(1.5, 1.5),
        roughness: 0.7, // Dusty look
        metalness: 0.0
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    grp.add(mesh);

    scene.add(grp);
    planets['mars'] = { group: grp, mesh: mesh, r: 8 };
};

// Jupiter: Simple Texture
const createJupiter = () => {
    const grp = new THREE.Group();
    grp.position.set(600, 0, 0);

    const geo = new THREE.SphereGeometry(18, 64, 64);
    const mat = new THREE.MeshStandardMaterial({
        map: loadTex(IMAGE_BASE + "Jupiter/realj2k.jpg"),
        roughness: 0.5,
        metalness: 0.0
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    grp.add(mesh);

    scene.add(grp);
    planets['jupiter'] = { group: grp, mesh: mesh, r: 18 };
};

// Saturn: Base + Rings
const createSaturn = () => {
    const grp = new THREE.Group();
    grp.position.set(800, 0, 0);

    // 1. Planet
    const geo = new THREE.SphereGeometry(16, 64, 64);
    const mat = new THREE.MeshStandardMaterial({
        map: loadTex(IMAGE_BASE + "Saturn/th_saturn.png"),
        bumpMap: loadTex(IMAGE_BASE + "Saturn/th_saturnbump.png", false),
        bumpScale: 0.2,
        roughness: 0.6,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    grp.add(mesh);

    // 2. Rings
    const ringGeo = new THREE.RingGeometry(22, 42, 128);
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
    ring.receiveShadow = true;
    ring.frustumCulled = false;
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
        pos: new THREE.Vector3(605, 10, 45),
        lookAt: new THREE.Vector3(600, 0, 0)
    },
    saturn: {
        pos: new THREE.Vector3(770, 10, 40),
        lookAt: new THREE.Vector3(800, 0, 0)
    }
};

let currentView = views.overview;
let targetView = views.overview;

// Smooth camera movement vars
const camPos = new THREE.Vector3().copy(views.overview.pos);
const camLook = new THREE.Vector3().copy(views.overview.lookAt);

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
                    targetView = views[planetKey];

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

function animate() {
    requestAnimationFrame(animate);

    const dt = Math.min(clock.getDelta(), 0.1);
    const time = clock.getElapsedTime();

    // 1. Rotate Planets for life
    if (planets.earth) {
        planets.earth.mesh.rotation.y += 0.05 * dt;
        // Rotate clouds slightly faster
        if (planets.earth.clouds) planets.earth.clouds.rotation.y += 0.07 * dt;
    }
    if (planets.mars) planets.mars.mesh.rotation.y += 0.04 * dt;
    if (planets.jupiter) planets.jupiter.mesh.rotation.y += 0.02 * dt;
    if (planets.saturn) planets.saturn.mesh.rotation.y += 0.02 * dt;

    // 2. Rotate Starfield slowly
    if (starField) starField.rotation.y -= 0.02 * dt;

    // 3. Horizon Parallax (Moved to Loop for smoothness)
    if (planetHorizon) {
        const maxTranslateY = window.innerHeight * 0.6;
        const maxScroll = maxTranslateY / 0.15;

        const rawScroll = Math.min(window.scrollY, maxScroll);
        const t = rawScroll / maxScroll;
        const eased = 1 - Math.pow(1 - t, 20);

        const translateY = eased * maxTranslateY;

        planetHorizon.style.transform = `translateY(${translateY}px) scale(${1 + eased * 0.35})`;
    }

    // 4. Smooth Camera Interpolation (Damping)
    // Use Linear Interpolation (Lerp) to move current pos towards target pos
    const damp = 2.0 * dt;
    camPos.lerp(targetView.pos, damp);
    camLook.lerp(targetView.lookAt, damp);

    camera.position.copy(camPos);
    camera.lookAt(camLook);

    renderer.render(scene, camera);
}

// Handle Resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- 7. SYSTEM INITIALIZATION ---
function initSystem() {
    // Sun (Central Light) - Visual representation with Procedural Noise
    const sunTex = generateSunTexture(512, 256);
    const sunGeo = new THREE.SphereGeometry(15, 64, 64);
    const sunMat = new THREE.MeshStandardMaterial({
        color: 0x000000,
        emissive: 0xffc35b,
        emissiveMap: sunTex,
        emissiveIntensity: 0.8,
        roughness: 1.0,
        metalness: 0.0
    });
    sun = new THREE.Mesh(sunGeo, sunMat);

    const glowTex = generateGlowTexture();
    const spriteMat = new THREE.SpriteMaterial({ 
        map: glowTex, 
        color: 0xffaa00, 
        transparent: true, 
        blending: THREE.AdditiveBlending,
        opacity: 1.0
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
    const starCount = 6000;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount * 3; i++) {
        starPos[i] = (Math.random() - 0.5) * 2000;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.8, transparent: true, opacity: 0.8 });
    starField = new THREE.Points(starGeo, starMat);
    scene.add(starField);

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

/* ============================================================
   STARDUST
   ------------------------------------------------------------
   Every section is made of dust while it moves through the
   edges of the screen, and is solid in the middle.

   - Near the bottom of the screen, each piece of content
     (letters, rules, borders, images) gathers out of dust that
     streams in from below along curved, swirling ribbons.
   - In the middle band the real page is shown, crisp and solid.
   - Near the top of the screen it breaks back into dust that
     streams up and away.

   The look: loose dust is fine, cool blue streaks of light
   (each speck is drawn stretched along its own path, like a
   long exposure). Specks glow hot gold/red in the moment they
   land in place and the moment they break away. The paths
   follow a curl-noise flow field, so nearby specks share a
   path and together draw ribbons.

   How it works:
   - At load (and on resize / image load) the visible content of
     each section is sampled into points in page coordinates:
     words are re-drawn on a scratch canvas with their own font
     and colour, borders become dotted lines, images are read
     pixel by pixel.
   - The GPU places each speck from its page position, the scroll
     offset and a few seeds, so nothing per speck runs on the
     CPU. Each frame only updates a handful of uniforms.
   - The real content is masked to the same band with a CSS mask
     that is pinned to the viewport, so dust and DOM cross-fade.
   ============================================================ */
import * as THREE from "three";

// Zones, as fractions of the viewport height.
const ENTER_FROM = 1.0;    // dust starts gathering here (bottom edge)
const ENTER_TO = 0.9;      // ...and is fully formed here
const EXIT_FROM = 0.08;    // dust starts breaking up here (top)
const EXIT_TO = -0.02;     // ...and is gone here
const EDGE_RAMP = 0.4;     // at the top and bottom of the page, the zones step aside

export function createStardust({ roots, quality = "high" } = {}) {
    if (!roots || !roots.length) return null;

    const canvas = document.createElement("canvas");
    canvas.className = "stardust";
    canvas.setAttribute("aria-hidden", "true");

    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: "high-performance" });
    } catch (err) {
        console.warn("Stardust disabled: no WebGL context.", err);
        return null;
    }
    document.body.appendChild(canvas);

    const small = window.innerWidth < 768 || window.matchMedia("(pointer: coarse)").matches;
    // Particle budgets; "low" graphics halves them and draws at 1x.
    const FULL_BUDGET = small ? 50000 : 120000;   // text + lines
    const FULL_IMG_BUDGET = small ? 2500 : 7000;  // per image
    let BUDGET = FULL_BUDGET;
    let IMG_BUDGET = FULL_IMG_BUDGET;
    const fullDpr = Math.min(window.devicePixelRatio || 1, 2);
    let dpr = fullDpr;
    // Glow makes each loose speck a larger sprite (more pixels to fill),
    // so phones get a softer version and "low" graphics none.
    let glow = 1;
    const setLevel = (level) => {
        const low = level === "low";
        BUDGET = low ? FULL_BUDGET / 2 : FULL_BUDGET;
        IMG_BUDGET = low ? FULL_IMG_BUDGET / 2 : FULL_IMG_BUDGET;
        dpr = low ? 1 : fullDpr;
        glow = low ? 0 : small ? 0.6 : 1;
    };
    setLevel(quality);
    let vw = window.innerWidth;
    let vh = window.innerHeight;
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(vw, vh);

    // Colours. Loose dust is cool blue (the telemetry blue, lifted);
    // a speck glows hot (gold to red, the sun's colours) in the moment
    // it lands in place and the moment it breaks away.
    const rootCss = getComputedStyle(document.documentElement);
    const rgbOf = (name, fallback) => {
        const v = rootCss.getPropertyValue(name).trim();
        return v.startsWith("#") ? hexToRgba(v) : fallback;
    };
    const gold = rgbOf("--horizon-gold", [1, 0.82, 0.56, 1]);
    const red = rgbOf("--horizon-red", [0.84, 0.43, 0.31, 1]);
    const uniforms = {
        uView: { value: new THREE.Vector2(vw, vh) },
        uDpr: { value: dpr },
        uTime: { value: 0 },
        uScroll: { value: 0 },
        uVel: { value: 0 },
        uGlow: { value: glow },
        uLines: { value: new THREE.Vector4() },
        uCool: { value: new THREE.Vector3(0.5, 0.66, 1.0) },
        uGold: { value: new THREE.Vector3(gold[0], gold[1], gold[2]) },
        uRed: { value: new THREE.Vector3(red[0], red[1], red[2]) }
    };

    // Each speck is drawn as a small quad stretched along its own path,
    // from where it was a moment ago (tail) to where it is now (head).
    // Still specks are round dots; moving ones are streaks.
    const mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: /* glsl */`
            // position.xy = the quad corner (-1..1); the rest is per speck.
            attribute vec2 aPos;     // page position of the speck (px)
            attribute vec4 aColor;
            attribute float aSize;
            attribute vec2 aSeed;
            uniform vec2 uView;
            uniform float uDpr;
            uniform float uTime;
            uniform float uScroll;
            uniform float uVel;    // this layer's smoothed scroll speed (px per frame)
            uniform float uGlow;   // 0 = plain, 1 = full glow
            uniform vec4 uLines;   // enter-from, enter-to, exit-from, exit-to (px)
            uniform vec3 uCool;
            uniform vec3 uGold;
            uniform vec3 uRed;
            varying vec3 vColor;
            varying float vA;
            varying vec2 vUv;      // quad corner, for the capsule shape
            varying float vLen;    // streak length (px)
            varying float vW;      // half width (px)
            varying float vCore;   // solid part, as a share of the half width
            varying float vHalo;

            // 2D simplex noise. Ian McEwan, Ashima Arts (MIT licence).
            vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
            float snoise(vec2 v) {
                const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
                vec2 i = floor(v + dot(v, C.yy));
                vec2 x0 = v - i + dot(i, C.xx);
                vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
                vec4 x12 = x0.xyxy + C.xxzz;
                x12.xy -= i1;
                i = mod(i, 289.0);
                vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
                vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
                m = m * m;
                m = m * m;
                vec3 x = 2.0 * fract(p * C.www) - 1.0;
                vec3 h = abs(x) - 0.5;
                vec3 a0 = x - floor(x + 0.5);
                m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
                vec3 g;
                g.x = a0.x * x0.x + h.x * x0.y;
                g.yz = a0.yz * x12.xz + h.yz * x12.yw;
                return 130.0 * dot(m, g);
            }

            // Curl of the noise: a swirling flow with no sources or sinks.
            vec2 curl(vec2 q) {
                const float e = 0.12;
                float dy = snoise(q + vec2(0.0, e)) - snoise(q - vec2(0.0, e));
                float dx = snoise(q + vec2(e, 0.0)) - snoise(q - vec2(e, 0.0));
                return vec2(dy, -dx) / (2.0 * e);
            }

            // Follow the flow from a start point for a given distance, in a
            // few steps. Nearby specks follow nearly the same curved path,
            // each to its own distance, so together they draw ribbons.
            // bias pulls the path one way (down on the way in, up on the
            // way out). dir returns the direction at the end of the path.
            const float FLOW_SCALE = 0.0024;
            // The path may sweep sideways but never turns back across
            // the page: dust coming in stays below its home, dust going
            // out stays above it.
            vec2 march(vec2 start, float dist, vec2 bias, vec2 drift, out vec2 dir) {
                vec2 x = start;
                vec2 d = normalize(bias);
                float h = dist / 5.0;
                for (int i = 0; i < 5; i++) {
                    d = normalize(curl(x * FLOW_SCALE + drift) + bias);
                    d.y = bias.y > 0.0 ? max(d.y, 0.12) : min(d.y, -0.12);
                    d = normalize(d);
                    x += d * h;
                }
                dir = d;
                return x;
            }

            void main() {
                vec2 home = vec2(aPos.x, aPos.y - uScroll);
                float j = aSeed.y;

                // Progress through each zone. The stagger mixes broad
                // patches (noise over the page) with fine grain, so the
                // edge is ragged, like burning paper.
                float patchN = snoise(aPos * 0.0042) * 0.5 + 0.5;
                float s = mix(j, patchN, 0.55);
                float pin = clamp((uLines.x - home.y) / (uLines.x - uLines.y), 0.0, 1.0);
                pin = clamp(pin * 1.3 - s * 0.3, 0.0, 1.0);
                float pout = clamp((uLines.z - home.y) / (uLines.z - uLines.w), 0.0, 1.0);
                pout = clamp(pout * 1.12 - s * 0.12, 0.0, 1.0);

                float aIn = smoothstep(0.0, 0.3, pin) * (1.0 - smoothstep(0.8, 1.0, pin));
                float aOut = smoothstep(0.0, 0.12, pout) * (1.0 - smoothstep(0.4, 1.0, pout));
                float a = max(aIn, aOut) * aColor.a;

                if (a < 0.004) {           // skip invisible dust entirely
                    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                    vColor = vec3(0.0);
                    vA = 0.0;
                    vUv = vec2(0.0);
                    vLen = 0.0;
                    vW = 1.0;
                    vCore = 1.0;
                    vHalo = 0.0;
                    return;
                }

                float lin = pow(1.0 - pin, 3.0);   // looseness on the way in
                float lout = pout * pout;          // looseness on the way out
                float loose = max(lin, lout);
                bool leaving = lout > lin;

                // Paths. Far specks (depth) travel less, like parallax.
                float depth = 0.55 + fract(aSeed.x * 17.31) * 0.9;
                vec2 drift = vec2(uTime * 0.02, -uTime * 0.03);   // the flow slowly changes
                vec2 bias = leaving
                    ? vec2((aSeed.x - 0.5) * 0.5, -0.8)
                    : vec2((aSeed.x - 0.5) * 0.5, 0.6);
                float reach = leaving
                    ? (150.0 + fract(j * 5.3) * 170.0) * depth
                    : (110.0 + j * 150.0) * depth;
                float L = leaving ? lout : lin;
                vec2 dir;
                vec2 headPage = march(aPos, reach * L, bias, drift, dir);
                vec2 wob = vec2(sin(uTime * 1.3 + aSeed.x * 40.0), cos(uTime * 1.1 + j * 30.0)) * (1.5 + 3.0 * loose);
                vec2 lag = vec2(0.0, uVel * (0.4 + depth) * 1.3 * loose);   // inertia
                vec2 head = headPage - vec2(0.0, uScroll) + wob + lag;

                // Streak length follows the speck's speed along its path
                // (how fast its looseness changes as you scroll), plus
                // motion blur from the scroll itself. The tail points back
                // to where it came from.
                float speed = leaving ? 2.0 * pout : 3.0 * (1.0 - pin) * (1.0 - pin);
                float len = reach * speed * 0.11 * (0.6 + 0.8 * fract(aSeed.x * 3.3));
                // Break into points first, then stretch into streaks.
                len *= smoothstep(0.02, 0.3, L);
                vec2 tail = leaving ? head - dir * len : head + dir * len;
                tail.y += uVel * 1.2 * sqrt(loose);
                vec2 ax = head - tail;
                len = length(ax);
                if (len > 140.0) { tail = head - ax / len * 140.0; len = 140.0; }

                // Colour: true colour in place, cool blue when loose, hot
                // as it lands and as it breaks away.
                vec3 col = mix(aColor.rgb, uCool, 0.9 * smoothstep(0.0, 0.3, loose));
                float heatIn = smoothstep(0.45, 0.65, pin) * (1.0 - smoothstep(0.74, 0.92, pin));
                float heatOut = smoothstep(0.0, 0.04, pout) * (1.0 - smoothstep(0.08, 0.3, pout));
                float heat = max(heatIn, heatOut) * smoothstep(0.4, 0.8, fract(j * 7.31 + aSeed.x));
                vec3 ember = mix(uGold, uRed, fract(aSeed.x * 23.7));
                col = mix(col, ember, heat * 0.85);
                float glint = max(heatIn, heatOut) * step(0.82, fract(j * 13.7));
                col = mix(col, vec3(1.0), glint * 0.7);

                // Twinkle only while loose.
                float tw0 = 0.5 + 0.5 * sin(uTime * (1.6 + fract(aSeed.x * 9.1) * 3.4) + j * 50.0);
                float tw = mix(1.0, 0.55 + 0.75 * tw0 * tw0 * tw0, loose);

                // Size: in place, the sampled size; loose, a spread from
                // fine points to a few larger motes. The quad is wider
                // than the solid core to hold a soft glow.
                float spread = 0.45 + 1.35 * pow(fract(aSeed.x * 71.3 + j * 0.37), 3.0);
                // Big specks (large headings, images) keep their size when
                // loose, varied a little, so they do not shrink from big to
                // small as they move. Small specks (body text) stay as
                // before: loose strands are fine, like hair-thin light.
                float big = smoothstep(1.4, 2.2, aSize);
                float vary = 0.85 + 0.3 * fract(aSeed.x * 71.3 + j * 0.37);
                float looseScale = mix(spread * 0.6, vary, big);
                float core = aSize * 0.5 * mix(1.0, looseScale, smoothstep(0.0, 0.5, loose));
                // A fast speck smears into a thinner, longer streak
                // (only a little for big specks).
                core *= mix(1.0, mix(0.4, 0.8, big), smoothstep(2.0, 14.0, len / max(core, 0.3)));
                core = max(core, 0.45);
                float halo = 1.0 + 1.3 * loose * uGlow;
                float w = core * halo;

                // A long streak spreads the same light over more length.
                float energy = clamp((5.0 * core) / (len + 5.0 * core), 0.45, 1.0);

                vec2 along = len > 0.01 ? ax / len : vec2(1.0, 0.0);
                vec2 nrm = vec2(-along.y, along.x);
                vec2 q = mix(tail, head, position.x * 0.5 + 0.5) + along * position.x * w + nrm * position.y * w;

                gl_Position = vec4(q.x / uView.x * 2.0 - 1.0, 1.0 - q.y / uView.y * 2.0, 0.0, 1.0);
                vUv = position.xy;
                vLen = len;
                vW = w;
                vCore = 1.0 / halo;
                vHalo = loose * uGlow;
                vColor = min(col * 1.1, 1.0);
                vA = a * tw * energy * (1.0 + 0.3 * loose + heat * 0.9 + glint * 0.8);
            }
        `,
        fragmentShader: /* glsl */`
            varying vec3 vColor;
            varying float vA;
            varying vec2 vUv;
            varying float vLen;
            varying float vW;
            varying float vCore;
            varying float vHalo;
            void main() {
                // Distance to the streak's centre line, as a capsule.
                float x = (vUv.x * 0.5 + 0.5) * (vLen + 2.0 * vW) - vW;   // 0 = tail, vLen = head
                float dx = max(max(-x, x - vLen), 0.0);
                float d = length(vec2(dx, vUv.y * vW)) / vW;
                if (d > 1.0) discard;
                float r = d / vCore;
                float core = 1.0 - smoothstep(0.35, 1.0, r);
                float halo = exp(-d * d * 5.0) * 0.7 * vHalo;
                // Brightest at the head, fading toward the tail.
                float fade = vLen > 0.5 ? mix(0.12, 1.0, clamp(x / vLen, 0.0, 1.0)) : 1.0;
                float a = clamp(core + halo, 0.0, 1.0) * vA * fade;
                gl_FragColor = vec4(vColor * a, a);   // premultiplied
            }
        `,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,   // screen y runs down, which flips the winding
        // Colour adds up (overlapping streaks glow brighter, like light);
        // coverage blends normally.
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneMinusSrcAlphaFactor
    });

    // One quad, shared by every speck (two triangles).
    const QUAD = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
    const QUAD_INDEX = [0, 1, 2, 0, 2, 3];

    const scene = new THREE.Scene();
    const cam = new THREE.Camera();
    // Every layer shares one material; each sets its own scroll offset
    // just before it draws. Normal content scrolls with the page.
    // Content in a pinned (sticky) container follows that container:
    // its offset is where the container was when sampled, minus where
    // it is now on screen.
    // A layer can also bring its own zone lines (userData.lines), as
    // a burst does; all others use the screen-edge zones.
    const globalLines = new THREE.Vector4();
    const makeLayer = (anchor = null) => {
        const layer = new THREE.Mesh(new THREE.InstancedBufferGeometry(), mat);
        layer.frustumCulled = false;
        layer.visible = false;   // until it has specks (upload)
        const ud = layer.userData;
        if (anchor) {
            let sampledTop = 0;
            ud.rebase = () => {
                sampledTop = anchor.getBoundingClientRect().top + window.scrollY;
                ud.prev = undefined;   // the offset jumps; not real movement
            };
            ud.rebase();
            ud.scroll = () => sampledTop - anchor.getBoundingClientRect().top;
        }
        ud.vel = 0;
        layer.onBeforeRender = () => {
            const s = ud.scroll ? ud.scroll() : window.scrollY;
            // Scroll speed in px per 60 Hz frame, so the trail looks the
            // same at any refresh rate. Clamped and smoothed.
            const t = performance.now();
            let v = 0;
            if (ud.prev !== undefined && t > ud.prevT) v = (s - ud.prev) * (16.67 / Math.max(4, t - ud.prevT));
            ud.prev = s;
            ud.prevT = t;
            ud.vel += (Math.max(-36, Math.min(36, v)) - ud.vel) * 0.16;
            uniforms.uScroll.value = s;
            uniforms.uVel.value = ud.vel;
            uniforms.uLines.value.copy(ud.lines ? ud.lines() : globalLines);
            mat.uniformsNeedUpdate = true;
        };
        scene.add(layer);
        return layer;
    };
    const countSpecks = () => scene.children.reduce((n, l) => n + (l.geometry.instanceCount || 0), 0);
    const dropLayer = (layer) => { scene.remove(layer); layer.geometry.dispose(); };
    const textLayer = makeLayer();
    const imageLayers = new Map();   // <img> -> its own dust layer
    const pinnedLayers = [];         // text in sticky containers

    /* --- Sampling -------------------------------------------- */
    const scratch = document.createElement("canvas");
    scratch.width = 2048;
    scratch.height = 1024;
    const sctx = scratch.getContext("2d", { willReadFrequently: true });

    const cssVar = (name, fallback) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

    function hexToRgba(hex) {
        const h = hex.replace("#", "");
        const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
        return [parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255, 1];
    }

    function parseColor(str) {
        const m = str && str.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
        return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1];
    }

    // Content can opt out with data-dust="off" (it keeps its own effect).
    const isVisible = (el, honourOff = true) =>
        !(honourOff && el.closest('[data-dust="off"]')) &&
        el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";

    const range = document.createRange();
    const newOut = () => ({ x: [], y: [], c: [], s: [] });

    // Every visible word and border/hairline under root becomes points.
    // pushFor(el) returns the push(x, y, r, g, b, a, size) to use for
    // that element, in screen coordinates.
    function sampleTree(root, pushFor, honourOff = true) {
        const opacityCache = new Map();
        const opacityOf = (el) => {
            if (opacityCache.has(el)) return opacityCache.get(el);
            let o = 1;
            for (let n = el; n && n !== root.parentElement; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity);
            opacityCache.set(el, o);
            return o;
        };

        const starlight = cssVar("--starlight", "#EDEDF3");
        const gold = cssVar("--horizon-gold", "#FFD28E");
        const red = cssVar("--horizon-red", "#D66D50");

        /* Words: re-drawn on the scratch canvas, then read back. */
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const el = node.parentElement;
            if (!el || !node.textContent.trim() || !isVisible(el, honourOff)) continue;
            const push = pushFor(el);
            const cs = getComputedStyle(el);
            const fs = parseFloat(cs.fontSize);
            const hl = el.closest(".highlight");
            const col = parseColor(cs.color);
            if (!hl && (!col || col[3] < 0.05)) continue;
            const alpha = (col ? col[3] : 1) * opacityOf(el);
            const upper = cs.textTransform === "uppercase";
            const stride = Math.min(2.6, Math.max(1, fs / 22));
            const size = Math.min(3.2, Math.max(1.15, stride * 1.3));
            const pad = Math.ceil(fs * 0.35);

            sctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
            if ("letterSpacing" in sctx) sctx.letterSpacing = cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing;

            const text = node.textContent;
            const re = /\S+/g;
            let m;
            while ((m = re.exec(text))) {
                range.setStart(node, m.index);
                range.setEnd(node, m.index + m[0].length);
                const r = range.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const word = upper ? m[0].toUpperCase() : m[0];
                const W = Math.min(scratch.width, Math.ceil(r.width + pad * 2));
                const H = Math.min(scratch.height, Math.ceil(r.height + pad * 2));
                const metrics = sctx.measureText(word);
                const A = metrics.fontBoundingBoxAscent ?? fs * 0.8;

                sctx.clearRect(0, 0, W, H);
                if (hl) {
                    const hr = hl.getBoundingClientRect();
                    const g = sctx.createLinearGradient(hr.left - r.left + pad, 0, hr.right - r.left + pad, 0);
                    g.addColorStop(0, starlight); g.addColorStop(0.45, gold); g.addColorStop(1, red);
                    sctx.fillStyle = g;
                } else {
                    sctx.fillStyle = cs.color;
                }
                sctx.fillText(word, pad, pad + A);

                const data = sctx.getImageData(0, 0, W, H).data;
                for (let y = 0; y < H; y += stride) {
                    for (let x = 0; x < W; x += stride) {
                        const px = Math.min(W - 1, (x + Math.random() * stride) | 0);
                        const py = Math.min(H - 1, (y + Math.random() * stride) | 0);
                        const i = (py * W + px) * 4;
                        if (data[i + 3] < 110) continue;
                        push(r.left - pad + px, r.top - pad + py,
                            data[i] / 255, data[i + 1] / 255, data[i + 2] / 255, alpha, size);
                    }
                }
            }
        }

        /* Borders and hairlines become dotted lines of dust. */
        root.querySelectorAll("*").forEach((el) => {
            if (!isVisible(el, honourOff)) return;
            const push = pushFor(el);
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return;
            const op = opacityOf(el);
            const line = (x0, y0, x1, y1, w, c) => {
                const len = Math.hypot(x1 - x0, y1 - y0);
                const n = Math.max(2, Math.round(len / 1.7));
                for (let k = 0; k < n; k++) {
                    const t = k / (n - 1);
                    push(x0 + (x1 - x0) * t + (Math.random() - 0.5),
                        y0 + (y1 - y0) * t + Math.random() * w,
                        c[0], c[1], c[2], Math.min(1, c[3] * 1.6) * op, 1.4);
                }
            };
            [["Top", r.left, r.top, r.right, r.top],
             ["Bottom", r.left, r.bottom - 1, r.right, r.bottom - 1],
             ["Left", r.left, r.top, r.left, r.bottom],
             ["Right", r.right - 1, r.top, r.right - 1, r.bottom]].forEach(([side, x0, y0, x1, y1]) => {
                const w = parseFloat(cs[`border${side}Width`]);
                if (!w || cs[`border${side}Style`] === "none") return;
                const c = parseColor(cs[`border${side}Color`]);
                if (c && c[3] >= 0.05) line(x0, y0, x1, y1, w, c);
            });
            // Thin decorative rules drawn with a background (e.g. .section-line).
            if (r.height <= 3 && r.width > 8 && cs.backgroundImage !== "none") {
                line(r.left, r.top, r.right, r.top, r.height,
                    gold.startsWith("#") ? hexToRgba(gold) : (parseColor(gold) || [1, 0.82, 0.56, 1]));
            }
        });
    }

    function sampleAll() {
        // Start clean: images hidden by a new layout must not leave dust.
        imageLayers.forEach(dropLayer);
        imageLayers.clear();
        pinnedLayers.splice(0).forEach(dropLayer);

        const sx = window.scrollX;
        const sy = window.scrollY;
        // Points are grouped by the sticky container they sit in (null = none).
        const outs = new Map();
        const pushFor = (el) => {
            const anchor = el.closest("[data-dust-sticky]");
            let out = outs.get(anchor);
            if (!out) { out = newOut(); outs.set(anchor, out); }
            return (x, y, r, g, b, a, size) => {
                out.x.push(x + sx); out.y.push(y + sy);
                out.c.push(r, g, b, a); out.s.push(size);
            };
        };

        roots.forEach((root) => {
            sampleTree(root, pushFor);

            /* Images get their own layers, so a late (lazy) load only
               samples that one image. */
            root.querySelectorAll("img").forEach((img) => {
                if (!isVisible(img)) return;
                if (img.complete && img.naturalWidth) sampleImage(img, root);
                else img.addEventListener("load", () => sampleImage(img, root), { once: true });
            });
        });

        upload(textLayer, outs.get(null) || newOut(), BUDGET);
        outs.forEach((group, anchor) => {
            if (!anchor) return;
            const layer = makeLayer(anchor);
            upload(layer, group, BUDGET * 0.3);
            pinnedLayers.push(layer);
        });
        sampledHeight = document.documentElement.scrollHeight;
        api.count = countSpecks();
    }

    function sampleImage(img, root) {
        const sx = window.scrollX;
        const sy = window.scrollY;
        const out = { x: [], y: [], c: [], s: [] };
        const r = img.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        const cs = getComputedStyle(img);
        const scale = Math.min(1, scratch.width / r.width, scratch.height / r.height);
        const W = Math.max(1, Math.floor(r.width * scale));
        const H = Math.max(1, Math.floor(r.height * scale));
        const nw = img.naturalWidth, nh = img.naturalHeight;
        const cover = Math.max(r.width / nw, r.height / nh);
        const sw = r.width / cover, sh = r.height / cover;
        const pos = (cs.objectPosition || "50% 50%").split(" ").map((v) => (v.endsWith("%") ? parseFloat(v) / 100 : 0.5));
        sctx.clearRect(0, 0, W, H);
        let data;
        try {
            sctx.drawImage(img, (nw - sw) * pos[0], (nh - sh) * (pos[1] ?? 0.5), sw, sh, 0, 0, W, H);
            data = sctx.getImageData(0, 0, W, H).data;
        } catch (e) {
            return;   // cross-origin image: no dust for it
        }
        let op = 1;
        for (let n = img; n && n !== root.parentElement; n = n.parentElement) op *= parseFloat(getComputedStyle(n).opacity);
        // Spacing so each image stays within its budget.
        const stride = Math.max(3.2, Math.sqrt((r.width * r.height) / IMG_BUDGET)) * scale;
        const size = Math.min(4, stride / scale * 0.95);
        for (let y = 0; y < H; y += stride) {
            for (let x = 0; x < W; x += stride) {
                const px = Math.min(W - 1, (x + Math.random() * stride) | 0);
                const py = Math.min(H - 1, (y + Math.random() * stride) | 0);
                const i = (py * W + px) * 4;
                if (data[i + 3] < 40) continue;
                out.x.push(r.left + px / scale + sx);
                out.y.push(r.top + py / scale + sy);
                out.c.push(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255, op);
                out.s.push(size);
            }
        }
        const old = imageLayers.get(img);
        if (old) dropLayer(old);
        const layer = makeLayer(img.closest("[data-dust-sticky]"));
        imageLayers.set(img, layer);
        upload(layer, out, IMG_BUDGET * 1.5);
        api.count = countSpecks();
    }

    function upload(layer, out, budget) {
        const geo = layer.geometry;
        const n = out.x.length;
        let keep = 1;
        if (n > budget) keep = budget / n;
        const grow = keep < 1 ? Math.sqrt(1 / keep) : 1;
        const count = Math.min(n, Math.floor(budget));
        const pos = new Float32Array(count * 2);
        const col = new Float32Array(count * 4);
        const size = new Float32Array(count);
        const seed = new Float32Array(count * 2);
        let k = 0;
        for (let i = 0; i < n && k < count; i++) {
            if (keep < 1 && Math.random() > keep) continue;
            pos[k * 2] = out.x[i];
            pos[k * 2 + 1] = out.y[i];
            col[k * 4] = out.c[i * 4];
            col[k * 4 + 1] = out.c[i * 4 + 1];
            col[k * 4 + 2] = out.c[i * 4 + 2];
            col[k * 4 + 3] = out.c[i * 4 + 3];
            size[k] = Math.min(3.6, out.s[i] * grow);
            seed[k * 2] = Math.random();
            seed[k * 2 + 1] = Math.random();
            k++;
        }
        if (!geo.index) {
            geo.setIndex(QUAD_INDEX);
            geo.setAttribute("position", new THREE.BufferAttribute(QUAD, 3));
        }
        geo.setAttribute("aPos", new THREE.InstancedBufferAttribute(pos, 2));
        geo.setAttribute("aColor", new THREE.InstancedBufferAttribute(col, 4));
        geo.setAttribute("aSize", new THREE.InstancedBufferAttribute(size, 1));
        geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 2));
        geo.instanceCount = k;
        layer.visible = k > 0;
    }

    let sampleTimer = 0;
    function scheduleSample() {
        clearTimeout(sampleTimer);
        sampleTimer = setTimeout(sampleAll, 250);
    }

    /* --- Zones and masks ------------------------------------- */

    // The page content is masked to the solid band. The mask image is
    // one viewport tall and is moved so it stays pinned to the screen.
    const maskTargets = roots.flatMap((root) =>
        [...root.children].filter((c) => c.tagName !== "BR" && c.dataset.dust !== "off"));
    maskTargets.forEach((el) => {
        el.classList.add("dust-masked");
        el.style.maskRepeat = el.style.webkitMaskRepeat = "no-repeat";
    });
    let lastMask = "";
    let lastVh = 0;

    let intro = 0;          // 0 = nothing formed yet, 1 = normal
    let started = false;

    function zoneLines() {
        const max = Math.max(1, document.documentElement.scrollHeight - vh);
        const y = window.scrollY;
        // At the very top and bottom of the page there is nothing further
        // to scroll to, so the bottom zone steps aside and everything on
        // screen is solid.
        const topEase = Math.min(1, y / (vh * EDGE_RAMP));
        const botEase = Math.min(1, (max - y) / (vh * EDGE_RAMP));
        const shift = (1 - Math.min(topEase, botEase)) * (ENTER_FROM - ENTER_TO + 0.06) * vh;

        let enterTo = ENTER_TO * vh + shift;
        let enterFrom = ENTER_FROM * vh + shift;
        // Intro: the band grows down from the top of the screen.
        const introTo = -0.3 * vh + (enterTo + 0.3 * vh) * intro;
        const d = enterFrom - enterTo;
        enterTo = Math.min(enterTo, introTo);
        enterFrom = enterTo + d;
        return [enterFrom, enterTo, EXIT_FROM * vh, EXIT_TO * vh];
    }

    function applyMasks(lines) {
        const [ef, et, xf, xt] = lines;
        const a = xf - 0.15 * (xf - xt);   // fully hidden above this
        const b = xf;                      // fully shown below this
        const c = et;                      // fully shown above this
        const d = et + 0.2 * (ef - et);    // fully hidden below this
        let img;
        if (c <= a) img = "linear-gradient(transparent, transparent)";
        else {
            const s3 = Math.max(c, b), s4 = Math.max(d, s3 + 1);
            img = `linear-gradient(to bottom, transparent ${a.toFixed(1)}px, #000 ${b.toFixed(1)}px, #000 ${s3.toFixed(1)}px, transparent ${s4.toFixed(1)}px)`;
        }
        const changed = img !== lastMask || vh !== lastVh;
        const rects = maskTargets.map((el) => el.getBoundingClientRect().top);
        maskTargets.forEach((el, i) => {
            if (changed) {
                el.style.maskImage = el.style.webkitMaskImage = img;
                el.style.maskSize = el.style.webkitMaskSize = `100% ${vh}px`;
            }
            el.style.maskPosition = el.style.webkitMaskPosition = `0 ${(-rects[i]).toFixed(1)}px`;
        });
        lastMask = img;
        lastVh = vh;
    }

    /* --- Frame ----------------------------------------------- */
    function tick(time) {
        uniforms.uTime.value = time;
        uniforms.uScroll.value = window.scrollY;
        const lines = zoneLines();
        globalLines.set(lines[0], lines[1], lines[2], lines[3]);
        uniforms.uLines.value.copy(globalLines);
        applyMasks(lines);
        if (started || intro > 0) renderer.render(scene, cam);
    }

    let lastWidth = vw;
    window.addEventListener("resize", () => {
        vw = window.innerWidth;
        vh = window.innerHeight;
        renderer.setSize(vw, vh);
        uniforms.uView.value.set(vw, vh);
        if (vw !== lastWidth) { lastWidth = vw; scheduleSample(); }
    });
    // Fonts or late content can change the page height after the first
    // sample; only then is a full re-sample worth its cost.
    let sampledHeight = 0;
    window.addEventListener("load", () => {
        if (document.documentElement.scrollHeight !== sampledHeight) scheduleSample();
    });

    // Safety nets: any change in a section's size (a scrollbar
    // appearing, content re-wrapping) or a font arriving late moves
    // the real content, so the dust is sampled again.
    let observed = false;
    const sizes = new Map();
    const ro = new ResizeObserver((entries) => {
        let changed = false;
        entries.forEach((e) => {
            const key = `${Math.round(e.contentRect.width)}x${Math.round(e.contentRect.height)}`;
            if (sizes.get(e.target) !== key) { sizes.set(e.target, key); changed = true; }
        });
        if (observed && changed) scheduleSample();
        observed = true;
    });
    roots.forEach((r) => ro.observe(r));
    if (document.fonts) document.fonts.addEventListener("loadingdone", scheduleSample);

    /* --- Bursts ---------------------------------------------- */

    // Turn chosen elements to dust on demand, driven by a progress
    // value (0 = solid, 1 = gone) instead of by the screen edges. The
    // dust breaks away top to bottom and drifts up, the same look as
    // the top edge, and the real elements are masked away in step.
    // Used where content opts out of the normal dust (data-dust="off")
    // but should still leave as dust, e.g. the end of About.
    // anchor: the sticky container the elements sit in (or null).
    function createBurst({ elements, anchor = null }) {
        const layer = makeLayer(anchor);
        const lines = new THREE.Vector4();
        let rel = null;          // bounds relative to the anchor
        let stale = true;
        let progress = 0;

        const anchorTop = () => (anchor ? anchor.getBoundingClientRect().top : -window.scrollY);
        const zRel = () => rel.top - 2 + progress * (rel.h + rel.range + 4);

        // Formed dust is invisible (the real elements show); only the
        // exit pair of lines moves.
        layer.userData.lines = () => {
            if (!rel) return lines.set(1e6, 1e6 - 1, -1e6, -1e6 - 1);
            const z = anchorTop() + zRel();
            return lines.set(1e6, 1e6 - 1, z, z - rel.range);
        };

        function sample() {
            stale = false;
            if (layer.userData.rebase) layer.userData.rebase();
            const sx = window.scrollX;
            const sy = window.scrollY;
            const out = newOut();
            const push = (x, y, r, g, b, a, size) => {
                out.x.push(x + sx); out.y.push(y + sy);
                out.c.push(r, g, b, a); out.s.push(size);
            };
            elements.forEach((el) => sampleTree(el, () => push, false));
            upload(layer, out, BUDGET * 0.25);

            const at = anchorTop();
            let top = Infinity, bottom = -Infinity;
            elements.forEach((el) => {
                const r = el.getBoundingClientRect();
                el._dustTop = r.top - at;
                top = Math.min(top, r.top - at);
                bottom = Math.max(bottom, r.bottom - at);
            });
            const h = Math.max(1, bottom - top);
            rel = { top, h, range: Math.max(160, h * 0.4) };
            api.count = countSpecks();
        }

        function maskElements() {
            elements.forEach((el) => {
                let img = "";
                if (progress >= 1) img = "linear-gradient(transparent, transparent)";
                else if (progress > 0 && rel) {
                    const z = zRel() - el._dustTop;
                    img = `linear-gradient(to bottom, transparent ${(z - 0.15 * rel.range).toFixed(1)}px, #000 ${z.toFixed(1)}px)`;
                }
                el.style.maskImage = el.style.webkitMaskImage = img;
            });
        }

        let resizeTimer = 0;
        window.addEventListener("resize", () => {
            stale = true;
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => { if (progress > 0) { sample(); maskElements(); } }, 300);
        });

        return {
            sample,
            setProgress(p) {
                progress = Math.min(1, Math.max(0, p));
                if (progress > 0 && stale) sample();
                maskElements();
            }
        };
    }

    const api = {
        canvas,
        count: 0,
        createBurst,
        sample: sampleAll,
        tick,
        // Intro: the first screen gathers out of dust, top to bottom.
        setQuality(level) {
            setLevel(level);
            renderer.setPixelRatio(dpr);
            renderer.setSize(vw, vh);
            uniforms.uDpr.value = dpr;
            uniforms.uGlow.value = glow;
            sampleAll();
        },
        begin(duration = 2.2) {
            started = true;
            const state = { v: intro };
            window.gsap.to(state, {
                v: 1, duration, ease: "power2.inOut",
                onUpdate: () => { intro = state.v; }
            });
        }
    };
    return api;
}
/* ============================================================
   STARDUST
   ------------------------------------------------------------
   Every section is made of dust while it moves through the
   edges of the screen, and is solid in the middle.

   - Near the bottom of the screen, each piece of content
     (letters, rules, borders, images) gathers out of dust that
     drifts in from just around it.
   - In the middle band the real page is shown, crisp and solid.
   - Near the top of the screen it breaks back into dust that
     drifts up and fades away.

   How it works:
   - At load (and on resize / image load) the visible content of
     each section is sampled into points in page coordinates:
     words are re-drawn on a scratch canvas with their own font
     and colour, borders become dotted lines, images are read
     pixel by pixel.
   - The GPU places each point from its page position, the scroll
     offset and a few seeds, so nothing per particle runs on the
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
    const setLevel = (level) => {
        const low = level === "low";
        BUDGET = low ? FULL_BUDGET / 2 : FULL_BUDGET;
        IMG_BUDGET = low ? FULL_IMG_BUDGET / 2 : FULL_IMG_BUDGET;
        dpr = low ? 1 : fullDpr;
    };
    setLevel(quality);
    let vw = window.innerWidth;
    let vh = window.innerHeight;
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(vw, vh);

    const uniforms = {
        uView: { value: new THREE.Vector2(vw, vh) },
        uDpr: { value: dpr },
        uTime: { value: 0 },
        uScroll: { value: 0 },
        uLines: { value: new THREE.Vector4() }
    };

    const mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: /* glsl */`
            attribute vec4 aColor;
            attribute float aSize;
            attribute vec2 aSeed;
            uniform vec2 uView;
            uniform float uDpr;
            uniform float uTime;
            uniform float uScroll;
            uniform vec4 uLines;   // enter-from, enter-to, exit-from, exit-to (px)
            varying vec4 vColor;
            varying float vA;

            vec2 dir(float a) { return vec2(cos(a * 6.2831853), sin(a * 6.2831853)); }

            void main() {
                vec2 p = vec2(position.x, position.y - uScroll);
                float j = aSeed.y;

                // Progress through each zone, staggered per particle so
                // the edge never reads as a straight line.
                float pin = clamp((uLines.x - p.y) / (uLines.x - uLines.y), 0.0, 1.0);
                pin = clamp(pin * 1.3 - j * 0.3, 0.0, 1.0);
                float pout = clamp((uLines.z - p.y) / (uLines.z - uLines.w), 0.0, 1.0);
                pout = clamp(pout * 1.12 - j * 0.12, 0.0, 1.0);

                float ein = 1.0 - pow(1.0 - pin, 3.0);
                float eout = pout * pout;
                vec2 wob = vec2(sin(uTime * 1.3 + aSeed.x * 40.0), cos(uTime * 1.1 + j * 30.0));

                // Arrives from a little way off, slightly from below;
                // leaves wider, drifting upward.
                vec2 sIn = dir(aSeed.x) * (16.0 + j * 64.0) + vec2(0.0, 24.0);
                vec2 sOut = dir(fract(aSeed.x * 7.13 + 0.3)) * (30.0 + fract(j * 3.7) * 140.0) + vec2(0.0, -90.0);
                p += (sIn + wob * 7.0) * (1.0 - ein);
                p += (sOut + wob * 12.0) * eout;

                float aIn = smoothstep(0.0, 0.3, pin) * (1.0 - smoothstep(0.8, 1.0, pin));
                float aOut = smoothstep(0.0, 0.12, pout) * (1.0 - smoothstep(0.4, 1.0, pout));
                float a = max(aIn, aOut) * aColor.a;

                if (a < 0.004) {           // skip invisible dust entirely
                    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                    gl_PointSize = 0.0;
                    vColor = vec4(0.0);
                    vA = 0.0;
                    return;
                }

                gl_Position = vec4(p.x / uView.x * 2.0 - 1.0, 1.0 - p.y / uView.y * 2.0, 0.0, 1.0);
                gl_PointSize = aSize * uDpr * (1.0 + (1.0 - ein) * 0.6 + eout * 0.8);
                float tw = 0.8 + 0.2 * sin(uTime * (2.0 + fract(aSeed.x * 9.1) * 3.0) + j * 50.0);
                vColor = aColor;
                vA = a * tw;
            }
        `,
        fragmentShader: /* glsl */`
            varying vec4 vColor;
            varying float vA;
            void main() {
                float d = length(gl_PointCoord - 0.5) * 2.0;
                if (d > 1.0) discard;
                float a = 1.0 - smoothstep(0.3, 1.0, d);
                gl_FragColor = vec4(min(vColor.rgb * 1.15, 1.0), a * vA);
            }
        `,
        transparent: true,
        depthTest: false,
        depthWrite: false
    });

    const scene = new THREE.Scene();
    const cam = new THREE.Camera();
    // Every layer shares one material; each sets its own scroll offset
    // just before it draws. Normal content scrolls with the page.
    // Content in a pinned (sticky) container follows that container:
    // its offset is where the container was when sampled, minus where
    // it is now on screen.
    const makeLayer = (anchor = null) => {
        const layer = new THREE.Points(new THREE.BufferGeometry(), mat);
        layer.frustumCulled = false;
        if (anchor) {
            const sampledTop = anchor.getBoundingClientRect().top + window.scrollY;
            layer.userData.scroll = () => sampledTop - anchor.getBoundingClientRect().top;
        }
        layer.onBeforeRender = () => {
            uniforms.uScroll.value = layer.userData.scroll ? layer.userData.scroll() : window.scrollY;
            mat.uniformsNeedUpdate = true;
        };
        scene.add(layer);
        return layer;
    };
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
    const isVisible = (el) =>
        !el.closest('[data-dust="off"]') &&
        el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";

    function sampleAll() {
        // Start clean: images hidden by a new layout must not leave dust.
        imageLayers.forEach(dropLayer);
        imageLayers.clear();
        pinnedLayers.splice(0).forEach(dropLayer);

        const sx = window.scrollX;
        const sy = window.scrollY;
        // Points are grouped by the sticky container they sit in (null = none).
        const outs = new Map();
        let out = null;
        const useGroup = (el) => {
            const anchor = el.closest("[data-dust-sticky]");
            out = outs.get(anchor);
            if (!out) { out = { x: [], y: [], c: [], s: [] }; outs.set(anchor, out); }
        };
        const push = (x, y, r, g, b, a, size) => {
            out.x.push(x + sx); out.y.push(y + sy);
            out.c.push(r, g, b, a); out.s.push(size);
        };
        const opacityCache = new Map();
        const opacityOf = (el, root) => {
            if (opacityCache.has(el)) return opacityCache.get(el);
            let o = 1;
            for (let n = el; n && n !== root.parentElement; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity);
            opacityCache.set(el, o);
            return o;
        };

        const starlight = cssVar("--starlight", "#EDEDF3");
        const gold = cssVar("--horizon-gold", "#FFD28E");
        const red = cssVar("--horizon-red", "#D66D50");
        const range = document.createRange();

        roots.forEach((root) => {
            /* Words: re-drawn on the scratch canvas, then read back. */
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const el = node.parentElement;
                if (!el || !node.textContent.trim() || !isVisible(el)) continue;
                useGroup(el);
                const cs = getComputedStyle(el);
                const fs = parseFloat(cs.fontSize);
                const hl = el.closest(".highlight");
                const col = parseColor(cs.color);
                if (!hl && (!col || col[3] < 0.05)) continue;
                const alpha = (col ? col[3] : 1) * opacityOf(el, root);
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
                if (!isVisible(el)) return;
                useGroup(el);
                const cs = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                if (r.width === 0 && r.height === 0) return;
                const op = opacityOf(el, root);
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

            /* Images get their own layers, so a late (lazy) load only
               samples that one image. */
            root.querySelectorAll("img").forEach((img) => {
                if (!isVisible(img)) return;
                if (img.complete && img.naturalWidth) sampleImage(img, root);
                else img.addEventListener("load", () => sampleImage(img, root), { once: true });
            });
        });

        upload(textLayer, outs.get(null) || { x: [], y: [], c: [], s: [] }, BUDGET);
        outs.forEach((group, anchor) => {
            if (!anchor) return;
            const layer = makeLayer(anchor);
            upload(layer, group, BUDGET * 0.3);
            pinnedLayers.push(layer);
        });
        sampledHeight = document.documentElement.scrollHeight;
        api.count = [...scene.children].reduce((n, l) => n + l.geometry.drawRange.count, 0);
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
        api.count = [...scene.children].reduce((n, l) => n + l.geometry.drawRange.count, 0);
    }

    function upload(layer, out, budget) {
        const geo = layer.geometry;
        const n = out.x.length;
        let keep = 1;
        if (n > budget) keep = budget / n;
        const grow = keep < 1 ? Math.sqrt(1 / keep) : 1;
        const count = Math.min(n, Math.floor(budget));
        const pos = new Float32Array(count * 3);
        const col = new Float32Array(count * 4);
        const size = new Float32Array(count);
        const seed = new Float32Array(count * 2);
        let k = 0;
        for (let i = 0; i < n && k < count; i++) {
            if (keep < 1 && Math.random() > keep) continue;
            pos[k * 3] = out.x[i];
            pos[k * 3 + 1] = out.y[i];
            col[k * 4] = out.c[i * 4];
            col[k * 4 + 1] = out.c[i * 4 + 1];
            col[k * 4 + 2] = out.c[i * 4 + 2];
            col[k * 4 + 3] = out.c[i * 4 + 3];
            size[k] = Math.min(3.6, out.s[i] * grow);
            seed[k * 2] = Math.random();
            seed[k * 2 + 1] = Math.random();
            k++;
        }
        geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        geo.setAttribute("aColor", new THREE.BufferAttribute(col, 4));
        geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
        geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 2));
        geo.setDrawRange(0, k);
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
        uniforms.uLines.value.set(lines[0], lines[1], lines[2], lines[3]);
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

    const api = {
        canvas,
        count: 0,
        sample: sampleAll,
        tick,
        // Intro: the first screen gathers out of dust, top to bottom.
        setQuality(level) {
            setLevel(level);
            renderer.setPixelRatio(dpr);
            renderer.setSize(vw, vh);
            uniforms.uDpr.value = dpr;
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
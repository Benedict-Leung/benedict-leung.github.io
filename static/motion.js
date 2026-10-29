/* ============================================================
   MOTION — the page layer's choreography.
   ------------------------------------------------------------
   The 3D scene (app.js) flies between planets. This file moves
   the page with it:

   - Smooth, weighted scrolling (Lenis) drives everything.
   - Stardust (stardust.js): every section gathers out of dust
     at the bottom edge of the screen, is solid in between, and
     breaks back into dust at the top edge.
   - A small ship flies along a route at the bottom of the
     screen, past each planet, as you scroll.
   - The About section plays as pinned scenes (ABOUT, at the
     end of this file).
   - The nav steps aside while you read; buttons and links roll
     their labels on hover; in-page links glide.

   Without WebGL, a lighter fallback runs instead: headlines
   rise out of a mask, titles drift together, the biography
   lights up word by word and items fade up as they arrive.
   With prefers-reduced-motion, content is simply shown.
   ============================================================ */

import { createStardust } from "./stardust.js";

let Lenis = null;
try {
    ({ default: Lenis } = await import("lenis"));
} catch (err) {
    console.warn("Lenis did not load; using native scrolling.", err);
}

const gsap = window.gsap;
const ScrollTrigger = window.ScrollTrigger;
gsap.registerPlugin(ScrollTrigger);

const GLYPHS = "<>/\\|[]=+*#%01ABCDEFXZ";

// Expo in-out, used for long programmatic scrolls (nav links).
const EXPO_IN_OUT = (t) =>
    t === 0 || t === 1 ? t
        : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2
            : (2 - Math.pow(2, -20 * t + 10)) / 2;

// The ship on the flight route (nose to the right). Colours come
// from app.css (.ship-*), so it follows the site palette.
const SHIP = `<div class="route-ship-flip"><div class="route-ship-bob"><svg viewBox="0 0 34 20" aria-hidden="true" focusable="false">
<g class="ship-flame"><g class="ship-flicker">
<path class="ship-flame-out" d="M7.5 7 C3 7.5 -0.5 8.8 -3.5 10 C-0.5 11.2 3 12.5 7.5 13 Z"/>
<path class="ship-flame-in" d="M7.5 8.3 C4.5 8.7 2.3 9.4 0.8 10 C2.3 10.6 4.5 11.3 7.5 11.7 Z"/>
</g></g>
<path class="ship-trim" d="M10.5 6 L7 1.9 Q6.4 1 7.5 1.3 L14.5 5 Z"/>
<path class="ship-trim" d="M10.5 14 L7 18.1 Q6.4 19 7.5 18.7 L14.5 15 Z"/>
<path class="ship-body" d="M6.5 10 C6.5 6.2 10 4.6 17 4.6 C23.5 4.6 28.5 6.6 31.5 10 C28.5 13.4 23.5 15.4 17 15.4 C10 15.4 6.5 13.8 6.5 10 Z"/>
<path class="ship-trim" d="M25.5 6.3 C28 7.2 30 8.4 31.5 10 C30 11.6 28 12.8 25.5 13.7 C26.4 12.6 26.9 11.3 26.9 10 C26.9 8.7 26.4 7.4 25.5 6.3 Z"/>
<circle class="ship-window" cx="19" cy="10" r="3.1"/>
<circle class="ship-shine" cx="18" cy="9" r="0.9"/>
</svg></div></div>`;

/* ------------------------------------------------------------
   Text splitting
   ------------------------------------------------------------ */

// Replace an element's content with one span per word. Inline
// children (.highlight, em.accent) are flattened, and their
// classes are copied onto each word so styling survives.
function flattenWords(el, chars) {
    const out = document.createDocumentFragment();
    const words = [];

    const visit = (node, classes) => {
        node.childNodes.forEach((n) => {
            if (n.nodeType === Node.TEXT_NODE) {
                n.textContent.split(/(\s+)/).forEach((part) => {
                    if (!part) return;
                    if (/^\s+$/.test(part)) {
                        out.appendChild(document.createTextNode(" "));
                        return;
                    }
                    const w = document.createElement("span");
                    w.className = ["w", ...classes].join(" ");
                    if (chars) {
                        for (const ch of part) {
                            const c = document.createElement("span");
                            c.className = "c";
                            c.textContent = ch;
                            w.appendChild(c);
                        }
                    } else {
                        w.textContent = part;
                    }
                    out.appendChild(w);
                    words.push(w);
                });
            } else if (n.nodeName === "BR") {
                out.appendChild(document.createElement("br"));
            } else if (n.nodeType === Node.ELEMENT_NODE) {
                visit(n, [...classes, ...n.classList]);
            }
        });
    };

    visit(el, []);
    el.textContent = "";
    el.appendChild(out);
    return words;
}

// Split into visual lines, each wrapped in a clipping mask.
function splitLines(el, { chars = false } = {}) {
    if (el.classList.contains("is-split")) return;
    if (!el.getAttribute("aria-label")) el.setAttribute("aria-label", el.textContent.replace(/\s+/g, " ").trim());

    flattenWords(el, chars);

    const lines = [];
    let current = null;
    let top = 0;
    [...el.childNodes].forEach((n) => {
        if (n.nodeName === "BR") { current = null; return; }
        if (n.nodeType === Node.ELEMENT_NODE) {
            const t = n.offsetTop;
            if (!current || Math.abs(t - top) > 3) {
                current = [];
                lines.push(current);
                top = t;
            }
            current.push(n);
        } else if (current) {
            current.push(n);
        }
    });

    el.textContent = "";
    lines.forEach((nodes) => {
        while (nodes.length && nodes[nodes.length - 1].nodeType === Node.TEXT_NODE) nodes.pop();
        const mask = document.createElement("span");
        mask.className = "line-mask";
        mask.setAttribute("aria-hidden", "true");
        const inner = document.createElement("span");
        inner.className = "line-inner";
        nodes.forEach((n) => inner.appendChild(n));
        mask.appendChild(inner);
        el.appendChild(mask);
    });
    el.classList.add("is-split");
}

/* ------------------------------------------------------------
   Small effects
   ------------------------------------------------------------ */

// Characters resolve left to right out of random glyphs.
function scramble(el, duration = 0.8, text) {
    const final = text ?? (el.dataset.text ??= el.textContent);
    const state = { p: 0 };
    return gsap.to(state, {
        p: 1,
        duration,
        ease: "none",
        onUpdate() {
            const settled = Math.floor(state.p * final.length);
            let s = "";
            for (let i = 0; i < final.length; i++) {
                const ch = final[i];
                s += i < settled || ch === " " ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0];
            }
            el.textContent = s;
        },
        onComplete() { el.textContent = final; }
    });
}

// Hover label that rolls up to a second copy of itself.
function addTextRoll(el) {
    const text = el.textContent.replace(/\s+/g, " ").trim();
    if (!text) return;
    el.textContent = "";
    el.setAttribute("aria-label", text);
    const roll = document.createElement("span");
    roll.className = "roll";
    roll.setAttribute("aria-hidden", "true");
    const inner = document.createElement("span");
    inner.className = "roll-inner";
    inner.dataset.text = text;
    inner.textContent = text;
    roll.appendChild(inner);
    el.appendChild(roll);
}

// A scrollbar drawn by the page. Dragging it scrolls through Lenis, so the
// scroll happens on the main thread in the same frame as the dust and masks.
// The native scrollbar scrolls on the compositor thread, which the dust
// can't follow without lagging.
function createScrollbar(lenis) {
    const root = document.documentElement;
    root.classList.add("custom-scrollbar");

    const bar = document.createElement("div");
    bar.className = "scrollbar";
    bar.setAttribute("aria-hidden", "true");
    const thumb = document.createElement("div");
    thumb.className = "scrollbar-thumb";
    bar.appendChild(thumb);
    document.body.appendChild(bar);

    let thumbH = 0, travel = 1, drag = null;
    const limit = () => Math.max(1, root.scrollHeight - window.innerHeight);
    const clamp = (v) => Math.min(limit(), Math.max(0, v));

    function place() {
        // While dragging, follow the target so the thumb stays under the cursor.
        const y = drag ? lenis.targetScroll : lenis.scroll;
        thumb.style.transform = `translateY(${(clamp(y) / limit()) * travel}px)`;
    }

    function measure() {
        const h = window.innerHeight;
        thumbH = Math.max(40, (h * h) / (h + limit()));
        travel = Math.max(1, h - thumbH);
        thumb.style.height = `${thumbH}px`;
        place();
    }

    thumb.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        thumb.setPointerCapture(e.pointerId);
        drag = { y: e.clientY, start: lenis.targetScroll };
        bar.classList.add("is-dragging");
    });

    thumb.addEventListener("pointermove", (e) => {
        if (!drag) return;
        const target = clamp(drag.start + (e.clientY - drag.y) * (limit() / travel));
        lenis.scrollTo(target, { lerp: 0.2 });   // or { immediate: true } for a raw feel
        place();
    });

    const end = () => {
        drag = null;
        bar.classList.remove("is-dragging");
    };
    thumb.addEventListener("pointerup", end);
    thumb.addEventListener("pointercancel", end);

    // Clicking the track jumps there.
    bar.addEventListener("pointerdown", (e) => {
        if (e.target !== bar || e.button !== 0) return;
        lenis.scrollTo(clamp(((e.clientY - thumbH / 2) / travel) * limit()), { duration: 1.2 });
    });

    lenis.on("scroll", place);
    window.addEventListener("resize", measure);
    new ResizeObserver(measure).observe(document.body);   // page height changes (images, re-sampling)
    measure();
}

/* ------------------------------------------------------------
   Pen annotations
   ------------------------------------------------------------
   A nod to pen-based annotation: gold marks drawn by hand over
   the page. Put a class on any word or phrase:

   - .annot-circle    a loose circle around it
   - .annot-underline a quick underline (one per line of text)
   - .annot-note      (a span of text) a handwritten note

   The marks are SVG paths built to the exact size of the words,
   so the stroke keeps an even width. The pen is tied to the
   scroll: each mark draws as you scroll down past it and lifts
   off again as you scroll back up.
   Settings → "Pen annotations" hides them (html.annot-off).
   ------------------------------------------------------------ */

// Small seeded random, so a mark looks the same on every visit.
function seeded(seed) {
    let t = seed >>> 0;
    return () => {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

// A smooth path through points (midpoint quadratic curves).
function smoothPath(pts) {
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length - 1; i++) {
        const [x, y] = pts[i];
        const mx = (x + pts[i + 1][0]) / 2;
        const my = (y + pts[i + 1][1]) / 2;
        d += ` Q${x.toFixed(1)} ${y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
    }
    const last = pts[pts.length - 1];
    return d + ` L${last[0].toFixed(1)} ${last[1].toFixed(1)}`;
}

// A loose ellipse that overshoots its start, like a quick pen
// circle. (x, y, w, h) is the box of the word.
function circlePath(x, y, w, h, rand) {
    const padX = Math.max(10, h * 0.32);
    const padY = Math.max(6, h * 0.16);
    const cx = x + w / 2, cy = y + h / 2 + h * 0.04;
    const rx = w / 2 + padX, ry = h / 2 + padY;
    const tilt = (-3 + rand() * 2) * Math.PI / 180;
    const start = Math.PI * (0.95 + rand() * 0.1);
    const sweep = Math.PI * 2 + 0.5 + rand() * 0.3;
    const n = 56;
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        const a = start + sweep * t;
        // Drift outward a little, so the end does not meet the start.
        const grow = 1 + t * 0.07 + (rand() - 0.5) * 0.012;
        const ex = Math.cos(a) * rx * grow;
        const ey = Math.sin(a) * ry * (grow - t * 0.1);
        pts.push([cx + ex * Math.cos(tilt) - ey * Math.sin(tilt), cy + ex * Math.sin(tilt) + ey * Math.cos(tilt)]);
    }
    return smoothPath(pts);
}

// A quick underline with a slight rise, under one line of text.
function underlinePath(x, y, w, h, rand) {
    const base = y + h * 0.96;
    const n = 14;
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        const px = x - w * 0.02 + t * w * 1.05;
        const py = base - t * h * 0.05 + Math.sin(t * Math.PI * 1.6 + rand()) * h * 0.025;
        pts.push([px, py]);
    }
    return smoothPath(pts);
}

function createAnnotations({ animate = true } = {}) {
    const root = document.documentElement;
    if (animate) root.classList.add("has-annot");
    // Each mark keeps its own progress: p (how far scrolling has drawn
    // it, 0..1). The hero mark also has intro (drawn in after the
    // intro, by time) and out (erased as the hero scrolls away).
    const marks = [];     // { host, kind, svg, paths, p, intro, out, hero }
    const notes = [...document.querySelectorAll(".annot-note")];
    // Notes are crisp text, not dust: they fade with the mask instead.
    notes.forEach((n) => { n.dataset.dust = "off"; });
    const penEase = gsap.parseEase("power1.inOut");

    // Hosts: after the headlines are split, a class on a word lives
    // on that word's span (.w), so query again each layout.
    const hosts = () => [...document.querySelectorAll(".annot-circle, .annot-underline")]
        .filter((el) => !el.querySelector(".annot-circle, .annot-underline"));

    // Show the drawn part of each stroke. With several strokes (an
    // underline over two lines), they are drawn one after another.
    function apply(mark) {
        const amount = mark.hero ? Math.min(mark.intro, 1 - mark.out) : mark.p;
        const n = mark.paths.length;
        mark.paths.forEach((path, k) => {
            const part = Math.min(1, Math.max(0, amount * n - k));
            path.style.strokeDashoffset = (1 - penEase(part)).toFixed(4);
        });
    }

    function layout() {
        hosts().forEach((host, i) => {
            const kind = host.classList.contains("annot-circle") ? "circle" : "underline";
            // Draw in the nearest heading or paragraph, so the mark can
            // span line breaks and is clipped by the same masks.
            const anchor = host.closest("h1, h2, h3, p, li") || host.parentElement;
            if (getComputedStyle(anchor).position === "static") anchor.style.position = "relative";
            let mark = marks.find((m) => m.host === host);
            if (!mark) {
                const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                svg.setAttribute("class", `annot annot--${kind}`);
                svg.setAttribute("aria-hidden", "true");
                svg.setAttribute("focusable", "false");
                anchor.appendChild(svg);
                const full = animate ? 0 : 1;
                mark = { host, kind, svg, paths: [], p: full, intro: full, out: 0, hero: !!host.closest("#hero") };
                marks.push(mark);
            }
            const ar = anchor.getBoundingClientRect();
            const fs = parseFloat(getComputedStyle(host).fontSize) || 16;
            const rand = seeded(1013 + i * 7919);
            const rects = kind === "circle"
                ? [host.getBoundingClientRect()]
                : [...host.getClientRects()].filter((r) => r.width > 2);
            const ds = rects.map((r) => {
                const x = r.left - ar.left, y = r.top - ar.top;
                return kind === "circle"
                    ? circlePath(x, y, r.width, r.height, rand)
                    : underlinePath(x, y, r.width, r.height, rand);
            });
            const sw = Math.min(3.4, Math.max(1.5, fs * (kind === "circle" ? 0.022 : 0.05)));
            const W = Math.max(1, ar.width), H = Math.max(1, ar.height);
            mark.svg.setAttribute("width", W);
            mark.svg.setAttribute("height", H);
            mark.svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
            mark.svg.style.strokeWidth = sw.toFixed(2);
            mark.svg.innerHTML = ds.map((d) => `<path pathLength="1" d="${d}"/>`).join("");
            mark.paths = [...mark.svg.querySelectorAll("path")];
            apply(mark);
        });
        if (!animate) notes.forEach((n) => n.classList.add("is-drawn"));
    }

    // Called once scrolling is unlocked (after the intro). Every mark
    // is tied to the scroll position (scrub), so the pen draws as you
    // scroll down and lifts off again as you scroll back up.
    function start() {
        if (!animate) return;
        marks.forEach((mark) => {
            if (mark.hero) {
                // Already on screen when the page opens: the pen draws it
                // once the intro ends, then erases it with the scroll as
                // the hero leaves.
                gsap.to(mark, { intro: 1, duration: 1.3, delay: 0.2, ease: "none", onUpdate: () => apply(mark) });
                gsap.to(mark, {
                    out: 1,
                    ease: "none",
                    onUpdate: () => apply(mark),
                    scrollTrigger: { trigger: "#hero", start: "top top", end: "45% top", scrub: 0.6 }
                });
                return;
            }
            gsap.fromTo(mark, { p: 0 }, {
                p: 1,
                ease: "none",
                onUpdate: () => apply(mark),
                scrollTrigger: {
                    trigger: mark.host,
                    start: "top 92%",
                    end: "top 62%",
                    scrub: 0.6,
                    invalidateOnRefresh: true
                }
            });
        });
        // Notes are written out left to right, also with the scroll.
        notes.forEach((note) => {
            gsap.fromTo(note,
                { clipPath: "inset(-20% 100% -20% -5%)" },
                {
                    clipPath: "inset(-20% -5% -20% -5%)",
                    ease: "none",
                    scrollTrigger: { trigger: note, start: "top 90%", end: "top 66%", scrub: 0.6 }
                });
        });
    }

    return { layout, start };
}

/* ------------------------------------------------------------
   Footer name
   ------------------------------------------------------------
   "Benedict Leung", sized to span the full width, letters rising
   into place as the bottom of the page comes into view.
   ------------------------------------------------------------ */
function createFootWord({ animate = true } = {}) {
    const el = document.querySelector(".foot-word");
    if (!el) return { fit() {}, start() {} };

    // One span per word, one per letter inside it.
    const words = el.textContent.trim().split(/\s+/);
    el.textContent = "";
    const chars = [];
    words.forEach((word, wi) => {
        const w = document.createElement("span");
        w.className = "fw-w";
        for (const ch of word) {
            const c = document.createElement("span");
            c.className = "fw-c";
            c.textContent = ch;
            w.appendChild(c);
            chars.push(c);
        }
        el.appendChild(w);
        if (wi < words.length - 1) el.appendChild(document.createTextNode(" "));
    });

    function fit() {
        const avail = el.parentElement.clientWidth;
        if (!avail) return;
        el.style.setProperty("--fit", "100px");
        // Width of the letters themselves, not of the block.
        const range = document.createRange();
        range.selectNodeContents(el);
        const natural = range.getBoundingClientRect().width;
        if (natural) el.style.setProperty("--fit", `${(100 * avail / natural * 0.995).toFixed(2)}px`);
    }

    function start() {
        if (!animate) return;
        gsap.fromTo(chars, { yPercent: 105 }, {
            yPercent: 0,
            ease: "none",
            stagger: 0.06,
            scrollTrigger: { trigger: el, start: "top bottom", end: "bottom bottom", scrub: 0.8 }
        });
    }

    return { fit, start };
}

/* ------------------------------------------------------------
   Main
   ------------------------------------------------------------ */
export function createMotion({ reducedMotion = false, quality = "high" } = {}) {
    const animate = !reducedMotion;

    // The intro always plays from the top of the page.
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    window.scrollTo(0, 0);

    let lenis = null;
    if (animate && Lenis) {
        lenis = new Lenis({
            lerp: 0.085,
            wheelMultiplier: 0.95,
            smoothWheel: true,
            syncTouch: true,        // finger scrolling goes through Lenis too
            syncTouchLerp: 0.075    // how much the scroll glides after a flick (lower = longer glide)
        });
        lenis.on("scroll", ScrollTrigger.update);
        gsap.ticker.add((time) => lenis.raf(time * 1000));
        lenis.stop();

        // Mouse/trackpad users only; touch devices keep their overlay scrollbars.
        if (window.matchMedia("(pointer: fine)").matches) createScrollbar(lenis);

        window.addEventListener("keydown", (e) => {
            if (!lenis || lenis.isStopped || e.target.closest("input, textarea, [contenteditable]")) return;
            const page = window.innerHeight * 0.85;
            const map = { ArrowDown: 80, ArrowUp: -80, PageDown: page, PageUp: -page, " ": e.shiftKey ? -page : page };
            if (e.key === "Home") { e.preventDefault(); lenis.scrollTo(0); return; }
            if (e.key === "End")  { e.preventDefault(); lenis.scrollTo("bottom"); return; }
            if (map[e.key] == null) return;
            e.preventDefault();
            lenis.scrollTo(lenis.targetScroll + map[e.key]);
        });
    }

    const sections = [...document.querySelectorAll("main > section")];
    const blocks = [...document.querySelectorAll("main .content-block")];
    const topBlocks = [...document.querySelectorAll("main > section > .content-block")];
    const heroBlock = document.querySelector("#hero > .content-block");

    /* --- DOM preparation (runs under the preloader) ---------- */

    // Group label + title + "view all" so they move as one unit.
    blocks.forEach((block) => {
        // A pinned column (Capabilities) holds the heading one level down.
        const host = block.querySelector(":scope > [data-dust-sticky]") || block;
        const label = host.querySelector(":scope > .section-label");
        const heading = host.querySelector(":scope > h1, :scope > h2");
        if (!label && !heading) return;
        const head = document.createElement("div");
        head.className = "section-head";
        host.insertBefore(head, label || heading);
        [label, heading, host.querySelector(":scope > .view-all")].forEach((el) => el && head.appendChild(el));
    });

    document.querySelectorAll(".btn-primary, .btn-small, .nav-links a, .contact-links a, .view-all").forEach(addTextRoll);

    // About: the biography as pinned scenes (ABOUT, below). Done before the
    // stardust is sampled, because it makes the section taller.
    const about = prepareAbout({ animate });

    // Stardust needs WebGL; reduced motion gets plain content.
    const dust = animate ? createStardust({ roots: topBlocks, quality }) : null;
    if (dust) {
        document.documentElement.classList.add("has-dust");
        gsap.ticker.add((time) => dust.tick(time));
    }
    const fallback = animate && !dust;

    const ITEMS = ".paper-row, .thesis, .project";
    const followOf = (block) => {
        const out = [];
        const viewAll = block.querySelector(":scope > .section-head > .view-all");
        if (viewAll) out.push(viewAll);
        [...block.children].forEach((c) => {
            if (c.matches(".section-head, .content-block, br, .scrub-text, .paper-index, .paper-head, .gallery, .about-stage")) return;
            out.push(c);
        });
        return out;
    };

    function splitAll() {
        // The capabilities statement keeps its first-line indent, so it is not split.
        // Headings with data-reveal are split by the ABOUT code instead.
        document.querySelectorAll("main h1, main h2:not(.statement):not([data-reveal])").forEach((h) => {
            splitLines(h, { chars: fallback && !!h.closest("#contact") });
        });
        if (fallback) document.querySelectorAll(".scrub-text").forEach((p) => flattenWords(p, false));
    }

    // Fallback only: hidden starting states for the reveals.
    function setInitialStates() {
        document.querySelectorAll(".section-line").forEach((line) => {
            const fromRight = line.closest(".align-right") && window.innerWidth > 768;
            gsap.set(line, { scaleX: 0, transformOrigin: fromRight ? "100% 50%" : "0% 50%" });
        });
        gsap.set(".section-text", { opacity: 0 });
        const lineInners = [...document.querySelectorAll("main h1 .line-inner, main h2 .line-inner")]
            .filter((el) => !el.closest("#contact"));
        gsap.set(lineInners, { yPercent: 115, rotate: 2.5 });
        gsap.set("#contact h2 .c", { yPercent: 115 });
        blocks.forEach((b) => {
            const follow = followOf(b);
            if (follow.length) gsap.set(follow, { opacity: 0, y: 28, filter: "blur(6px)" });
        });
        gsap.set(ITEMS, { opacity: 0, y: 50 });
        gsap.set(".scrub-text .w", { opacity: 0.14 });
    }

    // Wait for the display font, otherwise text is measured with the
    // fallback font (wrong line breaks, wrong dust positions).
    const fontsLoaded = document.fonts
        ? Promise.all([
            document.fonts.load('400 1em "Instrument Serif"'),
            document.fonts.load('italic 400 1em "Instrument Serif"'),
            document.fonts.load('500 1em "Caveat"'),
            document.fonts.ready
        ]).catch(() => {})
        : Promise.resolve();
    const timeout = new Promise((r) => setTimeout(r, 3000));

    // Capabilities: centre the pinned column in the solid band and size
    // the list so every skill passes the middle while the column is pinned.
    function layoutSkills() {
        const block = document.querySelector(".skills-block");
        const left = block && block.querySelector(".skills-left");
        const first = block && block.querySelector(".skill");
        if (!left || !first) return;
        const vh = window.innerHeight;
        const h = left.offsetHeight;
        const item = first.offsetHeight;
        // Pin only on wide screens where the whole column fits in the
        // middle 80% of the screen (clear of the dust zones).
        const pin = window.innerWidth > 900 && h <= vh * 0.8;
        block.classList.toggle("no-pin", !pin);
        if (!pin) return;
        const top = Math.round(Math.min(vh * 0.2, Math.max(vh * 0.1, (vh - h) / 2)));
        block.style.setProperty("--pin-top", `${top}px`);
        block.style.setProperty("--list-lead", `${Math.round(vh / 2 - top - item / 2)}px`);
        // A little extra so the last skill rests at the centre before release.
        block.style.setProperty("--list-tail", `${Math.round(top + h - vh / 2 - item / 2 + vh * 0.08)}px`);
    }
    let skillsTimer = 0;
    window.addEventListener("resize", () => {
        clearTimeout(skillsTimer);
        skillsTimer = setTimeout(() => {
            layoutSkills();
            annotations.layout();
            footWord.fit();
        }, 150);
    });

    // Pen annotations and the footer name (both below this function).
    const annotations = createAnnotations({ animate });
    const footWord = createFootWord({ animate });

    const ready = Promise.race([fontsLoaded, timeout]).then(() => {
        splitAll();
        layoutSkills();
        annotations.layout();
        footWord.fit();
        if (dust) dust.sample();
        if (fallback) setInitialStates();
    });

    /* --- Fallback reveals ------------------------------------ */

    function revealBlock(block) {
        const tl = gsap.timeline();
        const head = block.querySelector(":scope > .section-head");
        if (head) {
            const line = head.querySelector(".section-line");
            const label = head.querySelector(".section-text");
            if (line) tl.to(line, { scaleX: 1, duration: 1.1, ease: "expo.out" }, 0);
            if (label) tl.set(label, { opacity: 1 }, 0.12).add(scramble(label, 0.8), 0.12);
            const chars = head.querySelectorAll(".c");
            if (chars.length) {
                tl.to(chars, { yPercent: 0, duration: 1.1, ease: "expo.out", stagger: 0.022 }, 0.18);
            } else {
                tl.to(head.querySelectorAll(".line-inner"), {
                    yPercent: 0, rotate: 0, duration: 1.3, ease: "expo.out", stagger: 0.1
                }, 0.18);
            }
        }
        const follow = followOf(block);
        if (follow.length) {
            tl.to(follow, {
                opacity: 1, y: 0, filter: "blur(0px)",
                duration: 1.1, ease: "expo.out", stagger: 0.07, clearProps: "filter"
            }, 0.45);
        }
        return tl;
    }

    function buildFallbackScroll() {
        const heroMasks = heroBlock ? heroBlock.querySelectorAll("h1 .line-mask") : [];
        const heroExit = gsap.timeline({ scrollTrigger: { trigger: "#hero", start: "top top", end: "bottom 25%", scrub: 0.6 } });
        if (heroMasks.length) {
            heroExit.to(heroMasks, { x: (i) => (i % 2 ? 1 : -1) * window.innerWidth * 0.05 * (1 + i * 0.4), ease: "none" }, 0);
        }
        heroExit
            .to(heroBlock, { opacity: 0, y: -60, ease: "power1.in" }, 0)
            .to("#hero .hero-bottom", { opacity: 0, ease: "none", duration: 0.35 }, 0);

        blocks.filter((b) => b !== heroBlock).forEach((block) => {
            const head = block.querySelector(":scope > .section-head") || block;
            let done = false;
            const run = () => { if (!done) { done = true; revealBlock(block); } };
            const st = ScrollTrigger.create({ trigger: head, start: "top 85%", once: true, onEnter: run });
            if (window.scrollY > st.start) run();
        });

        ScrollTrigger.batch(ITEMS, {
            start: "top 88%", once: true,
            onEnter: (batch) => gsap.to(batch, { opacity: 1, y: 0, duration: 1.1, ease: "expo.out", stagger: 0.1 })
        });

        document.querySelectorAll("main h2:not([data-reveal])").forEach((h2) => {
            if (h2.closest("#contact")) return;
            const words = h2.querySelectorAll(".w");
            const st = { trigger: h2, start: "top bottom", end: "top 30%", scrub: 0.8, invalidateOnRefresh: true };
            if (words.length > 1) {
                const mid = (words.length - 1) / 2;
                const spread = () => Math.min(window.innerWidth * 0.08, 130);
                gsap.fromTo(words, { x: (i) => (i - mid) * spread() }, { x: 0, ease: "none", scrollTrigger: st });
            } else {
                gsap.fromTo(h2,
                    { letterSpacing: () => (window.innerWidth > 768 ? "0.2em" : "0.08em") },
                    { letterSpacing: "-0.015em", ease: "none", scrollTrigger: st });
            }
        });

        document.querySelectorAll(".scrub-text").forEach((p) => {
            gsap.timeline({ scrollTrigger: { trigger: p, start: "top 78%", end: "bottom 55%", scrub: 0.5 } })
                .to(p.querySelectorAll(".w"), { opacity: 1, stagger: 0.06, duration: 0.25, ease: "none" });
        });
    }

    /* --- Capabilities list ----------------------------------- */

    // Each skill brightens toward the middle of the screen and fades
    // toward the edges; the one nearest the centre gets the arrow.
    function buildSkills() {
        const list = document.querySelector(".skills-list");
        if (!list) return;
        const items = [...list.querySelectorAll(".skill")];
        let active = -1;
        const update = () => {
            const lr = list.getBoundingClientRect();
            const vh = window.innerHeight;
            if (lr.bottom < -vh * 0.2 || lr.top > vh * 1.2) return;
            const mid = vh * 0.5;
            let best = 0, bestD = Infinity;
            items.forEach((el, i) => {
                const r = el.getBoundingClientRect();
                const d = Math.abs(r.top + r.height / 2 - mid);
                if (d < bestD) { bestD = d; best = i; }
                el.style.opacity = Math.max(0.06, 1 - 1.25 * (d / (vh * 0.5))).toFixed(3);
            });
            if (best !== active) {
                if (active >= 0) items[active].classList.remove("is-active");
                items[best].classList.add("is-active");
                active = best;
            }
        };
        gsap.ticker.add(update);
        update();
    }

    /* --- Flight route ---------------------------------------- */

    // A small ship flies along the bottom of the screen. Each section
    // takes the share of the track that it takes of the page's scroll,
    // so a long section (About) is a long stretch. A section that flies
    // to a new planet starts with that planet; a section that stays at
    // the same planet (Skills, at Earth) starts with a small tick.
    // The labels under the track name the sections.
    //
    // It is also a way to travel: click a label to fly to that section,
    // click the track to fly to that point, or drag along it to scrub.
    function buildRoute() {
        const root = document.querySelector(".route");
        if (!root || !sections.length) return;
        root.innerHTML =
            '<div class="route-track">' +
            '<div class="route-line" aria-hidden="true"></div>' +
            '<div class="route-trail" aria-hidden="true"></div>' +
            '</div>';
        const track = root.querySelector(".route-track");
        const trail = root.querySelector(".route-trail");

        // Label: data-route on the section, else its nav link text.
        const nameOf = (s) => {
            if (s.dataset.route) return s.dataset.route;
            const a = document.querySelector(`.nav-links a[href="#${s.id}"]`);
            return a ? (a.getAttribute("aria-label") || a.textContent).trim() : s.id;
        };

        const stops = sections.map((s, i) => {
            const planet = s.dataset.planet;
            const isPlanet = i === 0 || planet !== sections[i - 1].dataset.planet;
            const mark = document.createElement("span");
            mark.className = isPlanet ? "route-planet" : "route-tick";
            mark.setAttribute("aria-hidden", "true");
            if (isPlanet) mark.dataset.planet = planet;
            track.appendChild(mark);
            return { section: s, mark, isPlanet, name: nameOf(s), start: 0, target: 0, x: 0, w: 0, ideal: 0, left: 0 };
        });
        // Each stop remembers the planet stop it belongs to.
        stops.forEach((st, i) => { st.home = st.isPlanet ? st : stops[i - 1].home; });

        const ship = document.createElement("div");
        ship.className = "route-ship";
        ship.setAttribute("aria-hidden", "true");
        ship.innerHTML = SHIP;
        const ghost = document.createElement("span");
        ghost.className = "route-ghost";
        ghost.setAttribute("aria-hidden", "true");
        const hit = document.createElement("div");
        hit.className = "route-hit";
        hit.setAttribute("aria-hidden", "true");
        track.append(ship, ghost, hit);

        // Labels are buttons, on top of the click strip.
        stops.forEach((st) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "route-label";
            b.textContent = st.name;
            b.addEventListener("click", () => glideTo(st.target));
            track.appendChild(b);
            st.label = b;
        });

        let max = 1, width = 1, active = -1;

        // A section starts when its top reaches 55% of the screen, the
        // same line the camera uses to fly to the next planet. Clicking
        // it lands with the section top at the top of the screen, the
        // same place the nav links land.
        function measure() {
            const vh = window.innerHeight;
            max = Math.max(1, document.documentElement.scrollHeight - vh);
            width = track.offsetWidth || 1;
            stops.forEach((st, i) => {
                const top = st.section.getBoundingClientRect().top + window.scrollY;
                st.start = i === 0 ? 0 : Math.min(max, Math.max(0, top - vh * 0.55));
                st.target = i === 0 ? 0 : Math.min(max, Math.max(0, top));
                st.x = (st.start / max) * width;
                st.mark.style.left = `${st.x.toFixed(1)}px`;
                st.w = st.label.offsetWidth;
                st.ideal = Math.min(width - st.w, Math.max(0, st.x - st.w / 2));
            });
            placeLabels();
        }

        // Short sections sit close together (Home and About, Projects and
        // Contact), so their labels would overlap. Each label sits under
        // its stop when it can, and is nudged sideways when it must, so
        // every label shows. Only when the screen is too narrow for all
        // of them do some hide; the current one always shows.
        const LABEL_GAP = 12;
        function placeLabels() {
            const total = stops.reduce((n, st) => n + st.w, 0) + LABEL_GAP * (stops.length - 1);
            if (total <= width) {
                let edge = -Infinity;          // left to right: no overlaps
                stops.forEach((st) => { st.left = Math.max(st.ideal, edge); edge = st.left + st.w + LABEL_GAP; });
                edge = width;                  // right to left: stay on the track
                for (let i = stops.length - 1; i >= 0; i--) {
                    stops[i].left = Math.min(stops[i].left, edge - stops[i].w);
                    edge = stops[i].left - LABEL_GAP;
                }
                stops.forEach((st) => {
                    st.label.style.left = `${st.left.toFixed(1)}px`;
                    st.label.classList.remove("is-hidden");
                });
                return;
            }
            const shown = [];
            const clear = (a, b) => b.ideal >= a.ideal + a.w + LABEL_GAP;
            stops.forEach((st, i) => {
                st.label.style.left = `${st.ideal.toFixed(1)}px`;
                const last = shown[shown.length - 1];
                if (!last || clear(last, st)) shown.push(st);
                else if (i === active) {
                    while (shown.length && !clear(shown[shown.length - 1], st)) shown.pop();
                    shown.push(st);
                }
            });
            stops.forEach((st) => st.label.classList.toggle("is-hidden", !shown.includes(st)));
        }

        const stopAt = (y) => {
            let i = 0;
            while (i + 1 < stops.length && y >= stops[i + 1].start - 1) i++;
            return i;
        };

        function setActive(i) {
            const forward = i > active;
            active = i;
            const home = stops[i].home;
            stops.forEach((st, k) => {
                st.mark.classList.toggle("is-passed", k <= i);
                st.label.classList.toggle("is-current", k === i);
                if (k === i) st.label.setAttribute("aria-current", "location");
                else st.label.removeAttribute("aria-current");
                if (st.isPlanet) st.mark.classList.toggle("is-current", st === home);
            });
            placeLabels();
            // Arriving at a new planet: it pops a little.
            if (animate && forward && stops[i].isPlanet && i > 0) {
                gsap.fromTo(stops[i].mark, { scale: 1.9 }, { scale: 1, duration: 0.7, ease: "expo.out", overwrite: true });
            }
        }

        /* Travel ------------------------------------------------ */

        // A long, eased flight (like the nav links) for clicks.
        function glideTo(y) {
            y = Math.min(max, Math.max(0, y));
            if (lenis) lenis.scrollTo(y, { duration: 2, easing: EXPO_IN_OUT });
            else window.scrollTo({ top: y, behavior: animate ? "smooth" : "auto" });
        }
        // A quick follow for dragging.
        function followTo(y) {
            y = Math.min(max, Math.max(0, y));
            if (lenis) lenis.scrollTo(y, { lerp: 0.2 });
            else window.scrollTo(0, y);
        }

        const xOf = (e) => Math.min(width, Math.max(0, e.clientX - track.getBoundingClientRect().left));
        // Clicks near a planet or tick snap to that section.
        const SNAP = 12;
        const yOf = (x, snap) => {
            if (snap) {
                const near = stops.find((st) => Math.abs(st.x - x) <= SNAP);
                if (near) return near.target;
            }
            return (x / width) * max;
        };

        let hoverStop = -1;
        function hover(x) {
            ghost.style.transform = `translate3d(${x.toFixed(1)}px, 0, 0)`;
            const i = stopAt(yOf(x, false));
            if (i === hoverStop) return;
            if (hoverStop >= 0) stops[hoverStop].label.classList.remove("is-hover");
            stops[i].label.classList.add("is-hover");
            hoverStop = i;
        }
        function unhover() {
            root.classList.remove("is-hovering");
            if (hoverStop >= 0) stops[hoverStop].label.classList.remove("is-hover");
            hoverStop = -1;
        }

        let drag = null;
        hit.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") root.classList.add("is-hovering"); });
        hit.addEventListener("pointerleave", () => { if (!drag) unhover(); });
        hit.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            hit.setPointerCapture(e.pointerId);
            drag = { x0: e.clientX, moved: false };
        });
        hit.addEventListener("pointermove", (e) => {
            const x = xOf(e);
            if (e.pointerType === "mouse") hover(x);
            if (!drag) return;
            if (!drag.moved && Math.abs(e.clientX - drag.x0) > 4) {
                drag.moved = true;
                root.classList.add("is-dragging");
            }
            if (drag.moved) followTo(yOf(x, false));
        });
        const endDrag = (e) => {
            if (!drag) return;
            // A click (no drag): fly there, snapping to a nearby stop.
            if (!drag.moved && e.type === "pointerup") glideTo(yOf(xOf(e), true));
            drag = null;
            root.classList.remove("is-dragging");
            if (e.pointerType !== "mouse") unhover();
        };
        hit.addEventListener("pointerup", endDrag);
        hit.addEventListener("pointercancel", endDrag);

        /* Every frame ------------------------------------------- */

        // Place the ship and trail, set the flame from the scroll speed,
        // and turn the ship to face the way you scroll.
        let thrust = 0.3, back = false, lastY = window.scrollY;
        function frame(time, deltaMs) {
            const y = window.scrollY;
            const dt = Math.max(1, deltaMs || 16) / 1000;
            const v = (y - lastY) / dt;       // px per second
            lastY = y;

            const p = Math.min(1, Math.max(0, y / max));
            ship.style.transform = `translate3d(${(p * width).toFixed(1)}px, 0, 0)`;
            trail.style.transform = `scaleX(${p.toFixed(4)})`;

            const target = animate ? 0.3 + Math.min(1, Math.abs(v) / 2200) * 0.9 : 0.5;
            thrust += (target - thrust) * (1 - Math.exp(-dt * (target > thrust ? 14 : 4)));
            ship.style.setProperty("--thrust", thrust.toFixed(3));

            if (v < -40 && !back) { back = true; ship.classList.add("is-back"); }
            else if (v > 40 && back) { back = false; ship.classList.remove("is-back"); }

            const i = stopAt(y);
            if (i !== active) setActive(i);
        }

        measure();
        frame(0, 16);
        gsap.ticker.add(frame);
        ScrollTrigger.addEventListener("refresh", measure);
        new ResizeObserver(measure).observe(document.body);   // page height changes
        window.addEventListener("resize", measure);
        // Labels change width once the mono font arrives.
        if (document.fonts) document.fonts.ready.then(measure);

        // Over the hero, the route hides if it would sit on the hero's
        // bottom chrome (the swipe cue on phones). It shows once the
        // hero scrolls away. While hidden it cannot be clicked.
        const heroChrome = [...document.querySelectorAll("#hero .hero-bottom")];
        const clashes = () => {
            const r = root.getBoundingClientRect();
            return heroChrome.some((el) => {
                const o = el.getBoundingClientRect();
                return o.width > 0 && o.left < r.right && o.right > r.left && o.top < r.bottom && o.bottom > r.top;
            });
        };
        const show = (on) => {
            root.style.visibility = "";
            gsap.to(root, {
                opacity: on ? 1 : 0, duration: animate ? 0.8 : 0, overwrite: true,
                onComplete: () => { if (!on) root.style.visibility = "hidden"; }
            });
        };
        show(!clashes());
        ScrollTrigger.create({
            trigger: "#hero", start: "top top", end: "bottom 60%",
            onLeave: () => show(true),
            onEnterBack: () => show(!clashes())
        });
    }

    /* --- Always on (reduced motion too) ---------------------- */

    function buildChrome() {
        buildRoute();

        // The hero's bottom chrome fades as you leave the first screen.
        if (animate && !fallback) {
            gsap.to("#hero .hero-bottom", {
                opacity: 0, ease: "none",
                scrollTrigger: { trigger: "#hero", start: "top top", end: "25% top", scrub: 0.4 }
            });
        }

        // Nav steps aside while you read, returns when you scroll up.
        const nav = document.querySelector("nav");
        const menu = document.getElementById("mobile-menu");
        let navHidden = false;
        ScrollTrigger.create({
            start: 0, end: "max",
            onUpdate: (self) => {
                const y = self.scroll();
                const menuOpen = (menu && menu.classList.contains("open")) ||
                    !!document.querySelector(".settings.is-open");
                const hide = !menuOpen && self.direction === 1 && y > 160;
                if (hide !== navHidden) {
                    navHidden = hide;
                    gsap.to(nav, { yPercent: hide ? -110 : 0, duration: animate ? 0.7 : 0, ease: "expo.out" });
                }
            }
        });

        // In-page links glide instead of jumping.
        document.querySelectorAll('a[href^="#"]').forEach((a) => {
            a.addEventListener("click", (e) => {
                const target = document.querySelector(a.getAttribute("href"));
                if (!target) return;
                e.preventDefault();
                if (lenis) lenis.scrollTo(target, { duration: 2, easing: EXPO_IN_OUT });
                else target.scrollIntoView({ behavior: animate ? "smooth" : "auto" });
            });
        });
    }

    return {
        lenis,
        ready,

        // Settings panel hooks.
        setQuality(level) { if (dust) dust.setQuality(level); },
        refresh() {
            layoutSkills();
            annotations.layout();
            footWord.fit();
            if (dust) dust.sample();
            ScrollTrigger.refresh();
        },

        // The hero's entrance, slotted into the intro timeline in app.js.
        heroIntro() {
            const tl = gsap.timeline();
            if (dust) tl.call(() => dust.begin(), null, 0);
            else if (fallback && heroBlock) tl.add(revealBlock(heroBlock), 0);
            return tl;
        },

        // Called once the intro has finished and scrolling is unlocked.
        start() {
            if (lenis) lenis.start();
            if (fallback) buildFallbackScroll();
            buildChrome();
            buildSkills();
            buildAbout(about, { lenis, dust });
            annotations.start();
            footWord.start();
            ScrollTrigger.refresh();
        }
    };
}


/* ============================================================
   ABOUT — the biography, told in short scenes.
   (Was about.js. Used only by createMotion above.)
   ------------------------------------------------------------
   Inspired by nesilnoble.com. The section is several screens
   tall and its stage sticks to the viewport (position: sticky).
   As you scroll, the scenes play one after another in the same
   spot:

   - Scene 1 ("Hi, I'm Ben.") rises letter by letter. Each letter
     rests at its own small tilt, and a squiggle draws under
     the name. Scrolling on, the greeting scales up toward you
     and fades out.
   - The other scenes: the headline sharpens in word by word out
     of a blur, then the short text below it follows.
   - Each scene blurs away upward before the next one arrives.
   - Last scene: "Someone must take the first step." scales up and
     fades the same way, while everything else on the stage (the
     lines around it, the CV button, the label and counter) breaks
     into stardust and drifts up (stardust.js createBurst).

   The stage opts out of the screen-edge stardust (data-dust="off"),
   so these animations are the section's own entrance and exit.

   Sound: the scene changes, zooms and the burst are announced as
   "bl:sound" events on window; audio.js plays them when sound is on.

   Without motion (prefers-reduced-motion) nothing here runs and
   the scenes stay as a plain, readable list (see the ABOUT part of app.css).

   Content is in index.html: every element with data-reveal is
   split ("chars", "words" or "rise"); any other child of a
   scene simply fades up after it. Add, remove or reorder scenes
   freely; the section height and the counter follow.
   ============================================================ */

// Resting tilt (deg) and lift (% of height) per letter of the big
// greeting, so the line sits a little uneven, like hand-set type.
const TILT = [-4, 3, -2, 4, -3, 5, -4, 2, -5, 3, -2, 4];
const LIFT = [3, -4, 2, -3, 4, -2, 3, -4, 2, -3, 4, -2];

// Timeline units (the scroll distance is shared out by these).
const HOLD = 0.9;     // a scene sits fully formed
const OUT = 0.5;      // a scene blurs away
const SCENE_GAP = 0.12;    // empty stage between two scenes
const ZOOM = 3.6;     // how far the big lines scale up as they leave
const ZOOM_DUR = 1.1; // ...and how long that takes
const BURST_DUR = 1.2;

const emit = (type, detail = {}) =>
    window.dispatchEvent(new CustomEvent("bl:sound", { detail: { type, ...detail } }));

// A big line scales up toward the viewer and fades. Scrubbed, so it
// runs backward when you scroll back up.
function zoomOut(tl, el, at) {
    const p = { v: 0 };
    tl.to(el, { scale: ZOOM, duration: ZOOM_DUR, ease: "power2.in" }, at)
      .to(el, { opacity: 0, duration: ZOOM_DUR, ease: "power3.in" }, at)
      .to(p, { v: 1, duration: ZOOM_DUR, ease: "none", onUpdate: () => emit("zoom", { p: p.v }) }, at);
}

/* ------------------------------------------------------------
   Splitting
   ------------------------------------------------------------ */

// Wrap each word (or letter) in a span, in place, so inline
// elements such as <em class="accent"> keep their styling.
// SVG (the squiggle) is left alone.
function splitInPlace(el, mode) {
    const units = [];
    const walk = (node) => {
        [...node.childNodes].forEach((n) => {
            if (n.nodeType === Node.TEXT_NODE) {
                const frag = document.createDocumentFragment();
                n.textContent.split(/(\s+)/).forEach((part) => {
                    if (!part) return;
                    if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(" ")); return; }
                    const word = document.createElement("span");
                    word.className = "aw";
                    if (mode === "chars") {
                        word.setAttribute("aria-hidden", "true");
                        for (const ch of part) {
                            const c = document.createElement("span");
                            c.className = "ac";
                            c.textContent = ch;
                            word.appendChild(c);
                            units.push(c);
                        }
                    } else {
                        word.textContent = part;
                        units.push(word);
                    }
                    frag.appendChild(word);
                });
                n.replaceWith(frag);
            } else if (n.nodeType === Node.ELEMENT_NODE && !(n instanceof SVGElement)) {
                walk(n);
            }
        });
    };
    walk(el);
    return units;
}

/* ------------------------------------------------------------
   Scene timelines
   ------------------------------------------------------------ */

// Hidden starting states, set once and explicitly. (Not left to
// fromTo: ScrollTrigger.refresh() reverts what fromTo renders up
// front, which would leave every scene showing at once.)
const FROM = {
    chars: { yPercent: 120, rotate: (i) => TILT[i % TILT.length] * 4, opacity: 0 },
    words: { opacity: 0, y: "0.3em", filter: "blur(10px)" },
    rise: { opacity: 0, yPercent: 70, rotate: 8 },
    fade: { opacity: 0, y: 24, filter: "blur(6px)" }
};

function hideScene(scene) {
    [...scene.children].forEach((el) => {
        const mode = el._units ? el.dataset.reveal : "fade";
        gsap.set(el._units || el, FROM[mode] || FROM.words);
    });
    const squiggle = scene.querySelector(".about-squiggle path");
    if (squiggle) gsap.set(squiggle, { strokeDashoffset: 1 });
}

// Everything in a scene arrives in reading order.
function sceneIn(scene) {
    const tl = gsap.timeline();
    let t = 0;
    [...scene.children].forEach((el) => {
        const units = el._units;
        const mode = units ? el.dataset.reveal : "fade";
        if (mode === "chars") {
            tl.to(units, {
                yPercent: (i) => LIFT[i % LIFT.length], rotate: (i) => TILT[i % TILT.length], opacity: 1,
                duration: 0.7, ease: "expo.out", stagger: { amount: 0.5 }
            }, t);
            t += 0.6;
        } else if (mode === "rise") {
            tl.to(units, { opacity: 1, yPercent: 0, rotate: 0, duration: 0.6, ease: "expo.out", stagger: { amount: 0.4 } }, t);
            t += 0.55;
        } else if (units) {
            tl.to(units, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.45, ease: "power2.out", stagger: { amount: 0.6 } }, t);
            t += 0.65;
        } else {
            tl.to(el, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.45, ease: "power2.out" }, t);
            t += 0.18;
        }
    });
    const squiggle = scene.querySelector(".about-squiggle path");
    if (squiggle) tl.to(squiggle, { strokeDashoffset: 0, duration: 0.5, ease: "power2.inOut" }, Math.max(0, t - 0.5));
    return tl;
}

// The greeting zooms out; the small lines around it fade first.
function helloOut(scene) {
    const tl = gsap.timeline();
    const title = scene.querySelector(".about-hello");
    const rest = [...scene.children].filter((c) => c !== title);
    tl.to(rest, { opacity: 0, y: -20, filter: "blur(6px)", duration: OUT * 0.7, ease: "power1.in" }, 0);
    if (title) {
        // The letters drift apart a little as they grow.
        const chars = title.querySelectorAll(".ac");
        const mid = (chars.length - 1) / 2;
        tl.to(chars, { x: (i) => (i - mid) * Math.min(window.innerWidth * 0.006, 9), duration: ZOOM_DUR, ease: "power1.in" }, 0);
        zoomOut(tl, title, 0);
    }
    return tl;
}

// The finale: the big line zooms out while the rest turns to dust.
// Without WebGL (no dust) the rest simply fades.
function finaleOut(scene, head, dust) {
    const tl = gsap.timeline();
    const big = scene.querySelector(".about-big");
    const rest = [...scene.children].filter((c) => c !== big);
    const leaving = head ? [head, ...rest] : rest;
    // The big line waits until the lines below it are turning to dust,
    // so its growing letters never sit on top of solid text.
    if (big) zoomOut(tl, big, BURST_DUR * 0.5);

    const burst = dust && dust.createBurst
        ? dust.createBurst({ elements: leaving, anchor: scene.closest(".about-stage") })
        : null;
    const p = { v: 0 };
    tl.to(p, {
        v: 1, duration: BURST_DUR, ease: "none",
        onUpdate: () => {
            if (burst) burst.setProgress(p.v);
            else gsap.set(leaving, { opacity: 1 - p.v });
            emit("burst", { p: p.v });
        }
    }, 0);
    return tl;
}

function sceneOut(scene) {
    return gsap.to(scene, { opacity: 0, y: -40, filter: "blur(8px)", duration: OUT, ease: "power1.in" });
}

/* ------------------------------------------------------------
   Public
   ------------------------------------------------------------ */

// Runs under the preloader, before the stardust is sampled, so
// the taller section is already in the layout it measures.
function prepareAbout({ animate = true } = {}) {
    const section = document.getElementById("about");
    if (!section || !animate || !gsap || !ScrollTrigger) return null;
    const scenes = [...section.querySelectorAll(".about-scene")];
    if (!scenes.length) return null;

    section.classList.add("about-pinned");
    section.style.setProperty("--scenes", scenes.length);
    const total = section.querySelector(".about-count-total");
    if (total) total.textContent = String(scenes.length).padStart(2, "0");

    section.querySelectorAll("[data-reveal]").forEach((el) => {
        const mode = el.dataset.reveal;
        // Letters split into spans read badly in screen readers.
        if (mode === "chars" && !el.getAttribute("aria-label")) {
            el.setAttribute("aria-label", el.textContent.replace(/\s+/g, " ").trim());
        }
        el._units = splitInPlace(el, mode === "chars" ? "chars" : "words");
    });

    scenes[0].classList.add("is-current");
    return { section, scenes };
}

// Runs once the intro is over and scrolling is unlocked.
function buildAbout(state, { lenis = null, dust = null } = {}) {
    if (!state) return null;
    const { section, scenes } = state;
    const track = section.querySelector(".content-block");
    const head = section.querySelector(".about-head");
    const cur = section.querySelector(".about-count-cur");
    const fill = section.querySelector(".about-count-fill");

    scenes.forEach(hideScene);
    if (head) gsap.set(head, { opacity: 0, y: 16 });

    // One timeline owns every animation in this section, so tweens on
    // the same element can never run out of order, even when the page
    // jumps (scrollbar drag, End key).

    // 1. The first scene forms while the stage rises into view.
    const entrance = gsap.timeline();
    if (head) entrance.to(head, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }, 0);
    entrance.add(sceneIn(scenes[0]), 0.1);

    // 2. While the stage is stuck, the scenes take turns.
    const starts = [0];   // when each scene starts arriving
    const rests = [0];    // when each scene is fully formed
    const body = gsap.timeline();
    let t = HOLD * 0.6;
    scenes.forEach((scene, i) => {
        if (i > 0) {
            starts[i] = t;
            const tl = sceneIn(scene);
            body.add(tl, t);
            t += tl.duration();
            rests[i] = t;
            t += HOLD;
        }
        if (i === 0 && scenes.length > 1) {
            body.add(helloOut(scene), t);
            t += ZOOM_DUR * 0.8;          // the next scene starts as the zoom fades
        } else if (i < scenes.length - 1) {
            body.add(sceneOut(scene), t);
            t += OUT + SCENE_GAP;
        } else {
            const tl = finaleOut(scene, head, dust);
            body.add(tl, t);
            t += tl.duration();
        }
    });
    body.set({}, {}, t + HOLD * 0.3);   // a moment of empty stage before it lets go

    // The entrance plays over the approach (stage top from 55% of the
    // screen to the top), the rest while pinned. Shares of the timeline
    // are set to match those scroll distances.
    const approach = window.innerHeight * 0.55;
    const pinned = Math.max(1, track.offsetHeight - window.innerHeight);
    const E = body.duration() * approach / pinned;
    entrance.timeScale(entrance.duration() / E);
    const master = gsap.timeline();
    master.add(entrance, 0).add(body, E);
    for (let i = 0; i < starts.length; i++) { starts[i] += E; rests[i] += E; }
    starts[0] = 0;

    let active = 0;
    const setActive = (i) => {
        if (i === active) return;
        scenes[active].classList.remove("is-current");
        scenes[i].classList.add("is-current");
        active = i;
        emit("scene", { index: i });
        if (cur) {
            cur.textContent = String(i + 1).padStart(2, "0");
            gsap.fromTo(cur, { yPercent: 100 }, { yPercent: 0, duration: 0.5, ease: "expo.out", overwrite: true });
        }
    };

    const st = ScrollTrigger.create({
        trigger: track,
        start: "top 55%",
        end: "bottom bottom",
        scrub: 0.6,
        animation: master,
        invalidateOnRefresh: true
    });
    master.eventCallback("onUpdate", () => {
        const time = master.time();
        let i = 0;
        while (i + 1 < starts.length && time >= starts[i + 1]) i++;
        setActive(i);
        if (fill) gsap.set(fill, { scaleX: master.progress() });
    });

    // Keyboard: tabbing into a scene (the CV link) scrolls to where
    // that scene is fully formed, so focus never lands on hidden text.
    scenes.forEach((scene, i) => {
        scene.addEventListener("focusin", () => {
            if (!st) return;
            const y = st.start + (rests[i] / master.duration()) * (st.end - st.start);
            if (lenis) lenis.scrollTo(y, { immediate: true });
            else window.scrollTo(0, y);
        });
    });

    ScrollTrigger.refresh();
    return { master };
}
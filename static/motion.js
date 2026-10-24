/* ============================================================
   MOTION — the page layer's choreography.
   ------------------------------------------------------------
   The 3D scene (app.js) flies between planets. This file moves
   the page with it:

   - Smooth, weighted scrolling (Lenis) drives everything.
   - Stardust (stardust.js): every section gathers out of dust
     at the bottom edge of the screen, is solid in between, and
     breaks back into dust at the top edge.
   - A small orbit readout tracks which planet you are at.
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

const ORBITS = {
    overview: "SOL // SYSTEM VIEW",
    earth: "EARTH // 1.00 AU",
    mars: "MARS // 1.52 AU",
    jupiter: "JUPITER // 5.20 AU",
    saturn: "SATURN // 9.58 AU"
};

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

    // Stardust needs WebGL; reduced motion gets plain content.
    const dust = animate ? createStardust({ roots: topBlocks, quality }) : null;
    if (dust) {
        document.documentElement.classList.add("has-dust");
        gsap.ticker.add((time) => dust.tick(time));
    }
    const fallback = animate && !dust;

    const ITEMS = ".pub-row, .thesis, .project";
    const followOf = (block) => {
        const out = [];
        const viewAll = block.querySelector(":scope > .section-head > .view-all");
        if (viewAll) out.push(viewAll);
        [...block.children].forEach((c) => {
            if (c.matches(".section-head, .content-block, br, .scrub-text, .pub-index, .pub-head, .gallery")) return;
            if (c.matches(".contact-links")) out.push(...c.children);
            else out.push(c);
        });
        return out;
    };

    function splitAll() {
        // The capabilities statement keeps its first-line indent, so it is not split.
        document.querySelectorAll("main h1, main h2:not(.statement)").forEach((h) => {
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
            document.fonts.load('400 1em "Playfair Display"'),
            document.fonts.load('italic 400 1em "Playfair Display"'),
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
        skillsTimer = setTimeout(layoutSkills, 150);
    });

    const ready = Promise.race([fontsLoaded, timeout]).then(() => {
        splitAll();
        layoutSkills();
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
            .to("#hero .hud-footer, #hero .scroll-indicator, #hero .sys-status, #hero .deco-line-vertical",
                { opacity: 0, ease: "none", duration: 0.35 }, 0);

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

        document.querySelectorAll("main h2").forEach((h2) => {
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

    /* --- Always on (reduced motion too) ---------------------- */

    function buildChrome() {
        // Orbit readout: which planet, and how far through the page.
        const hud = document.querySelector(".orbit-hud");
        if (hud) {
            const cur = hud.querySelector(".oi-cur");
            const name = hud.querySelector(".orbit-name");
            const fill = hud.querySelector(".orbit-fill");
            let active = 0;
            const setOrbit = (i, section) => {
                if (i === active) return;
                active = i;
                cur.textContent = String(i + 1).padStart(2, "0");
                const label = ORBITS[section.dataset.planet] || "";
                if (animate) {
                    gsap.fromTo(cur, { yPercent: 100 }, { yPercent: 0, duration: 0.6, ease: "expo.out" });
                    scramble(name, 0.6, label);
                } else {
                    name.textContent = label;
                }
            };
            // Counted by planet, so a section that stays at the same
            // planet (Capabilities, at Earth) keeps the same number.
            const PLANETS = ["overview", "earth", "mars", "jupiter", "saturn"];
            sections.forEach((s) => ScrollTrigger.create({
                trigger: s, start: "top 55%", end: "bottom 55%",
                onToggle: (self) => self.isActive && setOrbit(Math.max(0, PLANETS.indexOf(s.dataset.planet)), s)
            }));
            ScrollTrigger.create({
                start: 0, end: "max",
                onUpdate: (self) => gsap.set(fill, { scaleX: self.progress })
            });
            // On phones the readout would sit on the swipe cue, so it
            // only appears once the hero has scrolled away.
            const isPhone = () => window.innerWidth <= 768;
            const showHud = (on) => gsap.to(hud, { opacity: on ? 1 : 0, duration: animate ? 0.8 : 0, overwrite: true });
            showHud(!isPhone());
            ScrollTrigger.create({
                trigger: "#hero", start: "top top", end: "bottom 60%",
                onLeave: () => showHud(true),
                onEnterBack: () => showHud(!isPhone())
            });
        }

        // The hero's bottom chrome fades as you leave the first screen.
        if (animate && !fallback) {
            gsap.to("#hero .hud-footer, #hero .scroll-indicator, #hero .sys-status, #hero .deco-line-vertical", {
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
            if (dust) dust.sample();
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
            ScrollTrigger.refresh();
        }
    };
}
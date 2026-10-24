/* ============================================================
   AUDIO — music and sound, made live with the Web Audio API.
   ------------------------------------------------------------
   No audio files: every sound is built from oscillators and
   noise, so there is nothing to download or license.

   Sound is OFF until the visitor turns it on with the nav button
   ("SOUND OFF" / "SOUND ON", like nesilnoble.com). Browsers only
   allow audio after a click or key press, and a quiet page is the
   polite default. The choice is saved in this browser; if it was
   on, sound resumes at the visitor's first click or key press.

   What plays:
   - Music: a slow ambient pad. Each planet has its own chord, and
     the pad drifts to the new chord as the camera flies there.
     Soft high notes sparkle now and then, like distant stars.
   - Warp: a rushing wind that grows with the camera's speed.
   - About: a small bell for each new scene; a rising swell while
     a big line zooms out; a shimmer of crackles while the stage
     turns to stardust.
   - Interface: a faint tick on hover and a soft click on press.

   Inputs:
   - app.js calls setPlanet(key), setWarp(0..1) and showHint().
   - about.js sends "bl:sound" events on window:
       { type: "scene", index } | { type: "zoom", p } | { type: "burst", p }
   ============================================================ */

const KEY = "bl-sound";

// Note frequencies (Hz).
const N = {
    E2: 82.41, G2: 98.0, A2: 110.0, B2: 123.47,
    D3: 146.83, E3: 164.81, F$3: 185.0, G3: 196.0, A3: 220.0, B3: 246.94,
    C$4: 277.18, D4: 293.66, E4: 329.63, F$4: 369.99, G4: 392.0, A4: 440.0,
    B4: 493.88, D5: 587.33, E5: 659.25, F$5: 739.99, A5: 880.0, B5: 987.77, D6: 1174.66
};

// One chord per planet: open voicings, all close to D major so the
// changes feel like drifting, not jumping.
const CHORDS = {
    overview: [N.D3, N.A3, N.E4, N.F$4],   // D add9
    earth: [N.B2, N.F$3, N.D4, N.A4],      // B minor 7
    mars: [N.G2, N.D3, N.B3, N.F$4],       // G major 7
    jupiter: [N.E2, N.B2, N.G3, N.D4],     // E minor 7
    saturn: [N.A2, N.E3, N.B3, N.C$4]      // A add9
};

// Bell notes for the About scenes (D major pentatonic, rising).
const BELLS = [N.D5, N.E5, N.F$5, N.A5, N.B5, N.D6];

const MASTER_ON = 0.75;

function loadPref() {
    try { return localStorage.getItem(KEY) === "on"; } catch (e) { return false; }
}
function savePref(on) {
    try { localStorage.setItem(KEY, on ? "on" : "off"); } catch (e) { /* private mode */ }
}

export function createAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    let ctx = null;
    let on = false;
    let wanted = loadPref();     // saved as on: start at the first gesture
    let planet = "overview";

    // Nodes, made in init().
    let master, sfx, verbIn, noise, crackle;
    let pad = null;              // current chord voices
    let warpGain, warpBand, rumbleGain;
    let zoomGain, zoomBand, zoomTone, zoomToneGain;
    let burstGain;
    let lastWarp = -1;
    let sparkleTimer = 0;
    let lastBurst = 0;

    /* --- Building blocks ------------------------------------- */

    const now = () => ctx.currentTime;

    function gainNode(v, ...outs) {
        const g = ctx.createGain();
        g.gain.value = v;
        outs.forEach((o) => g.connect(o));
        return g;
    }

    // White noise, looped.
    function noiseBuffer(seconds) {
        const len = Math.floor(ctx.sampleRate * seconds);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        return buf;
    }

    // Sparse little clicks: the sound of dust crackling.
    function crackleBuffer(seconds) {
        const len = Math.floor(ctx.sampleRate * seconds);
        const buf = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
            const d = buf.getChannelData(ch);
            for (let i = 0; i < len; i++) {
                if (Math.random() < 0.0016) {
                    const amp = (0.3 + Math.random() * 0.7) * (Math.random() < 0.5 ? -1 : 1);
                    const n = 30 + (Math.random() * 120) | 0;
                    for (let k = 0; k < n && i + k < len; k++) d[i + k] += amp * Math.exp(-k / (n / 5)) * (Math.random() * 2 - 1);
                }
            }
        }
        return buf;
    }

    // A long, soft reverb tail made from decaying noise.
    function impulse(seconds, decay) {
        const len = Math.floor(ctx.sampleRate * seconds);
        const buf = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
            const d = buf.getChannelData(ch);
            for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
        }
        return buf;
    }

    function loop(buffer) {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        src.start();
        return src;
    }

    /* --- Setup ----------------------------------------------- */

    function init() {
        ctx = new AC();

        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -16;
        comp.ratio.value = 3;
        comp.connect(ctx.destination);
        master = gainNode(0, comp);

        const verb = ctx.createConvolver();
        verb.buffer = impulse(4, 2.8);
        verb.connect(master);
        verbIn = gainNode(0.8, verb);

        sfx = gainNode(0.9, master);
        const sfxSend = gainNode(0.25, verbIn);
        sfx.connect(sfxSend);

        noise = noiseBuffer(3);
        crackle = crackleBuffer(4);

        // Warp: rushing wind plus a low rumble, both silent until moving.
        warpBand = ctx.createBiquadFilter();
        warpBand.type = "bandpass";
        warpBand.Q.value = 0.8;
        warpBand.frequency.value = 300;
        warpGain = gainNode(0, sfx);
        loop(noise).connect(warpBand).connect(warpGain);
        const rumble = ctx.createOscillator();
        rumble.frequency.value = 46;
        rumbleGain = gainNode(0, sfx);
        rumble.connect(rumbleGain);
        rumble.start();

        // Zoom: a rising, airy swell with a faint tone under it.
        zoomBand = ctx.createBiquadFilter();
        zoomBand.type = "bandpass";
        zoomBand.Q.value = 1.4;
        zoomGain = gainNode(0, sfx);
        loop(noise).connect(zoomBand).connect(zoomGain);
        zoomTone = ctx.createOscillator();
        zoomTone.type = "sine";
        zoomTone.frequency.value = 110;
        zoomToneGain = gainNode(0, sfx);
        zoomTone.connect(zoomToneGain);
        zoomTone.start();

        // Burst: high crackles while the stage turns to dust.
        const burstHp = ctx.createBiquadFilter();
        burstHp.type = "highpass";
        burstHp.frequency.value = 2500;
        burstGain = gainNode(0, sfx, verbIn);
        loop(crackle).connect(burstHp).connect(burstGain);

        setChord(planet, 0.5);
    }

    /* --- Music ------------------------------------------------ */

    function setChord(key, fade = 4) {
        const notes = CHORDS[key] || CHORDS.overview;
        const t = now();

        // Fade out the old chord, then stop it.
        if (pad) {
            const old = pad;
            old.gain.gain.cancelScheduledValues(t);
            old.gain.gain.setValueAtTime(old.gain.gain.value, t);
            old.gain.gain.linearRampToValueAtTime(0, t + fade);
            old.oscs.forEach((o) => o.stop(t + fade + 0.1));
        }

        const out = gainNode(0, master, verbIn);
        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 900;
        filter.Q.value = 0.6;
        filter.connect(out);

        // Slow breathing in the brightness.
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.06;
        const lfoAmt = gainNode(350, filter.frequency);
        lfo.connect(lfoAmt);

        const oscs = [lfo];
        notes.forEach((f, i) => {
            // Two slightly detuned voices per note make it shimmer.
            [-6, 6].forEach((cents) => {
                const o = ctx.createOscillator();
                o.type = "triangle";
                o.frequency.value = f;
                o.detune.value = cents + (Math.random() - 0.5) * 3;
                const g = gainNode(0.11 / notes.length * (i === 0 ? 1.4 : 1), filter);
                o.connect(g);
                oscs.push(o);
            });
        });
        // A quiet sine an octave under the root.
        const sub = ctx.createOscillator();
        sub.frequency.value = notes[0] / 2;
        sub.connect(gainNode(0.035, out));
        oscs.push(sub);

        oscs.forEach((o) => o.start(t));
        out.gain.setValueAtTime(0, t);
        out.gain.linearRampToValueAtTime(1, t + fade);
        pad = { gain: out, oscs, notes };
    }

    // Now and then, one soft high note from the current chord.
    function sparkle(level = 0.045, octave = 4) {
        if (!ctx || !pad) return;
        const t = now();
        const f = pad.notes[(Math.random() * pad.notes.length) | 0] * octave;
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(level, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
        const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        if (pan) { pan.pan.value = Math.random() * 1.6 - 0.8; o.connect(g).connect(pan); pan.connect(verbIn); pan.connect(gainNode(0.35, master)); }
        else { o.connect(g); g.connect(verbIn); }
        o.start(t);
        o.stop(t + 2.5);
    }

    function scheduleSparkles() {
        clearTimeout(sparkleTimer);
        sparkleTimer = setTimeout(() => {
            if (on && ctx && ctx.state === "running") sparkle();
            scheduleSparkles();
        }, 2500 + Math.random() * 5000);
    }

    /* --- Sound effects ---------------------------------------- */

    function bell(f, level = 0.05) {
        const t = now();
        const out = gainNode(1, sfx, verbIn);
        // A bell is a few partials that are not whole-number multiples.
        [[1, 1], [2.76, 0.35], [5.4, 0.12]].forEach(([m, a]) => {
            const o = ctx.createOscillator();
            o.frequency.value = f * m;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(level * a, t + 0.006);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 2.8 / m + 0.4);
            o.connect(g).connect(out);
            o.start(t);
            o.stop(t + 3.4);
        });
    }

    let lastTick = 0;
    function tick() {
        const t = now();
        if (t - lastTick < 0.05) return;
        lastTick = t;
        const o = ctx.createOscillator();
        o.frequency.value = 2600;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.018, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
        o.connect(g).connect(sfx);
        o.start(t);
        o.stop(t + 0.05);
    }

    function click() {
        const t = now();
        const o = ctx.createOscillator();
        o.type = "triangle";
        o.frequency.setValueAtTime(660, t);
        o.frequency.exponentialRampToValueAtTime(330, t + 0.07);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.06, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
        o.connect(g).connect(sfx);
        o.start(t);
        o.stop(t + 0.14);
        const n = ctx.createBufferSource();
        n.buffer = noise;
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = 4000;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.035, t);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
        n.connect(hp).connect(ng).connect(sfx);
        n.start(t, Math.random());
        n.stop(t + 0.03);
    }

    // Scrubbed effects follow a progress value (0..1), so they also
    // play backward when you scroll back.
    const swell = (p) => Math.sin(Math.PI * Math.min(1, Math.max(0, p)));

    function zoom(p) {
        const t = now();
        zoomGain.gain.setTargetAtTime(swell(p) * 0.22, t, 0.05);
        zoomBand.frequency.setTargetAtTime(350 + p * 3200, t, 0.05);
        zoomTone.frequency.setTargetAtTime(110 * Math.pow(2, p * 2), t, 0.05);
        zoomToneGain.gain.setTargetAtTime(swell(p) * 0.04, t, 0.05);
    }

    function burst(p) {
        const t = now();
        burstGain.gain.setTargetAtTime(swell(p) * 0.4, t, 0.06);
        // A few bright notes as the dust lets go (forward only).
        [0.15, 0.4, 0.65].forEach((mark) => {
            if (lastBurst < mark && p >= mark) sparkle(0.04, 8);
        });
        lastBurst = p;
    }

    /* --- On / off --------------------------------------------- */

    function enable() {
        if (!AC) return;
        if (!ctx) init();
        ctx.resume();
        on = true;
        wanted = true;
        savePref(true);
        const t = now();
        master.gain.cancelScheduledValues(t);
        master.gain.setValueAtTime(master.gain.value, t);
        master.gain.linearRampToValueAtTime(MASTER_ON, t + 1.2);
        scheduleSparkles();
        render();
    }

    function disable() {
        on = false;
        wanted = false;
        savePref(false);
        clearTimeout(sparkleTimer);
        if (ctx) {
            const t = now();
            master.gain.cancelScheduledValues(t);
            master.gain.setValueAtTime(master.gain.value, t);
            master.gain.linearRampToValueAtTime(0, t + 0.5);
            setTimeout(() => { if (!on && ctx) ctx.suspend(); }, 700);
        }
        render();
    }

    // Saved as on: start at the first gesture the browser accepts.
    const resumeOnGesture = () => {
        window.removeEventListener("pointerdown", resumeOnGesture, true);
        window.removeEventListener("keydown", resumeOnGesture, true);
        if (wanted && !on) enable();
    };
    if (wanted) {
        window.addEventListener("pointerdown", resumeOnGesture, true);
        window.addEventListener("keydown", resumeOnGesture, true);
    }

    document.addEventListener("visibilitychange", () => {
        if (!ctx) return;
        if (document.hidden) ctx.suspend();
        else if (on) ctx.resume();
    });

    /* --- Nav button ------------------------------------------- */

    const wrap = document.createElement("div");
    wrap.className = "sound";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sound-btn";
    btn.innerHTML = `<span class="sound-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="sound-label"><span class="sound-label-pre">Sound </span><span class="sound-state">Off</span></span>`;
    const hint = document.createElement("div");
    hint.className = "sound-hint";
    hint.setAttribute("aria-hidden", "true");
    hint.textContent = "Click for sound";
    wrap.appendChild(btn);
    wrap.appendChild(hint);

    const nav = document.querySelector("nav");
    if (nav) {
        const links = nav.querySelector(".nav-links");
        nav.insertBefore(wrap, links ? links.nextSibling : nav.querySelector(".menu-toggle"));
    }

    function render() {
        wrap.classList.toggle("is-on", on || wanted);
        btn.setAttribute("aria-pressed", String(on));
        btn.setAttribute("aria-label", on ? "Turn sound off" : "Turn sound on");
        btn.querySelector(".sound-state").textContent = on || wanted ? "On" : "Off";
    }
    render();

    btn.addEventListener("click", () => {
        hint.classList.remove("is-visible");
        if (on) disable();
        else { enable(); click(); }
    });

    /* --- Interface sounds (delegated) -------------------------- */

    let hovered = null;
    document.addEventListener("pointerover", (e) => {
        if (!on || e.pointerType !== "mouse") return;
        const el = e.target.closest && e.target.closest("a, button");
        if (el === hovered) return;
        hovered = el;
        if (el && el !== btn) tick();
    });
    document.addEventListener("click", (e) => {
        if (!on) return;
        const el = e.target.closest && e.target.closest("a, button");
        if (el && el !== btn) click();
    });

    window.addEventListener("bl:sound", (e) => {
        if (!on || !ctx) return;
        const d = e.detail || {};
        if (d.type === "scene") bell(BELLS[d.index % BELLS.length]);
        else if (d.type === "zoom") zoom(d.p);
        else if (d.type === "burst") burst(d.p);
    });

    /* --- Public ----------------------------------------------- */

    return {
        setPlanet(key) {
            if (key === planet) return;
            planet = key;
            if (ctx) setChord(key);
        },
        // 0..1, every frame from the render loop.
        setWarp(w) {
            if (!on || !ctx || Math.abs(w - lastWarp) < 0.004) return;
            lastWarp = w;
            const t = now();
            warpGain.gain.setTargetAtTime(w * w * 0.3, t, 0.08);
            warpBand.frequency.setTargetAtTime(250 + w * 2600, t, 0.1);
            rumbleGain.gain.setTargetAtTime(w * 0.16, t, 0.1);
        },
        // A short "Click for sound" bubble after the intro.
        showHint() {
            if (on || wanted) return;
            hint.classList.add("is-visible");
            setTimeout(() => hint.classList.remove("is-visible"), 6000);
        },
        enable,
        disable,
        get on() { return on; }
    };
}
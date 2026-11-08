/* ============================================================
   AUDIO — music and sound, made live with the Web Audio API.
   ------------------------------------------------------------
   No audio files: every sound is built from oscillators and
   noise, so there is nothing to download or license.

   Sound is OFF until the visitor chooses. On entering, the
   preloader's "Enter with sound" / "Enter without sound" buttons
   decide (app.js); later the nav button ("SOUND OFF" / "SOUND ON",
   like nesilnoble.com) switches it. Browsers only allow audio after
   a click or key press, and a quiet page is the polite default.
   Nothing plays from any other click, so the loading screen stays
   silent until one of the enter buttons is pressed.

   What plays:
   - Music: a slow ambient pad. Each planet has its own chord, and
     the pad drifts to the new chord as the camera flies there.
     Soft high notes sparkle now and then, like distant stars.
   - Flight between planets (all grow with the camera's speed):
       a deep stereo whoosh (brown noise through slowly moving
       resonant filters, no hiss), an engine drone tuned to the
       planet's chord that rises in pitch like a doppler swoop,
       and a high shimmer of chord tones washed in reverb.
       Leaving a planet starts a rising warp-up glide; arriving
       ends with a soft low thump and a few star notes.
   - About: a small bell for each new scene; a deep rising swell
     (soft noise and two tones a fifth apart) while a big line
     zooms out; while the stage turns to stardust, a soft rising
     breath and a cloud of tiny star notes drifting in the reverb.
   - Sunrise (intro, as the sun rises into view): a deep swell and
     a rising rush of soft noise that open into a warm, ringing
     chord with a few star notes.
   - Interface: a faint tick on hover and a soft click on press.

   Inputs:
   - app.js calls setPlanet(key), setWarp(0..1), sunrise() and showHint().
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

function savePref(on) {
    try { localStorage.setItem(KEY, on ? "on" : "off"); } catch (e) { /* private mode */ }
}

export function createAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    let ctx = null;
    let on = false;
    let planet = "overview";

    // Nodes, made in init().
    let master, sfx, verbIn, noise, brown;
    let pad = null;              // current chord voices
    let whooshGain, whooshFilters = [], whooshLfoAmt;
    let droneGain, droneFilter, droneOscs = [];
    let shimmerGain, shimmerOscs = [];
    let warpArmed = false;
    let lastDepart = -10;
    let zoomGain, zoomBand, zoomTone, zoomTone2, zoomToneGain;
    let burstGain, burstBand;
    let grainAcc = 0;
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

    // Brown noise: white noise with the highs rolled off, a deep
    // soft rush instead of a hiss.
    function brownBuffer(seconds) {
        const len = Math.floor(ctx.sampleRate * seconds);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        let last = 0;
        for (let i = 0; i < len; i++) {
            last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
            d[i] = last * 3.5;
        }
        // Fade the ends together so the loop does not click.
        const x = Math.min(len >> 1, Math.floor(ctx.sampleRate * 0.05));
        for (let i = 0; i < x; i++) {
            const k = i / x;
            d[i] = d[i] * k + d[len - x + i] * (1 - k);
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
        brown = brownBuffer(6);

        // Flight: everything below is silent until the camera moves.
        // Most of it is sent into the long reverb, so it sounds far
        // away and wide, like space, not close like wind.
        const warpBus = gainNode(1, sfx);
        warpBus.connect(gainNode(0.9, verbIn));

        // 1. Whoosh: two brown-noise streams, left and right, each
        //    through a resonant lowpass that drifts slowly.
        whooshGain = gainNode(0, warpBus);
        const wobble = ctx.createOscillator();
        wobble.frequency.value = 0.13;
        whooshLfoAmt = ctx.createGain();
        whooshLfoAmt.gain.value = 60;
        wobble.connect(whooshLfoAmt);
        wobble.start();
        [-0.75, 0.75].forEach((side, i) => {
            const src = ctx.createBufferSource();
            src.buffer = brown;
            src.loop = true;
            src.start(0, i * 2.7);
            const f = ctx.createBiquadFilter();
            f.type = "lowpass";
            f.Q.value = 7;
            f.frequency.value = 160;
            whooshLfoAmt.connect(f.frequency);
            const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
            src.connect(f);
            if (pan) { pan.pan.value = side; f.connect(pan).connect(whooshGain); }
            else f.connect(whooshGain);
            whooshFilters.push(f);
        });

        // 2. Engine drone: two detuned saws and a sine, an octave
        //    under the chord's root, through a lowpass that opens up.
        droneFilter = ctx.createBiquadFilter();
        droneFilter.type = "lowpass";
        droneFilter.Q.value = 3;
        droneFilter.frequency.value = 90;
        droneGain = gainNode(0, warpBus);
        droneFilter.connect(droneGain);
        const root = (CHORDS[planet] || CHORDS.overview)[0] / 2;
        // The octave-up saw lets laptop and phone speakers carry the hum.
        [["sawtooth", 1, -7], ["sawtooth", 1, 7], ["sawtooth", 2, 4], ["sine", 0.5, 0]].forEach(([type, mult, cents]) => {
            const o = ctx.createOscillator();
            o.type = type;
            o.frequency.value = root * mult;
            o.detune.value = cents;
            o._mult = mult;
            o._cents = cents;
            o.connect(gainNode(type === "sine" ? 0.9 : mult === 2 ? 0.22 : 0.35, droneFilter));
            o.start();
            droneOscs.push(o);
        });

        // 3. Shimmer: high chord tones with a slow vibrato, almost
        //    all reverb, like a far-off choir of stars.
        shimmerGain = gainNode(0, verbIn);
        shimmerGain.connect(gainNode(0.25, sfx));
        const vib = ctx.createOscillator();
        vib.frequency.value = 4.2;
        const vibAmt = gainNode(9);
        vib.connect(vibAmt);
        vib.start();
        (CHORDS[planet] || CHORDS.overview).forEach((f, i) => {
            const o = ctx.createOscillator();
            o.type = "sine";
            o.frequency.value = f * (i < 2 ? 4 : 2);
            o._mult = i < 2 ? 4 : 2;
            vibAmt.connect(o.detune);
            const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
            const g = gainNode(0.25);
            o.connect(g);
            if (pan) { pan.pan.value = (i / 3) * 1.4 - 0.7; g.connect(pan).connect(shimmerGain); }
            else g.connect(shimmerGain);
            o.start();
            shimmerOscs.push(o);
        });

        // Zoom: a rising, airy swell with a faint tone under it.
        // Deep noise through a resonant lowpass that rises, plus two
        // soft tones a fifth apart. Half of it goes to the reverb.
        zoomBand = ctx.createBiquadFilter();
        zoomBand.type = "lowpass";
        zoomBand.Q.value = 6;
        zoomBand.frequency.value = 250;
        zoomGain = gainNode(0, sfx);
        zoomGain.connect(gainNode(0.6, verbIn));
        loop(brown).connect(zoomBand).connect(zoomGain);
        zoomToneGain = gainNode(0, sfx);
        zoomToneGain.connect(gainNode(0.8, verbIn));
        zoomTone = ctx.createOscillator();
        zoomTone.type = "sine";
        zoomTone.frequency.value = 110;
        zoomTone.connect(zoomToneGain);
        zoomTone.start();
        zoomTone2 = ctx.createOscillator();
        zoomTone2.type = "sine";
        zoomTone2.frequency.value = 165;
        zoomTone2.connect(gainNode(0.6, zoomToneGain));
        zoomTone2.start();

        // Burst: a soft breath that rises while the stage turns to
        // dust (the star notes over it are made in burst()).
        burstBand = ctx.createBiquadFilter();
        burstBand.type = "bandpass";
        burstBand.Q.value = 3;
        burstBand.frequency.value = 400;
        burstGain = gainNode(0, sfx, verbIn);
        loop(brown).connect(burstBand).connect(burstGain);

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
        // The flight drone and shimmer glide to the new chord.
        droneOscs.forEach((o) => o.frequency.setTargetAtTime(notes[0] / 2 * o._mult, t, 1.2));
        shimmerOscs.forEach((o, i) => o.frequency.setTargetAtTime(notes[i % notes.length] * o._mult, t, 1.2));
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

    // Leaving a planet: two tones a fifth apart glide up and fade,
    // under a resonant sweep. Mostly reverb.
    function depart() {
        const t = now();
        if (t - lastDepart < 0.8) return;
        lastDepart = t;
        const out = gainNode(0, sfx, verbIn);
        out.gain.setValueAtTime(0, t);
        out.gain.linearRampToValueAtTime(0.05, t + 0.5);
        out.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
        const f = ctx.createBiquadFilter();
        f.type = "lowpass";
        f.Q.value = 9;
        f.frequency.setValueAtTime(300, t);
        f.frequency.exponentialRampToValueAtTime(2600, t + 1.8);
        f.connect(out);
        const root = pad ? pad.notes[0] : N.D3;
        [1, 1.5].forEach((m) => {
            const o = ctx.createOscillator();
            o.type = "triangle";
            o.frequency.setValueAtTime(root * m, t);
            o.frequency.exponentialRampToValueAtTime(root * m * 4, t + 2.2);
            o.connect(f);
            o.start(t);
            o.stop(t + 2.8);
        });
    }

    // Arriving: a soft low thump and a few star notes.
    function arrive() {
        const t = now();
        const o = ctx.createOscillator();
        o.frequency.setValueAtTime(70, t);
        o.frequency.exponentialRampToValueAtTime(34, t + 1.4);
        const g = gainNode(0, sfx);
        g.connect(gainNode(0.5, verbIn));
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.16, t + 0.04);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
        o.connect(g);
        o.start(t);
        o.stop(t + 2);
        [0, 0.18, 0.4].forEach((d) => setTimeout(() => { if (on) sparkle(0.03, 4); }, d * 1000));
    }

    // The sun rising in the intro. It swells for `rise` seconds, then
    // opens into a warm chord that rings out in the reverb.
    function sunrise(rise = 2.2) {
        const t = now();
        const peak = t + rise;
        const chord = CHORDS.overview;

        // A deep swell under it all (root and the octave below).
        const sub = gainNode(0, sfx);
        sub.connect(gainNode(0.4, verbIn));
        sub.gain.setValueAtTime(0.0001, t);
        sub.gain.exponentialRampToValueAtTime(0.6, peak);
        sub.gain.exponentialRampToValueAtTime(0.0001, peak + 4);
        [0.5, 0.25].forEach((m) => {
            const o = ctx.createOscillator();
            o.frequency.value = chord[0] * m;
            o.connect(sub);
            o.start(t);
            o.stop(peak + 4.1);
        });

        // A rush of soft noise that rises and opens, like a breath in.
        const src = ctx.createBufferSource();
        src.buffer = brown;
        const f = ctx.createBiquadFilter();
        f.type = "lowpass";
        f.Q.value = 8;
        f.frequency.setValueAtTime(120, t);
        f.frequency.exponentialRampToValueAtTime(1600, peak);
        f.frequency.exponentialRampToValueAtTime(400, peak + 2.5);
        const rush = gainNode(0, sfx, verbIn);
        rush.gain.setValueAtTime(0.0001, t);
        rush.gain.exponentialRampToValueAtTime(1.1, peak);
        rush.gain.exponentialRampToValueAtTime(0.0001, peak + 2.5);
        src.connect(f).connect(rush);
        src.start(t, Math.random() * 2);
        src.stop(peak + 2.6);

        // The bloom: the chord an octave up, warm and slow to fade,
        // mostly reverb, spread left to right.
        chord.forEach((n, i) => {
            const o = ctx.createOscillator();
            o.type = "triangle";
            o.frequency.value = n * 2;
            o.detune.value = (Math.random() - 0.5) * 8;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0, peak - 0.15);
            g.gain.linearRampToValueAtTime(0.12, peak + 0.35);
            g.gain.exponentialRampToValueAtTime(0.0001, peak + 5.5);
            o.connect(g);
            const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
            if (pan) { pan.pan.value = (i / (chord.length - 1)) * 1.2 - 0.6; g.connect(pan); pan.connect(verbIn); pan.connect(gainNode(0.5, sfx)); }
            else { g.connect(verbIn); g.connect(gainNode(0.5, sfx)); }
            o.start(peak - 0.15);
            o.stop(peak + 5.6);
        });
        [0.1, 0.45, 0.9].forEach((d) => setTimeout(() => { if (on) sparkle(0.07, 4); }, (rise + d) * 1000));
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
        const rise = Math.pow(2, p * 2);   // two octaves over the zoom
        zoomGain.gain.setTargetAtTime(swell(p) * 0.42, t, 0.05);
        zoomBand.frequency.setTargetAtTime(250 + p * 1600, t, 0.05);
        zoomTone.frequency.setTargetAtTime(110 * rise, t, 0.05);
        zoomTone2.frequency.setTargetAtTime(165 * rise, t, 0.05);
        zoomToneGain.gain.setTargetAtTime(swell(p) * 0.105, t, 0.05);
    }

    // One star note: a soft, high sine from the current chord that
    // fades slowly, placed somewhere left to right, mostly reverb.
    function grain() {
        const t = now() + Math.random() * 0.04;
        const notes = pad ? pad.notes : CHORDS.overview;
        const f = notes[(Math.random() * notes.length) | 0] * (Math.random() < 0.6 ? 4 : 8);
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = f;
        o.detune.value = (Math.random() - 0.5) * 12;
        const g = ctx.createGain();
        const level = 0.042 + Math.random() * 0.059;
        const len = 0.6 + Math.random() * 0.9;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(level, t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        o.connect(g);
        const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        if (pan) { pan.pan.value = Math.random() * 1.8 - 0.9; g.connect(pan); pan.connect(verbIn); pan.connect(gainNode(0.3, sfx)); }
        else { g.connect(verbIn); }
        o.start(t);
        o.stop(t + len + 0.05);
    }

    function burst(p) {
        const t = now();
        burstGain.gain.setTargetAtTime(swell(p) * 0.64, t, 0.08);
        burstBand.frequency.setTargetAtTime(400 + p * 1400, t, 0.08);
        // Star notes, as many as the dust moves (either direction),
        // densest in the middle of the burst. About 45 over a burst.
        grainAcc += Math.abs(p - lastBurst) * 70 * (0.3 + 0.7 * swell(p));
        lastBurst = p;
        let n = 0;
        while (grainAcc >= 1 && n < 4) { grainAcc -= 1; n++; grain(); }
        grainAcc = Math.min(grainAcc, 2);
    }

    /* --- On / off --------------------------------------------- */

    function enable() {
        if (!AC) return;
        if (!ctx) init();
        ctx.resume();
        on = true;
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
        wrap.classList.toggle("is-on", on);
        btn.setAttribute("aria-pressed", String(on));
        btn.setAttribute("aria-label", on ? "Turn sound off" : "Turn sound on");
        btn.querySelector(".sound-state").textContent = on ? "On" : "Off";
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
            if (ctx) {
                setChord(key);
                if (on && ctx.state === "running") depart();
            }
        },
        // 0..1, every frame from the render loop.
        setWarp(w) {
            if (!on || !ctx || Math.abs(w - lastWarp) < 0.004) return;
            lastWarp = w;
            // A flight that got going and is now slowing down: arrival.
            if (w > 0.45) warpArmed = true;
            else if (warpArmed && w < 0.12) { warpArmed = false; arrive(); }
            const t = now();
            const e = w * w * (3 - 2 * w);   // smooth start and end
            whooshGain.gain.setTargetAtTime(e * 0.32, t, 0.12);
            whooshFilters.forEach((f, i) => f.frequency.setTargetAtTime((140 + w * 780) * (i ? 1.19 : 1), t, 0.15));
            droneGain.gain.setTargetAtTime(e * 0.24, t, 0.15);
            droneFilter.frequency.setTargetAtTime(140 + w * 760, t, 0.15);
            // Pitch rises with speed, like a doppler swoop (up to a fifth).
            droneOscs.forEach((o) => o.detune.setTargetAtTime(o._cents + w * 700, t, 0.2));
            shimmerGain.gain.setTargetAtTime(Math.max(0, e - 0.15) * 0.05, t, 0.3);
        },
        // The sun rising in the intro (only heard with sound on).
        sunrise(rise) {
            if (on && ctx) sunrise(rise);
        },
        // A short "Click for sound" bubble after the intro.
        showHint() {
            if (on) return;
            hint.classList.add("is-visible");
            setTimeout(() => hint.classList.remove("is-visible"), 6000);
        },
        enable,
        disable,
        get on() { return on; }
    };
}
/* ============================================================
   SETTINGS — graphics quality and readability.
   ------------------------------------------------------------
   A gear button in the nav opens a small panel with two
   choices. They are saved in this browser (localStorage) and
   applied before the page builds, so a reload keeps them.

   - Graphics: "high" | "low"
       low = lower 3D resolution, no bloom, no warp streaks,
       half-density stardust, no glass blur (html.q-low).
   - Readability: "standard" | "high"
       high = dims the space background behind the content,
       brightens body text and adds a soft halo behind
       text (html.read-high).
   ============================================================ */

const KEY = "bl-site-settings";
const DEFAULTS = { quality: "low", readability: "high" };

const OPTIONS = {
    quality: { label: "Graphics", choices: [["high", "High"], ["low", "Low"]],
        // hint: "Low turns off glow, streaks and blur, and draws less stardust. Try it if scrolling feels slow."
     },
    readability: { label: "Readability", choices: [["standard", "Standard"], ["high", "High contrast"]],
        // hint: "Dims the background behind the text and brightens the text."
     }
};

function read() {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
        const out = { ...DEFAULTS };
        for (const k of Object.keys(OPTIONS)) {
            if (OPTIONS[k].choices.some(([v]) => v === saved[k])) out[k] = saved[k];
        }
        return out;
    } catch (e) {
        return { ...DEFAULTS };
    }
}

function write(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
}

function applyClasses(state) {
    const root = document.documentElement;
    root.classList.toggle("q-low", state.quality === "low");
    root.classList.toggle("read-high", state.readability === "high");
}

// Read and apply at once (called before the page is measured).
export function loadSettings() {
    const state = read();
    applyClasses(state);
    return state;
}

const GEAR = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

// Build the nav button + panel. onChange(key, value, state) runs on every change.
export function createSettingsPanel({ state, onChange } = {}) {
    const nav = document.querySelector("nav");
    if (!nav) return null;
    const current = { ...state };

    const wrap = document.createElement("div");
    wrap.className = "settings";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "settings-btn";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "settings-panel");
    btn.innerHTML = `${GEAR}`;
    btn.setAttribute("aria-label", "Settings");

    const panel = document.createElement("div");
    panel.className = "settings-panel";
    panel.id = "settings-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Display settings");
    panel.hidden = true;

    for (const [key, opt] of Object.entries(OPTIONS)) {
        const group = document.createElement("div");
        group.className = "settings-group";
        const id = `settings-${key}`;
        group.innerHTML = `<div class="settings-label" id="${id}">${opt.label}</div>`;
        const seg = document.createElement("div");
        seg.className = "settings-seg";
        seg.setAttribute("role", "group");
        seg.setAttribute("aria-labelledby", id);
        opt.choices.forEach(([value, text]) => {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = text;
            b.dataset.value = value;
            b.setAttribute("aria-pressed", String(current[key] === value));
            b.addEventListener("click", () => {
                if (current[key] === value) return;
                current[key] = value;
                seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
                applyClasses(current);
                write(current);
                if (onChange) onChange(key, value, { ...current });
            });
            seg.appendChild(b);
        });
        group.appendChild(seg);
        const hint = document.createElement("p");
        hint.className = "settings-hint";
        hint.textContent = opt.hint;
        group.appendChild(hint);
        panel.appendChild(group);
    }

    wrap.appendChild(btn);
    wrap.appendChild(panel);
    const menuBtn = nav.querySelector(".menu-toggle");
    nav.insertBefore(wrap, menuBtn || null);

    const open = (on) => {
        panel.hidden = !on;
        btn.setAttribute("aria-expanded", String(on));
        wrap.classList.toggle("is-open", on);
    };
    btn.addEventListener("click", () => open(panel.hidden));
    document.addEventListener("pointerdown", (e) => { if (!panel.hidden && !wrap.contains(e.target)) open(false); });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !panel.hidden) { open(false); btn.focus(); }
    });

    return { isOpen: () => !panel.hidden, close: () => open(false) };
}
// Abilities (inspired by Blade Ball), PlayStyles (inspired by EA FC 26) and keybinds.
// The ids must match server/loadout.py. Effects are simulated in game.js.

// cooldown in ms; "needs" explains when the ability can fail (then no cooldown is used).
export const ABILITIES = {
    dash: {
        name: "Dash", icon: "💨", color: "#4aa3df", cooldown: 5000,
        description: "Burst forward in your movement direction.",
    },
    blink: {
        name: "Blink", icon: "✨", color: "#9b59b6", cooldown: 7000,
        description: "Teleport towards your cursor – up to 7 times before the cooldown. Only without the ball.",
    },
    shadow_step: {
        name: "Shadow Step", icon: "👣", color: "#34495e", cooldown: 10000,
        description: "Run 50% faster for 3 seconds.",
    },
    ninja_dash: {
        name: "Ninja Dash", icon: "🥷", color: "#2c3e50", cooldown: 10000,
        description: "Teleport right next to the ball (max. 500 px away).",
    },
    invisibility: {
        name: "Invisibility", icon: "👻", color: "#7f8c8d", cooldown: 12000,
        description: "Opponents can't see you for 3 seconds.",
    },
    freeze: {
        name: "Freeze", icon: "❄️", color: "#5dade2", cooldown: 10000,
        description: "Freeze a loose ball in place for 1.5 seconds – stop a shot on your goal.",
    },
    forcefield: {
        name: "Forcefield", icon: "🛡️", color: "#16a085", cooldown: 12000,
        description: "For 3 seconds you can't be tackled and you grab loose balls from further away.",
    },
    pull: {
        name: "Pull", icon: "🧲", color: "#c0392b", cooldown: 10000,
        description: "Pull a loose ball towards you (max. 600 px away).",
    },
    telekinesis: {
        name: "Telekinesis", icon: "🌀", color: "#8e44ad", cooldown: 12000,
        description: "Redirect a loose ball towards your cursor – and make it faster.",
    },
    raging_deflection: {
        name: "Raging Deflection", icon: "💥", color: "#e74c3c", cooldown: 8000,
        description: "Your next shot (within 5 s) is 200% faster.",
    },
    rapture: {
        name: "Rapture", icon: "🌪️", color: "#d35400", cooldown: 8000,
        description: "Your next shot (within 5 s) curves towards the goal.",
    },
    swap: {
        name: "Swap", icon: "🔄", color: "#27ae60", cooldown: 14000,
        description: "Swap places with the nearest opponent.",
    },
    hell_hook: {
        name: "Hell Hook", icon: "🪝", color: "#922b21", cooldown: 12000,
        description: "Hook every opponent within half the field and drag them in front of you.",
    },
    force: {
        name: "Force", icon: "💢", color: "#f39c12", cooldown: 12000,
        description: "Shockwave that pushes nearby opponents away – they lose the ball.",
    },
    time_hole: {
        name: "Time Hole", icon: "⏳", color: "#6c3483", cooldown: 14000,
        description: "For 3 seconds, opponents and the ball near you move in slow motion.",
    },
};

// Silver (normal) PlayStyles only. "badge" = when the icon pops up in a match,
// like in FC where the PlayStyle icon appears the moment it kicks in.
export const PLAYSTYLES = {
    finesse_shot: {
        name: "Finesse Shot", short: "FS", category: "Scoring",
        description: "Shots near the goal are guided a bit towards the goal mouth.",
        badge: "When a shot gets guided.",
    },
    power_shot: {
        name: "Power Shot", short: "PS", category: "Scoring",
        description: "All your shots are 20% faster.",
        badge: "On every shot.",
    },
    chip_shot: {
        name: "Chip Shot", short: "CS", category: "Scoring",
        description: "Your shots fly over players for the first 0.4 s – nobody can intercept them.",
        badge: "On every shot.",
    },
    rapid: {
        name: "Rapid", short: "RA", category: "Ball Control",
        description: "12% faster when sprinting with the ball.",
        badge: "When you start sprinting with the ball.",
    },
    technical: {
        name: "Technical", short: "TE", category: "Ball Control",
        description: "No speed loss while carrying the ball (others are 8% slower).",
        badge: "When you win the ball.",
    },
    trickster: {
        name: "Trickster", short: "TR", category: "Ball Control",
        description: "Spin (dodge) cooldown 1.8 s instead of 3 s and a longer dodge window.",
        badge: "On every spin.",
    },
    press_proven: {
        name: "Press Proven", short: "PP", category: "Ball Control",
        description: "50% chance to resist a tackle while you don't sprint.",
        badge: "When you resist a tackle.",
    },
    intercept: {
        name: "Intercept", short: "IN", category: "Defending",
        description: "Bigger reach for balls played by opponents.",
        badge: "When you intercept an opponent's ball.",
    },
    anticipate: {
        name: "Anticipate", short: "AN", category: "Defending",
        description: "Tackle cooldown 2 s instead of 3 s.",
        badge: "When your tackle wins the ball.",
    },
    slide_tackle: {
        name: "Slide Tackle", short: "ST", category: "Defending",
        description: "Faster slide tackle with more reach.",
        badge: "When your tackle wins the ball.",
    },
    jockey: {
        name: "Jockey", short: "JO", category: "Defending",
        description: "12% faster (without sprinting) near an opponent who has the ball.",
        badge: "When you start jockeying.",
    },
    quick_step: {
        name: "Quick Step", short: "QS", category: "Physical",
        description: "30% faster for the first 0.6 s of a sprint.",
        badge: "When you start a sprint.",
    },
    bruiser: {
        name: "Bruiser", short: "BR", category: "Physical",
        description: "Your successful tackles knock the opponent back.",
        badge: "When your tackle knocks someone back.",
    },
    enforcer: {
        name: "Enforcer", short: "EN", category: "Physical",
        description: "Opponents barely push you around while you have the ball.",
        badge: "When you hold off an opponent.",
    },
};

export const MAX_PLAYSTYLES = 2;

// Optional custom icons: image files in client/assets/abilities/<id>.png (or .webp/.svg/.gif/.jpg)
// and client/assets/playstyles/<id>.png replace the built-in symbols. The server lists them.
export const ICONS = { abilities: {}, playstyles: {} };

export async function loadIcons() {
    try {
        const response = await fetch("/api/icons");
        if (response.ok) Object.assign(ICONS, await response.json());
    } catch {
        // no custom icons – built-in symbols are used
    }
    return ICONS;
}

// ---------------------------------------------------------------------------
// Keybinds (stored per browser)
// ---------------------------------------------------------------------------

export const KEY_ACTIONS = [
    { id: "up", label: "Move up" },
    { id: "left", label: "Move left" },
    { id: "down", label: "Move down" },
    { id: "right", label: "Move right" },
    { id: "sprint", label: "Sprint" },
    { id: "shoot", label: "Shoot (or left click)" },
    { id: "tackle", label: "Slide tackle" },
    { id: "dribble", label: "Spin / dodge (with ball)" },
    { id: "ability", label: "Use ability" },
];

const DEFAULT_KEYBINDS = {
    up: { code: 87, label: "W" },
    left: { code: 65, label: "A" },
    down: { code: 83, label: "S" },
    right: { code: 68, label: "D" },
    sprint: { code: 16, label: "Shift" },
    shoot: { code: 70, label: "F" },
    tackle: { code: 69, label: "E" },
    dribble: { code: 81, label: "Q" },
    ability: { code: 82, label: "R" },
};

const KEYBIND_STORAGE_KEY = "bigleagues.keybinds";

export function loadKeybinds() {
    try {
        const stored = JSON.parse(localStorage.getItem(KEYBIND_STORAGE_KEY) || "{}");
        return { ...DEFAULT_KEYBINDS, ...stored };
    } catch {
        return { ...DEFAULT_KEYBINDS };
    }
}

export function saveKeybinds(binds) {
    try {
        localStorage.setItem(KEYBIND_STORAGE_KEY, JSON.stringify(binds));
    } catch {
        // storage unavailable – binds last until reload
    }
}

export function defaultKeybinds() {
    return { ...DEFAULT_KEYBINDS };
}

const ARROW_LABELS = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };

export function keyLabel(event) {
    if (event.key === " ") return "Space";
    if (event.key.length === 1) return event.key.toUpperCase();
    return ARROW_LABELS[event.key] || event.key;
}

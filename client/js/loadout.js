// Abilities (inspired by Blade Ball), PlayStyles (inspired by EA FC 26) and keybinds.
// The ids must match server/loadout.py. Effects are simulated in game.js.

// cooldown in ms. passive: works on its own (the ability key does nothing).
// once: can be used a single time per match.
export const ABILITIES = {
    dash: {
        name: "Dash", icon: "💨", color: "#4aa3df", cooldown: 5000,
        description: "Burst towards your mouse cursor.",
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
        description: "Teleport right next to the ball – anywhere on the field.",
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
        description: "For 3 seconds tackles mostly fail (30% chance of a foul getting through) and you grab loose balls from further away.",
    },
    pull: {
        name: "Pull", icon: "🧲", color: "#c0392b", cooldown: 10000,
        description: "Pull a loose ball towards you – anywhere on the field.",
    },
    telekinesis: {
        name: "Telekinesis", icon: "🌀", color: "#8e44ad", cooldown: 12000,
        description: "Redirect a loose ball towards your cursor – and make it faster.",
    },
    raging_deflection: {
        name: "Raging Deflection", icon: "💥", color: "#e74c3c", cooldown: 20000,
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
        description: "Chain every opponent within half the field and slowly drag them to you. A ball they carry stays where it is.",
    },
    force: {
        name: "Force", icon: "💢", color: "#f39c12", cooldown: 12000,
        description: "Shockwave that pushes nearby opponents away – they lose the ball.",
    },
    time_hole: {
        name: "Time Hole", icon: "⏳", color: "#6c3483", cooldown: 14000,
        description: "For 3 seconds, opponents and the ball in a big circle around you move in slow motion.",
    },
    reaper: {
        name: "Reaper", icon: "💀", color: "#5b2c6f", cooldown: 0, passive: true,
        description: "Passive: every goal you score makes you 30% stronger in everything (speed, shots, tackles) – stacks up to 5 goals.",
    },
    platform: {
        name: "Platform", icon: "🧱", color: "#8d6e4f", cooldown: 30000,
        description: "Raise a square wall (as wide as a goal) at your cursor – anywhere on the field. Blocks ball and players for 30 s; the cooldown starts after the wall is gone.",
    },
    virus: {
        name: "Virus", icon: "🦠", color: "#1e8449", cooldown: 0, passive: true,
        description: "Passive: an opponent who gets the ball from you goes almost blind for 3 seconds.",
    },
    absolute_confidence: {
        name: "Absolute Confidence", icon: "😤", color: "#c0392b", cooldown: 30000,
        description: "For 6 seconds every ball played by someone else flies to you – nobody can intercept it.",
    },
    scopophobia: {
        name: "Scopophobia", icon: "👁️", color: "#4a235a", cooldown: 30000,
        description: "Conqueror's Haki: a clip plays and the game freezes – then nobody except you can move for 15 seconds.",
    },
    flash_counter: {
        name: "Flash Counter", icon: "⚡", color: "#f4d03f", cooldown: 20000,
        description: "After an opponent took the ball straight from your shot (within 5 s): flash behind them, steal the ball and freeze them.",
    },
    guardian_angel: {
        name: "Guardian Angel", icon: "😇", color: "#f7dc6f", cooldown: 50000, passive: true,
        description: "Passive: when the opponents would score, you save the ball instantly. No goal against you for 10 s – each save resets the 10 s.",
    },
    slash_of_duality: {
        name: "Slash of Duality", icon: "☯️", color: "#7f8c8d", cooldown: 30000,
        description: "Pick Light or Dark for your next shot. Light: super fast. Dark: starts slow, then speeds up every 0.2 s up to 1000%.",
    },
    slashes_of_fury: {
        name: "Slashes of Fury", icon: "🔥", color: "#e67e22", cooldown: 30000,
        description: "For 10 s every shot boomerangs back to you and gets 20% faster each kick. After that, fire the charged shot.",
    },
    zeus_storm: {
        name: "Zeus' Storm", icon: "🌩️", color: "#f1c40f", cooldown: 0, once: true,
        description: "Once per match, 1 minute: everyone except you is 50% slower (also shots) and has a 50% chance every 5 s to be stunned for 3 s.",
    },
    displace: {
        name: "Displace", icon: "🎲", color: "#16a085", cooldown: 13000,
        description: "The ball teleports to a random player.",
    },
    infinity: {
        name: "Infinity", icon: "♾️", color: "#2e86c1", cooldown: 0, passive: true, once: true,
        description: "Passive: an invisible force pushes the ball and opponents away – you can't touch the ball. Use once: a clip plays, your team gets 10 goals, and you lose all abilities and PlayStyles.",
    },
    titan: {
        name: "Titan", icon: "🗿", color: "#7b7d7d", cooldown: 20000,
        description: "For 6 seconds you are bigger, shoot 50% harder and reach further – but you are 25% slower.",
    },
    chieftains_totem: {
        name: "Chieftain's Totem", icon: "🪶", color: "#b9770e", cooldown: 14000,
        description: "For 3 seconds, you and teammates in a big circle around you are 25% faster and shoot 25% harder.",
    },
    pulse: {
        name: "Pulse", icon: "📡", color: "#a569bd", cooldown: 20000,
        description: "Disables all opponents' abilities (and their running effects) for 6 seconds.",
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

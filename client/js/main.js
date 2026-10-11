import { Connection } from "./net.js";
import {
    ABILITIES, PLAYSTYLES, MAX_PLAYSTYLES, KEY_ACTIONS, ICONS,
    loadKeybinds, saveKeybinds, defaultKeybinds, keyLabel, loadIcons,
} from "./loadout.js";

// Per tab, so two tabs can be logged in with different accounts for testing.
const TOKEN_STORAGE_KEY = "bigleagues.token";
const FILTER_STORAGE_KEY = "bigleagues.filters";
const CONTROLS_STORAGE_KEY = "bigleagues.controlsHidden";
const MODE_LABELS = { 1: "1 vs 1", 2: "2 vs 2", 3: "3 vs 3" };
const TEAM_NAMES = { A: "Red", B: "Blue" };
const PING_INTERVAL_MS = 3000;
const LOBBY_REFRESH_MS = 4000;
const MAX_SKIN_BYTES = 2 * 1024 * 1024;

const FLAG_BASE = "https://cdn.jsdelivr.net/npm/flag-icons@7.5.0";
// Non-ISO flags that make sense for football.
const EXTRA_FLAGS = { "gb-eng": "England", "gb-sct": "Scotland", "gb-wls": "Wales", "gb-nir": "Northern Ireland", eu: "European Union", xk: "Kosovo" };

const LOCK_ICON = '<svg class="lock" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-label="Password"><path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 0 1 6 0v3H9z"/></svg>';

const $ = (id) => document.getElementById(id);

const state = {
    token: loadToken(),
    myId: null,
    profile: { name: "", skin: null, ability: "dash", playstyles: [] },
    myPing: null,    // round trip to the server in ms
    lobby: null,     // details of the lobby we are in
    lobbies: [],     // public lobby list
    online: 0,
    selectedLobbyId: null,
    filters: loadFilters(),
    keybinds: loadKeybinds(),
    game: null,      // running game controller
    inGame: false,   // game screen is showing (also while Phaser still loads)
    screen: "screen-start",
    leaderboardReturn: "screen-start",
};

// Loaded on demand so the menus work even before Phaser is downloaded.
const loadGameModule = () => import("./game.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function storageGet(storage, key) {
    try {
        return storage.getItem(key);
    } catch {
        return null; // storage unavailable (private mode)
    }
}

function storageSet(storage, key, value) {
    try {
        if (value === null) storage.removeItem(key);
        else storage.setItem(key, value);
    } catch {
        // storage unavailable – setting just isn't remembered
    }
}

function loadToken() {
    return storageGet(sessionStorage, TOKEN_STORAGE_KEY);
}

function saveToken(token) {
    state.token = token;
    storageSet(sessionStorage, TOKEN_STORAGE_KEY, token);
}

function loadFilters() {
    const defaults = { locked: true, full: true, empty: true };
    try {
        return { ...defaults, ...JSON.parse(storageGet(localStorage, FILTER_STORAGE_KEY) || "{}") };
    } catch {
        return defaults;
    }
}

const BLURRED_SCREENS = new Set(["screen-auth", "screen-browser", "screen-room", "screen-leaderboard"]);

function showScreen(id) {
    state.screen = id;
    for (const screen of document.querySelectorAll(".screen")) {
        screen.classList.toggle("hidden", screen.id !== id);
    }
    document.body.classList.toggle("blur-bg", BLURRED_SCREENS.has(id));
}

let toastTimer = null;
function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function formatTime(seconds) {
    const s = Math.max(0, seconds);
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function pingClass(ms) {
    return ms < 60 ? "ping-good" : ms < 150 ? "ping-ok" : "ping-bad";
}

// Shows a skin inside a round .skin-dot element; no skin = team colour.
function paintSkin(node, url, team = "A") {
    node.style.backgroundImage = url ? `url("${url}")` : "";
    node.classList.toggle("team-b", team === "B");
}

function iconImage(url, className) {
    const img = el("img", className);
    img.src = url;
    img.alt = "";
    return img;
}

// PlayStyle badge: custom image if one was added, otherwise the silver hexagon.
function psBadge(id, small = false) {
    const url = ICONS.playstyles[id];
    if (url) return iconImage(url, small ? "ps-img small" : "ps-img");
    return el("span", small ? "ps-badge small" : "ps-badge", PLAYSTYLES[id]?.short ?? "?");
}

// Ability symbol: custom image if one was added, otherwise the built-in emoji.
function abilityIcon(id) {
    const url = ICONS.abilities[id];
    return url ? iconImage(url, "ability-img") : document.createTextNode(ABILITIES[id]?.icon ?? "");
}

// Restarts a CSS animation even if it is already running.
function replayAnimation(node, className) {
    node.classList.remove(className);
    void node.offsetWidth;
    node.classList.add(className);
}

async function api(path, body) {
    const response = await fetch(`/api/${path}`, body === undefined ? {} : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail = typeof data.detail === "string" ? data.detail : "Please fill in all fields correctly.";
        throw new Error(detail);
    }
    return data;
}

const DIALOGS = ["create-dialog", "password-dialog", "skin-dialog", "account-dialog", "loadout-dialog", "settings-dialog"];

function openDialog(id) {
    $(id).classList.add("active");
    $(id).querySelector("input:not([type=file])")?.focus();
}

function closeDialog(id) {
    $(id).classList.remove("active");
    if (id === "settings-dialog") stopListeningForKey();
}

for (const button of document.querySelectorAll("[data-close]")) {
    button.addEventListener("click", () => closeDialog(button.closest(".overlay").id));
}

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !listeningAction) {
        const open = DIALOGS.filter((id) => $(id).classList.contains("active"));
        if (open.length) open.forEach(closeDialog);
        else if (state.inGame && !$("game-over").classList.contains("active")) openSettings();
    }
});

// While a menu is open in a match, the player stands still.
function inputBlocked() {
    return DIALOGS.some((id) => $(id).classList.contains("active")) || $("game-over").classList.contains("active");
}

// ---------------------------------------------------------------------------
// Start screen
// ---------------------------------------------------------------------------

$("play-button").addEventListener("click", () => {
    if (state.token) net.connect(state.token);
    else showAuth("login");
});

$("leaderboard-button").addEventListener("click", () => showLeaderboard("screen-start"));
$("rl-leaderboard").addEventListener("click", () => showLeaderboard("screen-browser"));
$("leaderboard-back").addEventListener("click", () => showScreen(state.leaderboardReturn));

for (const button of document.querySelectorAll(".back-to-start")) {
    button.addEventListener("click", () => showScreen("screen-start"));
}

// ---------------------------------------------------------------------------
// Login / register
// ---------------------------------------------------------------------------

let captchaId = null;

function showAuth(tab) {
    selectTab(tab);
    showScreen("screen-auth");
}

function selectTab(tab) {
    for (const button of document.querySelectorAll("#screen-auth .tab")) {
        button.classList.toggle("active", button.dataset.tab === tab);
    }
    $("login-form").classList.toggle("hidden", tab !== "login");
    $("register-form").classList.toggle("hidden", tab !== "register");
    for (const error of document.querySelectorAll("#screen-auth .form-error")) error.textContent = "";
    if (tab === "register") loadCaptcha();
    $(tab === "login" ? "login-name" : "register-name").focus();
}

for (const button of document.querySelectorAll("#screen-auth .tab")) {
    button.addEventListener("click", () => selectTab(button.dataset.tab));
}

async function loadCaptcha() {
    $("captcha-input").value = "";
    try {
        const data = await api("captcha");
        captchaId = data.id;
        $("captcha-image").src = data.image;
    } catch (error) {
        $("register-form").querySelector(".form-error").textContent = error.message;
    }
}

$("captcha-refresh").addEventListener("click", loadCaptcha);

async function submitForm(form, request, onSuccess) {
    const error = form.querySelector(".form-error");
    const button = form.querySelector("button[type=submit]");
    error.textContent = "";
    error.style.color = "";
    button.disabled = true;
    try {
        const data = await request();
        form.reset();
        onSuccess(data);
    } catch (err) {
        error.textContent = err.message;
        if (form.id === "register-form") loadCaptcha(); // each captcha is single-use
    } finally {
        button.disabled = false;
    }
}

function onLoggedIn(data) {
    saveToken(data.token);
    net.connect(data.token);
}

$("login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitForm(event.target, () => api("login", {
        username: $("login-name").value,
        password: $("login-password").value,
    }), onLoggedIn);
});

$("register-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if ($("register-password").value !== $("register-password2").value) {
        event.target.querySelector(".form-error").textContent = "The passwords don't match.";
        return;
    }
    submitForm(event.target, () => api("register", {
        username: $("register-name").value,
        password: $("register-password").value,
        captchaId,
        captcha: $("captcha-input").value,
    }), onLoggedIn);
});

$("logout-button").addEventListener("click", () => {
    const token = state.token;
    saveToken(null);
    net.close();
    resetSession();
    showScreen("screen-start");
    if (token) api("logout", { token }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Account: change name / password
// ---------------------------------------------------------------------------

function formSuccess(form, message) {
    const info = form.querySelector(".form-error");
    info.textContent = message;
    info.style.color = "#5be38a";
}

$("account-button").addEventListener("click", () => {
    for (const info of $("account-dialog").querySelectorAll(".form-error")) info.textContent = "";
    $("password-change-form").reset();
    openDialog("account-dialog");
    $("new-name").value = state.profile.name;
    $("new-name").select();
});

$("name-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    submitForm(form, () => api("account/name", { token: state.token, username: $("new-name").value }), (data) => {
        $("new-name").value = data.username;
        formSuccess(form, "Name changed.");
        net.send({ type: "reload_profile" });
    });
});

$("password-change-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    if ($("new-password").value !== $("new-password2").value) {
        form.querySelector(".form-error").textContent = "The new passwords don't match.";
        return;
    }
    submitForm(form, () => api("account/password", {
        token: state.token,
        current: $("current-password").value,
        new: $("new-password").value,
    }), () => formSuccess(form, "Password changed. Other devices were logged out."));
});

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

async function showLeaderboard(returnTo) {
    state.leaderboardReturn = returnTo;
    showScreen("screen-leaderboard");
    const rows = $("leaderboard-rows");
    const empty = $("leaderboard-empty");
    rows.replaceChildren();
    empty.classList.remove("hidden");
    empty.textContent = "Loading…";
    try {
        const players = await api("leaderboard");
        players.forEach((player, i) => {
            const row = el("tr", i === 0 ? "top-1" : "");
            row.append(el("td", "", String(i + 1)), el("td", "", player.username), el("td", "", String(player.goals)));
            rows.append(row);
        });
        empty.textContent = "No goals yet – be the first!";
        empty.classList.toggle("hidden", players.length > 0);
    } catch (error) {
        empty.textContent = error.message;
    }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const net = new Connection({ onMessage: handleMessage, onStatus: handleStatus });
let pingTimer = null;
let lobbyRefreshTimer = null;

function resetSession() {
    clearInterval(pingTimer);
    clearInterval(lobbyRefreshTimer);
    stopGame();
    state.lobby = null;
    state.myId = null;
    state.selectedLobbyId = null;
    $("connection-banner").classList.add("hidden");
    for (const id of [...DIALOGS, "game-over"]) closeDialog(id);
}

function handleStatus(status) {
    const banner = $("connection-banner");
    if (status === "open") {
        banner.classList.add("hidden");
    } else if (status === "connecting") {
        banner.classList.remove("hidden");
        $("connection-text").textContent = "Connecting to the server…";
        $("reconnect-button").classList.add("hidden");
    } else if (state.token) {
        resetSession();
        banner.classList.remove("hidden");
        $("connection-text").textContent = "No connection to the server. Is it running? (start.bat)";
        $("reconnect-button").classList.remove("hidden");
        showScreen("screen-start");
    }
}

function setProfile(msg) {
    state.myId = msg.id;
    state.profile = { name: msg.name, skin: msg.skin || null, ability: msg.ability, playstyles: msg.playstyles || [] };
    $("whoami-name").textContent = msg.name;
    paintSkin($("my-skin"), state.profile.skin);
}

function handleMessage(msg) {
    switch (msg.type) {
        case "auth_failed":
            // Token expired or unknown – log in again.
            saveToken(null);
            net.close();
            resetSession();
            showAuth("login");
            break;

        case "welcome":
            setProfile(msg);
            startPinging();
            showScreen("screen-browser");
            break;

        case "profile":
            setProfile(msg);
            break;

        case "pong":
            if (typeof msg.t === "number") {
                state.myPing = Math.round(performance.now() - msg.t);
                const ping = $("my-ping");
                ping.textContent = `${state.myPing} ms`;
                ping.className = pingClass(state.myPing);
            }
            break;

        case "lobbies":
            state.lobbies = msg.lobbies;
            state.online = msg.online ?? 0;
            renderLobbyTable();
            break;

        case "lobby":
            state.lobby = msg.lobby;
            closeDialog("create-dialog");
            closeDialog("password-dialog");
            renderRoom();
            if (!state.inGame) showScreen("screen-room");
            break;

        case "left_lobby":
            state.lobby = null;
            stopGame();
            showScreen("screen-browser");
            net.send({ type: "list_lobbies" });
            break;

        case "error":
            if (msg.code === "bad_password") {
                $("password-lobby-name").textContent = "Wrong password – try again.";
                $("join-password").select();
            } else {
                toast(msg.message);
            }
            break;

        case "game_start":
            startGame(msg);
            break;

        case "forfeited":
            returnToRoom();
            break;

        case "clock":
            $("timer").textContent = formatTime(msg.remaining);
            $("timer").classList.toggle("low", msg.remaining <= 10);
            break;

        case "goal":
            showGoal(msg);
            state.game?.handle(msg);
            break;

        case "game_over":
            if (state.inGame) showGameOver(msg);
            break;

        case "player_left":
            toast(`${msg.name} left the match.`);
            state.game?.handle(msg);
            break;

        default:
            // state, input, fx, kickoff
            state.game?.handle(msg);
    }
}

function startPinging() {
    clearInterval(pingTimer);
    clearInterval(lobbyRefreshTimer);
    const ping = () => net.send({ type: "ping", t: performance.now(), rtt: state.myPing });
    ping();
    pingTimer = setInterval(ping, PING_INTERVAL_MS);
    // Refresh the table so player counts and pings stay current.
    lobbyRefreshTimer = setInterval(() => {
        if (state.screen === "screen-browser") net.send({ type: "list_lobbies" });
    }, LOBBY_REFRESH_MS);
}

$("reconnect-button").addEventListener("click", () => {
    if (state.token) net.connect(state.token);
});

// ---------------------------------------------------------------------------
// Room list
// ---------------------------------------------------------------------------

function isJoinable(lobby) {
    return lobby.status === "waiting" && lobby.players < lobby.capacity;
}

function visibleLobbies() {
    const { locked, full, empty } = state.filters;
    return state.lobbies.filter((lobby) =>
        (locked || !lobby.hasPassword) &&
        (full || lobby.players < lobby.capacity) &&
        (empty || lobby.players > 0));
}

function renderLobbyTable() {
    const rooms = state.lobbies.length;
    $("online-count").textContent =
        `${state.online} ${state.online === 1 ? "player" : "players"} in ${rooms} ${rooms === 1 ? "room" : "rooms"}`;

    const lobbies = visibleLobbies();
    if (!lobbies.some((lobby) => lobby.id === state.selectedLobbyId)) state.selectedLobbyId = null;

    const rows = $("lobby-rows");
    rows.replaceChildren();
    $("lobby-empty").textContent = state.lobbies.length
        ? "No room matches your filters."
        : "No rooms open yet – create the first one!";
    $("lobby-empty").classList.toggle("hidden", lobbies.length > 0);

    for (const lobby of lobbies) {
        const row = el("tr");
        row.dataset.id = lobby.id;
        row.tabIndex = 0;
        row.classList.toggle("selected", lobby.id === state.selectedLobbyId);
        row.classList.toggle("unavailable", !isJoinable(lobby));
        row.title = `${MODE_LABELS[lobby.teamSize]} · Code ${lobby.id}`;

        const name = el("td", "", lobby.name);
        if (lobby.status === "playing") name.append(el("span", "tag-playing", "playing"));

        // Messages travel me → server → host, so both legs add up.
        const distance = el("td");
        if (state.myPing !== null) {
            const ms = state.myPing + lobby.hostPing;
            distance.textContent = `${ms} ms`;
            distance.className = pingClass(ms);
        } else {
            distance.textContent = "…";
        }

        row.append(name, el("td", "", `${lobby.players}/${lobby.capacity}`),
            el("td", "", lobby.hasPassword ? "Yes" : "No"), distance);

        row.addEventListener("click", () => selectLobby(lobby.id));
        row.addEventListener("dblclick", () => joinLobby(lobby));
        row.addEventListener("keydown", (event) => {
            if (event.key === "Enter") joinLobby(lobby);
        });
        rows.append(row);
    }
    updateJoinButton();
}

// Only toggles the highlight – re-rendering here would swallow the double click.
function selectLobby(id) {
    state.selectedLobbyId = id;
    for (const row of $("lobby-rows").children) row.classList.toggle("selected", row.dataset.id === id);
    updateJoinButton();
}

function selectedLobby() {
    return state.lobbies.find((lobby) => lobby.id === state.selectedLobbyId);
}

function updateJoinButton() {
    const lobby = selectedLobby();
    $("join-button").disabled = !lobby || !isJoinable(lobby);
}

for (const button of document.querySelectorAll(".filter-btn")) {
    button.setAttribute("aria-pressed", String(state.filters[button.dataset.filter]));
    button.addEventListener("click", () => {
        const key = button.dataset.filter;
        state.filters[key] = !state.filters[key];
        button.setAttribute("aria-pressed", String(state.filters[key]));
        storageSet(localStorage, FILTER_STORAGE_KEY, JSON.stringify(state.filters));
        renderLobbyTable();
    });
}

$("refresh-button").addEventListener("click", () => net.send({ type: "list_lobbies" }));
$("join-button").addEventListener("click", () => {
    const lobby = selectedLobby();
    if (lobby) joinLobby(lobby);
});

let pendingJoinId = null;

function joinLobby(lobby) {
    if (!isJoinable(lobby)) {
        toast(lobby.status === "playing" ? "A match is running in this room." : "This room is full.");
        return;
    }
    if (!lobby.hasPassword) {
        net.send({ type: "join_lobby", lobbyId: lobby.id });
        return;
    }
    pendingJoinId = lobby.id;
    $("password-lobby-name").textContent = lobby.name;
    $("join-password").value = "";
    openDialog("password-dialog");
}

$("password-form").addEventListener("submit", (event) => {
    event.preventDefault();
    net.send({ type: "join_lobby", lobbyId: pendingJoinId, password: $("join-password").value });
});

$("open-create").addEventListener("click", () => openDialog("create-dialog"));

$("create-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const teamSize = Number(new FormData(event.target).get("teamSize"));
    net.send({
        type: "create_lobby",
        name: $("lobby-name").value,
        password: $("lobby-password").value,
        teamSize,
    });
    $("lobby-name").value = "";
    $("lobby-password").value = "";
});

// ---------------------------------------------------------------------------
// Abilities & PlayStyles
// ---------------------------------------------------------------------------

let loadoutDraft = null; // { ability, playstyles: [] } while the dialog is open

function selectLoadoutTab(tab) {
    for (const button of document.querySelectorAll("[data-loadout-tab]")) {
        button.classList.toggle("active", button.dataset.loadoutTab === tab);
    }
    $("ability-grid").classList.toggle("hidden", tab !== "abilities");
    $("playstyle-grid").classList.toggle("hidden", tab !== "playstyles");
    $("loadout-hint").textContent = tab === "abilities"
        ? "Equip one ability. Use it in a match with your ability key (default R)."
        : `Equip up to ${MAX_PLAYSTYLES} PlayStyles. Their badge pops up above you whenever they kick in.`;
}

function renderLoadout() {
    const abilityGrid = $("ability-grid");
    abilityGrid.replaceChildren();
    for (const [id, ability] of Object.entries(ABILITIES)) {
        const option = el("button", "loadout-option");
        option.type = "button";
        option.classList.toggle("selected", loadoutDraft.ability === id);
        const bubble = el("span", "ability-bubble");
        bubble.append(abilityIcon(id));
        bubble.style.background = ability.color;
        option.append(bubble, el("strong", "", ability.name),
            el("span", "meta", `Cooldown ${ability.cooldown / 1000} s`), el("p", "", ability.description));
        option.addEventListener("click", () => {
            loadoutDraft.ability = id;
            renderLoadout();
        });
        abilityGrid.append(option);
    }

    const playstyleGrid = $("playstyle-grid");
    playstyleGrid.replaceChildren();
    for (const [id, playstyle] of Object.entries(PLAYSTYLES)) {
        const option = el("button", "loadout-option");
        option.type = "button";
        const selected = loadoutDraft.playstyles.includes(id);
        option.classList.toggle("selected", selected);
        option.append(psBadge(id), el("strong", "", playstyle.name), el("span", "meta", playstyle.category),
            el("p", "", playstyle.description), el("p", "when", `Badge: ${playstyle.badge}`));
        option.addEventListener("click", () => {
            const list = loadoutDraft.playstyles;
            if (selected) {
                list.splice(list.indexOf(id), 1);
            } else {
                if (list.length >= MAX_PLAYSTYLES) list.shift(); // replace the oldest pick
                list.push(id);
            }
            renderLoadout();
        });
        playstyleGrid.append(option);
    }
    $("playstyle-count").textContent = `${loadoutDraft.playstyles.length}/${MAX_PLAYSTYLES}`;
}

for (const button of document.querySelectorAll("[data-loadout-tab]")) {
    button.addEventListener("click", () => selectLoadoutTab(button.dataset.loadoutTab));
}

$("loadout-button").addEventListener("click", () => {
    loadoutDraft = { ability: state.profile.ability, playstyles: [...state.profile.playstyles] };
    $("loadout-error").textContent = "";
    selectLoadoutTab("abilities");
    renderLoadout();
    openDialog("loadout-dialog");
});

$("loadout-save").addEventListener("click", async () => {
    const button = $("loadout-save");
    button.disabled = true;
    try {
        await api("loadout", { token: state.token, ...loadoutDraft });
        net.send({ type: "reload_profile" });
        closeDialog("loadout-dialog");
        toast(`Equipped ${ABILITIES[loadoutDraft.ability].name}` +
            (loadoutDraft.playstyles.length ? ` + ${loadoutDraft.playstyles.map((p) => PLAYSTYLES[p].name).join(", ")}` : ""));
    } catch (error) {
        $("loadout-error").textContent = error.message;
    } finally {
        button.disabled = false;
    }
});

// ---------------------------------------------------------------------------
// Settings: keybinds + forfeit
// ---------------------------------------------------------------------------

let listeningAction = null;

function openSettings() {
    $("match-actions").classList.toggle("hidden", !state.inGame);
    renderKeybindList();
    openDialog("settings-dialog");
}

function stopListeningForKey() {
    listeningAction = null;
    renderKeybindList();
}

function renderKeybindList() {
    const list = $("keybind-list");
    list.replaceChildren();
    for (const action of KEY_ACTIONS) {
        const button = el("button", "keybind-button",
            listeningAction === action.id ? "Press a key…" : state.keybinds[action.id].label);
        button.type = "button";
        button.classList.toggle("listening", listeningAction === action.id);
        button.addEventListener("click", () => {
            listeningAction = action.id;
            renderKeybindList();
        });
        list.append(el("span", "", action.label), button);
    }
}

// Captures the next key press while a keybind is being changed.
window.addEventListener("keydown", (event) => {
    if (!listeningAction) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key !== "Escape") {
        // A key can only do one thing: take it away from any other action.
        for (const action of Object.keys(state.keybinds)) {
            if (state.keybinds[action].code === event.keyCode) state.keybinds[action] = { code: 0, label: "–" };
        }
        state.keybinds[listeningAction] = { code: event.keyCode, label: keyLabel(event) };
        saveKeybinds(state.keybinds);
        renderControlsList();
    }
    stopListeningForKey();
}, true);

$("keybind-reset").addEventListener("click", () => {
    state.keybinds = defaultKeybinds();
    saveKeybinds(state.keybinds);
    renderKeybindList();
    renderControlsList();
});

$("rl-settings").addEventListener("click", openSettings);
$("settings-button").addEventListener("click", openSettings);
$("resume-button").addEventListener("click", () => closeDialog("settings-dialog"));
$("forfeit-button").addEventListener("click", () => {
    closeDialog("settings-dialog");
    net.send({ type: "forfeit" });
});

// Keybind overview in the match (bottom right).
function renderControlsList() {
    const k = (action) => {
        const node = el("kbd", "", state.keybinds[action].label);
        return node;
    };
    const rows = [
        [[k("up"), k("left"), k("down"), k("right")], "Move"],
        [[k("sprint")], "Sprint"],
        [[el("kbd", "", "Mouse")], "Aim"],
        [[k("shoot"), " / ", el("kbd", "", "Left click")], "Shoot"],
        [[k("tackle")], "Slide tackle – steals the ball"],
        [[k("dribble")], "Spin with the ball – dodges a tackle"],
        [[k("ability")], `Ability: ${ABILITIES[state.profile.ability]?.name ?? ""}`],
        [[el("kbd", "", "Esc")], "Settings"],
    ];
    const list = $("controls-list");
    list.replaceChildren();
    for (const [keys, text] of rows) {
        const dt = el("dt");
        dt.append(...keys);
        list.append(dt, el("dd", "", text));
    }
    $("ability-key").textContent = state.keybinds.ability.label;
}

function setControlsHidden(hidden) {
    $("controls-panel").classList.toggle("collapsed", hidden);
    $("controls-toggle").textContent = hidden ? "Show keybinds ▴" : "Hide keybinds ▾";
    $("controls-toggle").setAttribute("aria-expanded", String(!hidden));
    storageSet(localStorage, CONTROLS_STORAGE_KEY, hidden ? "1" : null);
}

$("controls-toggle").addEventListener("click", (event) => {
    setControlsHidden(!$("controls-panel").classList.contains("collapsed"));
    event.currentTarget.blur(); // keep Space/Enter from re-toggling while playing
});
setControlsHidden(storageGet(localStorage, CONTROLS_STORAGE_KEY) === "1");

// ---------------------------------------------------------------------------
// Skins
// ---------------------------------------------------------------------------

let countries = null;      // [{code, name}] sorted by name
let skinChoice = null;     // {kind: "default"} | {kind: "flag", code} | {kind: "upload", dataUrl}

function flagUrl(code) {
    return `${FLAG_BASE}/flags/1x1/${code}.svg`;
}

async function loadCountries() {
    if (countries) return countries;
    const response = await fetch(`${FLAG_BASE}/country.json`);
    const list = await response.json();
    countries = list
        .filter((c) => c.iso || c.code in EXTRA_FLAGS)
        .map((c) => ({ code: c.code, name: EXTRA_FLAGS[c.code] || c.name }))
        .sort((a, b) => a.name.localeCompare(b.name, "en"));
    return countries;
}

function setSkinChoice(choice, label) {
    skinChoice = choice;
    const url = choice.kind === "flag" ? flagUrl(choice.code) : choice.kind === "upload" ? choice.dataUrl : null;
    paintSkin($("skin-preview"), url);
    $("skin-preview-name").textContent = label;
    $("skin-error").textContent = "";
    for (const option of $("flag-grid").children) {
        option.classList.toggle("selected", option.dataset.skin === (choice.kind === "flag" ? choice.code : choice.kind));
    }
}

function renderFlagGrid() {
    const query = $("flag-search").value.trim().toLowerCase();
    const grid = $("flag-grid");
    grid.replaceChildren();

    const addOption = (key, label, imageUrl, onPick) => {
        const option = el("button", "skin-option");
        option.type = "button";
        option.dataset.skin = key;
        if (imageUrl) {
            const img = el("img");
            img.src = imageUrl;
            img.alt = "";
            img.loading = "lazy";
            option.append(img);
        } else {
            option.append(el("div", "skin-dot"));
        }
        option.append(el("span", "", label));
        option.title = label;
        option.addEventListener("click", onPick);
        grid.append(option);
    };

    if (!query) addOption("default", "Default", null, () => setSkinChoice({ kind: "default" }, "Default (team colour)"));
    for (const country of countries || []) {
        if (query && !country.name.toLowerCase().includes(query) && !country.code.includes(query)) continue;
        addOption(country.code, country.name, flagUrl(country.code),
            () => setSkinChoice({ kind: "flag", code: country.code }, country.name));
    }
    if (skinChoice) setSkinChoice(skinChoice, $("skin-preview-name").textContent);
}

function selectSkinTab(tab) {
    for (const button of document.querySelectorAll("[data-skin-tab]")) {
        button.classList.toggle("active", button.dataset.skinTab === tab);
    }
    $("skin-tab-flags").classList.toggle("hidden", tab !== "flags");
    $("skin-tab-upload").classList.toggle("hidden", tab !== "upload");
}

for (const button of document.querySelectorAll("[data-skin-tab]")) {
    button.addEventListener("click", () => selectSkinTab(button.dataset.skinTab));
}

$("skin-button").addEventListener("click", async () => {
    skinChoice = null;
    paintSkin($("skin-preview"), state.profile.skin);
    $("skin-preview-name").textContent = "Current skin";
    $("skin-error").textContent = "";
    $("flag-search").value = "";
    $("skin-file").value = "";
    selectSkinTab("flags");
    openDialog("skin-dialog");
    try {
        await loadCountries();
    } catch {
        $("skin-error").textContent = "Could not load the country list (no internet?).";
    }
    renderFlagGrid();
});

$("flag-search").addEventListener("input", renderFlagGrid);

$("skin-file").addEventListener("change", () => {
    const file = $("skin-file").files[0];
    if (!file) return;
    if (file.size > MAX_SKIN_BYTES) {
        $("skin-error").textContent = "The image is too large (max. 2 MB).";
        return;
    }
    const reader = new FileReader();
    reader.onload = () => setSkinChoice({ kind: "upload", dataUrl: reader.result }, file.name);
    reader.readAsDataURL(file);
});

$("skin-save").addEventListener("click", async () => {
    if (!skinChoice) {
        closeDialog("skin-dialog");
        return;
    }
    const button = $("skin-save");
    button.disabled = true;
    try {
        if (skinChoice.kind === "upload") {
            await api("skin/upload", { token: state.token, image: skinChoice.dataUrl });
        } else {
            const skin = skinChoice.kind === "flag" ? `flag:${skinChoice.code}` : "default";
            await api("skin", { token: state.token, skin });
        }
        net.send({ type: "reload_profile" }); // server confirms with a "profile" message
        closeDialog("skin-dialog");
    } catch (error) {
        $("skin-error").textContent = error.message;
    } finally {
        button.disabled = false;
    }
});

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

function renderRoom() {
    const lobby = state.lobby;
    if (!lobby) return;
    const isHost = lobby.hostId === state.myId;

    $("room-name").textContent = lobby.name;
    $("room-mode").textContent = MODE_LABELS[lobby.teamSize];
    $("room-code").textContent = lobby.id;
    $("room-lock").innerHTML = lobby.hasPassword ? LOCK_ICON : "";

    for (const team of ["A", "B"]) {
        const list = $(team === "A" ? "team-a-list" : "team-b-list");
        list.replaceChildren();
        const members = lobby.playerList.filter((p) => p.team === team);

        for (const player of members) {
            const item = el("li", player.id === state.myId ? "me" : "");
            const dot = el("div", "skin-dot");
            paintSkin(dot, player.skin, team);
            const ability = ABILITIES[player.ability];
            const abilityTag = el("span", "room-ability");
            abilityTag.append(abilityIcon(player.ability));
            abilityTag.title = ability?.name ?? "";
            item.append(dot, el("span", "", player.name), abilityTag,
                ...player.playstyles.map((p) => {
                    const badge = psBadge(p, true);
                    badge.title = PLAYSTYLES[p]?.name ?? "";
                    return badge;
                }));
            const tags = [];
            if (player.id === lobby.hostId) tags.push("Host");
            if (player.id === state.myId) tags.push("You");
            if (tags.length) item.append(el("span", "tag", tags.join(" · ")));
            list.append(item);
        }
        for (let i = members.length; i < lobby.teamSize; i++) {
            list.append(el("li", "empty", "Free slot"));
        }
    }

    const myTeam = lobby.playerList.find((p) => p.id === state.myId)?.team;
    for (const button of document.querySelectorAll(".join-team")) {
        const team = button.dataset.team;
        const full = lobby.playerList.filter((p) => p.team === team).length >= lobby.teamSize;
        button.disabled = team === myTeam || full || lobby.status !== "waiting";
    }

    const start = $("start-button");
    start.classList.toggle("hidden", !isHost);
    start.disabled = !lobby.canStart || lobby.status !== "waiting";

    const hint = $("room-hint");
    if (lobby.status === "playing") {
        hint.textContent = "Match in progress…";
    } else if (!isHost) {
        hint.textContent = "Waiting for the host to start the match…";
    } else if (!lobby.canStart) {
        hint.textContent = "Each team needs at least one player. Share the room code!";
    } else {
        hint.textContent = `Ready! ${lobby.players}/${lobby.capacity} slots filled – you can start with free slots too.`;
    }

    // Start fetching the game code while people are waiting in the room.
    loadGameModule().catch(() => {});
}

for (const button of document.querySelectorAll(".join-team")) {
    button.addEventListener("click", () => net.send({ type: "switch_team", team: button.dataset.team }));
}

$("leave-button").addEventListener("click", () => net.send({ type: "leave_lobby" }));
$("start-button").addEventListener("click", () => net.send({ type: "start_game" }));

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------

let gameSession = 0;

function renderAbilityHud(players) {
    const me = players.find((p) => p.id === state.myId);
    const ability = ABILITIES[me?.ability] ?? ABILITIES.dash;
    $("ability-icon").replaceChildren(abilityIcon(me?.ability ?? "dash"));
    $("ability-slot").style.background = ability.color;
    $("ability-name").textContent = ability.name;
    $("hud-playstyles").replaceChildren(...(me?.playstyles ?? []).map((p) => {
        const badge = psBadge(p, true);
        badge.title = PLAYSTYLES[p]?.name ?? "";
        return badge;
    }));
    updateCooldown(0, ability.cooldown);
}

function updateCooldown(left, total, charges = null) {
    const cooldown = $("ability-cooldown");
    cooldown.textContent = left > 0 ? Math.ceil(left / 1000) : "";
    cooldown.style.setProperty("--cd", `${Math.min(100, (left / total) * 100)}%`);
    $("ability-slot").classList.toggle("ready", left <= 0);
    // Blink: remaining jumps before the cooldown starts.
    $("ability-charges").textContent = charges === null ? "" : `×${charges}`;
}

async function startGame(msg) {
    stopGame();
    $("score-a").textContent = "0";
    $("score-b").textContent = "0";
    $("timer").textContent = formatTime(msg.remaining);
    $("timer").classList.remove("low");
    $("game-over").classList.remove("active");
    $("goal-banner").classList.remove("show");
    renderAbilityHud(msg.players);
    renderControlsList();

    showScreen("screen-game");
    state.inGame = true;
    const session = ++gameSession;

    let module;
    try {
        module = await loadGameModule();
    } catch (error) {
        console.error(error);
        toast("The game could not be loaded (no internet connection for Phaser?).");
        return;
    }
    if (session !== gameSession) return; // left or restarted while loading
    state.game = module.startGame({
        parent: "game-container",
        send: (message) => net.send(message),
        myId: state.myId,
        hostId: msg.hostId,
        players: msg.players,
        getKeybinds: () => state.keybinds,
        inputBlocked,
        onCooldown: updateCooldown,
    });
}

function stopGame() {
    gameSession++;
    state.inGame = false;
    closeDialog("settings-dialog");
    if (state.game) {
        state.game.destroy();
        state.game = null;
    }
}

function teamSpan(team) {
    return el("span", team === "A" ? "t-red" : "t-blue", TEAM_NAMES[team]);
}

function showGoal(msg) {
    $("score-a").textContent = msg.scoreA;
    $("score-b").textContent = msg.scoreB;
    replayAnimation($(msg.team === "A" ? "score-a" : "score-b"), "score-pop");
    replayAnimation($(msg.team === "A" ? "sb-red" : "sb-blue"), "team-flash");

    const text = $("goal-text");
    const against = msg.team === "A" ? "B" : "A";
    if (msg.scorerName && msg.ownGoal) {
        text.replaceChildren(`${msg.scorerName} scored an own goal!`);
    } else if (msg.scorerName) {
        text.replaceChildren(`${msg.scorerName} from team `, teamSpan(msg.team), " scored against ", teamSpan(against));
    } else {
        text.replaceChildren("Team ", teamSpan(msg.team), " scored!");
    }
    $("goal-banner").querySelector(".goal-title").textContent = msg.ownGoal ? "OWN GOAL!" : "GOAL!";
    replayAnimation($("goal-banner"), "show");
}

function showGameOver(msg) {
    const { scoreA, scoreB, reason, forfeitedTeam } = msg;
    let title;
    if (forfeitedTeam) title = `Team ${TEAM_NAMES[forfeitedTeam === "A" ? "B" : "A"]} wins!`;
    else if (scoreA === scoreB) title = "Draw!";
    else title = `Team ${scoreA > scoreB ? "Red" : "Blue"} wins!`;
    $("game-over-title").textContent = title;
    $("game-over-score").textContent = `${scoreA} : ${scoreB}`;
    $("game-over-reason").textContent = reason || "";
    closeDialog("settings-dialog");
    $("game-over").classList.add("active");
    state.game?.freeze();
}

function returnToRoom() {
    $("game-over").classList.remove("active");
    stopGame();
    if (state.lobby) {
        renderRoom();
        showScreen("screen-room");
    } else {
        showScreen("screen-browser");
    }
}

$("back-to-lobby").addEventListener("click", returnToRoom);

renderControlsList();
showScreen("screen-start");
loadIcons();

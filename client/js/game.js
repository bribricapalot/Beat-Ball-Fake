import * as Phaser from "https://cdn.jsdelivr.net/npm/phaser@3.80.1/dist/phaser.esm.js";
import { ABILITIES, PLAYSTYLES, ICONS } from "./loadout.js";

// Netcode model: the lobby host's browser simulates everything (players + ball)
// from everyone's inputs and broadcasts the world state. Other clients only send
// their inputs and render the state they receive.

// Fixed world size so every client sees the same field, whatever the window size.
const WORLD_W = 1600;
const WORLD_H = 900;

const MARGIN_X = WORLD_W * 0.108;
const MARGIN_Y = WORLD_H * 0.095;
const GOAL_TOP = WORLD_H * 0.38;
const GOAL_BOTTOM = WORLD_H * 0.62;

const PLAYER_SIZE = 50;
const PLAYER_RADIUS = PLAYER_SIZE / 2;
const BALL_SIZE = 30;

// Speeds are in pixels per 60 fps frame (the values the game was tuned with);
// they are scaled by the real frame time so speed is the same at any frame rate.
const WALK_SPEED = 5;
const SPRINT_SPEED = 6.5;
const SLIDE_SPEED = 14;
const SLIDE_DECAY = 0.95;
const SLIDE_MS = 400;
const TACKLE_COOLDOWN_MS = 3000;
const STEAL_DISTANCE = 85;
const DODGE_MS = 600;
const DODGE_SPIN_MS = 400;
const DRIBBLE_COOLDOWN_MS = 3000;
const CATCH_DISTANCE = 45;
const BALL_OFFSET = 30;
const SHOOT_POWER = 700;
const MAX_BALL_SPEED = SHOOT_POWER * 10; // 1000% – the physics runs at 240 Hz so this can't tunnel
const REATTACH_DELAY_MS = 300;
const BALL_DRAG = 0.6; // fraction of speed kept per second
const AIM_RADIUS = 45;
const CARRY_SPEED = 0.92; // ball carriers are a bit slower (Technical removes this)

// Abilities
const DASH_SPEED = 18;
const DASH_DECAY = 0.86;
const DASH_MS = 220;
const BLINK_RANGE = 230;
const BLINK_CHARGES = 7;
const BLINK_GAP_MS = 150; // short pause between two blinks
const EFFECT_MS = 3000; // shadow step, invisibility, forcefield, time hole, totem
const ARMED_MS = 5000;  // raging deflection, rapture
const FREEZE_MS = 1500;
const SWAP_RANGE = 700;
const HOOK_RANGE = WORLD_W / 2; // half the field
const HOOK_PULL_SPEED = 13;     // px per frame – a slow, visible drag
const HOOK_MAX_MS = 2500;
const FORCE_RANGE = 230;
const FORCE_PUSH = 150;
const FIELD_RADIUS = 330;       // time hole and chieftain's totem
const SHIELD_CATCH_DISTANCE = 90;
const SHIELD_FOUL_CHANCE = 0.3;
const RAGING_POWER = 3;         // +200%
const REAPER_BONUS = 0.3;       // per goal
const REAPER_MAX = 5;
const PLATFORM_SIZE = GOAL_BOTTOM - GOAL_TOP; // as wide as a goal
const PLATFORM_MS = 30000;
const VIRUS_MS = 3000;
const VIRUS_SIGHT = 120;
const CONFIDENCE_MS = 6000;
const SCOPOPHOBIA_STUN_MS = 15000;
const CLIP_FALLBACK_MS = 3000;
const FLASH_WINDOW_MS = 5000;
const FLASH_FREEZE_MS = 2000;
const GUARDIAN_WINDOW_MS = 10000;
const DUALITY_CHOOSE_MS = 6000;
const DARK_START = 0.3;
const DARK_STEP_MS = 200;
const DARK_GROWTH = 1.25;
const FURY_MS = 10000;
const FURY_GROWTH = 1.2;
const FURY_MAX = 8;
const FURY_RETURN_MS = 250;
const ZEUS_MS = 60000;
const ZEUS_TICK_MS = 5000;
const ZEUS_STUN_CHANCE = 0.5;
const ZEUS_STUN_MS = 3000;
const INFINITY_RADIUS = 80;
const INFINITY_GOALS = 10;
const TITAN_MS = 6000;
const TITAN_SCALE = 1.6;
const PULSE_MS = 6000;
const TRAIL_INTERVAL_MS = 16;   // dash streak
const SHADOW_INTERVAL_MS = 90;  // shadow step stop-motion copies

// PlayStyles
const BADGE_COOLDOWN_MS = 1500;
const INTERCEPT_DISTANCE = 60;
const SLIDE_TACKLE_REACH = 105;
const CHIP_AIR_MS = 400;

const SEND_INTERVAL_MS = 33; // ~30 network updates per second

const TEAM_COLORS = { A: 0xe5413a, B: 0x2f80ed };
const SKIN_TEXTURE_SIZE = 128;
const MAX_GIF_FRAMES = 120;

// Bits of the per-player flags sent in the state.
const FLAG = {
    sliding: 1, dodging: 2, invisible: 4, shield: 8, timeHole: 16, armed: 32, dash: 64, shadow: 128,
    stunned: 256, angel: 512, confidence: 1024, titan: 2048, totem: 4096, disabled: 8192, fury: 16384,
    infinity: 32768,
};

const MOVE_ACTIONS = ["up", "down", "left", "right", "sprint"];
const PRESS_ACTIONS = ["shoot", "tackle", "dribble", "ability"];
const EMPTY_INPUT = {
    up: false, down: false, left: false, right: false, sprint: false,
    aim: 0, tx: 0, ty: 0, shoot: 0, tackle: 0, dribble: 0, ability: 0, duality: "", dualitySeq: 0,
};

const has = (player, playstyle) => player.playstyles.has(playstyle);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

class GameScene extends Phaser.Scene {
    constructor(options) {
        super("scene-game");
        this.opts = options;
        this.isHost = options.myId === options.hostId;
        this.ready = false;
        this.frozen = false;      // set when the match is over
        this.locked = !options.started; // nobody moves until the start countdown reaches 0
        this.goalPending = false; // between a goal and the next kickoff
        this.freezeUntil = 0;     // ability clip playing – everything stands still
        this.afterFreeze = [];    // host: things to do once the clip is over
        this.sendTimer = 0;
        this.lastCooldownSent = -1;

        this.players = new Map();      // id -> player
        this.remoteInputs = new Map(); // id -> last input (host only)
        this.ownerId = null;           // player holding the ball
        this.lastTouchId = null;       // last player who had the ball (goal scorer)
        this.assistId = null;          // teammate who had the ball right before the last toucher
        this.lastShooterTeam = null;   // team that last shot/played the ball
        this.canAttachAt = 0;
        this.resetBallEffects();
        this.platforms = new Map();    // id -> { x, y, until, rect }
        this.nextPlatformId = 1;
        this.zeus = null;              // { id, until, nextTick }
        this.clipDurations = {};       // host: clip id -> ms

        // Action presses are counted so none get lost between network packets.
        this.localInput = { ...EMPTY_INPUT };
        this.pressedKeys = new Set();
        this.ballTarget = null;
        this.ballAir = false;
        this.ballFrozen = false;
        this.ballDark = false;
        this.zeusLeft = 0;             // received (non-host)
        this.virusUntil = 0;           // my own vision is blocked until then
    }

    resetBallEffects() {
        this.ballEffects = {
            airUntil: 0, frozenUntil: 0, curveRate: 0, curveUntil: 0,
            dark: false, darkNextStep: 0,     // Slash of Duality (dark)
            boomerangId: null, returnAt: 0,    // Slashes of Fury
        };
    }

    preload() {
        this.load.on("loaderror", (file) => console.error("Failed to load:", file.key, "→", file.src));
        this.load.setPath("assets/");
        this.load.image("bg", "Only_Field.webp");
        this.load.image("ball", "football.png");
        this.load.image("teamA", "redcircle.png");
        this.load.image("teamB", "bluecircle.png");
        // Custom icons dropped into assets/abilities|playstyles (paths are relative to the page).
        this.load.setPath("");
        for (const [id, url] of Object.entries(ICONS.abilities)) this.load.image(`ability-${id}`, url);
        for (const [id, url] of Object.entries(ICONS.playstyles)) this.load.image(`playstyle-${id}`, url);
    }

    create() {
        this.add.image(0, 0, "bg").setOrigin(0, 0).setDisplaySize(WORLD_W, WORLD_H);

        this.createField();
        this.createBall();
        for (const info of this.opts.players) this.addPlayer(info);
        this.kickoff();

        this.aimCursor = this.add.circle(0, 0, 6, 0xffff00).setDepth(5);
        this.hookLines = this.add.graphics().setDepth(1.8);
        this.zeusTint = this.add.rectangle(0, 0, WORLD_W, WORLD_H, 0xffe14d, 0.13)
            .setOrigin(0, 0).setDepth(20).setVisible(false);
        this.darkness = this.add.graphics().setDepth(30);
        this.createInput();
        this.createConfetti();
        this.createIceEffects();
        if (this.isHost) this.measureClips();

        if (!this.isHost) {
            // Only the host runs physics; everyone else just draws what the host sends.
            this.physics.pause();
        }
        this.ready = true;
        this.opts.onReady?.(); // the server starts the countdown once everyone has loaded
    }

    // The host needs the clip lengths to know how long to freeze the game.
    measureClips() {
        for (const [id, url] of Object.entries(ICONS.clips || {})) {
            const video = document.createElement("video");
            video.preload = "metadata";
            video.onloadedmetadata = () => {
                if (Number.isFinite(video.duration)) this.clipDurations[id] = Math.round(video.duration * 1000);
            };
            video.src = url;
        }
    }

    // ------------------------------------------------------------------
    // Setup
    // ------------------------------------------------------------------

    createField() {
        this.walls = this.physics.add.staticGroup();
        const wall = (x, y, w, h) => {
            const rect = this.add.rectangle(x, y, w, h, 0x000000, 0);
            this.physics.add.existing(rect, true);
            this.walls.add(rect);
        };

        const fieldBottom = WORLD_H - MARGIN_Y;
        wall(WORLD_W / 2, MARGIN_Y / 2, WORLD_W, MARGIN_Y);
        wall(WORLD_W / 2, WORLD_H - MARGIN_Y / 2, WORLD_W, MARGIN_Y);
        for (const x of [MARGIN_X / 2, WORLD_W - MARGIN_X / 2]) {
            wall(x, (MARGIN_Y + GOAL_TOP) / 2, MARGIN_X, GOAL_TOP - MARGIN_Y);
            wall(x, (GOAL_BOTTOM + fieldBottom) / 2, MARGIN_X, fieldBottom - GOAL_BOTTOM);
        }
        wall(10, (GOAL_TOP + GOAL_BOTTOM) / 2, 20, GOAL_BOTTOM - GOAL_TOP);
        wall(WORLD_W - 10, (GOAL_TOP + GOAL_BOTTOM) / 2, 20, GOAL_BOTTOM - GOAL_TOP);

        // A ball in the left goal is a point for team B, in the right goal for team A.
        this.goals = [
            { x: MARGIN_X * 0.4, team: "B" },
            { x: WORLD_W - MARGIN_X * 0.4, team: "A" },
        ].map(({ x, team }) => {
            const zone = this.add.rectangle(x, (GOAL_TOP + GOAL_BOTTOM) / 2, 20, GOAL_BOTTOM - GOAL_TOP, 0x000000, 0);
            this.physics.add.existing(zone, true);
            zone.scoringTeam = team;
            return zone;
        });

        this.platformGroup = this.physics.add.staticGroup();
    }

    createBall() {
        this.ball = this.physics.add.image(WORLD_W / 2, WORLD_H / 2, "ball");
        this.ball.setDisplaySize(BALL_SIZE, BALL_SIZE);
        this.ball.setCircle(this.ball.width / 2);
        this.ball.setBounce(0.8, 0.8);
        this.ball.setDamping(true);
        this.ball.setDrag(BALL_DRAG);
        this.ball.setCollideWorldBounds(true);
        this.ball.setMaxVelocity(MAX_BALL_SPEED);
        this.ball.setDepth(4);

        this.physics.add.collider(this.ball, this.walls);
        this.physics.add.collider(this.ball, this.platformGroup);
        for (const goal of this.goals) {
            this.physics.add.overlap(this.ball, goal, () => this.onGoal(goal.scoringTeam));
        }
    }

    addPlayer({ id, name, team, skin, ability, playstyles }) {
        const isMe = id === this.opts.myId;
        const sprite = this.add.image(0, 0, team === "A" ? "teamA" : "teamB")
            .setDisplaySize(PLAYER_SIZE, PLAYER_SIZE)
            .setDepth(2);
        // Team-coloured ring so flags and custom skins still show which side a player is on.
        const ring = this.add.circle(0, 0, PLAYER_RADIUS + 2)
            .setStrokeStyle(4, TEAM_COLORS[team], 1)
            .setDepth(3);
        const halo = this.add.circle(0, 0, PLAYER_RADIUS + 7)
            .setStrokeStyle(2, 0xffffff, isMe ? 0.85 : 0)
            .setDepth(1);
        const shield = this.add.circle(0, 0, PLAYER_RADIUS + 14, 0x1abc9c, 0.18)
            .setStrokeStyle(3, 0x48f0c8, 0.9)
            .setDepth(1)
            .setVisible(false);
        const timeHole = this.add.circle(0, 0, FIELD_RADIUS, 0x6c3483, 0.16)
            .setStrokeStyle(3, 0xb07cc6, 0.6)
            .setDepth(0.5)
            .setVisible(false);
        const totem = this.add.circle(0, 0, FIELD_RADIUS, 0xd4ac0d, 0.12)
            .setStrokeStyle(3, 0x58d68d, 0.7)
            .setDepth(0.5)
            .setVisible(false);
        const aura = this.add.circle(0, 0, PLAYER_RADIUS + 10, 0xffffff, 0.2) // reaper, angel, fury, …
            .setDepth(1)
            .setVisible(false);
        const infinityRing = this.add.circle(0, 0, INFINITY_RADIUS, 0x5dade2, 0.05)
            .setStrokeStyle(2, 0xaed6f1, 0.35)
            .setDepth(0.6)
            .setVisible(false);
        const textStyle = {
            fontFamily: "Segoe UI, Arial, sans-serif",
            fontSize: "16px",
            fontStyle: "bold",
            color: "#ffffff",
            stroke: "#000000",
            strokeThickness: 4,
        };
        const label = this.add.text(0, 0, name, textStyle).setOrigin(0.5, 1).setDepth(6);
        const status = this.add.text(0, 0, "", { ...textStyle, fontSize: "18px" }).setOrigin(0.5, 1).setDepth(6);
        const reaperText = this.add.text(0, 0, "", {
            ...textStyle, fontFamily: "Lilita One, Segoe UI, sans-serif", color: "#e8daef", stroke: "#4a235a",
        }).setOrigin(0.5).setDepth(6);

        const validPlaystyles = (playstyles || []).filter((p) => PLAYSTYLES[p]);
        const player = {
            id, name, team, isMe, sprite, ring, halo, shield, timeHole, totem, aura, infinityRing, label, status, reaperText,
            ability: ABILITIES[ability] ? ability : "dash",
            playstyles: new Set(validPlaystyles),
            playstyleOrder: validPlaystyles, // badge positions
            skinAnimation: null,
            x: 0, y: 0, aim: team === "A" ? 0 : Math.PI,
            target: null,
            flags: 0,            // received state (non-host)
            cooldownLeft: 0,     // received ability cooldown in ms, -1 = not available (non-host)
            charges: 0,          // received blink charges / reaper stacks (non-host)
            hookedBy: null,
            lastInput: EMPTY_INPUT,
            handled: { shoot: 0, tackle: 0, dribble: 0, ability: 0, duality: 0 },
            badgeAt: {},
            abilityReadyAt: 0,
            blinkCharges: BLINK_CHARGES,
            reaperStacks: 0,
            lostPassives: false, // Infinity used
            trailAt: 0,
        };
        this.resetPlayerEffects(player);
        this.players.set(id, player);
        if (skin) this.loadSkin(player, skin);
    }

    resetPlayerEffects(player) {
        Object.assign(player, {
            sliding: false, slideX: 0, slideY: 0, slideUntil: 0, tackleReadyAt: 0, stoleThisSlide: false,
            dodgeStart: -Infinity, dodgeUntil: 0, dribbleReadyAt: 0,
            dashX: 0, dashY: 0, dashUntil: 0,
            speedUntil: 0, invisibleUntil: 0, shieldUntil: 0, timeHoleUntil: 0, ragingUntil: 0, raptureUntil: 0,
            sprintStart: null, jockeying: false,
            hookedBy: null, hookUntil: 0, stunnedUntil: 0, angelUntil: 0, confidenceUntil: 0,
            flashTargetId: null, flashUntil: 0,
            dualityPendingUntil: 0, dualityMode: null, dualityUntil: 0,
            furyUntil: 0, furyKicks: 0, furyFinal: 0, furyFinalUntil: 0,
            titanUntil: 0, totemUntil: 0, disabledUntil: 0,
        });
    }

    // Draws the skin (flag, image or GIF) into a round canvas texture for the player.
    async loadSkin(player, url) {
        const size = SKIN_TEXTURE_SIZE;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const context = canvas.getContext("2d");
        const draw = (source) => {
            context.clearRect(0, 0, size, size);
            context.save();
            context.beginPath();
            context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
            context.clip();
            context.drawImage(source, 0, 0, size, size);
            context.restore();
        };

        try {
            let frames = null;
            if (/\.gif(\?|$)/.test(url) && "ImageDecoder" in window) {
                frames = await this.decodeGif(url);
            }
            if (frames && frames.length > 1) {
                draw(frames[0].bitmap);
            } else {
                const image = new Image();
                image.crossOrigin = "anonymous";
                image.src = url;
                await image.decode();
                draw(image);
                frames = null;
            }
            if (!this.sys.isActive() || !this.players.has(player.id)) return; // game ended meanwhile

            const key = `skin-${player.id}`;
            if (this.textures.exists(key)) this.textures.remove(key);
            const texture = this.textures.addCanvas(key, canvas);
            player.sprite.setTexture(key).setDisplaySize(PLAYER_SIZE, PLAYER_SIZE);
            if (frames) {
                player.skinAnimation = { frames, index: 0, nextAt: 0, draw, texture };
            }
        } catch (error) {
            console.warn("Could not load skin:", url, error);
        }
    }

    async decodeGif(url) {
        const response = await fetch(url);
        const decoder = new ImageDecoder({ data: response.body, type: "image/gif" });
        await decoder.tracks.ready;
        const count = Math.min(decoder.tracks.selectedTrack.frameCount, MAX_GIF_FRAMES);
        const frames = [];
        for (let i = 0; i < count; i++) {
            const { image } = await decoder.decode({ frameIndex: i });
            const bitmap = await createImageBitmap(image);
            frames.push({ bitmap, duration: Math.max(20, (image.duration ?? 100000) / 1000) });
            image.close();
        }
        decoder.close();
        return frames;
    }

    animateSkins(now) {
        for (const player of this.players.values()) {
            const animation = player.skinAnimation;
            if (!animation || now < animation.nextAt) continue;
            animation.index = (animation.index + 1) % animation.frames.length;
            const frame = animation.frames[animation.index];
            animation.draw(frame.bitmap);
            animation.texture.refresh();
            animation.nextAt = now + frame.duration;
        }
    }

    removePlayer(id) {
        const player = this.players.get(id);
        if (!player) return;
        for (const part of [player.sprite, player.ring, player.halo, player.shield, player.timeHole, player.totem,
            player.aura, player.infinityRing, player.label, player.status, player.reaperText]) {
            part.destroy();
        }
        this.players.delete(id);
        this.remoteInputs.delete(id);
        if (this.ownerId === id) this.ownerId = null;
    }

    // Keyboard handling uses the player's own keybinds, read live so changes in
    // the settings apply immediately.
    createInput() {
        const actionFor = (code) => {
            const binds = this.opts.getKeybinds();
            return Object.keys(binds).find((action) => binds[action].code === code);
        };
        const onKeyDown = (event) => {
            if (this.opts.inputBlocked()) return;
            const action = actionFor(event.keyCode);
            if (!action) return;
            event.preventDefault();
            this.pressedKeys.add(event.keyCode);
            if (!event.repeat && PRESS_ACTIONS.includes(action)) this.localInput[action]++;
        };
        const onKeyUp = (event) => this.pressedKeys.delete(event.keyCode);
        const onBlur = () => this.pressedKeys.clear();

        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);
        window.addEventListener("blur", onBlur);
        this.removeInputListeners = () => {
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("keyup", onKeyUp);
            window.removeEventListener("blur", onBlur);
        };

        this.input.on("pointerdown", (pointer) => {
            if (pointer.leftButtonDown() && !this.opts.inputBlocked()) this.localInput.shoot++;
        });
    }

    // Slash of Duality: the player picked Light or Dark in the little menu.
    chooseDuality(choice) {
        this.localInput.duality = choice;
        this.localInput.dualitySeq++;
    }

    createConfetti() {
        const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff];
        this.confettiEmitters = colors.map((color, i) => {
            const g = this.make.graphics({ x: 0, y: 0, add: false });
            g.fillStyle(color, 1);
            g.fillCircle(4, 4, 4);
            g.generateTexture(`confetti${i}`, 8, 8);
            g.destroy();
            return this.add.particles(0, 0, `confetti${i}`, {
                emitting: false,
                lifespan: 2000,
                speed: { min: 150, max: 400 },
                angle: { min: 240, max: 300 },
                gravityY: 300,
                rotate: { min: 0, max: 360 },
                scale: { start: 1, end: 0.5 },
                alpha: { start: 1, end: 0 },
                quantity: 3,
            }).setDepth(10);
        });
    }

    createIceEffects() {
        const g = this.make.graphics({ x: 0, y: 0, add: false });
        g.fillStyle(0xffffff, 1);
        g.fillTriangle(0, 10, 4, 0, 8, 10);
        g.generateTexture("shard", 8, 10);
        g.destroy();
        this.shardEmitter = this.add.particles(0, 0, "shard", {
            emitting: false,
            lifespan: 600,
            speed: { min: 120, max: 320 },
            rotate: { min: 0, max: 360 },
            scale: { start: 1.2, end: 0.3 },
            alpha: { start: 1, end: 0 },
            tint: [0xffffff, 0xbfefff, 0x7fd3ff],
        }).setDepth(11);
        this.sparkEmitter = this.add.particles(0, 0, "shard", {
            emitting: false,
            lifespan: 400,
            speed: { min: 150, max: 420 },
            rotate: { min: 0, max: 360 },
            scale: { start: 0.9, end: 0.2 },
            alpha: { start: 1, end: 0 },
            tint: [0xffffff, 0xfff59d, 0xffd54f],
        }).setDepth(22);

        // A crystal shell drawn around the frozen ball.
        this.iceShell = this.add.graphics().setDepth(5).setVisible(false);
        const points = [];
        for (let i = 0; i < 12; i++) {
            const r = i % 2 === 0 ? 27 : 19;
            const a = (i * Math.PI) / 6;
            points.push(new Phaser.Geom.Point(Math.cos(a) * r, Math.sin(a) * r));
        }
        this.iceShell.fillStyle(0x9be3ff, 0.35).fillPoints(points, true);
        this.iceShell.lineStyle(2, 0xe6f9ff, 0.95).strokePoints(points, true);
    }

    // ------------------------------------------------------------------
    // Network
    // ------------------------------------------------------------------

    handle(msg) {
        if (!this.ready) return;
        switch (msg.type) {
            case "input":
                if (this.isHost) this.remoteInputs.set(msg.from, msg);
                break;
            case "state":
                if (!this.isHost) this.applyState(msg);
                break;
            case "fx":
                this.showFx(msg);
                break;
            case "goal":
                this.celebrateGoal();
                if (this.isHost) this.onGoalConfirmed(msg);
                break;
            case "kickoff":
                if (this.isHost) this.kickoff();
                break;
            case "countdown":
                if (msg.value === 0) this.locked = false;
                break;
            case "player_left":
                this.removePlayer(msg.id);
                break;
        }
    }

    // Host: show an effect locally and on every other screen.
    fx(message) {
        this.showFx(message);
        this.opts.send({ type: "fx", ...message });
    }

    showFx(msg) {
        const now = this.time.now;
        if (msg.kind === "text") this.showFloatingText(msg.x, msg.y, msg.text, msg.color);
        else if (msg.kind === "badge") this.showBadge(msg.id, msg.playstyle);
        else if (msg.kind === "ability") this.showAbilityFx(msg.id, msg.ability);
        else if (msg.kind === "shatter") this.shardEmitter.explode(16, msg.x, msg.y);
        else if (msg.kind === "lightning") this.strikeLightning(msg.x, msg.y);
        else if (msg.kind === "virus" && msg.id === this.opts.myId) this.virusUntil = now + VIRUS_MS;
        else if (msg.kind === "duality" && msg.id === this.opts.myId) this.opts.onDualityChoose?.(DUALITY_CHOOSE_MS);
        else if (msg.kind === "cinematic") this.opts.onCinematic?.(msg.clip, msg.ms, msg.id);
    }

    sendState(now) {
        const r = (v) => Math.round(v * 10) / 10;
        this.opts.send({
            type: "state",
            b: [
                r(this.ball.x), r(this.ball.y), this.ownerId, this.goalPending ? 1 : 0,
                now < this.ballEffects.airUntil ? 1 : 0, now < this.ballEffects.frozenUntil ? 1 : 0,
                this.ballEffects.dark ? 1 : 0,
            ],
            p: [...this.players.values()].map((p) => [
                p.id, r(p.x), r(p.y), r(p.aim), this.playerFlags(p, now),
                this.cooldownFor(p, now) < 0 ? -1 : Math.round(this.cooldownFor(p, now) / 100),
                p.ability === "reaper" ? p.reaperStacks : p.blinkCharges,
                p.hookedBy,
                p.reaperStacks,
            ]),
            g: [this.zeus ? Math.max(0, Math.round(this.zeus.until - now)) : 0],
            pl: [...this.platforms.entries()].map(([id, p]) => [id, Math.round(p.x), Math.round(p.y)]),
        });
    }

    // ms until the ability is ready again; -1 = used up / lost for this match.
    cooldownFor(p, now) {
        if (!p.ability || p.abilityReadyAt === Infinity) return -1;
        return Math.max(0, p.abilityReadyAt - now);
    }

    playerFlags(p, now) {
        return (p.sliding ? FLAG.sliding : 0)
            | (now < p.dodgeUntil ? FLAG.dodging : 0)
            | (now < p.invisibleUntil ? FLAG.invisible : 0)
            | (now < p.shieldUntil ? FLAG.shield : 0)
            | (now < p.timeHoleUntil ? FLAG.timeHole : 0)
            | (now < p.ragingUntil || now < p.raptureUntil || p.dualityMode || now < p.furyFinalUntil ? FLAG.armed : 0)
            | (now < p.dashUntil ? FLAG.dash : 0)
            | (now < p.speedUntil ? FLAG.shadow : 0)
            | (now < p.stunnedUntil ? FLAG.stunned : 0)
            | (now < p.angelUntil ? FLAG.angel : 0)
            | (now < p.confidenceUntil ? FLAG.confidence : 0)
            | (now < p.titanUntil ? FLAG.titan : 0)
            | (now < p.totemUntil ? FLAG.totem : 0)
            | (now < p.disabledUntil ? FLAG.disabled : 0)
            | (now < p.furyUntil ? FLAG.fury : 0)
            | (this.passiveActive(p, "infinity", now) ? FLAG.infinity : 0);
    }

    applyState(msg) {
        const [bx, by, ownerId, goalPending, air, frozen, dark] = msg.b;
        this.ballTarget = { x: bx, y: by };
        this.ownerId = ownerId;
        this.ballAir = Boolean(air);
        this.ballFrozen = Boolean(frozen);
        this.ballDark = Boolean(dark);
        this.ball.setTint(goalPending ? 0x00ffff : 0xffffff);

        for (const [id, x, y, aim, flags, cooldown, charges, hookedBy, reaperStacks] of msg.p) {
            const player = this.players.get(id);
            if (!player) continue;
            player.target = { x, y };
            if (!player.isMe) player.aim = aim;
            player.flags = flags;
            player.cooldownLeft = cooldown < 0 ? -1 : cooldown * 100;
            player.charges = charges;
            player.hookedBy = hookedBy;
            player.reaperStacks = reaperStacks;
        }
        this.zeusLeft = msg.g?.[0] ?? 0;
        this.syncPlatforms(msg.pl || []);
    }

    sendInput() {
        this.opts.send({ type: "input", ...this.localInput });
    }

    // ------------------------------------------------------------------
    // Main loop
    // ------------------------------------------------------------------

    update(time, delta) {
        if (!this.ready) return;
        const frames = Math.min(delta, 100) / (1000 / 60);
        const me = this.players.get(this.opts.myId);

        this.readLocalInput(me);

        if (this.isHost) {
            const clipPlaying = time < this.freezeUntil;
            if (clipPlaying) this.physics.world.pause();
            else if (this.physics.world.isPaused) this.physics.world.resume();
            if (!clipPlaying && this.afterFreeze.length) {
                for (const action of this.afterFreeze.splice(0)) action(time);
            }

            if (!this.frozen && !this.goalPending && !this.locked && !clipPlaying) this.simulate(time, frames);
            else this.discardPresses();
            this.expirePlatforms(time);
        } else {
            this.interpolate(delta);
        }

        this.sendTimer += delta;
        if (this.sendTimer >= SEND_INTERVAL_MS && !this.frozen) {
            this.sendTimer = 0;
            if (this.isHost) this.sendState(time);
            else this.sendInput();
        }

        this.draw(time);
        this.reportCooldown(me, time);
    }

    readLocalInput(me) {
        const binds = this.opts.getKeybinds();
        const blocked = this.opts.inputBlocked();
        for (const action of MOVE_ACTIONS) {
            this.localInput[action] = !blocked && this.pressedKeys.has(binds[action]?.code);
        }
        if (me) {
            const pointer = this.input.activePointer;
            this.localInput.aim = Phaser.Math.Angle.Between(me.x, me.y, pointer.worldX, pointer.worldY);
            this.localInput.tx = Math.round(pointer.worldX);
            this.localInput.ty = Math.round(pointer.worldY);
            me.aim = this.localInput.aim;
        }
    }

    reportCooldown(me, now) {
        if (!me) return;
        const left = this.isHost ? this.cooldownFor(me, now) : me.cooldownLeft;
        let counter = null;
        if (me.ability === "blink") counter = this.isHost ? me.blinkCharges : me.charges;
        if (me.ability === "reaper") counter = me.reaperStacks;
        const key = `${Math.ceil(left / 100)}|${counter}|${me.ability}`;
        if (key !== this.lastCooldownSent) {
            this.lastCooldownSent = key;
            // The short pause between blinks is not a real cooldown.
            const shown = me.ability === "blink" && counter < BLINK_CHARGES && left <= BLINK_GAP_MS ? 0 : left;
            this.opts.onCooldown?.(shown, ABILITIES[me.ability]?.cooldown || 1, counter, me.ability);
        }
    }

    simulate(now, frames) {
        this.updateZeus(now);
        for (const player of this.players.values()) {
            const input = player.isMe ? this.localInput : (this.remoteInputs.get(player.id) || EMPTY_INPUT);
            player.lastInput = input;
            player.aim = input.aim;
            this.simulatePlayer(player, input, now, frames);
        }
        this.separatePlayers(now);
        for (const player of this.players.values()) {
            this.pushOutOfPlatforms(player);
            this.clampToField(player, now);
        }
        this.applyInfinity(now);
        this.updateBall(now, frames);
    }

    // Presses made during a pause should not fire right after it.
    discardPresses() {
        for (const player of this.players.values()) {
            const input = player.isMe ? this.localInput : this.remoteInputs.get(player.id);
            if (!input) continue;
            for (const action of PRESS_ACTIONS) player.handled[action] = input[action] || 0;
            player.handled.duality = input.dualitySeq || 0;
        }
    }

    // ---------- stats ----------

    radius(p, now) {
        return PLAYER_RADIUS * (now < p.titanUntil ? TITAN_SCALE : 1);
    }

    clampToField(p, now = this.time.now) {
        const r = this.radius(p, now);
        p.x = Phaser.Math.Clamp(p.x, MARGIN_X + r, WORLD_W - MARGIN_X - r);
        p.y = Phaser.Math.Clamp(p.y, MARGIN_Y + r, WORLD_H - MARGIN_Y - r);
    }

    // Passive abilities stop working while disabled by Pulse or after Infinity was used.
    passiveActive(p, ability, now) {
        return p.ability === ability && !p.lostPassives && now >= p.disabledUntil;
    }

    reaperMultiplier(p, now) {
        return this.passiveActive(p, "reaper", now) ? 1 + REAPER_BONUS * p.reaperStacks : 1;
    }

    inTeamTotem(p, now) {
        for (const q of this.players.values()) {
            if (q.team === p.team && now < q.totemUntil && distance(q, p) < FIELD_RADIUS) return true;
        }
        return false;
    }

    zeusSlows(p, now) {
        return this.zeus && now < this.zeus.until && this.zeus.id !== p.id;
    }

    speedMultiplier(p, now) {
        let m = this.reaperMultiplier(p, now);
        if (now < p.speedUntil) m *= 1.5;
        if (now < p.titanUntil) m *= 0.75;
        if (this.inTeamTotem(p, now)) m *= 1.25;
        if (this.zeusSlows(p, now)) m *= 0.5;
        if (this.inOpponentTimeHole(p, now)) m *= 0.5;
        return m;
    }

    powerMultiplier(p, now) {
        let m = this.reaperMultiplier(p, now);
        if (now < p.titanUntil) m *= 1.5;
        if (this.inTeamTotem(p, now)) m *= 1.25;
        if (this.zeusSlows(p, now)) m *= 0.5;
        return m;
    }

    reachBonus(p, now) {
        return (now < p.titanUntil ? PLAYER_RADIUS * (TITAN_SCALE - 1) : 0) * 1.2;
    }

    // ---------- per-player simulation ----------

    simulatePlayer(player, input, now, frames) {
        const pressed = (action) => {
            const fresh = (input[action] || 0) > player.handled[action];
            player.handled[action] = input[action] || 0;
            return fresh;
        };
        const moveX = (input.right ? 1 : 0) - (input.left ? 1 : 0);
        const moveY = (input.down ? 1 : 0) - (input.up ? 1 : 0);
        const hasBall = this.ownerId === player.id;
        const moveAngle = moveX || moveY ? Math.atan2(moveY, moveX) : input.aim;

        // Slash of Duality: the Light/Dark choice from the little menu.
        const dualityChosen = (input.dualitySeq || 0) > player.handled.duality;
        player.handled.duality = input.dualitySeq || 0;
        if (dualityChosen && now < player.dualityPendingUntil && (input.duality === "light" || input.duality === "dark")) {
            player.dualityPendingUntil = 0;
            player.dualityMode = input.duality;
            player.dualityUntil = now + 8000;
            player.abilityReadyAt = now + ABILITIES.slash_of_duality.cooldown;
            this.fx({ kind: "ability", id: player.id, ability: "slash_of_duality" });
            this.fx({
                kind: "text", x: Math.round(player.x), y: Math.round(player.y - 20),
                text: input.duality === "light" ? "☀ LIGHT" : "🌑 DARK", color: input.duality === "light" ? "#fff9c4" : "#b39ddb",
            });
        }
        if (player.dualityMode && now > player.dualityUntil) player.dualityMode = null;

        // Stunned (Scopophobia, Zeus, Flash Counter) or dragged by a hook: no control at all.
        if (now < player.stunnedUntil || player.hookedBy) {
            for (const action of PRESS_ACTIONS) pressed(action);
            if (player.hookedBy) this.dragByHook(player, now, frames);
            return;
        }

        // Slide tackle in move direction, or towards the aim when standing still.
        if (pressed("tackle") && now >= player.tackleReadyAt && !player.sliding) {
            const speed = SLIDE_SPEED * (has(player, "slide_tackle") ? 1.2 : 1) * this.reaperMultiplier(player, now);
            player.sliding = true;
            player.slideX = Math.cos(moveAngle) * speed;
            player.slideY = Math.sin(moveAngle) * speed;
            player.slideUntil = now + SLIDE_MS;
            player.tackleReadyAt = now + (has(player, "anticipate") ? 2000 : TACKLE_COOLDOWN_MS);
            player.stoleThisSlide = false;
        }

        // 180° spin with the ball – dodges tackles for a short moment.
        if (pressed("dribble") && hasBall && now >= player.dribbleReadyAt) {
            const trickster = has(player, "trickster");
            player.dodgeStart = now;
            player.dodgeUntil = now + (trickster ? 800 : DODGE_MS);
            player.dribbleReadyAt = now + (trickster ? 1800 : DRIBBLE_COOLDOWN_MS);
            if (trickster) this.badge(player, "trickster", now);
        }

        if (pressed("ability")) this.tryAbility(player, input, now, moveAngle);

        if (pressed("shoot") && this.ownerId === player.id) this.shoot(player, input, now);

        // Fury over: the charged shot is ready.
        if (player.furyUntil && now >= player.furyUntil) {
            player.furyUntil = 0;
            if (player.furyKicks > 0) {
                player.furyFinal = Math.min(Math.pow(FURY_GROWTH, player.furyKicks), FURY_MAX);
                player.furyFinalUntil = now + 8000;
            }
        }

        if (player.sliding) {
            player.x += player.slideX * frames;
            player.y += player.slideY * frames;
            const decay = Math.pow(SLIDE_DECAY, frames);
            player.slideX *= decay;
            player.slideY *= decay;
            this.trySteal(player, now);
            if (now >= player.slideUntil) player.sliding = false;
            return;
        }
        if (now < player.dashUntil) {
            player.x += player.dashX * frames;
            player.y += player.dashY * frames;
            const decay = Math.pow(DASH_DECAY, frames);
            player.dashX *= decay;
            player.dashY *= decay;
            return;
        }
        if (!moveX && !moveY) {
            player.sprintStart = null;
            player.jockeying = false;
            return;
        }

        const sprinting = input.sprint;
        let speed = sprinting ? SPRINT_SPEED : WALK_SPEED;
        if (sprinting && player.sprintStart === null) {
            player.sprintStart = now;
            if (has(player, "quick_step")) this.badge(player, "quick_step", now);
            if (hasBall && has(player, "rapid")) this.badge(player, "rapid", now);
        } else if (!sprinting) {
            player.sprintStart = null;
        }
        if (sprinting && has(player, "quick_step") && now - player.sprintStart < 600) speed *= 1.3;
        if (this.ownerId === player.id) {
            if (sprinting && has(player, "rapid")) speed *= 1.12;
            if (!has(player, "technical")) speed *= CARRY_SPEED;
        }

        const carrier = this.players.get(this.ownerId);
        const jockeying = !sprinting && has(player, "jockey") && carrier && carrier.team !== player.team
            && distance(player, carrier) < 300;
        if (jockeying) {
            speed *= 1.12;
            if (!player.jockeying) this.badge(player, "jockey", now);
        }
        player.jockeying = Boolean(jockeying);

        speed *= this.speedMultiplier(player, now);

        const length = Math.hypot(moveX, moveY);
        player.x += (moveX / length) * speed * frames;
        player.y += (moveY / length) * speed * frames;
    }

    dragByHook(target, now, frames) {
        const hooker = this.players.get(target.hookedBy);
        if (!hooker || now > target.hookUntil) {
            target.hookedBy = null;
            return;
        }
        const angle = Math.atan2(target.y - hooker.y, target.x - hooker.x);
        const goalX = hooker.x + Math.cos(angle) * (PLAYER_SIZE + 6);
        const goalY = hooker.y + Math.sin(angle) * (PLAYER_SIZE + 6);
        const dx = goalX - target.x;
        const dy = goalY - target.y;
        const remaining = Math.hypot(dx, dy);
        const step = HOOK_PULL_SPEED * frames;
        if (remaining <= step) {
            target.x = goalX;
            target.y = goalY;
            target.hookedBy = null;
        } else {
            target.x += (dx / remaining) * step;
            target.y += (dy / remaining) * step;
        }
    }

    tryAbility(player, input, now, moveAngle) {
        const info = ABILITIES[player.ability];
        if (!info) return;
        const say = (text, color = "#cccccc") =>
            this.fx({ kind: "text", x: Math.round(player.x), y: Math.round(player.y), text, color });

        if (now < player.disabledUntil) return say("DISABLED", "#c39bd3");
        if (info.passive && !info.once) return say("PASSIVE", "#d7bde2");
        if (now < player.abilityReadyAt) return;

        const result = this.useAbility(player, input, now, moveAngle);
        if (result === null) return; // waiting for a choice (Slash of Duality)
        if (result !== true) return say(typeof result === "string" ? result : "NO TARGET");

        if (info.once) {
            player.abilityReadyAt = Infinity;
        } else {
            player.abilityReadyAt = now + info.cooldown;
            // Platform: the cooldown only starts once the wall is gone.
            if (player.ability === "platform") player.abilityReadyAt += PLATFORM_MS;
            if (player.ability === "blink") {
                // Several blinks in a row, the cooldown only starts after the last one.
                player.blinkCharges--;
                if (player.blinkCharges > 0) player.abilityReadyAt = now + BLINK_GAP_MS;
                else player.blinkCharges = BLINK_CHARGES;
            }
        }
        this.fx({ kind: "ability", id: player.id, ability: player.ability });
    }

    inOpponentTimeHole(target, now) {
        for (const p of this.players.values()) {
            if (p.team !== target.team && now < p.timeHoleUntil && distance(p, target) < FIELD_RADIUS) return true;
        }
        return false;
    }

    nearestOpponent(player, range) {
        let best = null;
        let bestDist = range;
        for (const p of this.players.values()) {
            if (p.team === player.team) continue;
            const d = distance(p, player);
            if (d < bestDist) {
                best = p;
                bestDist = d;
            }
        }
        return best;
    }

    // true = used, null = waiting for input, string/false = failed (no cooldown is used).
    useAbility(player, input, now, moveAngle) {
        const ball = this.ball;
        const ballFree = this.ownerId === null;

        switch (player.ability) {
            case "dash":
                // Towards the mouse cursor, not the movement keys.
                player.dashX = Math.cos(input.aim) * DASH_SPEED;
                player.dashY = Math.sin(input.aim) * DASH_SPEED;
                player.dashUntil = now + DASH_MS;
                return true;

            case "blink": {
                if (this.ownerId === player.id) return "NOT WITH BALL";
                const dx = input.tx - player.x;
                const dy = input.ty - player.y;
                const length = Math.hypot(dx, dy) || 1;
                const jump = Math.min(length, BLINK_RANGE);
                player.x += (dx / length) * jump;
                player.y += (dy / length) * jump;
                this.clampToField(player, now);
                return true;
            }

            case "shadow_step":
                player.speedUntil = now + EFFECT_MS;
                return true;

            case "ninja_dash": {
                const owner = this.players.get(this.ownerId);
                if (owner && (owner.team === player.team || owner.id === player.id)) return false;
                // Land just in front of the ball, on the side we came from – anywhere on the field.
                const angle = Math.atan2(player.y - ball.y, player.x - ball.x);
                player.x = ball.x + Math.cos(angle) * 30;
                player.y = ball.y + Math.sin(angle) * 30;
                this.clampToField(player, now);
                return true;
            }

            case "invisibility":
                player.invisibleUntil = now + EFFECT_MS;
                return true;

            case "freeze":
                if (!ballFree) return false;
                this.ballEffects.frozenUntil = now + FREEZE_MS;
                this.fx({ kind: "shatter", x: Math.round(ball.x), y: Math.round(ball.y) });
                this.ballEffects.curveUntil = 0;
                this.ballEffects.dark = false;
                ball.setVelocity(0, 0);
                return true;

            case "forcefield":
                player.shieldUntil = now + EFFECT_MS;
                return true;

            case "pull": {
                if (!ballFree) return false;
                const angle = Math.atan2(player.y - ball.y, player.x - ball.x);
                this.physics.velocityFromRotation(angle, 750, ball.body.velocity);
                this.ballEffects.frozenUntil = 0;
                this.lastShooterTeam = player.team;
                return true;
            }

            case "telekinesis": {
                if (!ballFree || distance(player, ball) > 600) return false;
                const speed = Math.max(ball.body.velocity.length() * 1.3, 650);
                this.physics.velocityFromRotation(input.aim, speed, ball.body.velocity);
                this.ballEffects.frozenUntil = 0;
                this.lastShooterTeam = player.team;
                if (this.lastTouchId !== player.id) this.assistId = null;
                this.lastTouchId = player.id;
                return true;
            }

            case "raging_deflection":
                player.ragingUntil = now + ARMED_MS;
                return true;

            case "rapture":
                player.raptureUntil = now + ARMED_MS;
                return true;

            case "swap": {
                const target = this.nearestOpponent(player, SWAP_RANGE);
                if (!target) return false;
                [player.x, target.x] = [target.x, player.x];
                [player.y, target.y] = [target.y, player.y];
                return true;
            }

            case "hell_hook": {
                // Chain every opponent within half the field; they are dragged over, not teleported.
                let hooked = false;
                for (const target of this.players.values()) {
                    if (target.team === player.team || distance(target, player) > HOOK_RANGE) continue;
                    if (this.passiveActive(target, "infinity", now)) continue;
                    target.hookedBy = player.id;
                    target.hookUntil = now + HOOK_MAX_MS;
                    target.sliding = false;
                    target.dashUntil = 0;
                    if (this.ownerId === target.id) {
                        // The ball stays on the field where it was.
                        this.ownerId = null;
                        ball.setVelocity(0, 0);
                        this.canAttachAt = now + REATTACH_DELAY_MS;
                    }
                    hooked = true;
                }
                return hooked;
            }

            case "force": {
                let hit = false;
                for (const target of this.players.values()) {
                    if (target.team === player.team || distance(target, player) > FORCE_RANGE) continue;
                    hit = true;
                    const angle = Math.atan2(target.y - player.y, target.x - player.x);
                    target.x += Math.cos(angle) * FORCE_PUSH;
                    target.y += Math.sin(angle) * FORCE_PUSH;
                    this.clampToField(target, now);
                    if (this.ownerId === target.id) {
                        // The ball is knocked loose – it counts as played by the Force user.
                        this.ownerId = null;
                        this.lastTouchId = player.id;
                        this.assistId = null;
                        this.lastShooterTeam = player.team;
                        this.canAttachAt = now + REATTACH_DELAY_MS;
                        this.physics.velocityFromRotation(angle, 350, ball.body.velocity);
                    }
                }
                return hit;
            }

            case "time_hole":
                player.timeHoleUntil = now + EFFECT_MS;
                return true;

            case "platform":
                return this.spawnPlatform(player, input, now);

            case "absolute_confidence":
                player.confidenceUntil = now + CONFIDENCE_MS;
                return true;

            case "scopophobia":
                this.startCinematic("scopophobia", player, now, (end) => {
                    // After the clip: everyone except the user is paralysed.
                    for (const p of this.players.values()) {
                        if (p.id !== player.id) p.stunnedUntil = end + SCOPOPHOBIA_STUN_MS;
                    }
                });
                return true;

            case "flash_counter": {
                const target = this.players.get(player.flashTargetId);
                if (!target || now > player.flashUntil || this.ownerId !== target.id) return false;
                // Appear right behind the opponent, take the ball, freeze them.
                const behind = target.aim + Math.PI;
                this.fx({ kind: "lightning", x: Math.round(player.x), y: Math.round(player.y) });
                player.x = target.x + Math.cos(behind) * (PLAYER_SIZE + 4);
                player.y = target.y + Math.sin(behind) * (PLAYER_SIZE + 4);
                this.clampToField(player, now);
                this.setOwner(player, now);
                target.stunnedUntil = now + FLASH_FREEZE_MS;
                player.flashTargetId = null;
                this.fx({ kind: "shatter", x: Math.round(target.x), y: Math.round(target.y) });
                return true;
            }

            case "slash_of_duality":
                if (now < player.dualityPendingUntil || player.dualityMode) return false;
                player.dualityPendingUntil = now + DUALITY_CHOOSE_MS;
                this.fx({ kind: "duality", id: player.id });
                return null;

            case "slashes_of_fury":
                player.furyUntil = now + FURY_MS;
                player.furyKicks = 0;
                player.furyFinal = 0;
                return true;

            case "zeus_storm":
                this.zeus = { id: player.id, until: now + ZEUS_MS, nextTick: now + ZEUS_TICK_MS };
                for (let i = 0; i < 3; i++) {
                    this.fx({ kind: "lightning", x: Math.round(Phaser.Math.Between(MARGIN_X, WORLD_W - MARGIN_X)), y: Math.round(Phaser.Math.Between(MARGIN_Y, WORLD_H - MARGIN_Y)) });
                }
                return true;

            case "displace": {
                const candidates = [...this.players.values()].filter((p) =>
                    p.id !== this.ownerId && !this.passiveActive(p, "infinity", now));
                if (!candidates.length) return false;
                const target = candidates[Math.floor(Math.random() * candidates.length)];
                this.fx({ kind: "shatter", x: Math.round(ball.x), y: Math.round(ball.y) });
                this.setOwner(target, now);
                this.lastShooterTeam = target.team;
                this.fx({ kind: "shatter", x: Math.round(target.x), y: Math.round(target.y) });
                return true;
            }

            case "infinity":
                if (player.lostPassives) return false;
                this.startCinematic("infinity", player, now, () => {
                    this.opts.send({ type: "bonus_goals", team: player.team, count: INFINITY_GOALS, by: player.id });
                    // The price: no ability and no PlayStyles for the rest of the match.
                    player.lostPassives = true;
                    player.ability = null;
                    player.playstyles = new Set();
                    player.playstyleOrder = [];
                    // Like after a goal: everyone back to the starting positions.
                    this.kickoff();
                });
                return true;

            case "titan":
                player.titanUntil = now + TITAN_MS;
                return true;

            case "chieftains_totem":
                player.totemUntil = now + EFFECT_MS;
                return true;

            case "pulse": {
                for (const target of this.players.values()) {
                    if (target.team === player.team) continue;
                    target.disabledUntil = now + PULSE_MS;
                    // Running effects stop too.
                    Object.assign(target, {
                        speedUntil: 0, invisibleUntil: 0, shieldUntil: 0, timeHoleUntil: 0, totemUntil: 0,
                        titanUntil: 0, confidenceUntil: 0, furyUntil: 0, ragingUntil: 0, raptureUntil: 0,
                        dualityMode: null, dualityPendingUntil: 0, furyFinalUntil: 0, angelUntil: 0,
                    });
                    this.fx({ kind: "text", x: Math.round(target.x), y: Math.round(target.y), text: "DISABLED", color: "#c39bd3" });
                }
                return true;
            }
        }
        return false;
    }

    // Plays an ability clip on every screen, freezes the game meanwhile, then runs `after`.
    startCinematic(clip, player, now, after) {
        const ms = Math.min(this.clipDurations[clip] || CLIP_FALLBACK_MS, 20000);
        this.freezeUntil = now + ms;
        this.ball.setVelocity(0, 0);
        this.opts.send({ type: "freeze", ms });
        this.fx({ kind: "cinematic", clip, ms, id: player.id });
        this.afterFreeze.push((end) => after(end));
    }

    // ---------- platforms ----------

    spawnPlatform(player, input, now) {
        // Exactly at the cursor, anywhere on the field (just kept inside the lines).
        const half = PLATFORM_SIZE / 2;
        const x = Phaser.Math.Clamp(input.tx, MARGIN_X + half, WORLD_W - MARGIN_X - half);
        const y = Phaser.Math.Clamp(input.ty, MARGIN_Y + half, WORLD_H - MARGIN_Y - half);

        const id = this.nextPlatformId++;
        const rect = this.createPlatformRect(x, y);
        this.physics.add.existing(rect, true); // full-size wall, before the pop-in animation scales it
        this.platformGroup.add(rect);
        this.popIn(rect);
        this.platforms.set(id, { x, y, until: now + PLATFORM_MS, rect });
        // A ball on the spot gets smashed away by the rising wall.
        const ball = this.ball;
        if (Math.abs(ball.x - x) < half + BALL_SIZE / 2 && Math.abs(ball.y - y) < half + BALL_SIZE / 2 && !this.ownerId) {
            this.launchFromPlatform(player, x, y, now);
        }
        return true;
    }

    launchFromPlatform(player, x, y, now) {
        const ball = this.ball;
        const half = PLATFORM_SIZE / 2;
        const r = BALL_SIZE / 2 + 2;
        let angle = Math.atan2(ball.y - y, ball.x - x);
        if (Math.hypot(ball.x - x, ball.y - y) < 1) angle = player.aim;
        // Leave the square in that direction; if that would be off the field, go the other way.
        const exitPoint = (a) => {
            const dx = Math.cos(a);
            const dy = Math.sin(a);
            const t = (half + r) / Math.max(Math.abs(dx), Math.abs(dy));
            return this.keepBallOnField(x + dx * t, y + dy * t);
        };
        let exit = exitPoint(angle);
        if (exit.clampedX || exit.clampedY) {
            angle += Math.PI;
            exit = exitPoint(angle);
        }
        ball.setPosition(exit.x, exit.y);
        this.physics.velocityFromRotation(angle, 750, ball.body.velocity);
        this.ballEffects.frozenUntil = 0;
        this.lastTouchId = player.id;
        this.assistId = null;
        this.lastShooterTeam = player.team;
        this.canAttachAt = now + REATTACH_DELAY_MS;
        this.fx({ kind: "shatter", x: Math.round(exit.x), y: Math.round(exit.y) });
    }

    createPlatformRect(x, y) {
        return this.add.rectangle(x, y, PLATFORM_SIZE, PLATFORM_SIZE, 0x7b5e3b, 0.92)
            .setStrokeStyle(5, 0x4e3b24, 1).setDepth(1.2);
    }

    popIn(rect) {
        rect.setScale(0.2);
        this.tweens.add({ targets: rect, scale: 1, duration: 220, ease: "Back.Out" });
    }

    expirePlatforms(now) {
        for (const [id, platform] of this.platforms) {
            if (now < platform.until) continue;
            platform.rect.destroy();
            this.platforms.delete(id);
        }
    }

    syncPlatforms(list) {
        const alive = new Set(list.map(([id]) => id));
        for (const [id, platform] of this.platforms) {
            if (!alive.has(id)) {
                platform.rect.destroy();
                this.platforms.delete(id);
            }
        }
        for (const [id, x, y] of list) {
            if (!this.platforms.has(id)) {
                const rect = this.createPlatformRect(x, y);
                this.popIn(rect);
                this.platforms.set(id, { x, y, rect });
            }
        }
    }

    pushOutOfPlatforms(p) {
        const half = PLATFORM_SIZE / 2;
        const r = PLAYER_RADIUS;
        for (const { x, y } of this.platforms.values()) {
            const nearestX = Phaser.Math.Clamp(p.x, x - half, x + half);
            const nearestY = Phaser.Math.Clamp(p.y, y - half, y + half);
            const dx = p.x - nearestX;
            const dy = p.y - nearestY;
            const dist = Math.hypot(dx, dy);
            if (dist >= r) continue;
            if (dist > 0) {
                p.x = nearestX + (dx / dist) * r;
                p.y = nearestY + (dy / dist) * r;
            } else {
                // Centre inside the wall: leave through the closest side.
                const exits = [
                    [x - half - r - p.x, 0], [x + half + r - p.x, 0], [0, y - half - r - p.y], [0, y + half + r - p.y],
                ].sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
                p.x += exits[0][0];
                p.y += exits[0][1];
            }
        }
    }

    // ---------- Zeus & Infinity ----------

    updateZeus(now) {
        if (!this.zeus) return;
        if (now >= this.zeus.until) {
            this.zeus = null;
            return;
        }
        if (now < this.zeus.nextTick) return;
        this.zeus.nextTick = now + ZEUS_TICK_MS;
        for (const p of this.players.values()) {
            if (p.id === this.zeus.id || Math.random() >= ZEUS_STUN_CHANCE) continue;
            p.stunnedUntil = Math.max(p.stunnedUntil, now + ZEUS_STUN_MS);
            p.sliding = false;
            this.fx({ kind: "lightning", x: Math.round(p.x), y: Math.round(p.y) });
        }
    }

    // Infinity: an invisible force around the user pushes the ball and opponents away.
    applyInfinity(now) {
        for (const p of this.players.values()) {
            if (!this.passiveActive(p, "infinity", now)) continue;
            for (const q of this.players.values()) {
                if (q.team === p.team) continue;
                const d = distance(p, q);
                if (d < INFINITY_RADIUS && d > 0) {
                    q.x = p.x + ((q.x - p.x) / d) * INFINITY_RADIUS;
                    q.y = p.y + ((q.y - p.y) / d) * INFINITY_RADIUS;
                    this.clampToField(q, now);
                }
            }
            const ball = this.ball;
            const d = distance(p, ball);
            if (this.ownerId === null && d < INFINITY_RADIUS && d > 0) {
                let nx = (ball.x - p.x) / d;
                let ny = (ball.y - p.y) / d;
                const pushed = this.keepBallOnField(p.x + nx * INFINITY_RADIUS, p.y + ny * INFINITY_RADIUS);
                // Against a wall the ball can't go further out – send it along the wall instead.
                if (pushed.clampedX) nx = 0;
                if (pushed.clampedY) ny = 0;
                if (Math.abs(nx) < 0.2 && Math.abs(ny) < 0.2) {
                    // Pinned between the user and a wall: slide sideways, towards the middle of the field.
                    if (pushed.clampedY) nx = ball.x < WORLD_W / 2 ? 1 : -1;
                    else ny = ball.y < WORLD_H / 2 ? 1 : -1;
                }
                const length = Math.hypot(nx, ny);
                ball.setPosition(pushed.x, pushed.y);
                const speed = Math.max(ball.body.velocity.length(), 420);
                ball.setVelocity((nx / length) * speed, (ny / length) * speed);
            }
        }
    }

    // Clamps a ball position to the playable area (the goal mouths count as playable).
    keepBallOnField(x, y) {
        const r = BALL_SIZE / 2 + 1;
        const inGoalMouth = y > GOAL_TOP + r && y < GOAL_BOTTOM - r;
        const minX = inGoalMouth ? 20 + r : MARGIN_X + r;
        const maxX = inGoalMouth ? WORLD_W - 20 - r : WORLD_W - MARGIN_X - r;
        const cx = Phaser.Math.Clamp(x, minX, maxX);
        const cy = Phaser.Math.Clamp(y, MARGIN_Y + r, WORLD_H - MARGIN_Y - r);
        return { x: cx, y: cy, clampedX: cx !== x, clampedY: cy !== y };
    }

    // ---------- shooting & possession ----------

    targetGoal(team) {
        return { x: team === "A" ? WORLD_W - MARGIN_X * 0.4 : MARGIN_X * 0.4, y: WORLD_H / 2 };
    }

    shoot(player, input, now) {
        let angle = input.aim;
        let power = SHOOT_POWER * this.powerMultiplier(player, now);
        const goal = this.targetGoal(player.team);
        const ball = this.ball;
        this.ballEffects.dark = false;
        this.ballEffects.boomerangId = null;

        if (has(player, "finesse_shot") && distance(ball, goal) < 700) {
            // Guide the shot towards the nearest point of the goal mouth.
            const goalY = Phaser.Math.Clamp(ball.y, GOAL_TOP + 20, GOAL_BOTTOM - 20);
            const ideal = Math.atan2(goalY - ball.y, goal.x - ball.x);
            const diff = Phaser.Math.Angle.Wrap(ideal - angle);
            if (Math.abs(diff) < 0.5 && Math.abs(diff) > 0.01) {
                angle += diff * 0.6;
                this.badge(player, "finesse_shot", now);
            }
        }
        if (has(player, "power_shot")) {
            power *= 1.2;
            this.badge(player, "power_shot", now);
        }
        if (now < player.ragingUntil) {
            power *= RAGING_POWER;
            player.ragingUntil = 0;
        }
        if (player.dualityMode === "light") {
            power *= RAGING_POWER;
            this.fx({ kind: "lightning", x: Math.round(ball.x), y: Math.round(ball.y) });
        } else if (player.dualityMode === "dark") {
            power *= DARK_START;
            this.ballEffects.dark = true;
            this.ballEffects.darkNextStep = now + DARK_STEP_MS;
        }
        player.dualityMode = null;

        if (now < player.furyUntil) {
            // Slashes of Fury: every kick is 20% faster and comes back.
            power *= Math.min(Math.pow(FURY_GROWTH, player.furyKicks), FURY_MAX);
            player.furyKicks++;
            this.ballEffects.boomerangId = player.id;
            this.ballEffects.returnAt = now + FURY_RETURN_MS;
        } else if (now < player.furyFinalUntil) {
            power *= player.furyFinal;
            player.furyFinalUntil = 0;
            player.furyKicks = 0;
        }

        if (has(player, "chip_shot")) {
            this.ballEffects.airUntil = now + CHIP_AIR_MS;
            this.badge(player, "chip_shot", now);
        }
        if (now < player.raptureUntil) {
            // Bend towards the goal: sign of the cross product shot × direction-to-goal.
            const cross = Math.cos(angle) * (goal.y - ball.y) - Math.sin(angle) * (goal.x - ball.x);
            this.ballEffects.curveRate = (cross >= 0 ? 1 : -1) * 2.2;
            this.ballEffects.curveUntil = now + 900;
            player.raptureUntil = 0;
        } else {
            this.ballEffects.curveUntil = 0;
        }

        this.ownerId = null;
        this.canAttachAt = now + (this.ballEffects.boomerangId ? 150 : REATTACH_DELAY_MS);
        this.lastShooterTeam = player.team;
        this.ballEffects.frozenUntil = 0;
        this.physics.velocityFromRotation(angle, Math.min(power, MAX_BALL_SPEED), ball.body.velocity);
    }

    setOwner(player, now, viaCatch = false) {
        const previous = this.players.get(this.lastTouchId);
        if (previous !== player) {
            // A pass from a teammate sets up an assist; an opponent's touch cancels it.
            this.assistId = previous && previous.team === player.team ? previous.id : null;
        }
        this.ownerId = player.id;
        this.lastTouchId = player.id;
        this.ballEffects.dark = false;
        this.ballEffects.boomerangId = null;
        if (has(player, "technical")) this.badge(player, "technical", now);

        if (previous && previous.team !== player.team) {
            // Virus: taking the ball from a virus carrier blinds you.
            if (this.passiveActive(previous, "virus", now)) {
                this.fx({ kind: "virus", id: player.id });
                this.fx({ kind: "text", x: Math.round(player.x), y: Math.round(player.y), text: "🦠 INFECTED", color: "#58d68d" });
            }
            // Flash Counter: an opponent took the ball straight from our shot.
            if (viaCatch && previous.ability === "flash_counter") {
                previous.flashTargetId = player.id;
                previous.flashUntil = now + FLASH_WINDOW_MS;
            }
        }
    }

    trySteal(player, now) {
        if (player.stoleThisSlide || this.ownerId === player.id) return;
        if (this.passiveActive(player, "infinity", now)) return; // can't touch the ball
        let reach = has(player, "slide_tackle") ? SLIDE_TACKLE_REACH : STEAL_DISTANCE;
        reach = reach * this.reaperMultiplier(player, now) + this.reachBonus(player, now);
        if (distance(player, this.ball) >= reach) return;

        const owner = this.players.get(this.ownerId);
        if (owner && owner.team === player.team) return; // no stealing from teammates

        player.stoleThisSlide = true;
        const text = (label, color) => this.fx({ kind: "text", x: Math.round(player.x), y: Math.round(player.y), text: label, color });

        if (owner) {
            if (now < owner.shieldUntil) {
                // Forcefield: most tackles bounce off, but some fouls get through.
                if (Math.random() >= SHIELD_FOUL_CHANCE) return text("BLOCKED", "#48f0c8");
                text("FOUL!", "#ffd54a");
            } else if (now < owner.dodgeUntil) {
                return text("MISS!", "#ff2222");
            } else if (has(owner, "press_proven") && !owner.lastInput.sprint && Math.random() < 0.5) {
                this.badge(owner, "press_proven", now);
                return text("RESISTED", "#ffd54a");
            }
        }

        this.setOwner(player, now);
        if (!owner) return;
        if (has(player, "anticipate")) this.badge(player, "anticipate", now);
        if (has(player, "slide_tackle")) this.badge(player, "slide_tackle", now);
        if (has(player, "bruiser")) {
            const angle = Math.atan2(owner.y - player.y, owner.x - player.x);
            owner.x += Math.cos(angle) * 70;
            owner.y += Math.sin(angle) * 70;
            this.clampToField(owner, now);
            this.badge(player, "bruiser", now);
        }
    }

    separatePlayers(now) {
        const list = [...this.players.values()];
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const a = list[i];
                const b = list[j];
                const minDist = this.radius(a, now) + this.radius(b, now);
                const dist = distance(a, b);
                if (dist >= minDist || dist === 0) continue;
                const angle = Math.atan2(b.y - a.y, b.x - a.x);
                const overlap = minDist - dist;

                // Enforcer: the ball carrier is barely pushed by opponents.
                let shareA = 0.5;
                const enforcer = (p, q) => this.ownerId === p.id && p.team !== q.team && has(p, "enforcer");
                if (enforcer(a, b)) shareA = 0.15;
                else if (enforcer(b, a)) shareA = 0.85;
                if (shareA !== 0.5) this.badge(shareA < 0.5 ? a : b, "enforcer", now);

                a.x -= Math.cos(angle) * overlap * shareA;
                a.y -= Math.sin(angle) * overlap * shareA;
                b.x += Math.cos(angle) * overlap * (1 - shareA);
                b.y += Math.sin(angle) * overlap * (1 - shareA);
            }
        }
    }

    // Absolute Confidence: the newest active user pulls every ball played by someone else.
    confidentPlayer(now) {
        let best = null;
        for (const p of this.players.values()) {
            if (now < p.confidenceUntil && now >= p.disabledUntil && (!best || p.confidenceUntil > best.confidenceUntil)) best = p;
        }
        return best && this.lastTouchId !== best.id ? best : null;
    }

    updateBall(now, frames) {
        const ball = this.ball;
        const effects = this.ballEffects;
        const velocity = ball.body.velocity;

        if (now < effects.frozenUntil) ball.setVelocity(0, 0);

        if (now < effects.curveUntil) velocity.rotate(effects.curveRate * frames / 60);

        // Slash of Duality (dark): slow start, then faster every 0.2 s up to 1000% – no friction meanwhile.
        ball.body.drag.set(effects.dark ? 1 : BALL_DRAG, effects.dark ? 1 : BALL_DRAG);
        if (effects.dark && !this.ownerId && now >= effects.darkNextStep) {
            effects.darkNextStep = now + DARK_STEP_MS;
            const speed = velocity.length();
            if (speed > 1) velocity.scale(Math.min(speed * DARK_GROWTH, MAX_BALL_SPEED) / speed);
        }

        // Ball steering: Slashes of Fury boomerang, Absolute Confidence.
        let exclusive = null;
        if (!this.ownerId) {
            const fury = effects.boomerangId && now >= effects.returnAt ? this.players.get(effects.boomerangId) : null;
            const confident = this.confidentPlayer(now);
            const homingTo = fury || confident;
            if (homingTo) {
                exclusive = homingTo;
                const angle = Math.atan2(homingTo.y - ball.y, homingTo.x - ball.x);
                const speed = Math.max(velocity.length(), fury ? 600 : 650);
                const blend = Math.min(1, 0.25 * frames);
                velocity.x += (Math.cos(angle) * speed - velocity.x) * blend;
                velocity.y += (Math.sin(angle) * speed - velocity.y) * blend;
            } else if (effects.boomerangId && now < effects.returnAt) {
                exclusive = this.players.get(effects.boomerangId); // the fury ball can't be intercepted
            }
        }

        // Time hole: opponents' balls slow down inside the field.
        if (!this.ownerId) {
            for (const p of this.players.values()) {
                if (now < p.timeHoleUntil && this.lastShooterTeam !== p.team && distance(p, ball) < FIELD_RADIUS) {
                    velocity.scale(Math.pow(0.92, frames));
                    break;
                }
            }
        }

        if (!this.ownerId && now >= this.canAttachAt && now >= effects.airUntil) {
            let closest = null;
            let closestMargin = 0;
            for (const player of this.players.values()) {
                if (exclusive && player !== exclusive) continue;
                if (this.passiveActive(player, "infinity", now)) continue;
                let reach = CATCH_DISTANCE;
                if (now < player.shieldUntil) reach = SHIELD_CATCH_DISTANCE;
                else if (has(player, "intercept") && this.lastShooterTeam && this.lastShooterTeam !== player.team) {
                    reach = INTERCEPT_DISTANCE;
                }
                reach += this.reachBonus(player, now);
                const margin = reach - distance(player, ball);
                if (margin > closestMargin) {
                    closest = player;
                    closestMargin = margin;
                }
            }
            if (closest) {
                const intercepted = this.lastShooterTeam && this.lastShooterTeam !== closest.team;
                this.setOwner(closest, now, true);
                if (intercepted && has(closest, "intercept")) this.badge(closest, "intercept", now);
                this.lastShooterTeam = closest.team;
            }
        }

        const owner = this.players.get(this.ownerId);
        if (owner) {
            const angle = owner.aim + this.dribbleOffset(owner, now);
            const offset = BALL_OFFSET + this.reachBonus(owner, now) * 0.5;
            ball.setPosition(owner.x + Math.cos(angle) * offset, owner.y + Math.sin(angle) * offset);
            ball.setVelocity(0, 0);
            effects.curveUntil = 0;
            effects.frozenUntil = 0;
        }
    }

    dribbleOffset(player, now) {
        const progress = (now - player.dodgeStart) / DODGE_SPIN_MS;
        if (progress >= 1) return 0;
        return Math.PI * Math.pow(1 - progress, 3); // ease out, like the old "Power2" tween
    }

    interpolate(delta) {
        const t = Math.min(1, delta / 60);
        const follow = (obj, target) => {
            if (!target) return;
            if (Phaser.Math.Distance.Between(obj.x, obj.y, target.x, target.y) > 200) {
                obj.x = target.x; // teleport (kickoff, blink, swap) – don't slide across the field
                obj.y = target.y;
            } else {
                obj.x += (target.x - obj.x) * t;
                obj.y += (target.y - obj.y) * t;
            }
        };
        for (const player of this.players.values()) follow(player, player.target);
        if (this.ballTarget) {
            const ball = { x: this.ball.x, y: this.ball.y };
            follow(ball, this.ballTarget);
            this.ball.setPosition(ball.x, ball.y);
        }
    }

    // ------------------------------------------------------------------
    // Drawing
    // ------------------------------------------------------------------

    draw(now) {
        const me = this.players.get(this.opts.myId);
        this.hookLines.clear();
        for (const player of this.players.values()) {
            const flags = this.isHost ? this.playerFlags(player, now) : player.flags;
            const invisible = Boolean(flags & FLAG.invisible);
            // Invisible players are hidden from opponents and see-through for their own team.
            const hidden = invisible && me && me.team !== player.team;
            const alpha = hidden ? 0 : invisible ? 0.35 : (flags & FLAG.dodging ? 0.6 : 1);
            const scale = flags & FLAG.titan ? TITAN_SCALE : 1;
            const size = PLAYER_SIZE * scale;
            const radius = PLAYER_RADIUS * scale;

            player.sprite.setPosition(player.x, player.y).setAlpha(alpha).setDisplaySize(size, size)
                .setAngle(flags & FLAG.sliding ? 25 : 0);
            if (flags & FLAG.stunned) player.sprite.setTint(0x8e8ea8);
            else player.sprite.clearTint();
            player.ring.setPosition(player.x, player.y).setAlpha(alpha).setRadius(radius + 2)
                .setStrokeStyle(4, flags & FLAG.armed ? 0xffa21a : TEAM_COLORS[player.team], 1);
            player.halo.setPosition(player.x, player.y).setAlpha(alpha).setRadius(radius + 7);
            player.label.setPosition(player.x, player.y - radius - 8).setAlpha(hidden ? 0 : 1);
            player.shield.setPosition(player.x, player.y).setVisible(Boolean(flags & FLAG.shield) && !hidden);
            player.timeHole.setPosition(player.x, player.y).setVisible(Boolean(flags & FLAG.timeHole));
            player.totem.setPosition(player.x, player.y).setVisible(Boolean(flags & FLAG.totem));
            player.infinityRing.setPosition(player.x, player.y).setVisible(Boolean(flags & FLAG.infinity) && !hidden)
                .setAlpha(0.6 + 0.4 * Math.sin(now / 300));

            // One aura for the strongest active state.
            let auraColor = null;
            let auraAlpha = 0.22;
            let auraSize = radius + 10;
            if (flags & FLAG.angel) auraColor = 0xf7dc6f;
            else if (flags & FLAG.confidence) auraColor = 0xe74c3c;
            else if (flags & FLAG.fury) auraColor = 0xff7f27;
            else if (player.reaperStacks > 0 && player.ability === "reaper") {
                auraColor = 0x8e44ad;
                auraAlpha = 0.12 + 0.08 * player.reaperStacks;
                auraSize = radius + 8 + 5 * player.reaperStacks;
            }
            player.aura.setVisible(auraColor !== null && !hidden);
            if (auraColor !== null) {
                player.aura.setPosition(player.x, player.y).setFillStyle(auraColor, auraAlpha * (0.8 + 0.2 * Math.sin(now / 150)))
                    .setRadius(auraSize);
            }

            // Reaper: the stack count floats beside the player, bigger with every goal.
            const stacks = player.ability === "reaper" ? player.reaperStacks : 0;
            player.reaperText.setVisible(stacks > 0 && !hidden);
            if (stacks > 0) {
                player.reaperText.setText(String(stacks)).setFontSize(16 + stacks * 5)
                    .setPosition(player.x + radius + 12, player.y - radius)
                    .setShadow(0, 0, "#bb8fce", 6 + stacks * 4, true, true);
            }

            const icons = [];
            if (flags & FLAG.stunned) icons.push("💫");
            if (flags & FLAG.disabled) icons.push("⛔");
            player.status.setText(icons.join(" ")).setPosition(player.x, player.y - radius - 28).setVisible(!hidden);

            if (!hidden) this.drawTrails(player, flags, alpha, now);

            // Hell Hook: a chain from the hooker to everyone being dragged.
            const hooker = player.hookedBy ? this.players.get(player.hookedBy) : null;
            if (hooker) this.drawChain(hooker, player);
        }

        const air = this.isHost ? now < this.ballEffects.airUntil : this.ballAir;
        this.ball.setDisplaySize(BALL_SIZE * (air ? 1.4 : 1), BALL_SIZE * (air ? 1.4 : 1));

        // An invisible player's ball is invisible for the opponents too.
        const owner = this.players.get(this.ownerId);
        const ownerFlags = owner ? (this.isHost ? this.playerFlags(owner, now) : owner.flags) : 0;
        const ballHidden = owner && (ownerFlags & FLAG.invisible) && me && me.team !== owner.team;
        this.ball.setAlpha(ballHidden ? 0 : 1);

        const frozen = this.isHost ? now < this.ballEffects.frozenUntil : this.ballFrozen;
        const dark = this.isHost ? this.ballEffects.dark : this.ballDark;
        if (frozen) this.ball.setTint(0x7fd3ff);
        else if (dark) this.ball.setTint(0x6c3483);
        else if (!this.goalPending && (this.ball.tintTopLeft === 0x7fd3ff || this.ball.tintTopLeft === 0x6c3483)) this.ball.clearTint();
        this.iceShell.setVisible(frozen && !ballHidden).setPosition(this.ball.x, this.ball.y)
            .setRotation(now / 900);
        if (dark && !ballHidden && now - (this.darkTrailAt || 0) > 30) {
            this.darkTrailAt = now;
            const smoke = this.add.circle(this.ball.x, this.ball.y, BALL_SIZE * 0.45, 0x1b0b2e, 0.6).setDepth(3.5);
            this.tweens.add({ targets: smoke, alpha: 0, scale: 1.8, duration: 350, onComplete: () => smoke.destroy() });
        }

        // Zeus' Storm: the whole field gets a yellow tint.
        const zeusActive = this.isHost ? Boolean(this.zeus && now < this.zeus.until) : this.zeusLeft > 0;
        this.zeusTint.setVisible(zeusActive).setAlpha(0.2 + 0.05 * Math.sin(now / 120));

        // Virus: almost everything is dark except a small circle around me.
        this.darkness.clear();
        if (me && now < this.virusUntil) {
            const fade = Math.min(1, (this.virusUntil - now) / 400);
            this.darkness.lineStyle(4000, 0x000000, 0.95 * fade).strokeCircle(me.x, me.y, VIRUS_SIGHT + 2000);
        }

        this.aimCursor.setVisible(Boolean(me));
        if (me) {
            this.aimCursor.setPosition(me.x + Math.cos(me.aim) * AIM_RADIUS, me.y + Math.sin(me.aim) * AIM_RADIUS);
        }
        this.animateSkins(now);
    }

    drawChain(from, to) {
        const g = this.hookLines;
        g.lineStyle(7, 0x2b0a0a, 0.8).lineBetween(from.x, from.y, to.x, to.y);
        g.lineStyle(3, 0xc0392b, 1).lineBetween(from.x, from.y, to.x, to.y);
        // Chain links along the line.
        const steps = Math.max(2, Math.floor(distance(from, to) / 22));
        for (let i = 1; i < steps; i++) {
            const t = i / steps;
            g.fillStyle(0x7b241c, 1).fillCircle(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, 3.5);
        }
        g.fillStyle(0xe74c3c, 1).fillCircle(to.x, to.y, 6);
    }

    drawTrails(player, flags, alpha, now) {
        if (flags & FLAG.dash && now - player.trailAt >= TRAIL_INTERVAL_MS) {
            // Dash: a smooth streak of fading copies.
            player.trailAt = now;
            const ghost = this.add.image(player.x, player.y, player.sprite.texture.key)
                .setDisplaySize(PLAYER_SIZE, PLAYER_SIZE).setAlpha(0.45 * alpha).setDepth(1.5)
                .setTint(TEAM_COLORS[player.team]);
            this.tweens.add({ targets: ghost, alpha: 0, scale: ghost.scale * 0.6, duration: 260, onComplete: () => ghost.destroy() });
        } else if (flags & FLAG.shadow && now - player.trailAt >= SHADOW_INTERVAL_MS) {
            // Shadow Step: black circles that vanish in hard steps, like stop motion.
            player.trailAt = now;
            const shadow = this.add.circle(player.x, player.y, PLAYER_RADIUS, 0x000000, 0.65 * alpha).setDepth(1.5);
            this.tweens.add({
                targets: shadow,
                alpha: 0,
                duration: 360,
                ease: "Stepped",
                easeParams: [3],
                onComplete: () => shadow.destroy(),
            });
        }
    }

    // A jagged lightning bolt from the top of the field down onto (x, y).
    strikeLightning(x, y) {
        const bolt = this.add.graphics().setDepth(21);
        const drawBolt = () => {
            bolt.clear();
            const points = [];
            let px = x + Phaser.Math.Between(-120, 120);
            const segments = 12;
            for (let i = 0; i <= segments; i++) {
                const t = i / segments;
                const py = -20 + (y + 20) * t;
                px += (x - px) * (i / segments) + Phaser.Math.Between(-28, 28) * (1 - t * 0.7);
                points.push(new Phaser.Geom.Point(i === segments ? x : px, py));
            }
            bolt.lineStyle(14, 0xfff59d, 0.25).strokePoints(points);
            bolt.lineStyle(6, 0xffeb3b, 0.6).strokePoints(points);
            bolt.lineStyle(2.5, 0xffffff, 1).strokePoints(points);
        };
        drawBolt();
        this.time.delayedCall(70, drawBolt);
        this.time.delayedCall(140, drawBolt);
        this.tweens.add({ targets: bolt, alpha: 0, delay: 180, duration: 220, onComplete: () => bolt.destroy() });

        const flash = this.add.circle(x, y, 40, 0xffffff, 0.8).setDepth(21);
        this.tweens.add({ targets: flash, scale: 2.5, alpha: 0, duration: 300, onComplete: () => flash.destroy() });
        this.sparkEmitter.explode(18, x, y);
        this.cameras.main.shake(120, 0.004);
    }

    // ------------------------------------------------------------------
    // Goals & effects
    // ------------------------------------------------------------------

    onGoal(team) {
        if (!this.isHost || this.goalPending || this.frozen) return;
        const now = this.time.now;

        // Guardian Angel: a defender saves it instantly – again and again for 10 s.
        const defending = team === "A" ? "B" : "A";
        for (const g of this.players.values()) {
            if (g.team !== defending || !this.passiveActive(g, "guardian_angel", now)) continue;
            if (now >= g.angelUntil && now < g.abilityReadyAt) continue;
            this.ball.setVelocity(0, 0);
            this.ball.setPosition(g.x, g.y);
            this.resetBallEffects();
            this.setOwner(g, now);
            this.lastShooterTeam = g.team;
            if (now >= g.angelUntil) this.fx({ kind: "ability", id: g.id, ability: "guardian_angel" });
            g.angelUntil = now + GUARDIAN_WINDOW_MS;
            g.abilityReadyAt = g.angelUntil + ABILITIES.guardian_angel.cooldown;
            this.fx({ kind: "text", x: Math.round(g.x), y: Math.round(g.y - 30), text: "😇 SAVED!", color: "#f7dc6f" });
            return;
        }

        this.goalPending = true;
        this.ownerId = null;
        this.ball.setVelocity(0, 0);
        this.ball.body.enable = false;
        this.ball.setTint(0x00ffff);
        this.sendState(now);
        this.opts.send({ type: "goal", team, scorer: this.lastTouchId, assist: this.assistId });
    }

    // Reaper: a real (not own) goal adds a stack.
    onGoalConfirmed(msg) {
        if (msg.ownGoal || !msg.scorerName) return;
        const scorer = [...this.players.values()].find((p) => p.name === msg.scorerName && p.team === msg.team);
        if (scorer && this.passiveActive(scorer, "reaper", this.time.now) && scorer.reaperStacks < REAPER_MAX) {
            scorer.reaperStacks++;
            this.fx({ kind: "text", x: Math.round(scorer.x), y: Math.round(scorer.y - 30), text: `💀 REAPER ${scorer.reaperStacks}`, color: "#d2b4de" });
        }
    }

    kickoff() {
        this.ownerId = null;
        this.lastTouchId = null;
        this.assistId = null;
        this.lastShooterTeam = null;
        this.goalPending = false;
        this.canAttachAt = 0;
        this.resetBallEffects();
        this.ball.clearTint();
        this.ball.body.enable = true;
        this.ball.setPosition(WORLD_W / 2, WORLD_H / 2);
        this.ball.setVelocity(0, 0);

        for (const team of ["A", "B"]) {
            const members = [...this.players.values()].filter((p) => p.team === team);
            // Formation: up to 4 players per column, more columns for big teams (up to 10v10).
            const perColumn = 4;
            const columns = Math.ceil(members.length / perColumn);
            members.forEach((player, i) => {
                const column = Math.floor(i / perColumn);
                const row = i % perColumn;
                const inColumn = Math.min(perColumn, members.length - column * perColumn);
                const offsetX = (column - (columns - 1) / 2) * 110;
                const xA = WORLD_W * 0.25 + offsetX;
                player.x = team === "A" ? xA : WORLD_W - xA;
                player.y = WORLD_H / 2 + (row - (inColumn - 1) / 2) * 140;
                // Cooldowns and the Guardian Angel window carry over, running effects don't.
                const { tackleReadyAt, dribbleReadyAt, angelUntil } = player;
                this.resetPlayerEffects(player);
                Object.assign(player, { tackleReadyAt, dribbleReadyAt, angelUntil });
            });
        }
    }

    celebrateGoal() {
        for (const emitter of this.confettiEmitters) {
            emitter.setPosition(this.ball.x, this.ball.y);
            emitter.explode(20);
        }
    }

    // Host: pop a PlayStyle badge above a player, at most every BADGE_COOLDOWN_MS per PlayStyle.
    badge(player, playstyle, now) {
        if (now - (player.badgeAt[playstyle] ?? -Infinity) < BADGE_COOLDOWN_MS) return;
        player.badgeAt[playstyle] = now;
        this.fx({ kind: "badge", id: player.id, playstyle });
    }

    showBadge(playerId, playstyle) {
        const player = this.players.get(playerId);
        const info = PLAYSTYLES[playstyle];
        if (!player || !info) return;
        const me = this.players.get(this.opts.myId);
        if (me && me.team !== player.team && player.sprite.alpha === 0) return; // don't reveal invisible players

        // Silver diamond like the (non-plus) FC PlayStyle icons, or a custom image if provided.
        const hex = this.add.graphics();
        const points = [[-10, -17], [10, -17], [19, -5], [0, 19], [-19, -5]]
            .map(([x, y]) => new Phaser.Geom.Point(x, y));
        hex.fillStyle(0xc9d0d6, 1).fillPoints(points, true);
        hex.lineStyle(2, 0x6f7b85, 1).strokePoints(points, true);
        let short = this.add.text(0, -3, info.short, {
            fontFamily: "Segoe UI, Arial, sans-serif", fontSize: "13px", fontStyle: "bold", color: "#2b333a",
        }).setOrigin(0.5);
        if (this.textures.exists(`playstyle-${playstyle}`)) {
            hex.clear();
            short.destroy();
            short = this.add.image(0, 0, `playstyle-${playstyle}`).setDisplaySize(44, 44);
        }
        const name = this.add.text(0, 24, info.name, {
            fontFamily: "Segoe UI, Arial, sans-serif", fontSize: "13px", fontStyle: "bold",
            color: "#ffffff", stroke: "#000000", strokeThickness: 3,
        }).setOrigin(0.5, 0);

        const slot = Math.max(0, player.playstyleOrder.indexOf(playstyle));
        const offset = (slot - (player.playstyleOrder.length - 1) / 2) * 96;
        const badge = this.add.container(player.x + offset, player.y - PLAYER_RADIUS - 84, [hex, short, name]).setDepth(9).setScale(0.6);
        this.tweens.add({ targets: badge, scale: 1, duration: 160, ease: "Back.Out" });
        this.tweens.add({
            targets: badge,
            y: badge.y - 24,
            alpha: 0,
            delay: 900,
            duration: 500,
            onComplete: () => badge.destroy(),
        });
    }

    showAbilityFx(playerId, abilityId) {
        const player = this.players.get(playerId);
        const ability = ABILITIES[abilityId];
        if (!player || !ability) return;
        const color = Phaser.Display.Color.HexStringToColor(ability.color).color;
        const me = this.players.get(this.opts.myId);
        const surprise = (abilityId === "invisibility" || abilityId === "dash" || abilityId === "blink")
            && me && me.team !== player.team && player.sprite.alpha === 0;

        // Dash and blink leave their own traces; a shockwave would only clutter them.
        if (abilityId !== "dash" && abilityId !== "blink" && !surprise) {
            const big = abilityId === "pulse" || abilityId === "scopophobia" || abilityId === "zeus_storm";
            const wave = this.add.circle(player.x, player.y, PLAYER_RADIUS, color, 0.25)
                .setStrokeStyle(3, color, 0.9).setDepth(1);
            this.tweens.add({ targets: wave, scale: big ? 14 : 3, alpha: 0, duration: big ? 700 : 450, onComplete: () => wave.destroy() });
        }
        if (abilityId === "blink") {
            const flash = this.add.circle(player.x, player.y, PLAYER_RADIUS * 0.8, color, 0.5).setDepth(1);
            this.tweens.add({ targets: flash, alpha: 0, scale: 0.2, duration: 200, onComplete: () => flash.destroy() });
            return; // up to 7 blinks in a row – no label spam
        }
        if (abilityId === "invisibility" && me && me.team !== player.team) return; // keep the surprise
        if (surprise) return;
        const label = this.textures.exists(`ability-${abilityId}`) ? ability.name : `${ability.icon} ${ability.name}`;
        this.showFloatingText(player.x, player.y - 20, label, ability.color);
    }

    showFloatingText(x, y, label, color = "#ff2222") {
        const text = this.add.text(x, y - 25, label, {
            fontFamily: "Segoe UI, Arial, sans-serif",
            fontSize: "20px",
            fontStyle: "bold",
            color,
            stroke: "#000000",
            strokeThickness: 4,
        }).setOrigin(0.5).setDepth(10);
        this.tweens.add({
            targets: text,
            y: y - 65,
            alpha: 0,
            duration: 900,
            onComplete: () => text.destroy(),
        });
    }
}

export function startGame(options) {
    const scene = new GameScene(options);
    const game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: options.parent,
        backgroundColor: "#0b0d10",
        scale: {
            mode: Phaser.Scale.FIT,
            autoCenter: Phaser.Scale.CENTER_BOTH,
            width: WORLD_W,
            height: WORLD_H,
        },
        physics: {
            default: "arcade",
            // 240 physics steps per second so even a 1000% ball can't skip through walls or goals.
            arcade: { gravity: { x: 0, y: 0 }, debug: false, fps: 240 },
        },
        input: { keyboard: false }, // keys are handled by the scene with the player's keybinds
        scene,
    });

    return {
        handle: (msg) => scene.handle(msg),
        chooseDuality: (choice) => scene.chooseDuality(choice),
        freeze: () => {
            scene.frozen = true;
        },
        destroy: () => {
            scene.removeInputListeners?.();
            game.destroy(true);
        },
    };
}

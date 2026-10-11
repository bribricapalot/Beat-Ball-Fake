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
const EFFECT_MS = 3000; // shadow step, invisibility, forcefield, time hole
const ARMED_MS = 5000;  // raging deflection, rapture
const FREEZE_MS = 1500;
const NINJA_RANGE = 500;
const BALL_ABILITY_RANGE = 600;
const SWAP_RANGE = 700;
const HOOK_RANGE = WORLD_W / 2; // half the field
const FORCE_RANGE = 230;
const FORCE_PUSH = 150;
const TIME_HOLE_RADIUS = 220;
const SHIELD_CATCH_DISTANCE = 90;
const RAGING_POWER = 3; // +200%
const TRAIL_INTERVAL_MS = 16;      // dash streak
const SHADOW_INTERVAL_MS = 90;     // shadow step stop-motion copies

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
const FLAG = { sliding: 1, dodging: 2, invisible: 4, shield: 8, timeHole: 16, armed: 32, dash: 64, shadow: 128 };

const MOVE_ACTIONS = ["up", "down", "left", "right", "sprint"];
const PRESS_ACTIONS = ["shoot", "tackle", "dribble", "ability"];
const EMPTY_INPUT = {
    up: false, down: false, left: false, right: false, sprint: false,
    aim: 0, tx: 0, ty: 0, shoot: 0, tackle: 0, dribble: 0, ability: 0,
};

const has = (player, playstyle) => player.playstyles.has(playstyle);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clampToField = (p) => {
    p.x = Phaser.Math.Clamp(p.x, MARGIN_X + PLAYER_RADIUS, WORLD_W - MARGIN_X - PLAYER_RADIUS);
    p.y = Phaser.Math.Clamp(p.y, MARGIN_Y + PLAYER_RADIUS, WORLD_H - MARGIN_Y - PLAYER_RADIUS);
};

class GameScene extends Phaser.Scene {
    constructor(options) {
        super("scene-game");
        this.opts = options;
        this.isHost = options.myId === options.hostId;
        this.ready = false;
        this.frozen = false;      // set when the match is over
        this.goalPending = false; // between a goal and the next kickoff
        this.sendTimer = 0;
        this.lastCooldownSent = -1;

        this.players = new Map();      // id -> player
        this.remoteInputs = new Map(); // id -> last input (host only)
        this.ownerId = null;           // player holding the ball
        this.lastTouchId = null;       // last player who had the ball (goal scorer)
        this.lastShooterTeam = null;   // team that last shot/played the ball
        this.canAttachAt = 0;
        this.ballEffects = { airUntil: 0, frozenUntil: 0, curveRate: 0, curveUntil: 0 };

        // Action presses are counted so none get lost between network packets.
        this.localInput = { ...EMPTY_INPUT };
        this.pressedKeys = new Set();
        this.ballTarget = null;
        this.ballAir = false;
        this.ballFrozen = false;
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
        this.createInput();
        this.createConfetti();
        this.createIceEffects();

        if (!this.isHost) {
            // Only the host runs physics; everyone else just draws what the host sends.
            this.physics.pause();
        }
        this.ready = true;
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
    }

    createBall() {
        this.ball = this.physics.add.image(WORLD_W / 2, WORLD_H / 2, "ball");
        this.ball.setDisplaySize(BALL_SIZE, BALL_SIZE);
        this.ball.setCircle(this.ball.width / 2);
        this.ball.setBounce(0.8, 0.8);
        this.ball.setDamping(true);
        this.ball.setDrag(BALL_DRAG);
        this.ball.setCollideWorldBounds(true);
        this.ball.setDepth(4);

        this.physics.add.collider(this.ball, this.walls);
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
        const timeHole = this.add.circle(0, 0, TIME_HOLE_RADIUS, 0x6c3483, 0.16)
            .setStrokeStyle(3, 0xb07cc6, 0.6)
            .setDepth(0.5)
            .setVisible(false);
        const label = this.add.text(0, 0, name, {
            fontFamily: "Segoe UI, Arial, sans-serif",
            fontSize: "16px",
            fontStyle: "bold",
            color: "#ffffff",
            stroke: "#000000",
            strokeThickness: 4,
        }).setOrigin(0.5, 1).setDepth(6);

        const player = {
            id, name, team, isMe, sprite, ring, halo, shield, timeHole, label,
            ability: ABILITIES[ability] ? ability : "dash",
            playstyles: new Set((playstyles || []).filter((p) => PLAYSTYLES[p])),
            skinAnimation: null,
            x: 0, y: 0, aim: team === "A" ? 0 : Math.PI,
            target: null,
            flags: 0,            // received state (non-host)
            cooldownLeft: 0,     // received ability cooldown in ms (non-host)
            lastInput: EMPTY_INPUT,
            handled: { shoot: 0, tackle: 0, dribble: 0, ability: 0 },
            badgeAt: {},
            playstyleOrder: (playstyles || []).filter((p) => PLAYSTYLES[p]), // badge positions
            abilityReadyAt: 0,
            blinkCharges: BLINK_CHARGES,
            charges: BLINK_CHARGES, // received (non-host)
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
        for (const part of [player.sprite, player.ring, player.halo, player.shield, player.timeHole, player.label]) {
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
                break;
            case "kickoff":
                if (this.isHost) this.kickoff();
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
        if (msg.kind === "text") this.showFloatingText(msg.x, msg.y, msg.text, msg.color);
        else if (msg.kind === "badge") this.showBadge(msg.id, msg.playstyle);
        else if (msg.kind === "ability") this.showAbilityFx(msg.id, msg.ability);
        else if (msg.kind === "shatter") this.shardEmitter.explode(16, msg.x, msg.y);
    }

    sendState(now) {
        const r = (v) => Math.round(v * 10) / 10;
        this.opts.send({
            type: "state",
            b: [
                r(this.ball.x), r(this.ball.y), this.ownerId, this.goalPending ? 1 : 0,
                now < this.ballEffects.airUntil ? 1 : 0, now < this.ballEffects.frozenUntil ? 1 : 0,
            ],
            p: [...this.players.values()].map((p) => [
                p.id, r(p.x), r(p.y), r(p.aim), this.playerFlags(p, now),
                Math.max(0, Math.round((p.abilityReadyAt - now) / 100)),
                p.blinkCharges,
            ]),
        });
    }

    playerFlags(p, now) {
        return (p.sliding ? FLAG.sliding : 0)
            | (now < p.dodgeUntil ? FLAG.dodging : 0)
            | (now < p.invisibleUntil ? FLAG.invisible : 0)
            | (now < p.shieldUntil ? FLAG.shield : 0)
            | (now < p.timeHoleUntil ? FLAG.timeHole : 0)
            | (now < p.ragingUntil || now < p.raptureUntil ? FLAG.armed : 0)
            | (now < p.dashUntil ? FLAG.dash : 0)
            | (now < p.speedUntil ? FLAG.shadow : 0);
    }

    applyState(msg) {
        const [bx, by, ownerId, goalPending, air, frozen] = msg.b;
        this.ballTarget = { x: bx, y: by };
        this.ownerId = ownerId;
        this.ballAir = Boolean(air);
        this.ballFrozen = Boolean(frozen);
        this.ball.setTint(goalPending ? 0x00ffff : 0xffffff);

        for (const [id, x, y, aim, flags, cooldown, charges] of msg.p) {
            const player = this.players.get(id);
            if (!player) continue;
            player.target = { x, y };
            if (!player.isMe) player.aim = aim;
            player.flags = flags;
            player.cooldownLeft = cooldown * 100;
            player.charges = charges;
        }
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
            if (!this.frozen && !this.goalPending) this.simulate(time, frames);
            else this.discardPresses();
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
        const left = this.isHost ? Math.max(0, me.abilityReadyAt - now) : me.cooldownLeft;
        const charges = me.ability === "blink" ? (this.isHost ? me.blinkCharges : me.charges) : null;
        const key = `${Math.ceil(left / 100)}|${charges}`;
        if (key !== this.lastCooldownSent) {
            this.lastCooldownSent = key;
            // The short pause between blinks is not a real cooldown.
            const shown = charges !== null && charges < BLINK_CHARGES && left <= BLINK_GAP_MS ? 0 : left;
            this.opts.onCooldown?.(shown, ABILITIES[me.ability].cooldown, charges);
        }
    }

    simulate(now, frames) {
        for (const player of this.players.values()) {
            const input = player.isMe ? this.localInput : (this.remoteInputs.get(player.id) || EMPTY_INPUT);
            player.lastInput = input;
            player.aim = input.aim;
            this.simulatePlayer(player, input, now, frames);
        }
        this.separatePlayers(now);
        for (const player of this.players.values()) clampToField(player);
        this.updateBall(now, frames);
    }

    // Presses made during a goal pause should not fire right after the kickoff.
    discardPresses() {
        for (const player of this.players.values()) {
            const input = player.isMe ? this.localInput : this.remoteInputs.get(player.id);
            if (!input) continue;
            for (const action of PRESS_ACTIONS) player.handled[action] = input[action] || 0;
        }
    }

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

        // Slide tackle in move direction, or towards the aim when standing still.
        if (pressed("tackle") && now >= player.tackleReadyAt && !player.sliding) {
            const speed = SLIDE_SPEED * (has(player, "slide_tackle") ? 1.2 : 1);
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

        if (pressed("ability") && now >= player.abilityReadyAt) {
            const result = this.useAbility(player, input, now, moveAngle);
            if (result === true) {
                player.abilityReadyAt = now + ABILITIES[player.ability].cooldown;
                if (player.ability === "blink") {
                    // Several blinks in a row, the cooldown only starts after the last one.
                    player.blinkCharges--;
                    if (player.blinkCharges > 0) player.abilityReadyAt = now + BLINK_GAP_MS;
                    else player.blinkCharges = BLINK_CHARGES;
                }
                this.fx({ kind: "ability", id: player.id, ability: player.ability });
            } else {
                const text = typeof result === "string" ? result : "NO TARGET";
                this.fx({ kind: "text", x: Math.round(player.x), y: Math.round(player.y), text, color: "#cccccc" });
            }
        }

        if (pressed("shoot") && this.ownerId === player.id) this.shoot(player, input, now);

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
        if (now < player.speedUntil) speed *= 1.5;

        const carrier = this.players.get(this.ownerId);
        const jockeying = !sprinting && has(player, "jockey") && carrier && carrier.team !== player.team
            && distance(player, carrier) < 300;
        if (jockeying) {
            speed *= 1.12;
            if (!player.jockeying) this.badge(player, "jockey", now);
        }
        player.jockeying = Boolean(jockeying);

        if (this.inOpponentTimeHole(player, now)) speed *= 0.5;

        const length = Math.hypot(moveX, moveY);
        player.x += (moveX / length) * speed * frames;
        player.y += (moveY / length) * speed * frames;
    }

    inOpponentTimeHole(target, now) {
        for (const p of this.players.values()) {
            if (p.team !== target.team && now < p.timeHoleUntil && distance(p, target) < TIME_HOLE_RADIUS) return true;
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

    // Returns false when the ability has no valid target (then no cooldown is used).
    useAbility(player, input, now, moveAngle) {
        const ball = this.ball;
        const ballFree = this.ownerId === null;
        const ballDistance = distance(player, ball);

        switch (player.ability) {
            case "dash":
                player.dashX = Math.cos(moveAngle) * DASH_SPEED;
                player.dashY = Math.sin(moveAngle) * DASH_SPEED;
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
                clampToField(player);
                return true;
            }

            case "shadow_step":
                player.speedUntil = now + EFFECT_MS;
                return true;

            case "ninja_dash": {
                const owner = this.players.get(this.ownerId);
                if (ballDistance > NINJA_RANGE || (owner && owner.team === player.team)) return false;
                // Land just in front of the ball, on the side we came from.
                const angle = Math.atan2(player.y - ball.y, player.x - ball.x);
                player.x = ball.x + Math.cos(angle) * 30;
                player.y = ball.y + Math.sin(angle) * 30;
                clampToField(player);
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
                ball.setVelocity(0, 0);
                return true;

            case "forcefield":
                player.shieldUntil = now + EFFECT_MS;
                return true;

            case "pull": {
                if (!ballFree || ballDistance > BALL_ABILITY_RANGE) return false;
                const angle = Math.atan2(player.y - ball.y, player.x - ball.x);
                this.physics.velocityFromRotation(angle, 750, ball.body.velocity);
                this.ballEffects.frozenUntil = 0;
                this.lastShooterTeam = player.team;
                return true;
            }

            case "telekinesis": {
                if (!ballFree || ballDistance > BALL_ABILITY_RANGE) return false;
                const speed = Math.max(ball.body.velocity.length() * 1.3, 650);
                this.physics.velocityFromRotation(input.aim, speed, ball.body.velocity);
                this.ballEffects.frozenUntil = 0;
                this.lastShooterTeam = player.team;
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
                // Every opponent within half the field is dragged in front of us.
                let hooked = false;
                for (const target of this.players.values()) {
                    if (target.team === player.team || distance(target, player) > HOOK_RANGE) continue;
                    const angle = Math.atan2(target.y - player.y, target.x - player.x);
                    target.x = player.x + Math.cos(angle) * (PLAYER_SIZE + 5);
                    target.y = player.y + Math.sin(angle) * (PLAYER_SIZE + 5);
                    clampToField(target);
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
                    clampToField(target);
                    if (this.ownerId === target.id) {
                        // The ball is knocked loose – it counts as played by the Force user.
                        this.ownerId = null;
                        this.lastTouchId = player.id;
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
        }
        return false;
    }

    targetGoal(team) {
        return { x: team === "A" ? WORLD_W - MARGIN_X * 0.4 : MARGIN_X * 0.4, y: WORLD_H / 2 };
    }

    shoot(player, input, now) {
        let angle = input.aim;
        let power = SHOOT_POWER;
        const goal = this.targetGoal(player.team);
        const ball = this.ball;

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
        this.canAttachAt = now + REATTACH_DELAY_MS;
        this.lastShooterTeam = player.team;
        this.ballEffects.frozenUntil = 0;
        this.physics.velocityFromRotation(angle, power, ball.body.velocity);
    }

    setOwner(player, now) {
        this.ownerId = player.id;
        this.lastTouchId = player.id;
        if (has(player, "technical")) this.badge(player, "technical", now);
    }

    trySteal(player, now) {
        if (player.stoleThisSlide || this.ownerId === player.id) return;
        const reach = has(player, "slide_tackle") ? SLIDE_TACKLE_REACH : STEAL_DISTANCE;
        if (distance(player, this.ball) >= reach) return;

        const owner = this.players.get(this.ownerId);
        if (owner && owner.team === player.team) return; // no stealing from teammates

        player.stoleThisSlide = true;
        const text = (label, color) => this.fx({ kind: "text", x: Math.round(player.x), y: Math.round(player.y), text: label, color });

        if (owner) {
            if (now < owner.shieldUntil) return text("BLOCKED", "#48f0c8");
            if (now < owner.dodgeUntil) return text("MISS!", "#ff2222");
            if (has(owner, "press_proven") && !owner.lastInput.sprint && Math.random() < 0.5) {
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
            clampToField(owner);
            this.badge(player, "bruiser", now);
        }
    }

    separatePlayers(now) {
        const list = [...this.players.values()];
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const a = list[i];
                const b = list[j];
                const dist = distance(a, b);
                if (dist >= PLAYER_SIZE || dist === 0) continue;
                const angle = Math.atan2(b.y - a.y, b.x - a.x);
                const overlap = PLAYER_SIZE - dist;

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

    updateBall(now, frames) {
        const ball = this.ball;
        const effects = this.ballEffects;

        if (now < effects.frozenUntil) ball.setVelocity(0, 0);

        if (now < effects.curveUntil) {
            const velocity = ball.body.velocity;
            velocity.rotate(effects.curveRate * frames / 60);
        }

        // Time hole: opponents' balls slow down inside the field.
        if (!this.ownerId) {
            for (const p of this.players.values()) {
                if (now < p.timeHoleUntil && this.lastShooterTeam !== p.team && distance(p, ball) < TIME_HOLE_RADIUS) {
                    ball.body.velocity.scale(Math.pow(0.92, frames));
                    break;
                }
            }
        }

        if (!this.ownerId && now >= this.canAttachAt && now >= effects.airUntil) {
            let closest = null;
            let closestMargin = 0;
            for (const player of this.players.values()) {
                let reach = CATCH_DISTANCE;
                if (now < player.shieldUntil) reach = SHIELD_CATCH_DISTANCE;
                else if (has(player, "intercept") && this.lastShooterTeam && this.lastShooterTeam !== player.team) {
                    reach = INTERCEPT_DISTANCE;
                }
                const margin = reach - distance(player, ball);
                if (margin > closestMargin) {
                    closest = player;
                    closestMargin = margin;
                }
            }
            if (closest) {
                const intercepted = this.lastShooterTeam && this.lastShooterTeam !== closest.team;
                this.setOwner(closest, now);
                if (intercepted && has(closest, "intercept")) this.badge(closest, "intercept", now);
                this.lastShooterTeam = closest.team;
            }
        }

        const owner = this.players.get(this.ownerId);
        if (owner) {
            const angle = owner.aim + this.dribbleOffset(owner, now);
            ball.setPosition(owner.x + Math.cos(angle) * BALL_OFFSET, owner.y + Math.sin(angle) * BALL_OFFSET);
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

    draw(now) {
        const me = this.players.get(this.opts.myId);
        for (const player of this.players.values()) {
            const flags = this.isHost ? this.playerFlags(player, now) : player.flags;
            const invisible = Boolean(flags & FLAG.invisible);
            // Invisible players are hidden from opponents and see-through for their own team.
            const hidden = invisible && me && me.team !== player.team;
            const alpha = hidden ? 0 : invisible ? 0.35 : (flags & FLAG.dodging ? 0.6 : 1);

            player.sprite.setPosition(player.x, player.y).setAlpha(alpha).setAngle(flags & FLAG.sliding ? 25 : 0);
            player.ring.setPosition(player.x, player.y).setAlpha(alpha)
                .setStrokeStyle(4, flags & FLAG.armed ? 0xffa21a : TEAM_COLORS[player.team], 1);
            player.halo.setPosition(player.x, player.y).setAlpha(alpha);
            player.label.setPosition(player.x, player.y - PLAYER_RADIUS - 8).setAlpha(hidden ? 0 : 1);
            player.shield.setPosition(player.x, player.y).setVisible(Boolean(flags & FLAG.shield) && !hidden);
            player.timeHole.setPosition(player.x, player.y).setVisible(Boolean(flags & FLAG.timeHole));
            if (!hidden) this.drawTrails(player, flags, alpha, now);
        }

        const air = this.isHost ? now < this.ballEffects.airUntil : this.ballAir;
        this.ball.setDisplaySize(BALL_SIZE * (air ? 1.4 : 1), BALL_SIZE * (air ? 1.4 : 1));

        // An invisible player's ball is invisible for the opponents too.
        const owner = this.players.get(this.ownerId);
        const ownerFlags = owner ? (this.isHost ? this.playerFlags(owner, now) : owner.flags) : 0;
        const ballHidden = owner && (ownerFlags & FLAG.invisible) && me && me.team !== owner.team;
        this.ball.setAlpha(ballHidden ? 0 : 1);

        const frozen = this.isHost ? now < this.ballEffects.frozenUntil : this.ballFrozen;
        if (frozen) this.ball.setTint(0x7fd3ff);
        else if (!this.goalPending && this.ball.tintTopLeft === 0x7fd3ff) this.ball.clearTint();
        this.iceShell.setVisible(frozen && !ballHidden).setPosition(this.ball.x, this.ball.y)
            .setRotation(now / 900);

        this.aimCursor.setVisible(Boolean(me));
        if (me) {
            this.aimCursor.setPosition(me.x + Math.cos(me.aim) * AIM_RADIUS, me.y + Math.sin(me.aim) * AIM_RADIUS);
        }
        this.animateSkins(now);
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

    // ------------------------------------------------------------------
    // Goals & effects
    // ------------------------------------------------------------------

    onGoal(team) {
        if (!this.isHost || this.goalPending || this.frozen) return;
        this.goalPending = true;
        this.ownerId = null;
        this.ball.setVelocity(0, 0);
        this.ball.body.enable = false;
        this.ball.setTint(0x00ffff);
        this.sendState(this.time.now);
        this.opts.send({ type: "goal", team, scorer: this.lastTouchId });
    }

    kickoff() {
        this.ownerId = null;
        this.lastTouchId = null;
        this.lastShooterTeam = null;
        this.goalPending = false;
        this.canAttachAt = 0;
        this.ballEffects = { airUntil: 0, frozenUntil: 0, curveRate: 0, curveUntil: 0 };
        this.ball.clearTint();
        this.ball.body.enable = true;
        this.ball.setPosition(WORLD_W / 2, WORLD_H / 2);
        this.ball.setVelocity(0, 0);

        for (const team of ["A", "B"]) {
            const members = [...this.players.values()].filter((p) => p.team === team);
            members.forEach((player, i) => {
                player.x = WORLD_W * (team === "A" ? 0.25 : 0.75);
                player.y = WORLD_H / 2 + (i - (members.length - 1) / 2) * 140;
                // Cooldowns carry over, running effects don't.
                const { tackleReadyAt, dribbleReadyAt } = player;
                this.resetPlayerEffects(player);
                Object.assign(player, { tackleReadyAt, dribbleReadyAt });
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
            const wave = this.add.circle(player.x, player.y, PLAYER_RADIUS, color, 0.25)
                .setStrokeStyle(3, color, 0.9).setDepth(1);
            this.tweens.add({ targets: wave, scale: 3, alpha: 0, duration: 450, onComplete: () => wave.destroy() });
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
            arcade: { gravity: { x: 0, y: 0 }, debug: false },
        },
        input: { keyboard: false }, // keys are handled by the scene with the player's keybinds
        scene,
    });

    return {
        handle: (msg) => scene.handle(msg),
        freeze: () => {
            scene.frozen = true;
        },
        destroy: () => {
            scene.removeInputListeners?.();
            game.destroy(true);
        },
    };
}

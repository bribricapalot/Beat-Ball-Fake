"""Big Leagues server: serves the web client, accounts API and lobbies over a WebSocket.

The host of a running match simulates the physics in their browser and sends the
world state; the server relays it, owns the score and the match clock, and
manages the lobbies. Accounts and goal statistics live in SQLite (see db.py).
"""
import asyncio
import logging
import mimetypes
import re
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import auth, captcha, db, loadout, skins

ROOT_DIR = Path(__file__).resolve().parent.parent
CLIENT_DIR = ROOT_DIR / "client"
log = logging.getLogger("uvicorn.error")

# Windows doesn't always know these, and would serve them as application/octet-stream.
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("video/mp4", ".mp4")
mimetypes.add_type("video/webm", ".webm")

MATCH_SECONDS = 180
GOAL_PAUSE_SECONDS = 2
COUNTDOWN_FROM = 3
READY_TIMEOUT_SECONDS = 10  # start the countdown even if someone's game never finishes loading
MAX_FREEZE_SECONDS = 20     # longest ability clip (Scopophobia, Infinity) that may stop the clock
MAX_TEAM_SIZE = 10  # players per team: 1v1 … 10v10
TEAMS = ("A", "B")
TEAM_NAMES = {"A": "Red", "B": "Blue"}
MAX_LOBBY_NAME_LENGTH = 24
MAX_LOBBY_PASSWORD_LENGTH = 32


def other_team(team: str) -> str:
    return "B" if team == "A" else "A"


@asynccontextmanager
async def lifespan(_app):
    try:
        await run_in_threadpool(db.init)
        log.info("Database ready.")
    except Exception as error:
        # Keep serving the page so players see a clear message instead of a dead server.
        log.error("Could not open the database: %s – login is disabled.", error)
    yield


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def no_stale_files(request: Request, call_next):
    # Browsers must revalidate (cheap via ETag) so nobody plays with an outdated game.js after an update.
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


def clean_text(value, max_length, fallback):
    if not isinstance(value, str):
        return fallback
    value = " ".join(value.split())[:max_length]
    return value or fallback


class Client:
    def __init__(self, websocket: WebSocket):
        self.websocket = websocket
        self.id = secrets.token_hex(4)
        self.name = "Player"
        self.user_id: int | None = None  # account id, set after login
        self.skin = "default"
        self.ability = loadout.DEFAULT_ABILITY
        self.playstyles: list[str] = []
        self.ping = 0  # last measured round trip to the server in ms
        self.lobby: "Lobby | None" = None
        # Outgoing messages go through a queue so concurrent senders never interleave
        # and a slow client cannot stall the relay for everyone else.
        self.outbox: asyncio.Queue = asyncio.Queue(maxsize=256)
        # High-frequency messages (world state, player inputs) are not queued: only the
        # newest one per sender is kept. Otherwise a slow connection builds up a backlog of
        # outdated states and the delay grows to many seconds.
        self.latest: dict[str, dict] = {}
        self.wakeup = asyncio.Event()

    def send(self, message: dict):
        kind = message.get("type")
        if kind == "state" or kind == "input":
            self.latest[f"{kind}:{message.get('from', '')}"] = message
            self.wakeup.set()
            return
        try:
            self.outbox.put_nowait(message)
            self.wakeup.set()
        except asyncio.QueueFull:
            pass  # client is not keeping up; drop rather than block the server

    async def writer(self):
        while True:
            await self.wakeup.wait()
            self.wakeup.clear()
            # Important messages (goals, clock, pong, …) first, then the newest state/inputs.
            while not self.outbox.empty():
                await self.websocket.send_json(self.outbox.get_nowait())
            while self.latest:
                _, message = self.latest.popitem()
                await self.websocket.send_json(message)

    def load_profile(self, user):
        self.name = user["username"]
        self.skin = user["skin"]
        self.ability = user["ability"] if user["ability"] in loadout.ABILITIES else loadout.DEFAULT_ABILITY
        self.playstyles = loadout.parse_playstyles(user["playstyles"])

    def profile(self):
        return {
            "id": self.id,
            "name": self.name,
            "skin": self.skin_url,
            "ability": self.ability,
            "playstyles": self.playstyles,
        }

    @property
    def skin_url(self) -> str | None:
        return skins.url_for(self.skin, self.user_id)


class Lobby:
    def __init__(self, name: str, team_size: int, host: Client, password: str):
        self.id = secrets.token_hex(2).upper()
        self.name = name
        self.password = password
        self.team_size = team_size
        self.host_id = host.id
        self.players: dict[str, Client] = {}
        self.teams: dict[str, str] = {}
        self.in_match: set[str] = set()  # who is still playing the running match
        self.ready: set[str] = set()     # who has finished loading the match
        self.countdown_started = False
        self.frozen_until = 0.0          # clock stops while an ability clip plays
        self.status = "waiting"  # or "playing"
        self.score = {"A": 0, "B": 0}
        self.remaining = MATCH_SECONDS
        self.paused = False
        self.match_id = 0  # bumped per match so stale timers from an old match do nothing

    def team_count(self, team: str) -> int:
        return sum(1 for t in self.teams.values() if t == team)

    def free_team(self):
        counts = {team: self.team_count(team) for team in TEAMS}
        team = min(TEAMS, key=lambda t: counts[t])
        return team if counts[team] < self.team_size else None

    def can_start(self) -> bool:
        return all(self.team_count(team) >= 1 for team in TEAMS)

    def match_team_count(self, team: str) -> int:
        return sum(1 for cid in self.in_match if self.teams.get(cid) == team)

    def player_list(self):
        return [{**c.profile(), "team": self.teams[c.id]} for c in self.players.values()]

    def summary(self):
        return {
            "id": self.id,
            "name": self.name,
            "teamSize": self.team_size,
            "players": len(self.players),
            "capacity": self.team_size * 2,
            "status": self.status,
            "hasPassword": bool(self.password),
            "hostPing": host.ping if (host := self.players.get(self.host_id)) else 0,
        }

    def detail(self):
        return {
            **self.summary(),
            "hostId": self.host_id,
            "playerList": self.player_list(),
            "canStart": self.can_start(),
        }

    def broadcast(self, message: dict, exclude: Client | None = None):
        for client in self.players.values():
            if client is not exclude:
                client.send(message)

    def broadcast_match(self, message: dict, exclude: Client | None = None):
        """Only to players still in the running match (not those who forfeited)."""
        for cid in self.in_match:
            client = self.players.get(cid)
            if client and client is not exclude:
                client.send(message)


class Hub:
    def __init__(self):
        self.clients: dict[str, Client] = {}
        self.lobbies: dict[str, Lobby] = {}

    # ---------- lobby list ----------

    def lobby_list(self):
        return [lobby.summary() for lobby in self.lobbies.values()]

    def lobbies_message(self):
        return {"type": "lobbies", "lobbies": self.lobby_list(), "online": len(self.clients)}

    def publish_lobby_list(self):
        message = self.lobbies_message()
        for client in self.clients.values():
            if client.lobby is None:
                client.send(message)

    def publish_lobby(self, lobby: Lobby):
        lobby.broadcast({"type": "lobby", "lobby": lobby.detail()})

    # ---------- joining / leaving ----------

    def join(self, client: Client, lobby: Lobby, team: str):
        lobby.players[client.id] = client
        lobby.teams[client.id] = team
        client.lobby = lobby
        self.publish_lobby(lobby)
        self.publish_lobby_list()

    def leave(self, client: Client):
        lobby = client.lobby
        if lobby is None:
            return
        if lobby.status == "playing" and client.id in lobby.in_match:
            self.quit_match(lobby, client, f"{client.name} left the game.")
        client.lobby = None
        lobby.players.pop(client.id, None)
        lobby.teams.pop(client.id, None)

        if not lobby.players:
            lobby.match_id += 1
            del self.lobbies[lobby.id]
        else:
            if lobby.host_id == client.id:
                lobby.host_id = next(iter(lobby.players))
            self.publish_lobby(lobby)

        client.send({"type": "left_lobby"})
        self.publish_lobby_list()

    # ---------- match flow ----------

    def start_match(self, lobby: Lobby):
        lobby.status = "playing"
        lobby.score = {"A": 0, "B": 0}
        lobby.remaining = MATCH_SECONDS
        lobby.paused = True  # frozen until the countdown reaches 0
        lobby.match_id += 1
        lobby.in_match = set(lobby.players)
        lobby.ready = set()
        lobby.countdown_started = False
        lobby.broadcast_match({
            "type": "game_start",
            "hostId": lobby.host_id,
            "players": lobby.player_list(),
            "remaining": lobby.remaining,
            "teamSize": lobby.team_size,
        })
        self.publish_lobby(lobby)
        self.publish_lobby_list()
        asyncio.create_task(self.ready_timeout(lobby, lobby.match_id))

    def maybe_start_countdown(self, lobby: Lobby):
        """Starts the countdown once everyone still in the match has loaded the game."""
        if lobby.status == "playing" and not lobby.countdown_started and lobby.in_match <= lobby.ready:
            lobby.countdown_started = True
            asyncio.create_task(self.run_countdown(lobby, lobby.match_id))

    async def ready_timeout(self, lobby: Lobby, match_id: int):
        await asyncio.sleep(READY_TIMEOUT_SECONDS)
        if lobby.match_id == match_id and lobby.status == "playing" and not lobby.countdown_started:
            lobby.countdown_started = True
            await self.run_countdown(lobby, match_id)

    async def run_countdown(self, lobby: Lobby, match_id: int):
        for value in range(COUNTDOWN_FROM, -1, -1):
            if lobby.match_id != match_id:
                return
            lobby.broadcast_match({"type": "countdown", "value": value})
            if value:
                await asyncio.sleep(1)
        lobby.paused = False
        asyncio.create_task(self.run_clock(lobby, match_id))

    def end_match(self, lobby: Lobby, reason: str = "", forfeited: str | None = None):
        lobby.status = "waiting"
        lobby.match_id += 1
        lobby.broadcast_match({
            "type": "game_over",
            "scoreA": lobby.score["A"],
            "scoreB": lobby.score["B"],
            "reason": reason,
            "forfeitedTeam": forfeited,
        })
        lobby.in_match = set()
        self.publish_lobby(lobby)
        self.publish_lobby_list()

    def quit_match(self, lobby: Lobby, client: Client, reason: str):
        """A player forfeits or disconnects during a match."""
        lobby.in_match.discard(client.id)
        team = lobby.teams.get(client.id)
        if client.id == lobby.host_id:
            # The host ran the simulation, so the match cannot continue.
            self.end_match(lobby, reason=f"{reason} (host)", forfeited=team)
        elif team and lobby.match_team_count(team) == 0:
            self.end_match(lobby, reason=f"Team {TEAM_NAMES[team]} forfeited.", forfeited=team)
        else:
            lobby.broadcast_match({"type": "player_left", "id": client.id, "name": client.name})
            self.maybe_start_countdown(lobby)  # don't keep waiting for someone who left

    async def run_clock(self, lobby: Lobby, match_id: int):
        while True:
            await asyncio.sleep(1)
            if lobby.match_id != match_id:
                return
            if lobby.paused or time.monotonic() < lobby.frozen_until:
                continue
            lobby.remaining -= 1
            lobby.broadcast_match({"type": "clock", "remaining": lobby.remaining})
            if lobby.remaining <= 0:
                self.end_match(lobby)
                return

    async def resume_after_goal(self, lobby: Lobby, match_id: int):
        await asyncio.sleep(GOAL_PAUSE_SECONDS)
        if lobby.match_id != match_id:
            return
        lobby.paused = False
        lobby.broadcast_match({"type": "kickoff"})

    async def reload_profile(self, client: Client):
        """Called after name, skin or loadout were changed over the HTTP API."""
        try:
            user = await run_in_threadpool(db.get_user_by_id, client.user_id)
        except Exception as error:
            log.error("Could not reload profile: %s", error)
            return
        if user is None:
            return
        client.load_profile(user)
        client.send({"type": "profile", **client.profile()})
        if client.lobby and client.lobby.status == "waiting":
            self.publish_lobby(client.lobby)

    # ---------- message handling ----------

    def handle(self, client: Client, data: dict):
        kind = data.get("type")
        lobby = client.lobby
        playing = lobby is not None and lobby.status == "playing" and client.id in lobby.in_match

        # Hot path first: in-game traffic.
        if kind == "input":
            if playing and client.id != lobby.host_id:
                host = lobby.players.get(lobby.host_id)
                if host:
                    host.send({**data, "from": client.id})
            return

        if kind in ("state", "fx"):
            if playing and client.id == lobby.host_id:
                lobby.broadcast_match(data, exclude=client)
            return

        if kind == "goal":
            team = data.get("team")
            if playing and client.id == lobby.host_id and not lobby.paused and team in TEAMS:
                lobby.score[team] += 1
                lobby.paused = True
                scorer = lobby.players.get(data.get("scorer"))
                if scorer and scorer.id not in lobby.in_match:
                    scorer = None
                scorer_team = lobby.teams.get(scorer.id) if scorer else None
                own_goal = scorer_team is not None and scorer_team != team
                if scorer and scorer.user_id and not own_goal:
                    # Own goals don't count for the leaderboard.
                    asyncio.create_task(record_goal(scorer.user_id))
                # Assist: the teammate who had the ball right before the scorer.
                assist = lobby.players.get(data.get("assist"))
                if (not scorer or own_goal or not assist or assist is scorer
                        or assist.id not in lobby.in_match or lobby.teams.get(assist.id) != scorer_team):
                    assist = None
                if assist and assist.user_id:
                    asyncio.create_task(record_assist(assist.user_id))
                lobby.broadcast_match({
                    "type": "goal",
                    "team": team,
                    "scorerName": scorer.name if scorer else None,
                    "assistName": assist.name if assist else None,
                    "ownGoal": own_goal,
                    "scoreA": lobby.score["A"],
                    "scoreB": lobby.score["B"],
                })
                asyncio.create_task(self.resume_after_goal(lobby, lobby.match_id))
            return

        if kind == "freeze":
            # The host plays an ability clip; the match clock waits for it.
            ms = data.get("ms")
            if playing and client.id == lobby.host_id and isinstance(ms, (int, float)) and 0 < ms:
                lobby.frozen_until = time.monotonic() + min(ms / 1000, MAX_FREEZE_SECONDS)
            return

        if kind == "bonus_goals":
            # Infinity: the user's team gets goals (they don't count for the leaderboard).
            team, count = data.get("team"), data.get("count")
            if playing and client.id == lobby.host_id and team in TEAMS and count in (10,):
                lobby.score[team] += count
                scorer = lobby.players.get(data.get("by"))
                lobby.broadcast_match({
                    "type": "bonus",
                    "team": team,
                    "count": count,
                    "name": scorer.name if scorer else None,
                    "scoreA": lobby.score["A"],
                    "scoreB": lobby.score["B"],
                })
            return

        if kind == "ready":
            if playing:
                lobby.ready.add(client.id)
                self.maybe_start_countdown(lobby)
            return

        if kind == "forfeit":
            if playing:
                self.quit_match(lobby, client, f"{client.name} forfeited.")
                client.send({"type": "forfeited"})
                self.publish_lobby(lobby)
            return

        if kind == "ping":
            rtt = data.get("rtt")
            if isinstance(rtt, (int, float)) and 0 <= rtt < 10_000:
                client.ping = round(rtt)
            client.send({"type": "pong", "t": data.get("t")})
            return

        if kind == "list_lobbies":
            client.send(self.lobbies_message())
            return

        if kind == "reload_profile":
            asyncio.create_task(self.reload_profile(client))
            return

        if kind == "create_lobby":
            team_size = data.get("teamSize")
            if not isinstance(team_size, int) or isinstance(team_size, bool) or not 1 <= team_size <= MAX_TEAM_SIZE:
                return client.send({"type": "error", "message": f"Team size must be between 1 and {MAX_TEAM_SIZE}."})
            self.leave(client)
            name = clean_text(data.get("name"), MAX_LOBBY_NAME_LENGTH, f"{client.name}'s room")
            password = data.get("password")
            password = password[:MAX_LOBBY_PASSWORD_LENGTH] if isinstance(password, str) else ""
            new_lobby = Lobby(name, team_size, client, password)
            self.lobbies[new_lobby.id] = new_lobby
            self.join(client, new_lobby, "A")
            return

        if kind == "join_lobby":
            target = self.lobbies.get(data.get("lobbyId"))
            if target is None:
                return client.send({"type": "error", "message": "This room doesn't exist anymore."})
            if target is lobby:
                return
            if target.password:
                given = data.get("password")
                if not isinstance(given, str) or not secrets.compare_digest(given.encode(), target.password.encode()):
                    return client.send({"type": "error", "message": "Wrong room password.", "code": "bad_password"})
            if target.status != "waiting":
                return client.send({"type": "error", "message": "A match is running in this room."})
            team = target.free_team()
            if team is None:
                return client.send({"type": "error", "message": "This room is full."})
            self.leave(client)
            self.join(client, target, team)
            return

        if kind == "kick":
            target = lobby.players.get(data.get("id")) if lobby else None
            if target and client.id == lobby.host_id and target is not client:
                target.send({"type": "kicked", "lobbyName": lobby.name})
                self.leave(target)
            return

        if kind == "leave_lobby":
            self.leave(client)
            return

        if kind == "switch_team":
            team = data.get("team")
            if (lobby and lobby.status == "waiting" and team in TEAMS
                    and lobby.teams[client.id] != team
                    and lobby.team_count(team) < lobby.team_size):
                lobby.teams[client.id] = team
                self.publish_lobby(lobby)
            return

        if kind == "start_game":
            if lobby and lobby.status == "waiting" and client.id == lobby.host_id:
                if not lobby.can_start():
                    return client.send({"type": "error", "message": "Each team needs at least one player."})
                self.start_match(lobby)
            return


hub = Hub()


async def record_goal(user_id: int):
    try:
        await run_in_threadpool(db.add_goal, user_id)
    except Exception as error:
        log.error("Could not save goal: %s", error)


async def record_assist(user_id: int):
    try:
        await run_in_threadpool(db.add_assist, user_id)
    except Exception as error:
        log.error("Could not save assist: %s", error)


# ---------------------------------------------------------------------------
# HTTP API: accounts, captcha, leaderboard, skins, loadout
# ---------------------------------------------------------------------------

class Credentials(BaseModel):
    username: str
    password: str


class Registration(Credentials):
    captchaId: str
    captcha: str


class TokenBody(BaseModel):
    token: str


class SkinChoice(TokenBody):
    skin: str


class SkinUpload(TokenBody):
    image: str  # data URL


class NameChange(TokenBody):
    username: str


class PasswordChange(TokenBody):
    current: str
    new: str


class LoadoutChoice(TokenBody):
    ability: str
    playstyles: list[str]


def require_db():
    if not db.is_ready():
        raise HTTPException(503, "The database is not available. Please check the server log.")


async def run_auth(func, *args):
    require_db()
    try:
        # Argon2 hashing is deliberately slow, so keep it off the event loop.
        return await run_in_threadpool(func, *args)
    except auth.AuthError as error:
        raise HTTPException(error.status, error.message) from None


async def user_from_token(token: str):
    require_db()
    user = await run_in_threadpool(db.get_user_by_token, token)
    if user is None:
        raise HTTPException(401, "Please log in again.")
    return user


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "?"


@app.get("/api/status")
async def get_status():
    return {"status": "online", "database": db.is_ready(), "clients": len(hub.clients), "lobbies": hub.lobby_list()}


@app.get("/api/captcha")
async def new_captcha():
    return captcha.create()


@app.post("/api/register")
async def register(body: Registration):
    if not captcha.verify(body.captchaId, body.captcha):
        raise HTTPException(400, "Wrong security code. Please enter the new one.")
    return await run_auth(auth.register, body.username.strip(), body.password)


@app.post("/api/login")
async def login(body: Credentials, request: Request):
    return await run_auth(auth.login, body.username.strip(), body.password, client_ip(request))


@app.post("/api/logout")
async def logout(body: TokenBody):
    if db.is_ready():
        await run_in_threadpool(db.delete_session, body.token)
    return {"ok": True}


@app.post("/api/account/name")
async def change_name(body: NameChange):
    user = await user_from_token(body.token)
    username = await run_auth(auth.change_name, user["id"], body.username.strip())
    return {"username": username}


@app.post("/api/account/password")
async def change_password(body: PasswordChange, request: Request):
    user = await user_from_token(body.token)
    await run_auth(auth.change_password, user["id"], body.token, body.current, body.new, client_ip(request))
    return {"ok": True}


@app.get("/api/leaderboard")
async def get_leaderboard():
    require_db()
    return await run_in_threadpool(db.leaderboard)


@app.post("/api/skin")
async def choose_skin(body: SkinChoice):
    user = await user_from_token(body.token)
    if not skins.is_valid(body.skin) or body.skin.startswith("custom:"):
        raise HTTPException(400, "Unknown skin.")
    await run_in_threadpool(db.set_skin, user["id"], body.skin)
    return {"skin": skins.url_for(body.skin, user["id"])}


@app.post("/api/skin/upload")
async def upload_skin(body: SkinUpload):
    user = await user_from_token(body.token)
    try:
        skin = await run_in_threadpool(skins.save_upload, user["id"], body.image)
    except skins.SkinError as error:
        raise HTTPException(400, str(error)) from None
    await run_in_threadpool(db.set_skin, user["id"], skin)
    return {"skin": skins.url_for(skin, user["id"])}


@app.post("/api/loadout")
async def choose_loadout(body: LoadoutChoice):
    user = await user_from_token(body.token)
    error = loadout.validate(body.ability, body.playstyles)
    if error:
        raise HTTPException(400, error)
    await run_in_threadpool(db.set_loadout, user["id"], body.ability, body.playstyles)
    return {"ok": True}


ICON_EXTENSIONS = {".png", ".webp", ".svg", ".gif", ".jpg", ".jpeg"}
CLIP_EXTENSIONS = {".mp4", ".webm", ".mov", ".ogg"}


@app.get("/api/icons")
async def get_icons():
    """Custom ability / PlayStyle icons and ability clips dropped into client/assets/."""
    result = {}
    for folder, valid in (("abilities", loadout.ABILITIES), ("playstyles", loadout.PLAYSTYLES)):
        icons = {}
        directory = CLIENT_DIR / "assets" / folder
        if directory.is_dir():
            for file in directory.iterdir():
                if file.stem in valid and file.suffix.lower() in ICON_EXTENSIONS:
                    icons[file.stem] = f"assets/{folder}/{file.name}"
        result[folder] = icons
    clips = {}
    directory = CLIENT_DIR / "assets" / "clips"
    if directory.is_dir():
        for file in directory.iterdir():
            key = re.sub(r"[^a-z]", "", file.stem.lower())
            for clip in loadout.CLIPS:
                if key == re.sub(r"[^a-z]", "", clip) and file.suffix.lower() in CLIP_EXTENSIONS:
                    clips[clip] = f"assets/clips/{file.name}"
    result["clips"] = clips
    return result


@app.get("/skins/{filename}")
async def get_custom_skin(filename: str):
    # Only "<user id>.png" / "<user id>.gif" – nothing else can be read from disk.
    if not re.fullmatch(r"\d+\.(png|gif)", filename) or not (skins.SKIN_DIR / filename).is_file():
        raise HTTPException(404)
    return FileResponse(skins.SKIN_DIR / filename)


# ---------------------------------------------------------------------------
# WebSocket: lobbies and matches (login required)
# ---------------------------------------------------------------------------

async def authenticate(websocket: WebSocket):
    """The first message must be {"type": "auth", "token": ...}."""
    try:
        data = await asyncio.wait_for(websocket.receive_json(), timeout=10)
    except (asyncio.TimeoutError, ValueError):
        return None
    token = data.get("token") if isinstance(data, dict) and data.get("type") == "auth" else None
    if not isinstance(token, str) or not db.is_ready():
        return None
    try:
        return await run_in_threadpool(db.get_user_by_token, token)
    except Exception as error:
        log.error("Login check failed: %s", error)
        return None


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        user = await authenticate(websocket)
    except WebSocketDisconnect:
        return
    if user is None:
        await websocket.send_json({"type": "auth_failed"})
        await websocket.close()
        return

    client = Client(websocket)
    client.user_id = user["id"]
    client.load_profile(user)
    hub.clients[client.id] = client
    writer = asyncio.create_task(client.writer())
    client.send({"type": "welcome", **client.profile()})
    client.send(hub.lobbies_message())

    try:
        while True:
            data = await websocket.receive_json()
            if isinstance(data, dict):
                hub.handle(client, data)
    except (WebSocketDisconnect, ValueError):
        pass
    finally:
        writer.cancel()
        hub.leave(client)
        hub.clients.pop(client.id, None)


# Registered last so /ws and /api win over the static files.
app.mount("/", StaticFiles(directory=CLIENT_DIR, html=True), name="client")

"""SQLite storage: users, login sessions and goal statistics.

Everything lives in one file (data/big_leagues.db), created automatically on
startup. Each call opens its own short-lived connection, so the functions are
safe to run from FastAPI's thread pool.
"""
import hashlib
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "big_leagues.db"
SESSION_SECONDS = 30 * 24 * 3600

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    goals INTEGER NOT NULL DEFAULT 0,
    assists INTEGER NOT NULL DEFAULT 0,
    skin TEXT NOT NULL DEFAULT 'default',
    ability TEXT NOT NULL DEFAULT 'dash',
    playstyles TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
);
"""

MIGRATIONS = {
    "skin": "TEXT NOT NULL DEFAULT 'default'",
    "ability": "TEXT NOT NULL DEFAULT 'dash'",
    "playstyles": "TEXT NOT NULL DEFAULT ''",
    "assists": "INTEGER NOT NULL DEFAULT 0",
}

_ready = False


class DuplicateUsername(Exception):
    pass


def init():
    global _ready
    DB_PATH.parent.mkdir(exist_ok=True)
    with cursor() as cur:
        cur.execute("PRAGMA journal_mode=WAL")  # readers don't block the writer
        cur.executescript(SCHEMA)
        # Databases created by older versions get the newer columns.
        columns = {row["name"] for row in cur.execute("PRAGMA table_info(users)")}
        for column, definition in MIGRATIONS.items():
            if column not in columns:
                cur.execute(f"ALTER TABLE users ADD COLUMN {column} {definition}")
    _ready = True


def is_ready() -> bool:
    return _ready


@contextmanager
def cursor():
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection.cursor()
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def _hash_token(token: str) -> str:
    # Only a hash of the token is stored, so a leaked database can't be used to log in.
    return hashlib.sha256(token.encode()).hexdigest()


# ---------- users ----------

def create_user(username: str, password_hash: str) -> int:
    try:
        with cursor() as cur:
            cur.execute(
                "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
                (username, password_hash, int(time.time())),
            )
            return cur.lastrowid
    except sqlite3.IntegrityError:
        raise DuplicateUsername() from None


def get_user_by_name(username: str):
    with cursor() as cur:
        cur.execute("SELECT id, username, password_hash FROM users WHERE username = ?", (username,))
        return cur.fetchone()


def get_user_by_id(user_id: int):
    with cursor() as cur:
        cur.execute(
            "SELECT id, username, password_hash, skin, ability, playstyles FROM users WHERE id = ?",
            (user_id,),
        )
        return cur.fetchone()


def update_password_hash(user_id: int, password_hash: str):
    with cursor() as cur:
        cur.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id))


def rename_user(user_id: int, username: str):
    try:
        with cursor() as cur:
            cur.execute("UPDATE users SET username = ? WHERE id = ?", (username, user_id))
    except sqlite3.IntegrityError:
        raise DuplicateUsername() from None


def delete_other_sessions(user_id: int, keep_token: str):
    with cursor() as cur:
        cur.execute(
            "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
            (user_id, _hash_token(keep_token)),
        )


def set_loadout(user_id: int, ability: str, playstyles: list[str]):
    with cursor() as cur:
        cur.execute(
            "UPDATE users SET ability = ?, playstyles = ? WHERE id = ?",
            (ability, ",".join(playstyles), user_id),
        )


# ---------- sessions ----------

def create_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    with cursor() as cur:
        cur.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        cur.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (_hash_token(token), user_id, now + SESSION_SECONDS),
        )
    return token


def get_user_by_token(token: str):
    with cursor() as cur:
        cur.execute(
            "SELECT u.id, u.username, u.skin, u.ability, u.playstyles FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token_hash = ? AND s.expires_at > ?",
            (_hash_token(token), int(time.time())),
        )
        return cur.fetchone()


def delete_session(token: str):
    with cursor() as cur:
        cur.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash_token(token),))


# ---------- skins ----------

def get_skin(user_id: int) -> str:
    with cursor() as cur:
        cur.execute("SELECT skin FROM users WHERE id = ?", (user_id,))
        row = cur.fetchone()
        return row["skin"] if row else "default"


def set_skin(user_id: int, skin: str):
    with cursor() as cur:
        cur.execute("UPDATE users SET skin = ? WHERE id = ?", (skin, user_id))


# ---------- stats ----------

def add_goal(user_id: int):
    with cursor() as cur:
        cur.execute("UPDATE users SET goals = goals + 1 WHERE id = ?", (user_id,))


def add_assist(user_id: int):
    with cursor() as cur:
        cur.execute("UPDATE users SET assists = assists + 1 WHERE id = ?", (user_id,))


def leaderboard(limit: int = 20):
    with cursor() as cur:
        cur.execute(
            "SELECT username, goals, assists FROM users WHERE goals > 0 OR assists > 0 "
            "ORDER BY goals DESC, assists DESC, username LIMIT ?",
            (limit,),
        )
        return [dict(row) for row in cur.fetchall()]

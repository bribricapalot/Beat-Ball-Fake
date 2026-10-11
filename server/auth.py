"""Registration / login: input rules, Argon2 password hashing, brute-force brake."""
import re
import time
from collections import defaultdict, deque

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from . import db

USERNAME_PATTERN = re.compile(r"[A-Za-z0-9_]{3,16}")
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 128

# At most this many failed logins per IP address within the window.
MAX_FAILED_LOGINS = 10
FAILED_LOGIN_WINDOW_SECONDS = 300

_hasher = PasswordHasher()
_dummy_hash = _hasher.hash("timing-equaliser")
_failed_logins: dict[str, deque] = defaultdict(deque)


class AuthError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def check_username(username: str):
    if not USERNAME_PATTERN.fullmatch(username):
        raise AuthError("Names must be 3–16 characters (letters, numbers, _).")


def check_password(password: str):
    if not MIN_PASSWORD_LENGTH <= len(password) <= MAX_PASSWORD_LENGTH:
        raise AuthError(f"Passwords need at least {MIN_PASSWORD_LENGTH} characters.")


def register(username: str, password: str) -> dict:
    check_username(username)
    check_password(password)
    try:
        user_id = db.create_user(username, _hasher.hash(password))
    except db.DuplicateUsername:
        raise AuthError("That name is already taken.") from None
    return {"token": db.create_session(user_id), "username": username}


def _too_many_failures(ip: str) -> bool:
    attempts = _failed_logins[ip]
    cutoff = time.time() - FAILED_LOGIN_WINDOW_SECONDS
    while attempts and attempts[0] < cutoff:
        attempts.popleft()
    return len(attempts) >= MAX_FAILED_LOGINS


def login(username: str, password: str, ip: str) -> dict:
    if _too_many_failures(ip):
        raise AuthError("Too many failed attempts. Please wait a few minutes.", status=429)

    user = db.get_user_by_name(username) if USERNAME_PATTERN.fullmatch(username) else None
    try:
        # Verify against a dummy hash for unknown names so both cases take equally long.
        _hasher.verify(user["password_hash"] if user else _dummy_hash, password)
        if user is None:
            raise VerificationError()
    except (VerificationError, InvalidHashError):
        _failed_logins[ip].append(time.time())
        raise AuthError("Wrong name or password.", status=401) from None

    if _hasher.check_needs_rehash(user["password_hash"]):
        db.update_password_hash(user["id"], _hasher.hash(password))
    _failed_logins.pop(ip, None)
    return {"token": db.create_session(user["id"]), "username": user["username"]}


def change_name(user_id: int, username: str) -> str:
    check_username(username)
    try:
        db.rename_user(user_id, username)
    except db.DuplicateUsername:
        raise AuthError("That name is already taken.") from None
    return username


def change_password(user_id: int, token: str, current: str, new: str, ip: str):
    if _too_many_failures(ip):
        raise AuthError("Too many failed attempts. Please wait a few minutes.", status=429)
    user = db.get_user_by_id(user_id)
    try:
        _hasher.verify(user["password_hash"], current)
    except (VerificationError, InvalidHashError):
        _failed_logins[ip].append(time.time())
        raise AuthError("Your current password is wrong.", status=401) from None
    check_password(new)
    db.update_password_hash(user_id, _hasher.hash(new))
    # Log out every other device that might know the old password.
    db.delete_other_sessions(user_id, token)

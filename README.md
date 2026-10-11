# Big Leagues

A 2D browser football game for 1 vs 1, 2 vs 2 or 3 vs 3 – with accounts, rooms, skins,
abilities, PlayStyles and a top-scorer leaderboard.

> **School project – for educational purposes only, non-commercial.**
> The abilities are inspired by *Blade Ball* (Roblox) and the PlayStyles by *EA SPORTS FC 26*.
> Their names and icons belong to their respective owners. This project is not affiliated with,
> endorsed or sponsored by them.

## Running it

Requirement: **Python 3.10+**. No Node.js and no database server needed.

**Windows:** double-click `start.bat`.

**Manually / macOS / Linux:**

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # macOS/Linux: .venv/bin/python
.venv/Scripts/python -m uvicorn server.app:app --port 8000
```

Then open **http://localhost:8000**. To test alone, open the page in two tabs.

> Don't open the page as a file or through an IDE preview – the Python server serves it,
> otherwise images and the WebSocket can't be found.

### With friends on the same Wi-Fi

```bash
.venv/Scripts/python -m uvicorn server.app:app --host 0.0.0.0 --port 8000
```

Others open `http://<your-IP>:8000` (find it with `ipconfig`). Allow the Windows firewall prompt.

## How it works

1. Press **Play**, then log in or register (with a captcha).
2. In the **Room list**, select a room and press **Join Room** (or double-click it), or **Create Room**
   (name, mode 1v1 / 2v2 / 3v3, optional password).
   - Click your **name** to change your name or password.
   - **Abilities**: equip one ability and up to two PlayStyles.
   - **Change Skin**: pick a country flag or upload your own image / GIF.
   - **Settings**: change your keybinds.
3. Pick a team (Red or Blue). The host starts the match once each team has a player.
4. A match lasts 3 minutes. In the match, the gear (top right) or **Esc** opens the settings,
   where you can also **forfeit** and go back to the room.

## Default controls (can be changed in Settings)

| Key | Action |
|---|---|
| W / A / S / D | Move |
| Shift | Sprint |
| Mouse | Aim |
| F or left click | Shoot |
| E | Slide tackle – steals the ball (3 s cooldown) |
| Q | 180° spin with the ball – dodges a tackle (3 s cooldown) |
| R | Use your ability |

Red attacks to the right, Blue to the left.

## Abilities & PlayStyles

- **Abilities** are inspired by Blade Ball. 15 of them fit a top-down football game (Dash, Blink,
  Shadow Step, Ninja Dash, Invisibility, Freeze, Forcefield, Pull, Telekinesis, Raging Deflection,
  Rapture, Swap, Hell Hook, Force, Time Hole). The icons are our own, not Blade Ball's artwork.
- **PlayStyles** are inspired by EA FC 26 (silver/normal versions only). 14 of them fit the game.
  Like in FC, a PlayStyle's badge pops up above the player at the moment it kicks in.
- Names, effects and cooldowns are listed in `client/js/loadout.js`.

## Project structure

```
client/             Web page (served by the server)
  index.html        Menus + match HUD
  css/style.css
  js/main.js        Menus, room list, dialogs, settings
  js/net.js         WebSocket connection
  js/game.js        Phaser match (physics, abilities, PlayStyles, drawing)
  js/loadout.js     Abilities, PlayStyles and keybinds
  assets/           Images
server/app.py       FastAPI: serves client/, account API, rooms, score, clock
server/db.py        SQLite: accounts, sessions, goals, skins, loadouts (data/big_leagues.db)
server/auth.py      Register/login, name & password changes, Argon2 hashing, login brake
server/captcha.py   Home-made image captcha
server/skins.py     Skins: flags (flag-icons via jsDelivr) and uploaded images/GIFs (data/skins/)
server/loadout.py   Valid ability and PlayStyle ids
src/db_webhook/     Old MySQL experiment (not used)
Database/           Old SQL schema (not used)
```

### Accounts & security

- Passwords are stored hashed with **Argon2**, never in plain text.
- 10 failed logins per IP address lock that IP out for 5 minutes.
- Login tokens are only stored as SHA-256 hashes. Changing your password logs out your other devices.
- `data/` is in `.gitignore` and never ends up on GitHub. To reset everything, delete it while the server is off.
- A goal counts for the player who touched the ball last. Own goals don't count.

### Multiplayer model

- The server manages rooms and teams and owns the **score and clock**.
- The **room host's browser** simulates the match (players, ball, abilities) and sends the state
  about 30 times per second through the server to everyone else.
- The other players only send their inputs (keys, aim, cursor) and draw the state they receive.
- If the host leaves a running match, it ends and another player becomes the room's host.

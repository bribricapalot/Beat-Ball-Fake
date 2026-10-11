Drop PlayStyle icons here (png, webp, jpg, gif). The file name just needs to
contain the name, e.g. "Hell Hook.jpeg" or "finesseShot.png".

start.bat prepares them automatically: background removed, renamed to <id>.png,
original moved to originals/. PlayStyle badges are turned into silver diamonds automatically.
Rebuild all from the originals:
  .venv\Scripts\python tools\prepare_icons.py --force

Ids: finesse_shot power_shot chip_shot rapid technical trickster press_proven intercept anticipate slide_tackle jockey quick_step bruiser enforcer

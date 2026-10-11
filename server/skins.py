"""Player skins: a country flag or an uploaded image / GIF shown inside the player circle.

Stored per user as a string:
  "default"              team-coloured circle
  "flag:de"              flag from the flag-icons package (served by jsDelivr)
  "custom:png:<version>" uploaded image, saved as data/skins/<user id>.png (or .gif)
"""
import base64
import binascii
import io
import re
import time
from pathlib import Path

from PIL import Image, ImageSequence, UnidentifiedImageError

SKIN_DIR = Path(__file__).resolve().parent.parent / "data" / "skins"
FLAG_URL = "https://cdn.jsdelivr.net/npm/flag-icons@7.5.0/flags/1x1/{code}.svg"
FLAG_PATTERN = re.compile(r"[a-z]{2,6}(-[a-z]{2,3})?")  # "de", "gb-eng", "eu", …
CUSTOM_PATTERN = re.compile(r"custom:(png|gif):\d+")

MAX_UPLOAD_BYTES = 2 * 1024 * 1024
MAX_SOURCE_PIXELS = 4096 * 4096
MAX_FRAMES = 120
SIZE = 128  # skins are stored as 128×128, the circle crops the corners


class SkinError(Exception):
    pass


def is_valid(skin: str) -> bool:
    if skin == "default":
        return True
    if skin.startswith("flag:"):
        return bool(FLAG_PATTERN.fullmatch(skin[5:]))
    return bool(CUSTOM_PATTERN.fullmatch(skin))


def url_for(skin: str, user_id: int) -> str | None:
    if skin.startswith("flag:") and FLAG_PATTERN.fullmatch(skin[5:]):
        return FLAG_URL.format(code=skin[5:])
    if match := CUSTOM_PATTERN.fullmatch(skin):
        ext = match.group(1)
        version = skin.rsplit(":", 1)[1]
        return f"/skins/{user_id}.{ext}?v={version}"
    return None


def _square(frame: Image.Image) -> Image.Image:
    frame = frame.convert("RGBA")
    side = min(frame.size)
    left = (frame.width - side) // 2
    top = (frame.height - side) // 2
    return frame.crop((left, top, left + side, top + side)).resize((SIZE, SIZE), Image.LANCZOS)


def save_upload(user_id: int, data_url: str) -> str:
    """Decode, validate and re-encode an uploaded image. Returns the new skin string.

    Re-encoding with Pillow means only clean pixel data ends up on disk,
    whatever the uploaded file contained.
    """
    payload = data_url.split(",", 1)[-1]
    if len(payload) > MAX_UPLOAD_BYTES * 4 // 3 + 4:
        raise SkinError("The image is too large (max. 2 MB).")
    try:
        raw = base64.b64decode(payload, validate=True)
        image = Image.open(io.BytesIO(raw))
    except (binascii.Error, ValueError, UnidentifiedImageError):
        raise SkinError("That is not a valid image.") from None

    if image.format not in {"PNG", "JPEG", "GIF", "WEBP"}:
        raise SkinError("Allowed formats: PNG, JPG, GIF and WEBP.")
    if image.width * image.height > MAX_SOURCE_PIXELS:
        raise SkinError("The image has too many pixels (max. 4096×4096).")

    SKIN_DIR.mkdir(parents=True, exist_ok=True)
    for old in SKIN_DIR.glob(f"{user_id}.*"):
        old.unlink()

    try:
        if getattr(image, "is_animated", False):
            frames, durations = [], []
            for index, frame in enumerate(ImageSequence.Iterator(image)):
                if index >= MAX_FRAMES:
                    break
                frames.append(_square(frame))
                durations.append(max(20, frame.info.get("duration", 100)))
            frames[0].save(
                SKIN_DIR / f"{user_id}.gif", format="GIF", save_all=True,
                append_images=frames[1:], duration=durations, loop=0, disposal=2,
            )
            ext = "gif"
        else:
            _square(image).save(SKIN_DIR / f"{user_id}.png", format="PNG")
            ext = "png"
    except (OSError, ValueError):
        raise SkinError("The image could not be read.") from None

    return f"custom:{ext}:{int(time.time())}"

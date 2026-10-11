"""Self-made text captcha: an image with distorted characters the user has to type."""
import base64
import io
import random
import secrets
import time

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I lookalikes
LENGTH = 5
LIFETIME_SECONDS = 300
MAX_STORED = 5000
WIDTH, HEIGHT = 220, 80

_challenges: dict[str, tuple[str, float]] = {}  # id -> (answer, expires_at)


def _font(size: int):
    for name in ("arialbd.ttf", "arial.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def _render(text: str) -> bytes:
    rng = random.SystemRandom()
    image = Image.new("RGB", (WIDTH, HEIGHT), (236, 240, 230))
    draw = ImageDraw.Draw(image)

    for _ in range(250):
        draw.point((rng.randrange(WIDTH), rng.randrange(HEIGHT)), fill=tuple(rng.randrange(120, 220) for _ in range(3)))

    x = 12
    for char in text:
        font = _font(rng.randint(34, 44))
        tile = Image.new("RGBA", (60, 70), (0, 0, 0, 0))
        color = (rng.randrange(20, 110), rng.randrange(20, 110), rng.randrange(20, 110))
        ImageDraw.Draw(tile).text((10, 6), char, font=font, fill=color)
        tile = tile.rotate(rng.uniform(-28, 28), resample=Image.BICUBIC, expand=False)
        image.paste(tile, (x, rng.randint(0, 14)), tile)
        x += rng.randint(34, 40)

    for _ in range(5):
        points = [(rng.randrange(WIDTH), rng.randrange(HEIGHT)) for _ in range(2)]
        draw.line(points, fill=tuple(rng.randrange(60, 160) for _ in range(3)), width=2)

    image = image.filter(ImageFilter.SMOOTH)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def create() -> dict:
    now = time.time()
    for key in [k for k, (_, expires) in _challenges.items() if expires < now]:
        del _challenges[key]
    if len(_challenges) >= MAX_STORED:
        _challenges.pop(next(iter(_challenges)))

    answer = "".join(secrets.choice(ALPHABET) for _ in range(LENGTH))
    challenge_id = secrets.token_urlsafe(16)
    _challenges[challenge_id] = (answer, now + LIFETIME_SECONDS)
    image = base64.b64encode(_render(answer)).decode()
    return {"id": challenge_id, "image": f"data:image/png;base64,{image}"}


def verify(challenge_id: str, text: str) -> bool:
    """Each captcha can be checked once; a wrong guess needs a new captcha."""
    entry = _challenges.pop(challenge_id, None)
    if entry is None:
        return False
    answer, expires = entry
    guess = "".join(text.split()).upper()
    return time.time() <= expires and secrets.compare_digest(guess, answer)

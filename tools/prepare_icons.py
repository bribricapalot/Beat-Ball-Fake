"""Prepares custom ability / PlayStyle icons dropped into client/assets/abilities|playstyles/.

For every image whose name isn't already "<id>.png" it
  - figures out the id from the file name ("hell hook.jpeg" -> hell_hook, "finesseShot.png" -> finesse_shot),
  - removes a solid background (white, black, …) that touches the image border,
  - for PlayStyles: turns the gold FC badge into silver (normal PlayStyle, not PlayStyle+),
  - trims, squares and saves it as "<id>.png",
  - moves the original into an "originals/" subfolder (nothing is deleted).

Run: .venv\\Scripts\\python tools\\prepare_icons.py   (start.bat does this automatically)
"""
import re
import shutil
import sys
from pathlib import Path
from urllib.parse import unquote

from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from server.loadout import ABILITIES, PLAYSTYLES  # noqa: E402

ASSETS = ROOT / "client" / "assets"
EXTENSIONS = {".png", ".webp", ".gif", ".jpg", ".jpeg"}
SIZE = 256
BACKGROUND_TOLERANCE = 60
MARKER = (255, 0, 254)  # temporary colour for flood-filled background pixels


def normalize(name: str) -> str:
    # unquote: downloaded files are often named like "Zeus%27_Storm" (%27 = apostrophe)
    return re.sub(r"[^a-z0-9]", "", unquote(name).lower())


def match_id(stem: str, valid_ids) -> str | None:
    """Exact match after normalising, else a unique prefix match ("ragingdeflect" -> raging_deflection)."""
    key = normalize(stem)
    by_key = {normalize(i): i for i in valid_ids}
    if key in by_key:
        return by_key[key]
    candidates = [i for k, i in by_key.items() if k.startswith(key) or key.startswith(k)]
    return candidates[0] if len(candidates) == 1 else None


def remove_background(image: Image.Image) -> Image.Image:
    """Makes a solid background that touches the border transparent (enclosed areas stay)."""
    image = image.convert("RGBA")
    w, h = image.size
    corners = [image.getpixel(p) for p in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]]
    if all(c[3] < 10 for c in corners):
        return image  # already transparent

    rgb = image.convert("RGB")
    seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
             (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
    reference = rgb.getpixel((0, 0))
    for seed in seeds:
        pixel = rgb.getpixel(seed)
        if pixel != MARKER and sum(abs(a - b) for a, b in zip(pixel, reference)) <= BACKGROUND_TOLERANCE:
            ImageDraw.floodfill(rgb, seed, MARKER, thresh=BACKGROUND_TOLERANCE)

    alpha = image.getchannel("A")
    mask = Image.new("L", (w, h), 0)
    pixels, mask_pixels = rgb.load(), mask.load()
    for y in range(h):
        for x in range(w):
            if pixels[x, y] == MARKER:
                mask_pixels[x, y] = 255
    image.putalpha(Image.composite(Image.new("L", (w, h), 0), alpha, mask))
    return image


SILVER_TOP = (244, 247, 250)
SILVER_BOTTOM = (132, 144, 155)
GLYPH = (30, 36, 42)


def to_silver(image: Image.Image) -> Image.Image:
    """Gold FC badge -> uniform silver badge with a dark symbol (like a normal PlayStyle).

    The badge outline comes from the alpha channel; everything inside it that is either
    transparent (cut-out symbols) or dark (symbols on a black badge) becomes the symbol.
    """
    image = image.convert("RGBA")
    w, h = image.size
    alpha = image.getchannel("A")

    # Pixels outside the badge = transparent area connected to the border.
    regions = alpha.point(lambda v: 255 if v >= 128 else 0)
    for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        if regions.getpixel(seed) == 0:
            ImageDraw.floodfill(regions, seed, 100)
    inside_box = regions.point(lambda v: 0 if v == 100 else 255).getbbox()
    if not inside_box:
        return image
    top, bottom = inside_box[1], inside_box[3]

    lum = ImageOps.grayscale(image.convert("RGB")).load()
    src_alpha, region = alpha.load(), regions.load()
    result = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out = result.load()
    for y in range(h):
        t = (y - top) / max(1, bottom - top)
        face = tuple(round(a + (b - a) * t) for a, b in zip(SILVER_TOP, SILVER_BOTTOM))
        for x in range(w):
            if region[x, y] == 100:
                continue  # outside the badge
            a = src_alpha[x, y]
            if a < 128 or lum[x, y] < 90:
                out[x, y] = (*GLYPH, 255)
            else:
                out[x, y] = (*face, a)
    return result


def square(image: Image.Image) -> Image.Image:
    box = image.getchannel("A").getbbox()
    if box:
        image = image.crop(box)
    side = max(image.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def process(folder: str, valid_ids, silver: bool, force: bool = False):
    directory = ASSETS / folder
    if not directory.is_dir():
        return
    originals = directory / "originals"
    if force and originals.is_dir():
        # Rebuild every icon from its original.
        for original in sorted(originals.iterdir()):
            icon_id = match_id(original.stem, valid_ids)
            if icon_id and original.suffix.lower() in EXTENSIONS:
                image = remove_background(Image.open(original))
                square(to_silver(image) if silver else image).save(directory / f"{icon_id}.png")
                print(f"  ↻ {folder}/originals/{original.name} -> {icon_id}.png")
    # An icon counts as prepared once its original sits in originals/.
    prepared = {match_id(o.stem, valid_ids) for o in originals.iterdir()} if originals.is_dir() else set()
    for file in sorted(directory.iterdir()):
        if not file.is_file() or file.suffix.lower() not in EXTENSIONS:
            continue
        icon_id = match_id(file.stem, valid_ids)
        if icon_id is None:
            print(f"  ? {folder}/{file.name}: no matching id – skipped")
            continue
        if file.name == f"{icon_id}.png" and icon_id in prepared:
            continue
        image = Image.open(file)
        image.load()
        originals.mkdir(exist_ok=True)
        target = originals / file.name
        if target.exists():  # a newer upload replaces an older original
            target.unlink()
        shutil.move(str(file), target)
        image = remove_background(image)
        if silver:
            image = to_silver(image)
        square(image).save(directory / f"{icon_id}.png")
        prepared.add(icon_id)
        print(f"  ✓ {folder}/{file.name} -> {icon_id}.png")


if __name__ == "__main__":
    print("Preparing icons…")
    force = "--force" in sys.argv  # rebuild all icons from the originals
    process("abilities", ABILITIES, silver=False, force=force)
    process("playstyles", PLAYSTYLES, silver=True, force=force)

#!/usr/bin/env python3
"""Generate the PWA icon set for power-logs.html.

The app already embedded a 180px EmmStrength logo as a data URI, but that logo has
a transparent background. iOS renders transparency in a home-screen icon as flat
black and adds no padding of its own, so the logo would sit small on a black tile.
This composites it onto the app's own paper colour with proper breathing room.

Source is only 180px, so the 512px output is upscaled and slightly soft. If a
higher-resolution original turns up, drop it in as icons/_source.png and re-run.
"""
from PIL import Image, ImageDraw

SRC = "icons/_source.png"

PAPER_TOP = (0xFF, 0xFF, 0xFF)   # near --surface
PAPER_BOT = (0xE9, 0xEC, 0xE4)   # slightly deeper than --bg (#f1f3ee)

SS = 4  # supersample factor


def vertical_gradient(size, top, bottom):
    img = Image.new("RGB", (1, size), top)
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        d.point((0, y), fill=tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return img.resize((size, size), Image.NEAREST)


def build(size, logo_scale=0.80, corner_radius=None):
    S = size * SS
    canvas = vertical_gradient(S, PAPER_TOP, PAPER_BOT).convert("RGBA")

    logo = Image.open(SRC).convert("RGBA")
    target = int(S * logo_scale)
    logo = logo.resize((target, target), Image.LANCZOS)

    # Centre it on the tile.
    off = ((S - target) // 2, (S - target) // 2)
    canvas.alpha_composite(logo, off)

    if corner_radius:
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1],
                                              radius=int(S * corner_radius), fill=255)
        canvas.putalpha(mask)

    return canvas.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    # Manifest icons, purpose "any" — rounded for surfaces that don't apply a mask.
    build(192, corner_radius=0.18).save("icons/icon-192.png")
    build(512, corner_radius=0.18).save("icons/icon-512.png")

    # Maskable — logo pulled into the centre 80% safe zone, full-bleed background.
    build(512, logo_scale=0.62).convert("RGB").save("icons/icon-512-maskable.png")

    # iOS applies its own squircle mask: full bleed, no alpha channel.
    build(180).convert("RGB").save("icons/apple-touch-icon.png")

    # Small favicon for browser tabs.
    build(32, logo_scale=0.92).convert("RGB").save("icons/favicon-32.png")

    print("icons written")

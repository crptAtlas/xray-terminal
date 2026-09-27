"""XRAY human skeleton mascots, three states.
green  - healthy, standing straight, coin in hand
yellow - cracked, arm in a cast, hairline fractures
red    - shattered, bones scattered, skull cracked open
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import math

ROOT = Path(__file__).resolve().parent
FONTS = ROOT / "fonts"
OUT = ROOT / "xray"
OUT.mkdir(exist_ok=True)

BG0 = (4, 10, 18)
BG1 = (10, 22, 38)
B0 = (255, 255, 255)
B1 = (230, 252, 255)
B2 = (158, 224, 247)
B3 = (92, 162, 196)
B4 = (42, 84, 110)
B5 = (22, 50, 70)
K = (3, 8, 14)
CY = (120, 220, 255)
GRN = (96, 240, 128)
YEL = (255, 214, 64)
RED = (255, 96, 92)
CAST = (226, 232, 238)
CAST2 = (176, 186, 198)
WHITE = (255, 255, 255)

W, H = 80, 120


def font(name, size, var=None):
    f = ImageFont.truetype(str(FONTS / name), size)
    if var:
        f.set_variation_by_name(var)
    return f


def outline(im):
    a = im.split()[3]
    grown = a.filter(ImageFilter.MaxFilter(3))
    edge = Image.eval(grown, lambda v: 255 if v > 0 else 0)
    ring = Image.new("RGBA", im.size, K + (255,))
    ring.putalpha(edge)
    return Image.alpha_composite(ring, im)


def up(im, px):
    return im.resize((im.width * px, im.height * px), Image.NEAREST)


def glow(sp, radius, alpha, color=CY):
    pad = radius * 3
    a = Image.new("L", (sp.width + 2 * pad, sp.height + 2 * pad), 0)
    a.paste(sp.split()[3], (pad, pad))
    a = a.filter(ImageFilter.GaussianBlur(radius))
    layer = Image.new("RGBA", a.size, color + (0,))
    layer.putalpha(a.point(lambda v: int(v * alpha)))
    return layer, pad


def film(size):
    Wf, Hf = size
    im = Image.new("RGBA", (Wf, Hf), BG0 + (255,))
    g = Image.new("RGBA", (Wf, Hf), (0, 0, 0, 0))
    ImageDraw.Draw(g).ellipse([Wf * 0.12, Hf * 0.06, Wf * 0.88, Hf * 0.94], fill=BG1 + (255,))
    im.alpha_composite(g.filter(ImageFilter.GaussianBlur(Wf // 8)))
    d = ImageDraw.Draw(im)
    for y in range(0, Hf, 4):
        d.line([(0, y), (Wf, y)], fill=(0, 0, 0, 40))
    return im


# ------------------------------------------------------------------ parts
def bone(d, x0, y0, x1, y1, w=3, col=B2, knob=False):
    """Thin flat bone: dark rim, lit core. Nothing rounded, nothing flared."""
    d.line([(x0, y0), (x1, y1)], fill=B5, width=w + 2)
    d.line([(x0, y0), (x1, y1)], fill=B3, width=w)
    if w >= 3:
        d.line([(x0, y0), (x1, y1)], fill=col, width=w - 2)


def skull(d, cx, cy, cracked=False, broken=False, scale=1.0):
    """Anatomical skull: cranium, brow, orbits, nasal aperture, cheekbones, jaw."""
    r = 14 * scale
    d.ellipse([cx - r, cy - r, cx + r, cy + r * 0.85], fill=B5)
    d.ellipse([cx - r + 1, cy - r + 1, cx + r - 1, cy + r * 0.85 - 1], fill=B4)
    d.ellipse([cx - r + 2, cy - r + 2, cx + r - 2, cy + r * 0.8 - 2], fill=B2)
    # cranium highlight, top-left light
    d.ellipse([cx - r + 4, cy - r + 3, cx + 1, cy - 1], fill=B1)
    d.ellipse([cx - r + 6, cy - r + 4, cx - 3, cy - 5], fill=B0)
    # temporal shadow
    d.chord([cx - r + 2, cy - r + 2, cx + r - 2, cy + r * 0.8 - 2], 20, 110, fill=B3)
    # brow ridge
    d.arc([cx - 10 * scale, cy - 8 * scale, cx + 10 * scale, cy + 4 * scale], 200, 340, fill=B1, width=2)
    # orbits, deep and round
    for sx in (-1, 1):
        ox = cx + sx * 5.5 * scale
        d.ellipse([ox - 4.2 * scale, cy - 3 * scale, ox + 4.2 * scale, cy + 4 * scale], fill=B5)
        d.ellipse([ox - 3.4 * scale, cy - 2.4 * scale, ox + 3.4 * scale, cy + 3.4 * scale], fill=K)
        d.point((ox - 1.6 * scale, cy - 0.8 * scale), fill=CY)
    # nasal aperture
    d.polygon([(cx, cy + 4 * scale), (cx + 2.2 * scale, cy + 8 * scale), (cx - 2.2 * scale, cy + 8 * scale)], fill=K)
    # cheekbones
    d.line([(cx - 11 * scale, cy + 3 * scale), (cx - 6 * scale, cy + 7 * scale)], fill=B1, width=1)
    d.line([(cx + 11 * scale, cy + 3 * scale), (cx + 6 * scale, cy + 7 * scale)], fill=B1, width=1)
    # jaw
    jy = cy + 9 * scale
    d.rounded_rectangle([cx - 9 * scale, jy, cx + 9 * scale, jy + 6 * scale], radius=3, fill=B5)
    d.rounded_rectangle([cx - 8 * scale, jy, cx + 8 * scale, jy + 5 * scale], radius=3, fill=B2)
    for i in range(-7, 8, 2):
        d.line([(cx + i * scale, jy + 1), (cx + i * scale, jy + 4 * scale)], fill=B4)
    d.line([(cx - 8 * scale, jy + 1), (cx + 8 * scale, jy + 1)], fill=B1)
    if cracked:
        d.line([(cx + 6 * scale, cy - r + 2), (cx + 2 * scale, cy - 5 * scale), (cx + 7 * scale, cy - 1 * scale)], fill=K, width=1)
    if broken:
        d.line([(cx - r + 3, cy - 6 * scale), (cx - 2 * scale, cy - 1), (cx - 7 * scale, cy + 4 * scale)], fill=K, width=1)
        d.line([(cx + 2 * scale, cy - r + 2), (cx + 6 * scale, cy - 4 * scale)], fill=K, width=1)
        d.polygon([(cx - r + 1, cy - 8 * scale), (cx - r + 6, cy - 11 * scale), (cx - r + 7, cy - 5 * scale)], fill=BG1)


def spine(d, cx, top, bottom, broken=False):
    n = max(2, (bottom - top) // 4)
    for i in range(n):
        y = top + i * (bottom - top) / (n - 1)
        w = 4 if i < n - 2 else 5
        d.rounded_rectangle([cx - w / 2, y - 1.6, cx + w / 2, y + 1.6], radius=1, fill=B4)
        d.rounded_rectangle([cx - w / 2 + 1, y - 1.1, cx + w / 2 - 1, y + 1.1], radius=1, fill=B2)
        if broken and i == n // 2:
            d.line([(cx - 3, y - 2), (cx + 3, y + 2)], fill=K)


def ribcage(d, cx, top, cracked=False, broken=False):
    """Barrel-shaped cage: ribs widen then taper, sternum down the middle."""
    rows = [(0, 7), (4, 10), (8, 12), (12, 12), (16, 11), (20, 9), (24, 6)]
    for i, (dy, w) in enumerate(rows):
        y = top + dy
        d.arc([cx - w - 1, y - 5, cx + w + 1, y + 9], 15, 165, fill=B5, width=3)
        d.arc([cx - w, y - 4, cx + w, y + 8], 15, 165, fill=B2, width=2)
        d.arc([cx - w + 2, y - 3, cx + w - 2, y + 6], 30, 90, fill=B1, width=1)
        if broken and i in (2, 4):
            sx = cx - w + 3
            d.line([(sx, y + 2), (sx + 5, y + 6)], fill=K, width=2)
        if cracked and i == 3:
            d.line([(cx + w - 5, y + 2), (cx + w - 2, y + 5)], fill=K)
    # sternum
    d.rounded_rectangle([cx - 2, top - 2, cx + 2, top + 16], radius=2, fill=B4)
    d.rounded_rectangle([cx - 1, top - 1, cx + 1, top + 15], radius=1, fill=B1)


def pelvis(d, cx, y, col=B2):
    d.arc([cx - 13, y - 8, cx + 13, y + 10], 195, 345, fill=B5, width=6)
    d.arc([cx - 12, y - 7, cx + 12, y + 9], 195, 345, fill=B4, width=5)
    d.arc([cx - 12, y - 7, cx + 12, y + 9], 195, 345, fill=col, width=3)
    d.rounded_rectangle([cx - 3, y + 1, cx + 3, y + 5], radius=1, fill=B4)


def hand(d, hx, hy, ang=90, col=B2, spread=True):
    a0 = math.radians(ang)
    px, py = math.cos(a0), math.sin(a0)
    d.polygon([(hx - py * 3, hy + px * 3), (hx + py * 3, hy - px * 3),
               (hx + px * 3 + py * 2, hy + py * 3 - px * 2),
               (hx + px * 3 - py * 2, hy + py * 3 + px * 2)], fill=B4)
    for k in range(-2, 3):
        a = math.radians(ang + k * (16 if spread else 7))
        sx, sy = hx + px * 3, hy + py * 3
        d.line([(sx, sy), (sx + math.cos(a) * 4, sy + math.sin(a) * 4)], fill=B4, width=2)
        d.line([(sx, sy), (sx + math.cos(a) * 3.4, sy + math.sin(a) * 3.4)], fill=col, width=1)


def foot(d, fx, fy, s=1, col=B2):
    d.line([(fx, fy), (fx + s * 7, fy)], fill=B4, width=4)
    d.line([(fx, fy - 1), (fx + s * 6, fy - 1)], fill=col, width=2)


def cast_on(d, x0, y0, x1, y1, w=9):
    d.line([(x0, y0), (x1, y1)], fill=(150, 160, 172), width=w + 2)
    d.line([(x0, y0), (x1, y1)], fill=CAST, width=w)
    d.line([(x0, y0), (x1, y1)], fill=CAST2, width=w - 4)
    for t in range(1, 5):
        px = x0 + (x1 - x0) * t / 5
        py = y0 + (y1 - y0) * t / 5
        d.line([(px - 3, py - 1), (px + 3, py + 1)], fill=(206, 214, 224), width=1)


def coin(d, cx, cy, r, col, ring):
    d.ellipse([cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1], fill=K)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ring)
    d.ellipse([cx - r + 2, cy - r + 2, cx + r - 2, cy + r - 2], fill=col)
    d.arc([cx - r + 1, cy - r + 1, cx + r - 1, cy + r - 1], 150, 260, fill=WHITE, width=1)
    d.point((cx - r + 3, cy - r + 3), fill=WHITE)


def spark(d, x, y, s=3, col=WHITE):
    d.line([(x, y - s), (x, y + s)], fill=col)
    d.line([(x - s, y), (x + s, y)], fill=col)
    d.point((x, y), fill=col)


# ------------------------------------------------------------------ three states
def draw_healthy():
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx = 40
    skull(d, cx, 20)
    spine(d, cx, 35, 41)
    d.line([(cx - 13, 42), (cx + 13, 42)], fill=B5, width=3)
    d.line([(cx - 12, 42), (cx + 12, 42)], fill=B2, width=1)
    ribcage(d, cx, 46)
    spine(d, cx, 47, 76)
    pelvis(d, cx, 80)
    bone(d, cx - 13, 43, cx - 18, 58, w=3)
    bone(d, cx - 18, 58, cx - 20, 72, w=3)
    hand(d, cx - 20, 73, ang=90)
    bone(d, cx + 13, 43, cx + 21, 34, w=3)
    bone(d, cx + 21, 34, cx + 24, 20, w=3)
    hand(d, cx + 24, 19, ang=-90)
    bone(d, cx - 6, 86, cx - 8, 100, w=4)
    bone(d, cx - 8, 100, cx - 8, 112, w=3)
    foot(d, cx - 9, 113, s=-1)
    bone(d, cx + 6, 86, cx + 8, 100, w=4)
    bone(d, cx + 8, 100, cx + 8, 112, w=3)
    foot(d, cx + 9, 113, s=1)
    for (x, y) in [(cx + 34, 10), (cx + 16, 12), (cx + 32, 28)]:
        spark(d, x, y, 3)
    return outline(im)


def draw_cracked():
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx = 40
    skull(d, cx - 1, 21, cracked=True)
    spine(d, cx, 36, 42)
    d.line([(cx - 13, 43), (cx + 13, 43)], fill=B5, width=3)
    d.line([(cx - 12, 43), (cx + 12, 43)], fill=B2, width=1)
    ribcage(d, cx, 47, cracked=True)
    spine(d, cx, 48, 77)
    pelvis(d, cx, 81)
    bone(d, cx - 13, 44, cx - 19, 57, w=3)
    cast_on(d, cx - 19, 57, cx - 16, 70, w=7)
    hand(d, cx - 15, 72, ang=80)
    bone(d, cx + 13, 44, cx + 20, 57, w=3)
    bone(d, cx + 20, 57, cx + 22, 70, w=3)
    hand(d, cx + 22, 71, ang=75)
    bone(d, cx - 6, 87, cx - 9, 101, w=4)
    bone(d, cx - 9, 101, cx - 9, 113, w=3)
    foot(d, cx - 10, 114, s=-1)
    bone(d, cx + 6, 87, cx + 9, 101, w=4)
    cast_on(d, cx + 9, 101, cx + 9, 113, w=8)
    foot(d, cx + 10, 114, s=1)
    d.line([(cx + 31, 54), (cx + 31, 114)], fill=(140, 150, 162), width=3)
    d.line([(cx + 31, 54), (cx + 31, 114)], fill=CAST2, width=1)
    d.rounded_rectangle([cx + 26, 52, cx + 36, 56], radius=2, fill=CAST)
    d.line([(cx + 27, 76), (cx + 35, 76)], fill=CAST2, width=2)
    return outline(im)


def draw_shattered():
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx = 40
    sk = Image.new("RGBA", (56, 56), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sk)
    skull(sd, 28, 24, broken=True)
    sk = sk.rotate(-24, resample=Image.NEAREST, center=(28, 24))
    im.alpha_composite(sk, (cx - 32, 4))
    d = ImageDraw.Draw(im)
    ribcage(d, cx + 2, 50, broken=True)
    spine(d, cx + 2, 51, 78, broken=True)
    pelvis(d, cx + 1, 84, col=B3)
    # arms: one still attached, one snapped in two pieces
    bone(d, cx - 11, 49, cx - 20, 60, w=3, col=B3)
    bone(d, cx - 24, 68, cx - 31, 76, w=3, col=B3)
    bone(d, cx + 15, 49, cx + 24, 61, w=3, col=B3)
    hand(d, cx + 25, 63, ang=45, col=B3)
    # legs at wrong angles
    bone(d, cx - 5, 89, cx - 13, 101, w=4, col=B3)
    bone(d, cx - 13, 101, cx - 23, 105, w=3, col=B3)
    bone(d, cx + 8, 89, cx + 18, 98, w=4, col=B3)
    bone(d, cx + 18, 98, cx + 14, 111, w=3, col=B3)
    foot(d, cx + 13, 113, s=-1, col=B3)
    # only three loose fragments
    for (x, y, a2, L) in [(14, 92, 25, 5), (66, 86, -30, 5), (20, 112, 60, 4)]:
        dx = math.cos(math.radians(a2)) * L
        dy = math.sin(math.radians(a2)) * L
        bone(d, x - dx, y - dy, x + dx, y + dy, w=3, col=B3)
    for (x, y) in [(28, 100), (56, 98), (40, 114)]:
        d.point((x, y), fill=B4)
    return outline(im)


# ------------------------------------------------------------------ plates
def plate(fn, px=8, size=(1000, 1000), label=None, accent=CY):
    im = film(size)
    sp = up(fn(), px)
    x = (size[0] - sp.width) // 2
    y = (size[1] - sp.height) // 2
    g, pad = glow(sp, 40, 0.45, accent)
    im.alpha_composite(g, (x - pad, y - pad))
    im.alpha_composite(sp, (x, y))
    if label:
        d = ImageDraw.Draw(im)
        f = font("Tiny5-Regular.ttf", 58)
        tw = d.textlength(label, font=f)
        d.text(((size[0] - tw) / 2, size[1] - 108), label, font=f, fill=accent)
    return im.convert("RGB")


if __name__ == "__main__":
    plate(draw_healthy, accent=GRN).save(OUT / "h-healthy.png")
    plate(draw_cracked, accent=YEL).save(OUT / "h-cracked.png")
    plate(draw_shattered, accent=RED).save(OUT / "h-shattered.png")
    for n, fn in [("healthy", draw_healthy), ("cracked", draw_cracked), ("shattered", draw_shattered)]:
        up(fn(), 10).save(OUT / f"sprite-h-{n}.png")
    print("ok")


"""Logo (skull), skeleton agents with readable faces, and animation.

Outputs into ./xray:
  logo.png / logo-sprite.png      big skull mark
  agent-<name>.png                static plate of each agent
  agents.png                      reference sheet with captions
  run-sheet.png / run.gif         6-frame run cycle, skeleton crossing the screen
  work-<name>-sheet.png / .gif    4-frame work loop per agent
  agents.css                      keyframes for both, steps() based
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
MAG = (210, 140, 255)
DIM = (110, 130, 145)
SCR = (8, 26, 40)


def font(name, size, var=None):
    f = ImageFont.truetype(str(FONTS / name), size)
    if var:
        f.set_variation_by_name(var)
    return f


def outline(im, col=K):
    a = im.split()[3]
    grown = a.filter(ImageFilter.MaxFilter(3))
    edge = Image.eval(grown, lambda v: 255 if v > 0 else 0)
    ring = Image.new("RGBA", im.size, col + (255,))
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
    ImageDraw.Draw(g).ellipse([Wf * .12, Hf * .06, Wf * .88, Hf * .94], fill=BG1 + (255,))
    im.alpha_composite(g.filter(ImageFilter.GaussianBlur(Wf // 8)))
    d = ImageDraw.Draw(im)
    for y in range(0, Hf, 4):
        d.line([(0, y), (Wf, y)], fill=(0, 0, 0, 40))
    return im


# ------------------------------------------------------------------ bones
def bone(d, x0, y0, x1, y1, w=3, col=B2):
    d.line([(x0, y0), (x1, y1)], fill=B5, width=w + 2)
    d.line([(x0, y0), (x1, y1)], fill=col, width=w)
    if w >= 3:
        d.line([(x0, y0), (x1, y1)], fill=B1, width=w - 2)


def skull_small(d, cx, cy):
    """Agent head, 11x12. Light bone, small orbits, same silhouette as the logo."""
    # cranium, bright
    d.ellipse([cx - 5, cy - 6, cx + 5, cy + 2], fill=B5)
    d.ellipse([cx - 4, cy - 5, cx + 4, cy + 1], fill=B2)
    d.ellipse([cx - 4, cy - 5, cx, cy - 2], fill=B1)
    # orbits, small
    d.rectangle([cx - 3, cy - 2, cx - 2, cy - 1], fill=K)
    d.rectangle([cx + 2, cy - 2, cx + 3, cy - 1], fill=K)
    d.point((cx - 3, cy - 2), fill=CY)
    d.point((cx + 2, cy - 2), fill=CY)
    # nose
    d.point((cx, cy + 1), fill=K)
    # jaw, bright, one tooth row
    d.rectangle([cx - 3, cy + 2, cx + 3, cy + 4], fill=B5)
    d.rectangle([cx - 3, cy + 2, cx + 3, cy + 3], fill=B2)
    d.point((cx - 2, cy + 2), fill=B1)
    d.point((cx - 1, cy + 3), fill=B2)
    d.point((cx + 1, cy + 3), fill=B2)
    return


def skull_big(d, cx, cy, r=18):
    """Logo skull: full detail."""
    d.ellipse([cx - r, cy - r, cx + r, cy + r * .85], fill=B5)
    d.ellipse([cx - r + 2, cy - r + 2, cx + r - 2, cy + r * .85 - 2], fill=B4)
    d.ellipse([cx - r + 3, cy - r + 3, cx + r - 3, cy + r * .8 - 3], fill=B2)
    d.ellipse([cx - r + 3, cy - r + 3, cx - 1, cy - 3], fill=B1)
    if r >= 12:
        d.ellipse([cx - r + 7, cy - r + 6, cx - 5, cy - 8], fill=B0)
    d.chord([cx - r + 3, cy - r + 3, cx + r - 3, cy + r * .8 - 3], 20, 110, fill=B3)
    d.arc([cx - r + 3, cy - r * .5, cx + r - 3, cy + r * .22], 200, 340, fill=B1, width=1 if r < 12 else 2)   # brow
    orb_w = r * (.26 if r < 12 else .34)
    for sx in (-1, 1):
        ox = cx + sx * r * .44
        d.ellipse([ox - orb_w - 1, cy - r * .2, ox + orb_w + 1, cy + r * .34], fill=B5)
        d.ellipse([ox - orb_w, cy - r * .15, ox + orb_w, cy + r * .3], fill=K)
        d.point((ox - orb_w * .5, cy), fill=CY)
    d.polygon([(cx, cy + r * .28), (cx + r * .17, cy + r * .58), (cx - r * .17, cy + r * .58)], fill=K)
    if r >= 10:
        d.line([(cx - r * .82, cy + r * .2), (cx - r * .45, cy + r * .48)], fill=B1)
        d.line([(cx + r * .82, cy + r * .2), (cx + r * .45, cy + r * .48)], fill=B1)
    jy = cy + r * .62
    d.rounded_rectangle([cx - r * .62, jy, cx + r * .62, jy + r * .4], radius=3, fill=B5)
    d.rounded_rectangle([cx - r * .55, jy, cx + r * .55, jy + r * .32], radius=3, fill=B2)
    step = max(2, int(r * .22))
    x = int(cx - r * .45)
    while x < cx + r * .5:
        d.line([(x, jy + 1), (x, jy + r * .28)], fill=B4)
        x += step


# ------------------------------------------------------------------ logo
def draw_logo():
    S = 48
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    skull_big(d, 24, 24, r=20)
    return outline(im)


# ------------------------------------------------------------------ agent body
AW, AH = 56, 62


def _c():
    return Image.new("RGBA", (AW, AH), (0, 0, 0, 0))


def body(d, cx, top, head_dy=0, larm=None, rarm=None, lleg=(0, 0), rleg=(0, 0)):
    """Standing skeleton. larm/rarm = (x, y, angle) of the hand. legs = (dx, dy) of the foot."""
    skull_small(d, cx, top + 7 + head_dy)
    d.rectangle([cx - 1, top + 13 + head_dy, cx + 1, top + 17], fill=B2)
    d.line([(cx - 8, top + 18), (cx + 8, top + 18)], fill=B5, width=3)
    d.line([(cx - 7, top + 18), (cx + 7, top + 18)], fill=B2, width=1)
    d.rounded_rectangle([cx - 1, top + 19, cx + 1, top + 33], radius=1, fill=B2)
    for w, y in [(7, top + 20), (8, top + 24), (7.5, top + 28), (6, top + 32)]:
        for sx in (-1, 1):
            d.line([(cx + sx * 1.5, y), (cx + sx * w, y + 2)], fill=B5, width=3)
            d.line([(cx + sx * 1.5, y), (cx + sx * w, y + 2)], fill=B2, width=1)
    d.arc([cx - 7, top + 33, cx + 7, top + 43], 195, 345, fill=B5, width=5)
    d.arc([cx - 6, top + 34, cx + 6, top + 42], 195, 345, fill=B2, width=3)
    # legs
    for sx, (dx, dy) in ((-1, lleg), (1, rleg)):
        kx = cx + sx * 5 + dx * .5
        ky = top + 50 + dy * .4
        fx = cx + sx * 6 + dx
        fy = top + 57 + dy
        bone(d, cx + sx * 4, top + 40, kx, ky, w=3)
        bone(d, kx, ky, fx, fy, w=3)
        d.line([(fx - 2, fy + 1), (fx + 3, fy + 1)], fill=B2, width=2)
    # arms
    for sx, arm in ((-1, larm), (1, rarm)):
        if arm is None:
            ex, ey = cx + sx * 11, top + 38
        else:
            ex, ey = arm[0], arm[1]
        bone(d, cx + sx * 8, top + 19, cx + sx * 10, top + 28, w=3)
        bone(d, cx + sx * 10, top + 28, ex, ey, w=3)
        for k in range(-1, 2):
            a = math.radians((arm[2] if arm else 90) + k * 22)
            d.line([(ex, ey), (ex + math.cos(a) * 3, ey + math.sin(a) * 3)], fill=B2, width=1)


def screen(d, x0, y0, x1, y1, rows=4, bars=False, phase=0):
    d.rounded_rectangle([x0 - 1, y0 - 1, x1 + 1, y1 + 1], radius=2, fill=B4)
    d.rectangle([x0, y0, x1, y1], fill=SCR)
    if bars:
        n = int((x1 - x0) / 4)
        for i in range(n):
            h = 2 + ((i * 5 + phase * 3) % max(2, int(y1 - y0 - 3)))
            col = GRN if i % 3 == 0 else (RED if i % 3 == 1 else YEL)
            d.rectangle([x0 + 2 + i * 4, y1 - 2 - h, x0 + 4 + i * 4, y1 - 2], fill=col)
    else:
        for i in range(rows):
            y = y0 + 3 + i * 3
            if y > y1 - 2:
                break
            d.line([(x0 + 2, y), (x1 - 2 - ((i + phase) % 3) * 4, y)], fill=CY)


# ------------------------------------------------------------------ agents, f = frame 0..3
def ag_scanner(f=0):
    im = _c(); d = ImageDraw.Draw(im)
    screen(d, 30, 8, 53, 28, rows=5, phase=f)
    d.rectangle([30, 29, 53, 31], fill=B4)
    dy = [0, -1, 0, 1][f]
    body(d, 14, 2, head_dy=0, rarm=(28, 28 + dy, -10))
    return outline(im)


def ag_ledger(f=0):
    im = _c(); d = ImageDraw.Draw(im)
    d.rectangle([28, 34, 54, 36], fill=B4)
    d.polygon([(30, 34), (41, 30), (41, 34)], fill=B2)
    d.polygon([(52, 34), (41, 30), (41, 34)], fill=B1)
    for j, y in enumerate((12, 17, 22)):
        for i in range(6):
            lit = (i + j + f) % 3 == 0
            col = (GRN if (i + j) % 2 else RED) if lit else B4
            d.rectangle([31 + i * 3, y, 33 + i * 3, y + 3], fill=col)
    d.line([(30, 10), (50, 10)], fill=B4)
    d.line([(30, 27), (50, 27)], fill=B4)
    dy = [0, 1, 2, 1][f]
    body(d, 14, 2, rarm=(29, 31 + dy, -20))
    return outline(im)


def ag_tracer(f=0):
    im = _c(); d = ImageDraw.Draw(im)
    screen(d, 30, 6, 54, 32, rows=0)
    nodes = [(35, 12), (43, 9), (50, 15), (38, 25), (48, 28), (43, 19)]
    for a2, b2 in [(0, 5), (1, 5), (2, 5), (3, 5), (4, 5), (0, 3)]:
        d.line([nodes[a2], nodes[b2]], fill=B4)
    path = [(0, 5), (5, 2), (5, 4), (5, 1)][f]
    d.line([nodes[path[0]], nodes[path[1]]], fill=MAG, width=2)
    for i, (x, y) in enumerate(nodes):
        lit = i in path
        r = 2.2 if i == 5 else 1.5
        d.ellipse([x - r, y - r, x + r, y + r], fill=MAG if lit else B2)
    tip = nodes[path[1]]
    body(d, 14, 2, rarm=(30, 20, -30))
    d.line([(30, 20), (tip[0] - 2, tip[1] + 2)], fill=B1)
    return outline(im)


def ag_auditor(f=0):
    im = _c(); d = ImageDraw.Draw(im)
    d.rectangle([28, 42, 54, 44], fill=B4)
    d.rectangle([40, 16, 42, 42], fill=B4)
    d.rectangle([40, 16, 41, 42], fill=B2)
    tilt = [0, 2, 3, 1][f]
    ly, ry = 19 + tilt, 22 - tilt
    d.line([(32, ly), (50, ry)], fill=B3, width=2)
    d.arc([29, ly, 36, ly + 6], 0, 180, fill=GRN, width=2)
    d.arc([46, ry, 53, ry + 7], 0, 180, fill=RED, width=2)
    d.ellipse([31, ly, 34, ly + 3], fill=GRN)
    d.ellipse([48, ry + 1, 51, ry + 4], fill=RED)
    body(d, 14, 2, rarm=(30, 24, -20))
    return outline(im)


def ag_sorter(f=0):
    im = _c(); d = ImageDraw.Draw(im)
    d.rectangle([28, 42, 54, 44], fill=B4)
    for i, col in enumerate((GRN, YEL, RED)):
        x = 30 + i * 8
        fill_h = [0, 1, 2, 1][f] if i == f % 3 else 0
        d.rounded_rectangle([x, 28, x + 6, 42], radius=1, fill=B4)
        d.rounded_rectangle([x + 1, 30 + i * 3 - fill_h, x + 5, 41], radius=1, fill=col)
        d.line([(x + 1, 29), (x + 5, 29)], fill=B2)
    d.polygon([(36, 10), (48, 10), (43, 22), (41, 22)], fill=B4)
    d.polygon([(37, 11), (47, 11), (42.6, 21), (41.4, 21)], fill=B2)
    dropy = [21, 24, 27, 18][f]
    d.ellipse([40, dropy, 44, dropy + 4], fill=YEL)
    body(d, 14, 2, rarm=(34, 14, -40))
    return outline(im)


def ag_flagger(f=0):
    im = _c(); d = ImageDraw.Draw(im)
    screen(d, 30, 7, 53, 25, bars=True, phase=f)
    d.rectangle([30, 27, 53, 30], fill=B4)
    for i, base in enumerate((B3, B3, RED, B3)):
        x = 32 + i * 5
        col = base
        if i == 2 and f % 2 == 0:
            col = (120, 40, 40)
        d.ellipse([x, 27.5, x + 3, 30.5], fill=col)
    d.polygon([(44, 33), (51, 43), (37, 43)], fill=B4)
    d.polygon([(44, 35), (49.4, 42), (38.6, 42)], fill=YEL if f % 2 == 0 else (190, 160, 40))
    d.rectangle([43.4, 36.6, 44.6, 39.4], fill=K)
    d.point((44, 40.6), fill=K)
    body(d, 14, 2, rarm=(29, 29, -10))
    return outline(im)


AGENTS = [
    ("SCANNER", ag_scanner, "pulling every trade of this token"),
    ("LEDGER", ag_ledger, "rebuilding each wallet's book: bought, sold, left"),
    ("TRACER", ag_tracer, "following the same wallets across other tokens"),
    ("AUDITOR", ag_auditor, "avg pnl and winrate, wallet by wallet"),
    ("SORTER", ag_sorter, "splitting holders into groups"),
    ("FLAGGER", ag_flagger, "dust, transfers in, first-ever trades"),
]


# ------------------------------------------------------------------ run cycle
RW, RH = 38, 52


def run_frame(f):
    """6-frame run, facing right, carrying an x-ray plate under one arm."""
    im = Image.new("RGBA", (RW, RH), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx, top = 17, 2
    bob = [0, -1, 0, 1, 0, -1][f]
    swing = [6, 3, -2, -6, -3, 2][f]

    skull_small(d, cx + 1, top + 7 + bob)
    d.rectangle([cx - 1, top + 14 + bob, cx + 1, top + 17 + bob], fill=B2)
    d.line([(cx - 7, top + 18 + bob), (cx + 7, top + 18 + bob)], fill=B5, width=3)
    d.line([(cx - 6, top + 18 + bob), (cx + 6, top + 18 + bob)], fill=B2, width=1)
    d.rounded_rectangle([cx - 1, top + 19 + bob, cx + 1, top + 31 + bob], radius=1, fill=B2)
    for w, y in [(6, top + 20), (7, top + 24), (6, top + 28)]:
        for sx in (-1, 1):
            d.line([(cx + sx * 1.5, y + bob), (cx + sx * w, y + 2 + bob)], fill=B5, width=3)
            d.line([(cx + sx * 1.5, y + bob), (cx + sx * w, y + 2 + bob)], fill=B2, width=1)
    d.arc([cx - 6, top + 31 + bob, cx + 6, top + 40 + bob], 195, 345, fill=B5, width=5)
    d.arc([cx - 5, top + 32 + bob, cx + 5, top + 39 + bob], 195, 345, fill=B2, width=3)

    # legs
    for sx, sw in ((-1, swing), (1, -swing)):
        kx = cx + sw * .6
        ky = top + 47 + bob - abs(sw) * .25
        fx = cx + sw
        fy = top + 53 + bob - abs(sw) * .1
        bone(d, cx + sx * 3, top + 38 + bob, kx, ky, w=3)
        bone(d, kx, ky, fx, fy, w=3)
        d.line([(fx - 1, fy + 1), (fx + 4, fy + 1)], fill=B2, width=2)

    # left arm: bent, clamped on the plate, barely moves
    bone(d, cx - 7, top + 20 + bob, cx - 10, top + 27 + bob, w=3)
    bone(d, cx - 10, top + 27 + bob, cx - 6, top + 30 + bob, w=3)
    # the plate itself, held against the ribs
    px0, py0 = cx - 13, top + 25 + bob
    d.rounded_rectangle([px0, py0, px0 + 9, py0 + 8], radius=1, fill=B5)
    d.rounded_rectangle([px0 + 1, py0 + 1, px0 + 8, py0 + 7], radius=1, fill=(12, 34, 52))
    d.line([(px0 + 2, py0 + 3), (px0 + 7, py0 + 3)], fill=B3)
    d.line([(px0 + 2, py0 + 5), (px0 + 6, py0 + 5)], fill=B3)
    for k in range(2):
        d.point((px0 + 8, py0 + 3 + k * 3), fill=B1)

    # right arm swings
    sw = swing
    ex = cx + 8 + sw * .7
    ey = top + 30 + bob + abs(sw) * .2
    bone(d, cx + 7, top + 20 + bob, cx + 9, top + 25 + bob, w=3)
    bone(d, cx + 9, top + 25 + bob, ex, ey, w=3)
    for k in range(-1, 2):
        a2 = math.radians(60 + k * 22)
        d.line([(ex, ey), (ex + math.cos(a2) * 3, ey + math.sin(a2) * 3)], fill=B2, width=1)

    # motion dashes behind
    for i, dx in enumerate((-4, -8, -12)):
        d.line([(cx + dx - 8, top + 34 + bob + i * 4), (cx + dx - 3, top + 34 + bob + i * 4)], fill=B4)
    return outline(im)


# ------------------------------------------------------------------ export helpers
def sheet(frames, px, path):
    fw, fh = frames[0].size
    sh = Image.new("RGBA", (fw * len(frames) * px, fh * px), (0, 0, 0, 0))
    for i, fr in enumerate(frames):
        sh.paste(up(fr, px), (i * fw * px, 0))
    sh.save(path)
    return fw, fh, len(frames)


def gif(frames, px, path, ms=110, bg=(8, 20, 32)):
    ims = []
    for fr in frames:
        b = Image.new("RGBA", fr.size, bg + (255,))
        b.alpha_composite(fr)
        ims.append(up(b.convert("RGB"), px).convert("P", palette=Image.ADAPTIVE, colors=64))
    ims[0].save(path, save_all=True, append_images=ims[1:], duration=ms, loop=0, optimize=False)


def logo_plate(size=1000):
    im = film((size, size))
    sp = up(draw_logo(), size // 60)
    x = (size - sp.width) // 2
    y = (size - sp.height) // 2
    g, pad = glow(sp, 42, .42)
    im.alpha_composite(g, (x - pad, y - pad))
    im.alpha_composite(sp, (x, y))
    return im.convert("RGB")


def agent_plate(fn, size=(600, 600)):
    im = film(size)
    sp = up(fn(0), 8)
    x = (size[0] - sp.width) // 2
    y = (size[1] - sp.height) // 2
    g, pad = glow(sp, 26, .35)
    im.alpha_composite(g, (x - pad, y - pad))
    im.alpha_composite(sp, (x, y))
    return im.convert("RGB")


def agents_sheet(w=1500, h=940):
    im = film((w, h))
    f_name = font("Tiny5-Regular.ttf", 46)
    f_cap = font("JetBrainsMono[wght].ttf", 22, "Regular")
    top, step = 24, (h - 60) / len(AGENTS)
    for i, (name, fn, cap) in enumerate(AGENTS):
        y = int(top + i * step)
        sp = up(fn(0), 3)
        g, pad = glow(sp, 16, .3)
        im.alpha_composite(g, (70 - pad, y - pad))
        im.alpha_composite(sp, (70, y))
        d = ImageDraw.Draw(im)
        d.text((290, y + 38), name, font=f_name, fill=B1)
        d.text((292, y + 84), cap, font=f_cap, fill=DIM)
        d.line([(70, y + step - 12), (w - 70, y + step - 12)], fill=(26, 52, 72))
    return im.convert("RGB")


if __name__ == "__main__":
    logo_plate().save(OUT / "logo.png")
    up(draw_logo(), 12).save(OUT / "logo-sprite.png")
    agents_sheet().save(OUT / "agents.png")

    css = []
    for name, fn, _ in AGENTS:
        key = name.lower()
        agent_plate(fn).save(OUT / f"agent-{key}.png")
        frames = [fn(i) for i in range(4)]
        fw, fh, n = sheet(frames, 4, OUT / f"work-{key}-sheet.png")
        gif(frames, 4, OUT / f"work-{key}.gif", ms=220)
        css.append(f""".ag-{key}{{--px:4;width:calc({fw}px*var(--px));height:calc({fh}px*var(--px));
  background:url("work-{key}-sheet.png") 0 0/calc({fw*n}px*var(--px)) calc({fh}px*var(--px)) no-repeat;
  image-rendering:pixelated;animation:ag-{key} 880ms steps({n}) infinite}}
@keyframes ag-{key}{{to{{background-position:calc(-{fw*n}px*var(--px)) 0}}}}""")

    runs = [run_frame(i) for i in range(6)]
    fw, fh, n = sheet(runs, 4, OUT / "run-sheet.png")
    gif(runs, 4, OUT / "run.gif", ms=95)
    css.append(f""".ag-run{{--px:4;width:calc({fw}px*var(--px));height:calc({fh}px*var(--px));
  background:url("run-sheet.png") 0 0/calc({fw*n}px*var(--px)) calc({fh}px*var(--px)) no-repeat;
  image-rendering:pixelated;animation:ag-run 570ms steps({n}) infinite}}
@keyframes ag-run{{to{{background-position:calc(-{fw*n}px*var(--px)) 0}}}}
.ag-run.travel{{animation:ag-run 570ms steps({n}) infinite, ag-cross 3.2s linear infinite}}
@keyframes ag-cross{{from{{transform:translateX(-10%)}}to{{transform:translateX(110%)}}}}""")

    (OUT / "agents.css").write_text("\n".join(css))
    print("ok")

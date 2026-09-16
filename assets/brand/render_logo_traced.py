"""Logo from the traced reference ribcage.

The cage itself is a bitmap traced off the reference art (assets ribcage.npy),
recoloured into the project palette. Around it: the negatoscope body, the film,
the sweeping beam and a fracture marker.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
import numpy as np

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "xray"
OUT.mkdir(exist_ok=True)
DARK = np.load(ROOT / "cage_dark.npy")    # traced outline layer
LIGHT = np.load(ROOT / "cage_light.npy")  # traced fill layer

BG0 = (4, 10, 18)
FILM = (12, 30, 50)
B0 = (255, 255, 255)
B1 = (214, 236, 255)      # bone
B2 = (150, 196, 246)      # bone shade
B5 = (26, 52, 88)         # rim
K = (8, 16, 30)
CY = (120, 220, 255)
GRN = (96, 240, 128)
PANEL = (38, 68, 96)
PANEL2 = (22, 44, 68)

N = 16


def outline(im, col=K):
    a = im.split()[3]
    grown = a.filter(ImageFilter.MaxFilter(3))
    edge = Image.eval(grown, lambda v: 255 if v > 0 else 0)
    ring = Image.new("RGBA", im.size, col + (255,))
    ring.putalpha(edge)
    return Image.alpha_composite(ring, im)


def up(im, px):
    return im.resize((im.width * px, im.height * px), Image.NEAREST)


def gif(frames, px, path, ms=95):
    ims = []
    for fr in frames:
        b = Image.new("RGBA", fr.size, BG0 + (255,))
        b.alpha_composite(fr)
        ims.append(up(b.convert("RGB"), px).convert("P", palette=Image.ADAPTIVE, colors=48))
    ims[0].save(path, save_all=True, append_images=ims[1:], duration=ms, loop=0, optimize=False)


def sheet(frames, px, path):
    fw, fh = frames[0].size
    sh = Image.new("RGBA", (fw * len(frames) * px, fh * px), (0, 0, 0, 0))
    for i, fr in enumerate(frames):
        sh.paste(up(fr, px), (i * fw * px, 0))
    sh.save(path)


def cage():
    """Traced ribcage: (dark outline, light fill) at native 45x55."""
    return DARK, LIGHT


def paste_cage(d, layers, ox, oy, lit_to=None, crack=True):
    dark, light = layers
    h, w = dark.shape
    for y in range(h):
        for x in range(w):
            py = oy + y
            dim = lit_to is not None and py > lit_to
            if light[y, x]:
                d.point((ox + x, py), fill=B2 if dim else B1)
            elif dark[y, x]:
                d.point((ox + x, py), fill=(20, 38, 62) if dim else B5)
    if crack:
        cy = oy + int(h * .46)
        cx = ox + int(w * .74)
        if lit_to is None or cy <= lit_to:
            for t in range(3):
                d.point((cx + t, cy + t), fill=K)
                d.point((cx + t + 1, cy + t), fill=K)
            d.point((cx + 4, cy - 1), fill=B0)
            d.point((cx - 1, cy + 4), fill=B0)


# ------------------------------------------------------------------ lightbox
S = 80


def lightbox_frame(f, beam=True):
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([2, 4, S - 3, S - 12], radius=4, fill=PANEL)
    d.rounded_rectangle([5, 7, S - 6, S - 15], radius=4, fill=PANEL2)
    d.rectangle([20, S - 11, 32, S - 3], fill=PANEL)
    d.rectangle([S - 33, S - 11, S - 21, S - 3], fill=PANEL)

    on = True
    d.rectangle([8, 10, S - 9, S - 18], fill=(16, 40, 62) if on else (8, 18, 28))

    g = cage()
    gh, gw = g[0].shape
    win = (8, 10, S - 9, S - 18)                 # lamp window: everything is clipped to it
    lay = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ld = ImageDraw.Draw(lay)
    fx = (S - (gw + 10)) // 2
    fy = 9
    ld.rectangle([fx, fy, fx + gw + 9, fy + gh + 5], fill=FILM if on else (10, 22, 36))
    ld.rectangle([fx, fy, fx + gw + 9, fy + 2], fill=(60, 96, 134))

    if on:
        t = (f + 1) / (N + 1)
        by = fy + 2 + t * (gh + 1)
        paste_cage(ld, g, fx + 5, fy + 4, lit_to=by)
        if beam:
            ld.line([(fx + 1, by), (fx + gw + 8, by)], fill=B0)
            ld.line([(fx + 1, by + 1), (fx + gw + 8, by + 1)], fill=CY)
    # clip the layer to the window, then drop it on the panel
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rectangle(list(win), fill=255)
    im.paste(lay, (0, 0), Image.composite(lay.split()[3], Image.new("L", (S, S), 0), mask))
    d = ImageDraw.Draw(im)
    d.rectangle([S - 14, S - 20, S - 11, S - 17], fill=GRN if on else PANEL)
    return outline(im)


# ------------------------------------------------------------------ plain film
def film_frame(f, beam=True):
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    g = cage()
    gh, gw = g[0].shape
    fx = (S - gw) // 2 - 4
    fy = (S - gh) // 2 - 2
    d.rectangle([fx - 4, fy - 4, fx + gw + 4, fy + gh + 4], fill=(60, 96, 134))
    d.rectangle([fx - 2, fy - 2, fx + gw + 2, fy + gh + 2], fill=FILM)
    t = f / (N - 1)
    by = fy - 3 + t * (gh + 8)
    paste_cage(d, g, fx, fy, lit_to=by)
    for (x, y, sx, sy) in [(fx, fy, 1, 1), (fx + gw, fy, -1, 1), (fx, fy + gh, 1, -1), (fx + gw, fy + gh, -1, -1)]:
        d.line([(x, y), (x + sx * 6, y)], fill=CY)
        d.line([(x, y), (x, y + sy * 5)], fill=CY)
    if beam and f < N - 2:
        d.line([(fx - 2, by), (fx + gw + 2, by)], fill=B0)
        d.line([(fx - 2, by + 1), (fx + gw + 2, by + 1)], fill=CY)
    return outline(im)


if __name__ == "__main__":
    for name, fn in [("lb", lightbox_frame), ("fm", film_frame)]:
        frames = [fn(i) for i in range(N)]
        gif(frames, 7, OUT / f"logo-{name}.gif")
        sheet(frames, 4, OUT / f"logo-{name}-sheet.png")
        up(fn(N - 1, beam=False), 8).save(OUT / f"logo-{name}-still.png")
    # bare cage sprite
    g = cage()
    bare = Image.new("RGBA", (g[0].shape[1] + 4, g[0].shape[0] + 4), (0, 0, 0, 0))
    paste_cage(ImageDraw.Draw(bare), g, 2, 2)
    up(outline(bare), 9).save(OUT / "cage-still.png")
    print("ok")

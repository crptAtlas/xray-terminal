"""Assembles the animated README banner: the static base rendered by
render-banner.mjs plus the animated logo frames on the right.
Refresh with: npm run render:banner
"""
from pathlib import Path
from PIL import Image

brand = Path(__file__).resolve().parent.parent / "assets" / "brand"
base = Image.open(brand / "banner-base.png").convert("RGB")
logo = Image.open(brand / "logo-lb.gif")

W, H = base.size
LX = W - 420 - logo.size[0] // 2  # centered where the static sprite used to sit
LY = (H - logo.size[1]) // 2

frames = []
durations = []
try:
    while True:
        frame = logo.convert("RGB")
        out = base.copy()
        out.paste(frame, (LX, LY))
        frames.append(out)
        durations.append(logo.info.get("duration", 90))
        logo.seek(len(frames))
except EOFError:
    pass

frames[0].save(
    brand / "banner.gif",
    save_all=True,
    append_images=frames[1:],
    duration=durations,
    loop=0,
    optimize=False,
)
print(f"assets/brand/banner.gif ({len(frames)} frames)")

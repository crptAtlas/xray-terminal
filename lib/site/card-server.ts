import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import { join } from "node:path";
import { drawCard } from "./card-draw";
import type { CardData } from "./types";

// Server render of the share card for OG images: same drawing code as the
// browser preview, fed by @napi-rs/canvas with the local fonts and sprites.

let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  const fonts = join(process.cwd(), "app", "fonts");
  GlobalFonts.registerFromPath(join(fonts, "Tiny5-Regular.ttf"), "Tiny5");
  GlobalFonts.registerFromPath(join(fonts, "JetBrainsMono[wght].ttf"), "JetBrains Mono");
  fontsReady = true;
}

export async function renderCardPng(d: CardData): Promise<Buffer> {
  ensureFonts();
  const assets = join(process.cwd(), "public", "assets");
  const [sprite, logo] = await Promise.all([
    loadImage(join(assets, `h-${d.grade}.png`)),
    loadImage(join(assets, "cage.png")),
  ]);
  const c = createCanvas(1080, 1080);
  const ctx = c.getContext("2d");
  drawCard(ctx as never, d, { sprite, logo });
  return c.toBuffer("image/png");
}

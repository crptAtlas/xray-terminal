import { drawCard } from "./card-draw";
import type { CardData } from "./types";

// Browser side of the share card: load images and fonts, draw and offer
// copy / download. The drawing itself lives in card-draw.ts, shared with
// the server OG route.

const cache: Record<string, Promise<HTMLImageElement>> = {};
function img(src: string): Promise<HTMLImageElement> {
  return (cache[src] ||= new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  }));
}

async function fonts(): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load("96px Tiny5"),
      document.fonts.load('700 128px "JetBrains Mono"'),
      document.fonts.load('400 30px "JetBrains Mono"'),
    ]);
  } catch {
    /* draw with fallbacks */
  }
}

export async function renderCard(d: CardData): Promise<HTMLCanvasElement> {
  await fonts();
  const [sprite, logo] = await Promise.all([img(`/assets/h-${d.grade}.png`), img("/assets/cage.png")]);
  const c = document.createElement("canvas");
  c.width = 1080;
  c.height = 1080;
  const ctx = c.getContext("2d")!;
  drawCard(ctx as never, d, { sprite, logo });
  return c;
}

export async function cardBlob(d: CardData): Promise<Blob> {
  const c = await renderCard(d);
  return new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
}

export async function copyCard(d: CardData): Promise<void> {
  const blob = await cardBlob(d);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

export async function downloadCard(d: CardData, name: string): Promise<void> {
  const blob = await cardBlob(d);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}


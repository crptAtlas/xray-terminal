import type { CardData } from "./types";

// Renders the 1080x1080 XRAY share card to a canvas. A one-to-one typed
// port of design/card.js - keep the drawing code in step with it.

const BAND = (wr: number): string => (wr >= 55 ? "#60F080" : wr >= 45 ? "#FFD640" : "#FF605C");

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
  const x = c.getContext("2d")!;
  x.imageSmoothingEnabled = false;
  x.fillStyle = "#040A12";
  x.fillRect(0, 0, 1080, 1080);
  // faint grid
  x.strokeStyle = "rgba(22,50,74,.35)";
  x.lineWidth = 1;
  for (let i = 0; i <= 1080; i += 54) {
    x.beginPath();
    x.moveTo(i + 0.5, 0);
    x.lineTo(i + 0.5, 1080);
    x.stroke();
    x.beginPath();
    x.moveTo(0, i + 0.5);
    x.lineTo(1080, i + 0.5);
    x.stroke();
  }
  x.fillStyle = "rgba(0,0,0,.26)";
  for (let y = 0; y < 1080; y += 4) x.fillRect(0, y, 1080, 1);
  // skeleton, fully visible bottom-right (sprite has its own bg and glow)
  const S = 400;
  x.imageSmoothingEnabled = true;
  x.drawImage(sprite, 1080 - S - 48, 1080 - S - 48, S, S);
  x.imageSmoothingEnabled = false;
  const glow = (col: string, blur: number) => {
    x.shadowColor = col;
    x.shadowBlur = blur;
  };
  const noglow = () => {
    x.shadowBlur = 0;
    x.shadowColor = "transparent";
  };
  const gc = d.gradeColor;
  // logo frame
  x.fillStyle = "#0A1626";
  x.fillRect(72, 72, 96, 96);
  x.drawImage(logo, 96, 84, 48, 58);
  glow(gc, 18);
  x.strokeStyle = gc;
  x.lineWidth = 2;
  x.strokeRect(72, 72, 96, 96);
  noglow();
  // ticker
  x.textBaseline = "alphabetic";
  x.fillStyle = "#E6FCFF";
  x.font = "64px Tiny5";
  glow("rgba(120,220,255,.7)", 24);
  x.fillText(d.ticker, 200, 140);
  noglow();
  x.fillStyle = "#6E8291";
  x.font = '400 22px "JetBrains Mono"';
  x.fillText(d.addr.slice(0, 10) + "…" + d.addr.slice(-8), 200, 176);
  // big pnl top-right
  x.textAlign = "right";
  x.fillStyle = gc;
  x.font = '700 108px "JetBrains Mono"';
  glow(gc, 32);
  x.fillText(d.pnl, 1008, 168);
  noglow();
  x.fillStyle = "#6E8291";
  x.font = '400 22px "JetBrains Mono"';
  x.fillText("avg holder pnl on this token", 1008, 206);
  x.textAlign = "left";
  // winrate + scale bar
  x.fillStyle = gc;
  x.font = '700 48px "JetBrains Mono"';
  const wrW = x.measureText(d.winrate).width;
  glow(gc, 16);
  x.fillText(d.winrate, 72, 316);
  noglow();
  x.fillStyle = "#D9D9D9";
  x.font = '400 26px "JetBrains Mono"';
  x.fillText("avg winrate of holders across Pons", 72 + wrW + 20, 316);
  const bx = 72;
  const bw = 936;
  const by = 344;
  const bh = 12;
  const px = (p: number) => bx + (bw * p) / 100;
  x.fillStyle = "rgba(255,96,92,.45)";
  x.fillRect(px(0), by, px(33.3) - px(0) - 2, bh);
  x.fillStyle = "rgba(255,214,64,.45)";
  x.fillRect(px(33.3), by, px(66.6) - px(33.3) - 2, bh);
  x.fillStyle = "rgba(96,240,128,.45)";
  x.fillRect(px(66.6), by, px(100) - px(66.6), bh);
  const wrN = parseFloat(d.winrate);
  x.fillStyle = "#E6FCFF";
  glow("#E6FCFF", 14);
  x.fillRect(px(wrN) - 3, by - 6, 6, bh + 12);
  noglow();
  x.fillStyle = "#6E8291";
  x.font = '400 20px "JetBrains Mono"';
  x.fillText("0", px(0), 386);
  x.fillText("33", px(33.3) - 12, 386);
  x.fillText("66", px(66.6) - 12, 386);
  x.textAlign = "right";
  x.fillText("100", px(100), 386);
  x.textAlign = "left";
  // group lines
  x.font = '500 32px "JetBrains Mono"';
  d.groups.forEach((g, i) => {
    const y = 464 + i * 56;
    x.fillStyle = BAND(g.wr);
    glow(BAND(g.wr), 10);
    x.fillText(`${g.supply}% of supply`, 72, y);
    noglow();
    const w = x.measureText(`${g.supply}% of supply`).width;
    x.fillStyle = "#D9D9D9";
    x.fillText(` · winrate ${g.wr}–${g.wr + 5}% · ${g.wallets} wallets`, 72 + w, y);
  });
  // grade
  x.fillStyle = gc;
  x.font = "72px Tiny5";
  glow(gc, 24);
  x.fillText(d.gradeLabel, 72, 770);
  noglow();
  x.fillStyle = "#D9D9D9";
  x.font = '400 26px "JetBrains Mono"';
  const hintW = 1080 - S - 40 - 72 - 24;
  const words = d.hint.split(" ");
  let line = "";
  let ly = 812;
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (x.measureText(t).width > hintW && line) {
      x.fillText(line, 72, ly);
      ly += 34;
      line = w;
    } else line = t;
  }
  if (line) x.fillText(line, 72, ly);
  // brand
  x.fillStyle = gc;
  x.font = "64px Tiny5";
  glow(gc, 20);
  x.fillText("XRAY", 72, 950);
  noglow();
  x.fillStyle = "#D9D9D9";
  x.font = '400 30px "JetBrains Mono"';
  x.fillText("Terminal", 72, 988);
  x.fillStyle = "#6E8291";
  x.font = '400 22px "JetBrains Mono"';
  x.fillText("xray.tools", 72, 1020);
  x.fillText(d.time, 72, 1050);
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

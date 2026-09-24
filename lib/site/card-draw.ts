import type { CardData } from "./types";

// The share card drawing code, context-agnostic: the browser preview and
// the server OG route both call drawCard with their own canvas context and
// pre-loaded images. Geometry is the design/card.js original.

import { GRADE_COLORS, recordLevel, winrateLevel } from "../grade.ts";

export const PNL = (v: number): string => (v > 20 ? "#60F080" : v < -20 ? "#FF605C" : "#FFD640");

export interface CardImages {
  sprite: unknown;
  logo: unknown;
}

// The minimal 2d-context surface we use; both CanvasRenderingContext2D and
// @napi-rs/canvas SKRSContext2D satisfy it structurally.
export interface Ctx2D {
  imageSmoothingEnabled: boolean;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  shadowColor: string;
  shadowBlur: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  drawImage(img: never, x: number, y: number, w: number, h: number): void;
  fillText(t: string, x: number, y: number): void;
  measureText(t: string): { width: number };
}

export function drawCard(ctx: Ctx2D, d: CardData, images: CardImages): void {
  const x = ctx;
  const sprite = images.sprite as never;
  const logo = images.logo as never;
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
  // big pnl top-right, colored by its own sign (the grade keeps the frame)
  const pnlNum = parseFloat(d.pnl.replace("\u2212", "-"));
  const pnlCol = Number.isNaN(pnlNum) ? gc : GRADE_COLORS[recordLevel(pnlNum)];
  x.textAlign = "right";
  x.fillStyle = pnlCol;
  x.font = '700 108px "JetBrains Mono"';
  glow(pnlCol, 32);
  x.fillText(d.pnl, 1008, 168);
  noglow();
  x.fillStyle = "#6E8291";
  x.font = '400 22px "JetBrains Mono"';
  x.fillText("avg realized pnl of holders across Pons", 1008, 206);
  if (d.pnlHere) {
    x.fillText(`on this token ${d.pnlHere}`, 1008, 236);
  }
  x.textAlign = "left";
  // winrate + scale bar, coloured by where it sits on this chain rather
  // than by the token's grade
  const wrNum = parseFloat(d.winrate);
  const wrCol = Number.isNaN(wrNum) ? gc : GRADE_COLORS[winrateLevel(wrNum)];
  x.fillStyle = wrCol;
  x.font = '700 48px "JetBrains Mono"';
  const wrW = x.measureText(d.winrate).width;
  glow(wrCol, 16);
  x.fillText(d.winrate, 72, 316);
  noglow();
  x.fillStyle = "#D9D9D9";
  x.font = '400 26px "JetBrains Mono"';
  x.fillText("avg winrate of holders across Pons (chain median 31%)", 72 + wrW + 20, 316);
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
  const wrN = parseFloat(d.winrate.replace("\u2212", "-"));
  if (!Number.isNaN(wrN)) {
    x.fillStyle = "#E6FCFF";
    glow("#E6FCFF", 14);
    x.fillRect(px(Math.max(0, Math.min(100, wrN))) - 3, by - 6, 6, bh + 12);
    noglow();
  }
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
    x.fillStyle = PNL(g.mid);
    glow(PNL(g.mid), 10);
    x.fillText(`${g.supply}% of supply`, 72, y);
    noglow();
    const w = x.measureText(`${g.supply}% of supply`).width;
    x.fillStyle = "#D9D9D9";
    x.fillText(` · pnl ${g.range} · ${g.wallets} wallets`, 72 + w, y);
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
  // one wordmark, not a name split over two lines
  x.fillText("Xray-terminal", 72, 950);
  noglow();
  x.fillStyle = "#6E8291";
  x.font = '400 22px "JetBrains Mono"';
  x.fillText(d.time, 72, 992);
}

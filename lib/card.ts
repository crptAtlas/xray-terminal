import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fmtAge, fmtUsd, isDead, type CheckResult } from "./format.ts";
import { gradeOf, type Grade } from "./grade.ts";

/**
 * Share card: a 1080x1080 PNG for one token check. The mood follows the
 * token grade (lib/grade.ts) and the matching skeleton sprite goes on the
 * right, next to the numbers:
 *
 *   healthy    green    intact skeleton
 *   cracked    yellow   cracks, cast and crutch
 *   shattered  red      in pieces (also every dead token)
 */

export type Mood = "green" | "yellow" | "red";

const MOOD_OF_GRADE: Record<Grade, Mood> = {
  healthy: "green",
  cracked: "yellow",
  shattered: "red",
};

const SPRITE_OF_GRADE: Record<Grade, string> = {
  healthy: "sprite-h-healthy.png",
  cracked: "sprite-h-cracked.png",
  shattered: "sprite-h-shattered.png",
};

const PALETTES: Record<Mood, { bg: string; panel: string; text: string; accent: string; dim: string }> = {
  green: { bg: "#07130b", panel: "#0d2416", text: "#e8ffe8", accent: "#4ef07f", dim: "#7da88b" },
  yellow: { bg: "#141005", panel: "#2a2208", text: "#fff7e0", accent: "#ffd640", dim: "#b3a26b" },
  red: { bg: "#160709", panel: "#2c0d12", text: "#ffe8e8", accent: "#ff5c5c", dim: "#b07a7a" },
};

const BRAND = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "brand");

export function cardGrade(r: CheckResult): Grade {
  return gradeOf(r.aggregates, r.snapshot.holders, isDead(r));
}

export function cardMood(r: CheckResult): Mood {
  return MOOD_OF_GRADE[cardGrade(r)];
}

const W = 1080;
const H = 1080;
const M = 72; // outer margin

const pct = (n: number | null, digits = 0): string =>
  n === null ? "-" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;

function font(px: number, weight = 400): string {
  return `${weight} ${px}px "Helvetica Neue", "Arial", sans-serif`;
}

function line(ctx: SKRSContext2D, text: string, x: number, y: number, fnt: string, color: string): void {
  ctx.font = fnt;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

export async function renderCard(r: CheckResult): Promise<Buffer> {
  const grade = cardGrade(r);
  const mood = MOOD_OF_GRADE[grade];
  const p = PALETTES[mood];
  const { snapshot: s, header: h, aggregates: a } = r;
  const dead = isDead(r);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = p.accent;
  ctx.lineWidth = 6;
  ctx.strokeRect(24, 24, W - 48, H - 48);

  // skeleton on the right (800x1200 sprite, drawn at half size, crisp)
  const sprite = await loadImage(join(BRAND, SPRITE_OF_GRADE[grade]));
  ctx.imageSmoothingEnabled = false;
  const sw = 400;
  const sh = 600;
  ctx.drawImage(sprite, W - sw - 40, 150, sw, sh);

  // header: symbol, phase, age
  line(ctx, `$${s.meta.symbol}`, M, 168, font(96, 700), p.text);
  const phase = h.phase.kind === "curve" ? `curve ${h.phase.fillPct.toFixed(0)}%` : "graduated";
  line(ctx, `${phase}   age ${fmtAge(h.ageMs)}`, M, 224, font(40), p.dim);
  if (r.demo) line(ctx, "DEMO", M, 280, font(40, 700), p.accent);

  // centerpiece, left column (skeleton owns the right)
  if (dead) {
    line(ctx, "TOKEN", M, 430, font(88, 700), p.accent);
    line(ctx, "IS DEAD", M, 520, font(88, 700), p.accent);
    line(ctx, "You're too early", M, 590, font(44), p.text);
    line(ctx, "or too late", M, 644, font(44), p.text);
  } else {
    line(ctx, "holders avg pnl", M, 380, font(40), p.dim);
    line(ctx, pct(a.avgPnlPct), M, 510, font(130, 700), p.accent);
    let y = 580;
    if (a.avgWinrate !== null) {
      line(ctx, `winrate ${a.avgWinrate.toFixed(0)}%`, M, y, font(40), p.text);
      y += 52;
      line(ctx, `across ${a.winrateWallets} wallets`, M, y, font(34), p.dim);
      y += 62;
    }
    y += 12;
    for (const [i, g] of r.groups.entries()) {
      const range = `${g.minPct >= 0 ? "+" : ""}${g.minPct.toFixed(0)}..${g.maxPct.toFixed(0)}%`;
      line(ctx, `group ${i + 1}  ${range}`, M, y, font(36), p.text);
      y += 46;
      line(ctx, `${(g.supplyShare * 100).toFixed(0)}% of supply, ${g.wallets} wallets`, M + 32, y, font(30), p.dim);
      y += 56;
    }
  }

  // footer stats
  ctx.fillStyle = p.panel;
  ctx.fillRect(48, H - 300, W - 96, 156);
  line(ctx, `mcap ${fmtUsd(h.mcapUsd)}   liq ${fmtUsd(h.liquidityUsd)}   vol24h ${fmtUsd(h.volume24hUsd)}`, M, H - 236, font(40), p.text);
  line(ctx, `${h.holders.toLocaleString("en-US")} holders   grade ${grade}`, M, H - 176, font(40), p.dim);

  const addr = `${s.meta.address.slice(0, 10)}...${s.meta.address.slice(-8)}`;
  line(ctx, addr, M, H - 84, font(34), p.dim);

  return canvas.toBuffer("image/png");
}

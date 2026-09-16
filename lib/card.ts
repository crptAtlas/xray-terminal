import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { DEAD_LINE, fmtAge, fmtUsd, isDead, type CheckResult } from "./format.ts";

/**
 * Share card: a 1080x1080 PNG for one token check, three moods.
 *
 *   red     token is dead (fewer than DEAD_HOLDERS_MIN current holders)
 *   yellow  holders are underwater: supply-weighted avg pnl below zero
 *   green   holders are in profit: supply-weighted avg pnl at or above zero
 *
 * Pure typography - the project ships no images or branding while the name
 * is still the APPNAME placeholder.
 */

export type Mood = "green" | "yellow" | "red";

const PALETTES: Record<Mood, { bg: string; panel: string; text: string; accent: string; dim: string }> = {
  green: { bg: "#07130b", panel: "#0d2416", text: "#e8ffe8", accent: "#4ef07f", dim: "#7da88b" },
  yellow: { bg: "#141005", panel: "#2a2208", text: "#fff7e0", accent: "#ffd640", dim: "#b3a26b" },
  red: { bg: "#160709", panel: "#2c0d12", text: "#ffe8e8", accent: "#ff5c5c", dim: "#b07a7a" },
};

export function cardMood(r: CheckResult): Mood {
  if (isDead(r)) return "red";
  const avg = r.aggregates.avgPnlPct;
  if (avg === null || avg < 0) return "yellow";
  return "green";
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

export function renderCard(r: CheckResult): Buffer {
  const mood = cardMood(r);
  const p = PALETTES[mood];
  const { snapshot: s, header: h, aggregates: a } = r;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = p.accent;
  ctx.lineWidth = 6;
  ctx.strokeRect(24, 24, W - 48, H - 48);

  // header: symbol, phase, age
  line(ctx, `$${s.meta.symbol}`, M, 168, font(96, 700), p.text);
  const phase = h.phase.kind === "curve" ? `curve ${h.phase.fillPct.toFixed(0)}%` : "graduated";
  line(ctx, `${phase}   age ${fmtAge(h.ageMs)}`, M, 224, font(40), p.dim);
  if (r.demo) line(ctx, "DEMO", W - M - ctx.measureText("DEMO").width - 40, 168, font(40, 700), p.accent);

  // centerpiece
  if (mood === "red") {
    line(ctx, "TOKEN IS DEAD", M, 470, font(88, 700), p.accent);
    line(ctx, "You're too early or too late", M, 550, font(48), p.text);
  } else {
    line(ctx, "holders avg pnl", M, 380, font(40), p.dim);
    line(ctx, pct(a.avgPnlPct), M, 510, font(140, 700), p.accent);
    let y = 580;
    if (a.avgWinrate !== null) {
      line(ctx, `winrate ${a.avgWinrate.toFixed(0)}%  across ${a.winrateWallets} wallets`, M, y, font(40), p.text);
      y += 56;
    }
    // groups panel
    y += 24;
    for (const [i, g] of r.groups.entries()) {
      const range = `${g.minPct >= 0 ? "+" : ""}${g.minPct.toFixed(0)}..${g.maxPct.toFixed(0)}%`;
      line(
        ctx,
        `group ${i + 1}   ${range.padEnd(11)} ${(g.supplyShare * 100).toFixed(0)}% of supply   ${g.wallets} wallets`,
        M,
        y,
        font(36),
        p.text,
      );
      y += 52;
    }
  }

  // footer stats
  ctx.fillStyle = p.panel;
  ctx.fillRect(48, H - 300, W - 96, 156);
  line(ctx, `mcap ${fmtUsd(h.mcapUsd)}   liq ${fmtUsd(h.liquidityUsd)}   vol24h ${fmtUsd(h.volume24hUsd)}`, M, H - 236, font(40), p.text);
  line(ctx, `${h.holders.toLocaleString("en-US")} holders`, M, H - 176, font(40), p.dim);

  const addr = `${s.meta.address.slice(0, 10)}...${s.meta.address.slice(-8)}`;
  line(ctx, addr, M, H - 84, font(34), p.dim);

  return canvas.toBuffer("image/png");
}

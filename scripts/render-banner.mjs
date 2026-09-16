#!/usr/bin/env node
// Renders assets/brand/banner.png for the README header: pixel wordmark,
// tagline, bottom line, the ribcage sprite with a soft glow on the right.
// Refresh with: npm run render:banner
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import { writeFile } from "node:fs/promises";

const W = 2172;
const H = 724;

const C = {
  bg: "#05070a",
  bone: "#cfe4f0",
  glow: "#9fd9ff",
  shadow: "#16222e",
  dim: "#8798a8",
  faint: "#5d7387",
};

const brand = new URL("../assets/brand/", import.meta.url).pathname;
GlobalFonts.registerFromPath(brand + "fonts/JetBrainsMono[wght].ttf", "JetBrains Mono");

// 5x5 pixel alphabet, same identity as the sprites.
const PIX = {
  X: ["10001", "01010", "00100", "01010", "10001"],
  R: ["11110", "10001", "11110", "10010", "10001"],
  A: ["01110", "10001", "11111", "10001", "10001"],
  Y: ["10001", "01010", "00100", "00100", "00100"],
};

const canvas = createCanvas(W, H);
const ctx = canvas.getContext("2d");

ctx.fillStyle = C.bg;
ctx.fillRect(0, 0, W, H);

// wordmark
const cell = 36;
let ox = 150;
const oy = 170;
for (const ch of "XRAY") {
  const glyph = PIX[ch];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      if (glyph[r][c] === "1") {
        ctx.fillStyle = C.shadow;
        ctx.fillRect(ox + c * cell + cell * 0.35, oy + r * cell + cell * 0.35, cell, cell);
        ctx.fillStyle = C.glow;
        ctx.fillRect(ox + c * cell, oy + r * cell, cell, cell);
      }
    }
  }
  ox += cell * 6.4;
}

// tagline
ctx.font = "500 44px 'JetBrains Mono'";
ctx.fillStyle = C.dim;
ctx.fillText("shows who is actually in profit in a token.", 150, 445);

// bottom line
ctx.font = "400 34px 'JetBrains Mono'";
ctx.fillStyle = C.faint;
ctx.fillText("$XRAY   ·   holder pnl terminal for pons v2   ·   read-only", 150, 620);

// ribcage with glow on the right
const cage = await loadImage(brand + "logo-sprite.png");
const sh = 560;
const sw = Math.round((cage.width / cage.height) * sh);
const cx = W - 420;
const cy = H / 2;
const grad = ctx.createRadialGradient(cx, cy, 40, cx, cy, 360);
grad.addColorStop(0, "rgba(159, 217, 255, 0.22)");
grad.addColorStop(1, "rgba(159, 217, 255, 0)");
ctx.fillStyle = grad;
ctx.fillRect(cx - 380, cy - 380, 760, 760);
ctx.imageSmoothingEnabled = false;
ctx.drawImage(cage, cx - sw / 2, cy - sh / 2, sw, sh);

await writeFile(brand + "banner.png", canvas.toBuffer("image/png"));
console.log("assets/brand/banner.png");

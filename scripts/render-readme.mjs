#!/usr/bin/env node
/**
 * Renders the README terminal views as SVG from real command output.
 * Nothing is drawn by hand: `demo` is the offline fixture run, `doctor`
 * and `check` are live runs at render time - the capture moment is
 * printed inside each live image and saved next to it as JSON.
 *
 * Refresh with: npm run render:readme [-- <healthy-ca> <cracked-ca> <shattered-ca>]
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = new URL("../bin/xray.mjs", import.meta.url).pathname;
const outDir = new URL("../assets/readme/", import.meta.url).pathname;

// The x-ray palette, one place, matching site/index.html.
const C = {
  bg: "#05070a",
  panel: "#0b1118",
  line: "#17222e",
  bone: "#cfe4f0",
  dim: "#5d7387",
  faint: "#31404f",
  glow: "#9fd9ff",
  green: "#4ef07f",
  yellow: "#ffd640",
  red: "#ff5c5c",
};

const FONT = "'JetBrains Mono','SFMono-Regular',Consolas,'Liberation Mono',monospace";
const FS = 14;
const LH = 22;
const CW = FS * 0.6;

const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// 5x5 pixel alphabet for the wordmark, same pixel identity as the sprites.
const PIX = {
  X: ["10001", "01010", "00100", "01010", "10001"],
  R: ["11110", "10001", "11110", "10010", "10001"],
  A: ["01110", "10001", "11111", "10001", "10001"],
  Y: ["10001", "01010", "00100", "00100", "00100"],
};

function wordmark(x, y, cell) {
  const rects = [];
  let ox = x;
  for (const ch of "XRAY") {
    const glyph = PIX[ch];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        if (glyph[r][c] === "1") {
          rects.push(`<rect x="${ox + c * cell + cell * 0.4}" y="${y + r * cell + cell * 0.4}" width="${cell}" height="${cell}" fill="${C.faint}"/>`);
          rects.push(`<rect x="${ox + c * cell}" y="${y + r * cell}" width="${cell}" height="${cell}" fill="${C.glow}"/>`);
        }
      }
    }
    ox += cell * 6.2;
  }
  return rects.join("");
}

/** Split one CLI line into colored segments. */
function colorize(line) {
  let base = C.bone;
  if (/^(DEMO|note:)/.test(line)) base = C.yellow;
  if (/^(excluded|source|first trade|endpoints)/.test(line)) base = C.dim;
  if (/^\$/.test(line)) base = C.glow;
  if (/^Token is dead/.test(line)) base = C.red;
  if (/^ ok /.test(line)) base = C.green;
  if (/^FAIL/.test(line)) base = C.red;
  if (/^all green/.test(line)) base = C.green;
  const segs = [];
  for (const part of line.split(/([+-]\d+(?:\.\d+)?(?:\.\.[+-]?\d+(?:\.\d+)?)?%)/)) {
    if (/^[+-]/.test(part)) segs.push({ t: part, c: part.startsWith("-") ? C.red : C.green, b: true });
    else if (part) segs.push({ t: part, c: base });
  }
  if (segs.length === 0) segs.push({ t: " ", c: base });
  return segs;
}

function panel({ title, lines, caption }) {
  const pad = 24;
  const headH = 46;
  const capH = caption ? 30 : 0;
  const textW = Math.max(...lines.map((l) => l.length), 60) * CW;
  const w = Math.min(Math.ceil(textW + pad * 2), 980);
  const h = headH + lines.length * LH + pad + capH + 10;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">`);
  parts.push(`<rect width="${w}" height="${h}" rx="12" fill="${C.bg}"/>`);
  parts.push(`<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="11" fill="none" stroke="${C.line}" stroke-width="2"/>`);
  // header bar
  for (const [i, col] of [C.red, C.yellow, C.green].entries()) {
    parts.push(`<circle cx="${pad + i * 20}" cy="${headH / 2 + 4}" r="5.5" fill="${col}" opacity="0.85"/>`);
  }
  parts.push(`<text x="${pad + 66}" y="${headH / 2 + 9}" font-family="${FONT}" font-size="13" fill="${C.dim}">${esc(title)}</text>`);
  parts.push(wordmark(w - 118, 14, 3.4));
  parts.push(`<line x1="1" y1="${headH}" x2="${w - 1}" y2="${headH}" stroke="${C.line}" stroke-width="1"/>`);
  // body
  let y = headH + 26;
  for (const line of lines) {
    let cursor = pad;
    for (const seg of colorize(line)) {
      parts.push(
        `<text x="${cursor.toFixed(1)}" y="${y}" font-family="${FONT}" font-size="${FS}" fill="${seg.c}"${seg.b ? ' font-weight="700"' : ""} xml:space="preserve">${esc(seg.t)}</text>`,
      );
      cursor += seg.t.length * CW;
    }
    y += LH;
  }
  if (caption) {
    parts.push(`<text x="${pad}" y="${h - 14}" font-family="${FONT}" font-size="11" fill="${C.faint}">${esc(caption)}</text>`);
  }
  parts.push("</svg>");
  return parts.join("\n");
}

async function cmd(args, env = {}) {
  const { stdout, stderr } = await run("npx", ["tsx", cli, ...args], {
    env: { ...process.env, ...env, NO_COLOR: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });
  return (stderr.trim() ? stderr.trimEnd() + "\n" : "") + stdout.trimEnd();
}

const clip = (text, max) => {
  const lines = text.split("\n");
  return lines.length <= max ? lines : [...lines.slice(0, max - 1), "  ..."];
};

await mkdir(outDir + "cards", { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";

// 1. demo: offline fixture run
const demoOut = await cmd(["demo"], { ETH_USD: "2400" });
await writeFile(
  outDir + "demo.svg",
  panel({
    title: "xray demo - offline, fixtures, no keys",
    lines: clip(demoOut, 30),
    caption: "synthetic fixture run: every line reproducible offline, marked DEMO",
  }),
);
console.log("demo.svg");

// 2. doctor: live
const doctorOut = await cmd(["doctor"]);
await writeFile(
  outDir + "doctor.svg",
  panel({
    title: "xray doctor - live chain verification",
    lines: clip(doctorOut, 24),
    caption: `captured ${stamp}; a historical run, not an uptime monitor`,
  }),
);
await writeFile(outDir + "doctor-snapshot.json", JSON.stringify({ capturedAt: stamp, output: doctorOut.split("\n") }, null, 2));
console.log("doctor.svg");

// 3. live checks + cards for the three grades
const [healthy, cracked, shattered] = process.argv.slice(2);
const targets = [
  ["healthy", healthy],
  ["cracked", cracked],
  ["shattered", shattered],
].filter(([, ca]) => ca);

for (const [grade, ca] of targets) {
  const out = await cmd(["check", ca, "--top", "5"]);
  if (grade === "healthy") {
    await writeFile(
      outDir + "check.svg",
      panel({
        title: `xray check ${ca.slice(0, 10)}... - live`,
        lines: clip(out, 30),
        caption: `captured ${stamp}; a historical grade of a public token, not a current one`,
      }),
    );
    await writeFile(outDir + "check-snapshot.json", JSON.stringify({ capturedAt: stamp, token: ca, output: out.split("\n") }, null, 2));
    console.log("check.svg");
  }
  const cardPath = `${outDir}cards/card-${grade}.png`;
  await rm(cardPath, { force: true });
  await cmd(["check", ca, "--card", cardPath]);
  console.log(`cards/card-${grade}.png`);
}

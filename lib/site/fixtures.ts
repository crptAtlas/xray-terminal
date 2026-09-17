import type { CardData, Grade } from "./types";

// Fixture data lifted verbatim from the design prototypes
// (design/XRAY Home.dc.html and design/XRAY Terminal.dc.html). The /api
// routes serve these until the engine is wired in.

export const COLORS = {
  profit: "#60F080",
  neutral: "#FFD640",
  loss: "#FF605C",
  accent: "#78DCFF",
} as const;

/** PnL color (design rule: above +20 green, below -20 red, else yellow). */
export const pnlColor = (v: number): string => (v > 20 ? "#60F080" : v < -20 ? "#FF605C" : "#FFD640");

// --- home page: engine log demo tokens ---

export interface DemoTok {
  t: string;
  a: string;
  tr: string;
  h: string;
  w: string;
  inE: string;
  outE: string;
  sup: string;
  pnl: string;
  pc: string;
  others: string;
  traced: string;
  avg: string;
  wr: string;
  tag: string;
  bands: string;
  fl: string;
  verdict: string;
  vc: string;
  vp: string;
  vw: string;
}

export const TOK: DemoTok[] = [
  { t: "$MARROW", a: "0x7a3f…9c41", tr: "18 920", h: "1 043", w: "0x3f9a…c21e", inE: "2.10", outE: "0.90", sup: "4.21%", pnl: "+184.2%", pc: "#60F080", others: "$FEMUR $RIBCAGE $CALCIUM +16", traced: "212", avg: "+38.4%", wr: "67%", tag: "SMART", bands: "+40..45% · 31.2% supply · 188 wallets | +6..11% · 22.9% · 302 | −15..−10% · 18.4% · 553", fl: "dust 214 · transfers-in 87 · infra 6 · first trades 312", verdict: "HEALTHY", vc: "#60F080", vp: "+38.4%", vw: "58%" },
  { t: "$TIBIA", a: "0x91cc…07ad", tr: "2 114", h: "312", w: "0xb02c…77d1", inE: "0.40", outE: "0.00", sup: "0.63%", pnl: "−41.7%", pc: "#FF605C", others: "$HUMERUS $OSSIFY +3", traced: "61", avg: "−12.0%", wr: "31%", tag: "no badge", bands: "+4..9% · 4.2% supply · 31 wallets | −21..−16% · 15.7% · 190 | −47..−42% · 61.0% · 690", fl: "dust 88 · transfers-in 12 · infra 2 · first trades 140", verdict: "SHATTERED", vc: "#FF605C", vp: "−31.7%", vw: "36%" },
  { t: "$FEMUR", a: "0x2be0…f302", tr: "7 480", h: "287", w: "0x5d1e…a904", inE: "1.20", outE: "1.35", sup: "1.02%", pnl: "+12.4%", pc: "#FFD640", others: "$MARROW $PATELLA +9", traced: "104", avg: "+6.2%", wr: "49%", tag: "RICH", bands: "+12..17% · 12.1% supply · 96 wallets | 0..+5% · 38.6% · 410 | −12..−7% · 27.3% · 388", fl: "dust 41 · transfers-in 20 · infra 1 · first trades 77", verdict: "CRACKED", vc: "#FFD640", vp: "+4.1%", vw: "47%" },
];

export type LogLine = [stage: number, tag: string, text: string, color: string];

const C = "#78DCFF";
export function script(k: DemoTok): LogLine[] {
  return [
    [0, "SCANNER", `${k.t} · ${k.a} · fetching swaps from block 59 570 827`, C],
    [0, "SCANNER", `${k.tr} trades pulled · ${k.h} holders`, C],
    [1, "LEDGER", `${k.w} · in ${k.inE} ETH · out ${k.outE} ETH · holds ${k.sup}`, C],
    [1, "LEDGER", `${k.w} · pnl here ${k.pnl}`, k.pc],
    [2, "TRACER", `${k.w} → ${k.others} more tokens`, C],
    [2, "TRACER", `${k.traced} wallets with ≥ 5 past Pons trades`, C],
    [3, "AUDITOR", `${k.w} · avg ${k.avg} / trade · winrate ${k.wr} → ${k.tag}`, C],
    [4, "SORTER", `pnl bands · ${k.bands}`, C],
    [5, "FLAGGER", k.fl, C],
    [6, "VERDICT", `${k.t} · ${k.verdict} · avg pnl ${k.vp} · winrate ${k.vw}`, k.vc],
  ];
}

/** Agent walk-and-talk scenarios for the home visualization. */
export const TALK: [number, number, [string, string]][] = [
  [0, 1, ["18 920 trades in. all yours.", "on it. rebuilding books."]],
  [1, 3, ["0x3f9a…c21e · in 2.1 out 0.9 - your read?", "wr 67% over 48. smart money."]],
  [2, 4, ["212 traced. bands ready?", "+40..45 holds 31% of supply."]],
  [5, 1, ["214 dust wallets - drop them.", "dropped. 87 unknown basis left."]],
  [4, 3, ["band −15..−10 is heavy.", "they lose elsewhere too."]],
  [3, 5, ["first-ever trades?", "312. kept out of the averages."]],
  [2, 0, ["need the swaps before block 59.57M", "pulling them now."]],
  [0, 5, ["3 wallets look like infra.", "flagged. never averaged."]],
  [4, 1, ["who holds the top 1%?", "14 wallets. 9 of them smart."]],
  [3, 2, ["same wallet on $FEMUR?", "yes - exited at 2.1x."]],
];

// --- terminal: agents, grades, rows, picks ---

export interface AgentMeta {
  name: string;
  src: string;
  cap: string;
  done: string;
  run: string;
}

export const AGENTS: AgentMeta[] = [
  { name: "SCANNER", src: "/assets/work-scanner.gif", cap: "pulling every trade of this token", done: "1 043 holders · 18 920 trades", run: "pulling trades…" },
  { name: "LEDGER", src: "/assets/work-ledger.gif", cap: "rebuilding each wallet's book", done: "1 043 books rebuilt", run: "rebuilding books…" },
  { name: "TRACER", src: "/assets/work-tracer.gif", cap: "following the same wallets across other tokens", done: "212 wallets traced", run: "reading wallet histories, this usually takes ~20s…" },
  { name: "AUDITOR", src: "/assets/work-auditor.gif", cap: "avg pnl and winrate, wallet by wallet", done: "winrate for 212 · pnl for 956", run: "auditing…" },
  { name: "SORTER", src: "/assets/work-sorter.gif", cap: "banding holders by pnl", done: "3 bands · 72.5% of supply", run: "banding…" },
  { name: "FLAGGER", src: "/assets/work-flagger.gif", cap: "dust, transfers in, first-ever trades", done: "619 flagged", run: "flagging…" },
];

export interface GradeFixture {
  label: string;
  color: string;
  sprite: string;
  pnl: string;
  winrate: string;
  counted: string;
  traced: string;
  hint: string;
  exited: string;
  exitPnl: string;
  exitColor: string;
  exitWr: string;
  total: string;
  groups: [supply: number, wallets: number, range: string, mid: number, avg: string][];
  bias: number;
}

export const GRADES: Record<Grade, GradeFixture> = {
  healthy: { label: "HEALTHY", color: "#60F080", sprite: "h-healthy.png", pnl: "+38.4%", winrate: "58%", counted: "956", traced: "212", hint: "holders in profit and they know how to trade", exited: "188", exitPnl: "+61.0%", exitColor: "#60F080", exitWr: "63%", total: "1 043",
    groups: [[31.2, 188, "+40..45%", 41, "+41.0%"], [22.9, 302, "+6..11%", 8, "+8.2%"], [18.4, 553, "−15..−10%", -13, "−12.5%"]], bias: 1 },
  cracked: { label: "CRACKED", color: "#FFD640", sprite: "h-cracked.png", pnl: "+4.1%", winrate: "47%", counted: "901", traced: "176", hint: "flat book, average traders - could go either way", exited: "264", exitPnl: "+12.3%", exitColor: "#60F080", exitWr: "49%", total: "1 043",
    groups: [[12.1, 96, "+12..17%", 14, "+14.0%"], [38.6, 410, "0..+5%", 2, "+2.1%"], [27.3, 388, "−12..−7%", -10, "−9.8%"]], bias: 0 },
  shattered: { label: "SHATTERED", color: "#FF605C", sprite: "h-shattered.png", pnl: "−31.7%", winrate: "36%", counted: "874", traced: "141", hint: "most holders underwater and they lose elsewhere too", exited: "402", exitPnl: "−22.8%", exitColor: "#FF605C", exitWr: "38%", total: "1 043",
    groups: [[4.2, 31, "+4..9%", 6, "+6.0%"], [15.7, 190, "−21..−16%", -18, "−18.3%"], [61.0, 690, "−47..−42%", -44, "−44.1%"]], bias: -1 },
};

export interface HolderRowFixture {
  addr: string;
  supply: string;
  pnl: string;
  pnlColor: string;
  avg: string;
  avgColor: string;
  winrate: string;
  badges: { text: string; color: string }[];
}

const HEX = "0123456789abcdef";
function rnd(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807 + 11) % 2147483647;
    return s / 2147483647;
  };
}

/** Deterministic fixture holder rows, verbatim port from the prototype. */
export function makeRows(bias: number): HolderRowFixture[] {
  const r = rnd(42 + bias * 7);
  const rows: HolderRowFixture[] = [];
  for (let i = 0; i < 40; i++) {
    let a = "0x";
    for (let k = 0; k < 4; k++) a += HEX[Math.floor(r() * 16)];
    a += "…";
    for (let k = 0; k < 4; k++) a += HEX[Math.floor(r() * 16)];
    const supply = Math.max(0.05, 6.2 * Math.pow(0.85, i) * (0.7 + r() * 0.6));
    const pnl = (r() - 0.5 + bias * 0.25) * 240;
    const avg = (r() - 0.5 + bias * 0.2) * 80;
    const wr = Math.round(30 + r() * 45 + bias * 8);
    const badges: { text: string; color: string }[] = [];
    if (wr >= 55) badges.push({ text: "SMART", color: "#78DCFF" });
    if (supply >= 1) badges.push({ text: "WHALE", color: "#FFD640" });
    if (!badges.length && r() > 0.6) badges.push({ text: r() > 0.5 ? "FIRST TRADE" : "TRANSFER IN", color: "#6E8291" });
    const col = (v: number) => (v > 20 ? "#60F080" : v < -20 ? "#FF605C" : "#FFD640");
    const fmt = (v: number) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1) + "%";
    rows.push({ addr: a, supply: supply.toFixed(2) + "%", pnl: fmt(pnl), pnlColor: col(pnl), avg: fmt(avg), avgColor: col(avg), winrate: wr + "%", badges });
  }
  return rows;
}

export interface PickFixture {
  addr: string;
  age: string;
  stage: string;
  mcap: string;
  holders: string;
}

export const PICKS: PickFixture[] = [
  { addr: "0x7a3f19c0…9c41", age: "3h 12m", stage: "graduated · V4", mcap: "$412k", holders: "1 043" },
  { addr: "0x2be0d7a1…f302", age: "6d 4h", stage: "graduated · V4", mcap: "$38k", holders: "287" },
  { addr: "0x91cc40e8…07ad", age: "41m", stage: "curve · 62%", mcap: "$9.1k", holders: "64" },
  { addr: "0xd4407b19…5e6f", age: "19d", stage: "dead", mcap: "$310", holders: "12" },
];

export function cardDataFor(grade: Grade, time = "2026-09-16 16:29 UTC"): CardData {
  const G = GRADES[grade];
  return {
    ticker: "$MARROW",
    addr: "0x7a3f19c0b8e2d4a6f51c93e0a7b2d8f4c6e19c41",
    pnl: G.pnl,
    winrate: G.winrate,
    grade,
    gradeColor: G.color,
    gradeLabel: G.label,
    hint: G.hint,
    time,
    groups: G.groups.map((x) => ({ supply: x[0], range: x[2], mid: x[3], wallets: x[1] })),
  };
}

import { NextRequest, NextResponse } from "next/server";
import { GRADES, makeRows } from "../../../lib/site/fixtures";
import type { Grade, Scan } from "../../../lib/site/types";

// Fixture scan endpoint. When the engine lands, this route calls it
// instead; the response contract stays the same.
export function GET(req: NextRequest): NextResponse<Scan> {
  const grade = (req.nextUrl.searchParams.get("grade") ?? "healthy") as Grade;
  const G = GRADES[grade] ?? GRADES.healthy;
  const scan: Scan = {
    token: { ticker: "$MARROW", address: "0x7a3f19c0b8e2d4a6f51c93e0a7b2d8f4c6e19c41", age: "3h 12m", stage: "graduated", mcap: "$412k", liquidity: "$58k", vol24h: "$1.21M", holders: "1 043" },
    verdict: { pnl: G.pnl, winrate: G.winrate, counted: Number(G.counted), traced: Number(G.traced), grade, hint: G.hint },
    bands: G.groups.map(([supply, wallets, wr, avgPnl]) => ({ supply, wrFrom: wr, wrTo: wr + 5, wallets, avgPnl })),
    holders: makeRows(G.bias).slice(0, 40).map((r) => ({ addr: r.addr, supply: r.supply, pnlHere: r.pnl, avgPnl: r.avg, winrate: r.winrate, badges: r.badges.map((b) => b.text) })),
    flags: { dust: 214, transfersIn: 87, infra: 6, firstTrades: 312 },
  };
  return NextResponse.json(scan);
}

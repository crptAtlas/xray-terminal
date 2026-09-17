import { NextResponse } from "next/server";
import type { WalletScan } from "../../../lib/site/types";

// Fixture wallet endpoint; same deal as /api/scan.
export function GET(): NextResponse<WalletScan> {
  const scan: WalletScan = {
    addr: "0x3f9a71c22d84b6e09fa4c17d20b9e8a3f56cc21e",
    firstTrade: "2026-08-03",
    lastTrade: "2026-09-16",
    badges: ["SMART", "RICH"],
    avgPnl: "+38.4%",
    medianPnl: "+21.0%",
    winrate: "67%",
    closedTrades: 48,
    tokensTouched: 19,
    openPositions: 4,
    totalProfit: "12.4 ETH",
    tokens: [
      { name: "$MARROW", status: "holding", supply: "4.21%", pnl: "+184.2%", held: "3h", grade: "healthy" },
      { name: "$FEMUR", status: "exited", supply: "0%", pnl: "+41.0%", held: "2d", grade: "cracked" },
      { name: "$TIBIA", status: "exited", supply: "0%", pnl: "−12.7%", held: "6h", grade: "shattered" },
    ],
  };
  return NextResponse.json(scan);
}

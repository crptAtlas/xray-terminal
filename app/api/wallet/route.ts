import { NextRequest, NextResponse } from "next/server";
import { BitqueryProvider } from "../../../lib/providers/bitquery.ts";
import { looksLikeAddress } from "../../../lib/read/launches.ts";
import { Cache } from "../../../lib/cache.ts";
import { cachePath } from "../../../lib/site/live";

export const maxDuration = 60;

// One wallet, read (mode B): the wallet's Pons record via Bitquery -
// per-token trades, closed positions, winrate, badges. 24h cached.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const wallet = (req.nextUrl.searchParams.get("address") ?? "").trim().toLowerCase();
  if (!looksLikeAddress(wallet)) {
    return NextResponse.json({ error: "not an address" }, { status: 400 });
  }
  if (!process.env.BITQUERY_TOKEN) {
    return NextResponse.json({ error: "mode B is not configured" }, { status: 503 });
  }
  const cache = new Cache(cachePath());
  try {
    const provider = new BitqueryProvider();
    const byToken = await provider.walletTrades(wallet);
    const remainingOf = (token: string): bigint => {
      let bal = 0n;
      for (const t of byToken.get(token) ?? []) bal += t.kind === "buy" ? t.tokens : -t.tokens;
      return bal > 0n ? bal : 0n;
    };
    const { walletProfile } = await import("../../../lib/read/wallet.ts");
    const profile = await walletProfile(provider, cache, wallet);

    const fmt = (v: number | null, d = 1) => (v === null ? null : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`);
    const tokens = [...byToken.entries()]
      .map(([token, trades]) => {
        const remaining = remainingOf(token);
        let bought = 0n, cost = 0n, sold = 0n, proceeds = 0n, lastBlock = 0n;
        for (const t of trades) {
          if (t.kind === "buy") { bought += t.tokens; cost += t.eth; } else { sold += t.tokens; proceeds += t.eth; }
          if (t.block > lastBlock) lastBlock = t.block;
        }
        const open = remaining > 0n;
        const pnlWei = proceeds - cost; // realized; open value needs a price
        const pnlPct = cost > 0n && !open ? (Number(pnlWei) / Number(cost)) * 100 : null;
        return { token, trades: trades.length, status: open ? "holding" : "exited", pnlPct, lastBlock: lastBlock.toString() };
      })
      .sort((a, b) => Number(BigInt(b.lastBlock) - BigInt(a.lastBlock)));

    return NextResponse.json({
      addr: wallet,
      trades: profile.trades,
      wins: profile.wins,
      avgPnl: fmt(profile.avgPnlPerTrade),
      winrate: profile.winrate === null ? null : profile.winrate.toFixed(0) + "%",
      realized: `${profile.realizedTotalEth >= 0 ? "+" : "−"}${Math.abs(profile.realizedTotalEth).toFixed(3)} ETH`,
      realizedPositive: profile.realizedTotalEth >= 0,
      balance: profile.balanceEth.toFixed(3) + " ETH",
      badges: profile.badges.map((b) => b.toUpperCase()),
      tokensTouched: byToken.size,
      openPositions: tokens.filter((t) => t.status === "holding").length,
      tokens: tokens.slice(0, 20).map((t) => ({
        token: t.token,
        trades: t.trades,
        status: t.status,
        pnl: t.pnlPct === null ? "—" : fmt(t.pnlPct),
        pnlNum: t.pnlPct,
      })),
      window: "realtime window of the current Bitquery plan (last few days)",
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  } finally {
    cache.close();
  }
}

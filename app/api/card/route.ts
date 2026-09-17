import { NextRequest, NextResponse } from "next/server";
import { cardDataFor } from "../../../lib/site/fixtures";
import { renderCardPng } from "../../../lib/site/card-server";
import { runScan } from "../../../lib/site/live";
import { looksLikeAddress } from "../../../lib/read/launches.ts";

export const maxDuration = 60;

// OG card: /api/card?token=0x… renders the live card when the scan fits in
// the crawler's patience, otherwise falls back to the demo card so the
// unfurl always shows something branded.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim().toLowerCase();
  let data = cardDataFor("healthy");
  if (looksLikeAddress(token)) {
    try {
      const scan = await Promise.race([
        runScan(token, () => {}),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("og timeout")), 8500)),
      ]);
      data = scan.card;
    } catch {
      /* fall back to the demo card */
    }
  }
  const png = await renderCardPng(data);
  return new NextResponse(new Uint8Array(png), {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=300, s-maxage=300",
    },
  });
}

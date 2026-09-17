import { NextRequest } from "next/server";
import { Cache } from "../../../../lib/cache.ts";
import { cachePath, resolveQuery, runScan } from "../../../../lib/site/live";

export const maxDuration = 300;

// Live scan over the engine (mode A), streamed as SSE: stage events while
// the agents work, then a single result payload. The terminal's agent row
// is driven by these events - it is the engine's real progress.
export function GET(req: NextRequest): Response {
  const q = (req.nextUrl.searchParams.get("token") ?? "").trim();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        if (!q) {
          send("error", { kind: "nodata", message: "empty query" });
          return;
        }
        const cache = new Cache(cachePath());
        let outcome;
        try {
          outcome = await resolveQuery(q, cache);
        } finally {
          cache.close();
        }
        if (outcome.error) {
          send("error", outcome.error);
          return;
        }
        if (outcome.picks) {
          send("picks", outcome.picks);
          return;
        }
        const result = await runScan(
          outcome.address!,
          (e) => send("stage", e),
          (partial) => send("result", partial),
        );
        send("result", result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send("error", {
          kind: msg.includes("not a Pons") ? "notpons" : "nodata",
          message: msg,
        });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

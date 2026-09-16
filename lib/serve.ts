import { createServer, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Cache } from "./cache.ts";
import { check } from "./check.ts";
import { isDead, type CheckResult } from "./format.ts";
import { cardGrade } from "./card.ts";
import type { Provider } from "./providers/provider.ts";
import { looksLikeAddress } from "./read/launches.ts";

/**
 * Local web terminal: one static page (site/index.html) plus a JSON/SSE API
 * over the library, bound to 127.0.0.1. The site makes no external
 * requests: fonts and sprites are served from assets/brand.
 *
 *   GET /                      the terminal page
 *   GET /brand/<file>          brand assets (sprites, fonts, css)
 *   GET /favicon.png           the skull sprite
 *   GET /api/check?token=0x..  SSE: stage events, then phase payloads
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const BRAND = join(ROOT, "assets", "brand");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".gif": "image/gif",
  ".ttf": "font/ttf",
  ".json": "application/json",
};

function sendFile(res: ServerResponse, path: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(path)] ?? "application/octet-stream",
    "cache-control": "max-age=3600",
  });
  createReadStream(path).pipe(res);
}

export function payloadOf(result: CheckResult, final: boolean) {
  const { snapshot: s, header: h } = result;
  return {
    final,
    demo: result.demo ?? false,
    dead: isDead(result),
    grade: cardGrade(result),
    token: { address: s.meta.address, symbol: s.meta.symbol, phase: s.meta.phase },
    header: h,
    aggregates: result.aggregates,
    groups: result.groups,
    top: result.top.map((t) => ({
      wallet: t.wallet,
      supplyShare: t.supplyShare,
      pnlPct: t.position.pnlPct,
      extras: result.topExtras?.get(t.wallet) ?? null,
    })),
    excluded: s.excluded,
    source: result.source,
  };
}

export interface ServeOpts {
  port?: number;
  top?: number;
  makeProvider: () => Provider | Promise<Provider>;
  cachePath?: string; // ":memory:" for demo
  resolveQuery?: (provider: Provider, cache: Cache, q: string) => Promise<string>;
}

export function startServer(opts: ServeOpts) {
  const port = opts.port ?? 4663;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/") return sendFile(res, join(SITE, "index.html"));
    if (path === "/agents.css") return sendFile(res, join(SITE, "agents.css"));
    if (path === "/favicon.png") return sendFile(res, join(BRAND, "logo-sprite.png"));
    if (path.startsWith("/brand/")) {
      const rel = normalize(path.slice("/brand/".length));
      if (rel.startsWith("..")) return void res.writeHead(400).end();
      return sendFile(res, join(BRAND, rel));
    }

    if (path === "/api/check") {
      const q = (url.searchParams.get("token") ?? "").trim().toLowerCase();
      if (!q) return void res.writeHead(400).end("token required");
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`);
      const cache = new Cache(opts.cachePath);
      const t0 = Date.now();
      try {
        const provider = await opts.makeProvider();
        let address = q;
        if (!looksLikeAddress(q)) {
          if (!opts.resolveQuery) throw new Error("enter a token contract address (0x...)");
          address = await opts.resolveQuery(provider, cache, q);
        }
        let result: CheckResult | null = null;
        for await (const phase of check(provider, cache, address as `0x${string}`, {
          onStage: (e) => send("stage", e),
        })) {
          const st = provider.stats();
          const source = { label: st.label, requests: st.requests, seconds: (Date.now() - t0) / 1000 };
          if (phase.phase === 1) {
            result = {
              snapshot: phase.snapshot,
              header: phase.header,
              groups: phase.groups,
              aggregates: phase.aggregates,
              top: phase.snapshot.holders.slice(0, opts.top ?? 10),
              source,
              demo: opts.cachePath === ":memory:" || undefined,
            };
            send("result", payloadOf(result, !provider.supportsProfiles));
          } else if (result) {
            const prev: CheckResult = result;
            result = {
              ...prev,
              aggregates: phase.aggregates,
              topExtras: new Map(
                prev.top.map((t) => {
                  const p = phase.profiles.get(t.wallet);
                  return [
                    t.wallet,
                    {
                      avgPnlPerTrade: p?.avgPnlPerTrade ?? null,
                      winrate: p?.winrate ?? null,
                      trades: p ? p.trades : null,
                      badges: p?.badges ?? [],
                      notRead: p?.notRead,
                    },
                  ];
                }),
              ),
              source,
            };
            send("result", payloadOf(result, true));
          }
        }
        send("done", {});
      } catch (err) {
        send("error", { message: err instanceof Error ? err.message : String(err) });
      } finally {
        cache.close();
        res.end();
      }
      return;
    }

    res.writeHead(404).end("not found");
  });

  server.listen(port, "127.0.0.1");
  return server;
}

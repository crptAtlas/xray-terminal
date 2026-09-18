"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AGENTS, GRADES, PICKS, pnlColor, cardDataFor, makeRows } from "../lib/site/fixtures";
import type { LiveScan } from "../lib/site/live";
import type { CardData, Grade } from "../lib/site/types";
import { CardLightbox, useCardActions, useCardUrl } from "./share-card";
import { AgentGif } from "./motion";

// The terminal. Live queries stream real engine stages over SSE from
// /api/scan/stream (phase 1: pnl, bands, header, grade, card; phase 2
// will fill winrate, badges and profiles). The design prototype's demo
// tokens ($MARROW and friends) still run on fixtures so the interface can
// be toured offline.

type View = "empty" | "pick" | "running" | "result" | "error-notpons" | "error-young" | "error-nodata";

const ERRS: Record<string, [string, string, string]> = {
  "error-notpons": [
    "not a Pons token",
    "this address is not a token launched through Pons V2 on Robinhood Chain. paste the token contract, not a wallet or a pair.",
    "clear",
  ],
  "error-young": [
    "too young to read",
    "the token is 2 minutes old - fewer than ten trades on the book. come back after five minutes.",
    "retry",
  ],
  "error-nodata": [
    "chain data did not arrive",
    "the indexer timed out on this token. nothing is cached - press scan again.",
    "retry",
  ],
};

const DEMO_ADDR = "0x7a3f19c0b8e2d4a6f51c93e0a7b2d8f4c6e19c41";
const STAGE_INDEX: Record<string, number> = { scanner: 0, ledger: 1, tracer: 2, auditor: 3, sorter: 4, flagger: 5 };

interface StageState {
  status: "idle" | "start" | "done" | "skip";
  detail?: string;
}

interface PickRow {
  addr: string;
  addrFull?: string;
  age: string;
  stage: string;
  mcap: string;
  holders: string;
}

function useIsMobile(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = matchMedia("(max-width:760px)");
    const upd = () => setM(mq.matches);
    upd();
    mq.addEventListener("change", upd);
    return () => mq.removeEventListener("change", upd);
  }, []);
  return m;
}

const freshStages = (): StageState[] => AGENTS.map(() => ({ status: "idle" }));

export function Terminal() {
  const params = useSearchParams();
  const fixtureGrade = (["healthy", "cracked", "shattered"].includes(params.get("grade") ?? "") ? params.get("grade") : "healthy") as Grade;
  const G = GRADES[fixtureGrade];
  const initialQ = params.get("q") ?? params.get("token") ?? "";
  const initialView = (params.get("view") as View) ?? null;

  const [view, setView] = useState<View>("empty");
  const [step, setStep] = useState(0); // fixture demo runs
  const [query, setQuery] = useState(initialQ);
  const [loaded, setLoaded] = useState(10);
  const [copied, setCopied] = useState(false);
  const [linked, setLinked] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const [live, setLive] = useState<LiveScan | null>(null);
  const [liveStages, setLiveStages] = useState<StageState[]>(freshStages);
  const [livePicks, setLivePicks] = useState<PickRow[] | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [isLiveRun, setIsLiveRun] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const es = useRef<EventSource | null>(null);
  const isMobile = useIsMobile();

  const cardData: CardData = useMemo(() => (live ? live.card : cardDataFor(fixtureGrade)), [live, fixtureGrade]);
  const cardUrl = useCardUrl(cardData);
  const cardFile = `xray-${cardData.ticker.replace("$", "")}.png`;
  const { copied: copiedImg, copy: copyImage, download: downloadImage } = useCardActions(cardData, cardFile);

  const stopAll = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    if (es.current) {
      es.current.close();
      es.current = null;
    }
  }, []);

  const startFixture = useCallback(() => {
    stopAll();
    setIsLiveRun(false);
    setLive(null);
    setView("running");
    setStep(0);
    setLoaded(0);
    timer.current = setInterval(() => {
      setStep((s) => {
        if (s + 1 >= 6) {
          if (timer.current) clearInterval(timer.current);
          setView("result");
          setLoaded(10);
          return 6;
        }
        return s + 1;
      });
    }, 1600);
  }, [stopAll]);

  const startLive = useCallback(
    (q: string) => {
      stopAll();
      setIsLiveRun(true);
      setLive(null);
      setLiveError(null);
      setLivePicks(null);
      setLiveStages(freshStages());
      setView("running");
      setLoaded(10);
      const src = new EventSource(`/api/scan/stream?token=${encodeURIComponent(q)}`);
      es.current = src;
      src.addEventListener("stage", (e) => {
        const ev = JSON.parse((e as MessageEvent).data) as { agent: string; status: "start" | "done" | "skip"; detail?: string };
        const idx = STAGE_INDEX[ev.agent];
        if (idx === undefined) return;
        setLiveStages((s) => {
          const next = s.slice();
          next[idx] = { status: ev.status, detail: ev.detail };
          return next;
        });
      });
      src.addEventListener("picks", (e) => {
        setLivePicks(JSON.parse((e as MessageEvent).data) as PickRow[]);
        setView("pick");
        src.close();
      });
      src.addEventListener("result", (e) => {
        setLive(JSON.parse((e as MessageEvent).data) as LiveScan);
        setView("result");
        src.close();
      });
      src.addEventListener("error", (e) => {
        const data = (e as MessageEvent).data as string | undefined;
        if (data) {
          // a real error event from the engine
          const err = JSON.parse(data) as { kind: string; message: string };
          setLiveError(err.message);
          setView(err.kind === "notpons" ? "error-notpons" : "error-nodata");
          src.close();
        }
        // otherwise: transport hiccup - EventSource reconnects on its own
        // and the incremental cache makes the retry cheaper than the run
        // it replaces, so stay in the running view
      });
    },
    [stopAll],
  );

  const scan = useCallback(
    (raw?: string) => {
      const q = (raw ?? query).trim();
      setQuery(q);
      const bare = q.replace(/^\$/, "").toUpperCase();
      if (!q) return startFixture();
      // prototype demo triggers keep working offline
      if (q.toLowerCase() === DEMO_ADDR) return startFixture();
      if (bare === "MARROW") {
        setLivePicks(null);
        setIsLiveRun(false);
        return setView("pick");
      }
      if (/young|^new$|min/i.test(q)) return setView("error-young");
      if (/nodata|timeout/i.test(q)) return setView("error-nodata");
      if (/^0x/i.test(q) && q.length < 42) return setView("error-notpons");
      startLive(q);
    },
    [query, startFixture, startLive],
  );

  useEffect(() => {
    if (initialView === "result") {
      setView("result");
      setStep(6);
    } else if (initialQ) {
      scan(initialQ);
    }
    return stopAll;
    // run once on mount with the url params
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isRunning = view === "running";
  const isResult = view === "result";
  const isError = view.startsWith("error");
  const isPick = view === "pick";
  const err = ERRS[view] ?? ["", "", ""];
  const errBody = liveError && isError ? liveError : err[1];

  // ---- view model: the live payload or the design fixtures ----
  const fixtureRows = useMemo(() => makeRows(G.bias), [G.bias]);
  const D = useMemo(() => {
    if (live) {
      return {
        token: live.token,
        pnl: live.verdict.pnl as string | null,
        pnlNum: live.verdict.pnlNum,
        holdersPnl: live.verdict.holdersPnl,
        holdersPnlNum: live.verdict.holdersPnlNum,
        holdersPnlWallets: live.verdict.holdersPnlWallets,
        median: live.verdict.median,
        inProfit: live.verdict.inProfit as number | null,
        profilesRead: live.profilesRead ?? null,
        bandCoverage: live.bandCoverage as string | null,
        winrate: live.verdict.winrate,
        counted: String(live.verdict.counted),
        traced: live.verdict.traced === null ? null : String(live.verdict.traced),
        gradeColor: live.card.gradeColor,
        dead: live.dead,
        bands: live.bands.map((b) => ({ range: b.range, color: pnlColor(b.mid), supply: b.supply + "%", wallets: b.wallets, avg: b.avg, avgColor: b.avg.startsWith("+") ? "var(--profit)" : b.avg === "—" ? "var(--text-dim)" : "var(--loss)" })),
        rows: live.holders.map((r) => ({ addr: r.addr, addrFull: r.addrFull as string | undefined, supply: r.supply, pnl: r.pnlHere, pnlColor: r.pnlNum === null ? "var(--text-dim)" : pnlColor(r.pnlNum), avg: r.avgPnl ?? "—", avgColor: r.avgPnlNum === null || r.avgPnlNum === undefined ? "var(--text-dim)" : pnlColor(r.avgPnlNum), winrate: r.winrate ?? "—", badges: r.badges })),
        exited: { wallets: String(live.exited.wallets), pnl: live.exited.avgPnl ?? "—", pnlColor: live.exited.avgPnl?.startsWith("+") ? "var(--profit)" : "var(--loss)", wr: "—" },
        flags: [
          ["dust", String(live.flags.dust)],
          ["unknown cost basis", `${live.flags.unknownBasis} (${live.flags.unknownSupplyPct} supply)`],
          ["infrastructure", String(live.flags.infra)],
          ["first-ever trades", live.flags.firstTrades ?? "reading…"],
        ] as [string, string][],
        total: String(live.totalHolders),
        source: live.source as { label: string; requests: number; seconds: number } | null,
      };
    }
    return {
      token: { ticker: "$MARROW", address: DEMO_ADDR, age: "3h 12m", stage: "graduated", mcap: "$412k", liquidity: "$58k", vol24h: "$1.21M", holders: "1 043" },
      pnl: G.pnl as string | null,
      pnlNum: parseFloat(G.pnl.replace("−", "-")) as number | null,
      holdersPnl: G.pnl as string | null,
      holdersPnlNum: parseFloat(G.pnl.replace("−", "-")) as number | null,
      holdersPnlWallets: 0,
      median: null as string | null,
      inProfit: null as number | null,
      profilesRead: null as number | null,
      bandCoverage: null as string | null,
      winrate: G.winrate as string | null,
      counted: G.counted,
      traced: G.traced as string | null,
      gradeColor: G.color,
      dead: false,
      bands: G.groups.map((x) => ({ range: x[2], color: pnlColor(x[3]), supply: x[0] + "%", wallets: x[1], avg: x[4], avgColor: x[4].startsWith("+") ? "var(--profit)" : "var(--loss)" })),
      rows: fixtureRows.map((r) => ({ addr: r.addr, addrFull: undefined as string | undefined, supply: r.supply, pnl: r.pnl, pnlColor: r.pnlColor, avg: r.avg, avgColor: r.avgColor, winrate: r.winrate, badges: r.badges })),
      exited: { wallets: G.exited, pnl: G.exitPnl, pnlColor: G.exitColor, wr: G.exitWr },
      flags: [
        ["dust", "214"],
        ["unknown cost basis", "87"],
        ["infrastructure", "6"],
        ["first-ever trades", "312"],
      ] as [string, string][],
      total: G.total,
      source: null as { label: string; requests: number; seconds: number } | null,
    };
  }, [live, G, fixtureRows]);

  const rows = D.rows.slice(0, loaded);
  const picks: PickRow[] = livePicks ?? PICKS;

  // loader: fixture demo runs on `step`; live runs on real stage events
  const liveDone = liveStages.filter((s) => s.status === "done" || s.status === "skip").length;
  const liveActiveIdx = liveStages.findIndex((s) => s.status === "start");
  const stageIdx = isLiveRun ? (liveActiveIdx >= 0 ? liveActiveIdx : Math.min(liveDone, 5)) : Math.min(step, 5);
  // the bar creeps steadily toward the next stage boundary so a long
  // stage never looks frozen; a completed stage snaps it forward
  const [smooth, setSmooth] = useState(0);
  const stageTarget = isRunning ? (isLiveRun ? liveDone : step) / 6 : 0;
  useEffect(() => {
    if (!isRunning) {
      setSmooth(0);
      return;
    }
    const floor = stageTarget * 100;
    const ceil = Math.min((stageTarget + 1 / 6) * 100 - 2, 98);
    setSmooth((s) => Math.max(s, floor));
    const t = setInterval(() => {
      setSmooth((s) => (s < ceil ? Math.min(s + Math.max(0.15, (ceil - s) * 0.02), ceil) : s));
    }, 250);
    return () => clearInterval(t);
  }, [isRunning, stageTarget]);
  const progress = isRunning ? Math.round(smooth) : 0;

  const showHeader = isResult || (!isLiveRun && isRunning && step >= 1);
  const showScore = (isResult || (!isLiveRun && isRunning && step >= 4)) && !D.dead;
  const showGroups = (isResult || (!isLiveRun && isRunning && step >= 5)) && !D.dead;
  const showTable = isResult && !D.dead;

  const pnlPos = D.pnlNum === null ? 0 : Math.max(0, Math.min(100, (D.pnlNum + 100) / 3));
  const holdersPnlPos = D.holdersPnlNum === null ? 0 : Math.max(0, Math.min(100, (D.holdersPnlNum + 100) / 3));
  const wrPos = D.winrate === null ? 0 : parseFloat(D.winrate);
  const glowColor = D.gradeColor + "55";

  const smallBtn: React.CSSProperties = {
    fontFamily: "inherit",
    fontSize: 13,
    background: "transparent",
    color: "var(--accent)",
    border: "1px solid var(--border)",
    padding: "10px 16px",
    cursor: "pointer",
  };

  const metric = (
    label: string,
    value: string | null,
    valueColor: string,
    pos: number,
    scale: [string, string, string, string],
    across: React.ReactNode,
    extraStyle: React.CSSProperties,
  ) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0, ...extraStyle }}>
      <div style={{ fontSize: 11, color: "var(--text-dim)", letterSpacing: ".14em", textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
      <div className="tabular" style={{ fontWeight: 700, fontSize: isMobile ? 48 : 56, lineHeight: 1, color: value === null ? "var(--bone-dark)" : valueColor, letterSpacing: "-.03em", textShadow: value === null ? "none" : `0 0 18px ${valueColor},0 0 40px ${valueColor}55`, whiteSpace: "nowrap" }}>{value ?? "—"}</div>
      <div style={{ position: "relative", height: 8, marginTop: 6 }}>
        <div style={{ position: "absolute", inset: 0, display: "flex", gap: 2 }}>
          <div style={{ flex: 1, background: "rgba(255,96,92,.35)" }} />
          <div style={{ flex: 1, background: "rgba(255,214,64,.35)" }} />
          <div style={{ flex: 1, background: "rgba(96,240,128,.35)" }} />
        </div>
        {value !== null && (
          <div style={{ position: "absolute", top: -5, bottom: -5, left: `${pos}%`, width: 4, marginLeft: -2, background: "var(--bone-bright)", boxShadow: "0 0 10px rgba(230,252,255,.9)", transition: "left 1s ease" }} />
        )}
      </div>
      <div className="tabular" style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--bone-dark)" }}>
        {scale.map((s) => (
          <span key={s}>{s}</span>
        ))}
      </div>
      <div style={{ fontSize: 12, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{across}</div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* input */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", gap: 0, border: `1px solid ${isError ? "var(--loss)" : isRunning ? "var(--bone-mid)" : "var(--border)"}`, background: "var(--bg-panel)" }}>
          <span style={{ padding: "14px 0 14px 16px", fontSize: 14, color: "var(--bone-mid)" }}>&gt;</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") scan();
            }}
            placeholder="paste a contract address or a ticker"
            style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: "var(--bone-bright)", fontSize: 14, padding: "14px 12px" }}
          />
          <button
            onClick={() => scan()}
            style={{ fontFamily: "inherit", fontSize: 14, fontWeight: 700, letterSpacing: ".08em", background: isRunning ? "var(--bone-mid)" : "var(--accent)", color: "var(--bg-deep)", border: "none", padding: "0 28px", cursor: "pointer", boxShadow: "0 0 24px rgba(120,220,255,.4)" }}
          >
            {isRunning ? "SCANNING" : "SCAN"}
          </button>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, fontSize: 12, color: "var(--text-dim)", flexWrap: "wrap" }}>
          <span>reads public state only - no wallet connect, no signing · Robinhood Chain · Pons V2</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 6, height: 6, background: "var(--accent)", display: "inline-block", boxShadow: "0 0 8px #78DCFF" }} />
            <span className="tabular" style={{ color: "var(--text)" }}>public RPC · no keys</span>
          </span>
        </div>

        {isPick && (
          <div className="tabular" style={{ border: "1px solid var(--border)", background: "var(--bg-panel)", fontSize: 13 }}>
            <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 12 }}>
              {picks.length} launches use this ticker - pick one
            </div>
            {picks.map((p) => (
              <div
                key={p.addr}
                onClick={() => scan(p.addrFull ?? DEMO_ADDR)}
                style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr 1fr", gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--border)", cursor: "pointer", alignItems: "center" }}
              >
                <span style={{ color: "var(--bone-light)" }}>{p.addr}</span>
                <span style={{ color: "var(--text)" }}>{p.age}</span>
                <span style={{ color: "var(--text-dim)" }}>{p.stage}</span>
                <span style={{ textAlign: "right", color: "var(--text)" }}>{p.mcap}</span>
                <span style={{ textAlign: "right", color: "var(--text)" }}>{p.holders}</span>
              </div>
            ))}
          </div>
        )}

        {isError && (
          <div style={{ border: "1px solid var(--loss)", background: "var(--bg-panel)", padding: "14px 16px", display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 13, color: "var(--loss)", fontWeight: 700 }}>{err[0]}</div>
              <div style={{ fontSize: 12, color: "var(--text)" }}>{errBody}</div>
            </div>
            <button
              onClick={() => {
                setView("empty");
                setQuery("");
                setLiveError(null);
              }}
              style={{ fontFamily: "inherit", fontSize: 12, background: "transparent", color: "var(--accent)", border: "1px solid var(--border)", padding: "8px 14px", cursor: "pointer" }}
            >
              {err[2]}
            </button>
          </div>
        )}
      </div>

      {/* stage loader */}
      {!isResult && (
        <div style={{ border: "1px solid var(--border)", background: "var(--bg-panel)", padding: "14px 20px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, fontSize: 12, color: "var(--text-dim)", flexWrap: "wrap", alignItems: "baseline" }}>
            <span style={{ display: "inline-flex", gap: 10, alignItems: "baseline" }}>
              <span className="font-tiny" style={{ fontSize: 16, lineHeight: 1, color: "var(--bone-bright)", textShadow: "0 0 10px rgba(120,220,255,.6)" }}>
                {isRunning ? AGENTS[stageIdx]!.name : "IDLE"}
              </span>
              <span style={{ color: "var(--bone-light)" }}>
                {isRunning ? (isLiveRun ? liveStages[stageIdx]?.detail ?? AGENTS[stageIdx]!.cap : AGENTS[stageIdx]!.cap) : isError ? "nothing to run" : "paste a token to start the run"}
              </span>
            </span>
            <span className="tabular" style={{ color: "var(--text)" }}>
              {progress}% · {isRunning ? `stage ${Math.min(stageIdx + 1, 6)} / 6` : "waiting"}
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(3,minmax(0,1fr))" : "repeat(6,minmax(0,1fr))", gap: 8 }}>
            {AGENTS.map((a, i) => {
              const st = isLiveRun ? liveStages[i]!.status : isRunning ? (i < step ? "done" : i === step ? "start" : "idle") : "idle";
              const done = st === "done";
              const active = isRunning && st === "start";
              const skipped = st === "skip";
              return (
                <div
                  key={a.name}
                  style={{
                    position: "relative",
                    height: 104,
                    background: "var(--sprite-bg)",
                    border: `1px solid ${active ? "var(--accent)" : done ? "var(--bone-dark)" : "var(--border)"}`,
                    overflow: "hidden",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    animation: active ? "glow 1.2s ease-in-out infinite" : "none",
                    transition: "border-color .4s",
                    opacity: skipped ? 0.45 : 1,
                  }}
                >
                  <AgentGif src={a.src} style={{ width: 56, height: 62, display: "block", marginTop: -10, opacity: done || active ? 1 : 0.3, transition: "opacity .6s", filter: active ? "drop-shadow(0 0 10px rgba(120,220,255,.9))" : "none" }} />
                  {active && (
                    <div style={{ position: "absolute", left: 0, right: 0, height: 2, background: "linear-gradient(90deg,transparent,#E6FCFF 30%,#E6FCFF 70%,transparent)", boxShadow: "0 0 10px #78DCFF", animation: "expose 1.2s linear infinite" }} />
                  )}
                  {done && <div style={{ position: "absolute", top: 4, right: 6, fontSize: 11, fontWeight: 700, color: "var(--profit)" }}>✓</div>}
                  {skipped && <div style={{ position: "absolute", top: 4, right: 6, fontSize: 9, letterSpacing: ".1em", color: "var(--bone-dark)" }}>MODE B</div>}
                  <div style={{ position: "absolute", left: 6, bottom: 4, fontSize: 9, letterSpacing: ".14em", color: done ? "var(--bone-light)" : active ? "var(--bone-bright)" : "var(--bone-dark)" }}>
                    0{i + 1} {a.name}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ height: 3, background: "var(--bg-deep)", border: "1px solid var(--border)", position: "relative" }}>
            <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: `${progress}%`, background: "var(--accent)", boxShadow: "0 0 10px rgba(120,220,255,.8)", transition: "width 1.5s linear" }} />
          </div>
        </div>
      )}

      {/* empty state */}
      {view === "empty" && (
        <div style={{ border: "1px dashed var(--border)", padding: "48px 24px", textAlign: "center", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/lightbox.png" alt="" style={{ width: 64, height: 64, display: "block", opacity: 0.8 }} />
          <div className="font-tiny" style={{ fontSize: 24, lineHeight: 1, color: "var(--bone-dark)" }}>NOTHING ON THE FILM YET</div>
          <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 640 }}>
            paste a contract address or a ticker - six agents rebuild every holder&apos;s book and tell you who is in profit, who is underwater, and whether they can trade at all.
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
            live scans read the public RPC and take 10-60s · demo tour:{" "}
            <a href="#" onClick={(e) => { e.preventDefault(); scan(DEMO_ADDR); }}>0x7a3f…9c41</a> ·{" "}
            <a href="#" onClick={(e) => { e.preventDefault(); scan("MARROW"); }}>$MARROW</a> ·{" "}
            <a href="#" onClick={(e) => { e.preventDefault(); scan("young"); }}>a token launched 2 min ago</a>
          </div>
        </div>
      )}

      {/* token header */}
      {showHeader && (
        <div style={{ border: "1px solid var(--border)", background: "var(--bg-panel)", display: "grid", gridTemplateColumns: `repeat(${isMobile ? 3 : 6},minmax(0,1fr))` }}>
          <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 4, gridColumn: "1/-1", borderBottom: "1px solid var(--border)" }}>
            <div style={{ fontSize: 11, color: "var(--text-dim)", letterSpacing: ".08em", textTransform: "uppercase" }}>token</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
              <span className="font-tiny" style={{ fontSize: 24, lineHeight: 1, color: "var(--bone-bright)" }}>{D.token.ticker}</span>
              <a href={`https://robinhood.blockscout.com/token/${D.token.address}`} target="_blank" rel="noopener" style={{ fontSize: 12, color: "var(--bone-light)" }}>
                {D.token.address.slice(0, 10)}…{D.token.address.slice(-4)}
              </a>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(D.token.address);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }}
                style={{ fontFamily: "inherit", fontSize: 11, background: "transparent", color: "var(--text-dim)", border: "1px solid var(--border)", padding: "2px 6px", cursor: "pointer" }}
              >
                {copied ? "copied" : "copy"}
              </button>
            </div>
          </div>
          {[
            ["age", D.token.age],
            ["stage", D.token.stage],
            ["mcap", D.token.mcap],
            ["liquidity", D.token.liquidity],
            ["vol 24h", D.token.vol24h],
            ["holders", D.token.holders],
          ].map(([t, v]) => (
            <div key={t} style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 4, borderRight: "1px solid var(--border)", borderBottom: "1px solid var(--border)", marginRight: -1, marginBottom: -1 }}>
              <div style={{ fontSize: 11, color: "var(--text-dim)", letterSpacing: ".08em", textTransform: "uppercase" }}>{t}</div>
              <div className="tabular" style={{ fontSize: 14, color: "var(--text)", whiteSpace: "nowrap" }}>{v}</div>
            </div>
          ))}
        </div>
      )}

      {/* dead token */}
      {isResult && D.dead && (
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "minmax(0,1fr)" : "minmax(0,1fr) 520px", gap: 12, alignItems: "start" }}>
          <div style={{ border: "1px solid var(--loss)", background: "var(--bg-panel)", padding: "24px 28px", display: "flex", flexDirection: "column", gap: 16, justifyContent: "center", minWidth: 0, boxSizing: "border-box", height: isMobile ? "auto" : 520 }}>
            <div className="font-tiny" style={{ fontSize: 48, lineHeight: 1.1, color: "var(--loss)", textShadow: "0 0 24px rgba(255,96,92,.6)" }}>TOKEN IS DEAD</div>
            <div style={{ fontSize: 16, color: "var(--text)" }}>You&apos;re too early or too late.</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
              fewer than 10 wallets still hold this token · exited: {D.exited.wallets} wallets, avg pnl here <span style={{ color: D.exited.pnlColor }}>{D.exited.pnl}</span>
            </div>
            {D.source && (
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>source {D.source.label} · {D.source.requests} requests · {D.source.seconds.toFixed(1)}s</div>
            )}
          </div>
          <div
            onClick={() => cardUrl && setCardOpen(true)}
            style={{ position: "relative", width: isMobile ? "100%" : 520, height: isMobile ? "auto" : 520, aspectRatio: isMobile ? "1/1" : undefined, border: "1px solid var(--loss)", background: "var(--bg-deep)", cursor: "zoom-in", overflow: "hidden", boxSizing: "border-box" }}
          >
            {cardUrl ? (
              <div role="img" aria-label="XRAY share card" style={{ position: "absolute", inset: 0, backgroundImage: `url(${cardUrl})`, backgroundSize: "cover", backgroundPosition: "center" }} />
            ) : (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--text-dim)" }}>rendering card…</div>
            )}
          </div>
        </div>
      )}

      {/* verdict */}
      {showScore && (
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "minmax(0,1fr)" : "minmax(0,1fr) 520px", gap: 12, alignItems: "start" }}>
          <div style={{ border: "1px solid var(--border)", background: "var(--bg-panel)", padding: "24px 28px", display: "flex", flexDirection: "column", gap: 20, justifyContent: "space-between", minWidth: 0, boxSizing: "border-box", height: isMobile ? "auto" : 520, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "minmax(0,1fr)" : "repeat(2,minmax(0,1fr))", gap: 0 }}>
              {metric(
                "avg pnl / trade of holders",
                D.holdersPnl,
                D.holdersPnlNum === null ? "var(--bone-dark)" : pnlColor(D.holdersPnlNum),
                holdersPnlPos,
                ["−100%", "0", "+100%", "+200%"],
                D.holdersPnl !== null ? (
                  <>chain-wide record of <span style={{ color: "var(--text)" }}>{D.holdersPnlWallets}</span> holders · this token excluded</>
                ) : D.profilesRead !== null && D.profilesRead > 0 ? (
                  <>{D.profilesRead} wallets read · none with closed trades yet</>
                ) : (
                  <>reading wallet histories…</>
                ),
                { paddingRight: isMobile ? 0 : 24 },
              )}
              {metric(
                "avg winrate",
                D.winrate,
                D.winrate === null ? "var(--bone-dark)" : wrPos >= 55 ? "var(--profit)" : wrPos >= 45 ? "var(--neutral)" : "var(--loss)",
                wrPos,
                ["0", "33", "66", "100"],
                D.winrate !== null ? (
                  <>across <span style={{ color: "var(--text)" }}>{D.traced}</span> holders with 2+ trades</>
                ) : D.profilesRead === 0 ? (
                  <>wallet histories unavailable right now - retry the scan</>
                ) : D.profilesRead !== null ? (
                  <>{D.profilesRead} wallets read · none with 2+ closed trades yet</>
                ) : (
                  <>reading wallet histories · fills in on repeat scans</>
                ),
                isMobile ? {} : { paddingLeft: 24, borderLeft: "1px solid var(--border)" },
              )}
            </div>
            <div className="tabular" style={{ fontSize: 13, color: "var(--text-dim)", borderTop: "1px solid var(--border)", paddingTop: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              pnl on this token{" "}
              <span style={{ color: D.pnlNum === null ? "var(--text-dim)" : pnlColor(D.pnlNum), fontWeight: 700 }}>{D.pnl ?? "—"}</span>
              {D.median !== null && <> · median <span style={{ color: "var(--text)" }}>{D.median}</span></>}
              {D.inProfit !== null && <> · <span style={{ color: "var(--text)" }}>{D.inProfit}</span> of {D.counted} in profit</>}
            </div>
            {showGroups && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, borderTop: "1px solid var(--border)", paddingTop: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, whiteSpace: "nowrap" }}>
                  <div className="font-tiny" style={{ fontSize: 24, lineHeight: 1, color: "var(--bone-bright)" }}>WHO HOLDS THE SUPPLY</div>
                  <div style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis" }}>pnl bands · bar = share of supply</div>
                </div>
                {D.bands.map((gr) => (
                  <div key={gr.range} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div className="tabular" style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, whiteSpace: "nowrap" }}>
                      <span style={{ paddingRight: 4 }}>
                        <span style={{ color: gr.color, fontWeight: 700 }}>{gr.supply} of supply</span>
                        <span style={{ color: "var(--text)" }}> · pnl <span style={{ color: gr.color }}>{gr.range}</span></span>
                      </span>
                      <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>
                        <span style={{ color: "var(--text)" }}>{gr.wallets} wallets</span> · avg pnl <span style={{ color: gr.avgColor }}>{gr.avg}</span>
                      </span>
                    </div>
                    <div style={{ height: 10, background: "var(--bg-deep)", border: "1px solid var(--border)", position: "relative" }}>
                      <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: gr.supply, background: gr.color, transition: "width 1s ease" }} />
                    </div>
                  </div>
                ))}
                {D.bands.length === 0 && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>no dense pnl bands on this token</div>}
                {D.bandCoverage !== null && D.bands.length > 0 && (
                  <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                    bands cover {D.bandCoverage} of supply - the densest clusters; the rest is spread out (see the table)
                  </div>
                )}
              </div>
            )}
          </div>
          <div
            onClick={() => cardUrl && setCardOpen(true)}
            style={{ position: "relative", width: isMobile ? "100%" : 520, height: isMobile ? "auto" : 520, aspectRatio: isMobile ? "1/1" : undefined, border: "1px solid var(--accent)", background: "var(--bg-deep)", cursor: "zoom-in", overflow: "hidden", boxSizing: "border-box", boxShadow: "0 0 0 1px rgba(120,220,255,.15),0 0 48px rgba(120,220,255,.25)" }}
          >
            {cardUrl ? (
              <div role="img" aria-label="XRAY share card" style={{ position: "absolute", inset: 0, backgroundImage: `url(${cardUrl})`, backgroundSize: "cover", backgroundPosition: "center" }} />
            ) : (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--text-dim)" }}>rendering card…</div>
            )}
            <div style={{ position: "absolute", right: 8, bottom: 8, fontSize: 9, letterSpacing: ".14em", color: "var(--bone-mid)", textTransform: "uppercase", background: "rgba(4,10,18,.85)", padding: "3px 6px", border: "1px solid var(--border)", whiteSpace: "nowrap" }}>click to enlarge</div>
          </div>
        </div>
      )}

      {/* holders table + trailers */}
      {showTable && (
        <>
          <div style={{ border: "1px solid var(--border)", background: "var(--bg-panel)", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, padding: "20px 24px", flexWrap: "wrap" }}>
              <div className="font-tiny" style={{ fontSize: 24, lineHeight: 1, color: "var(--bone-bright)" }}>HOLDERS</div>
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>sorted by holder avg pnl once histories land · every address opens on Blockscout</div>
            </div>
            {rows.length > 0 && !isMobile && (
              <div className="tabular" style={{ fontSize: 13, borderTop: "1px solid var(--border)" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1.4fr .8fr .9fr 1.1fr .8fr 1.2fr", gap: 12, padding: "10px 24px", borderBottom: "1px solid var(--border)", fontSize: 11, color: "var(--text-dim)", letterSpacing: ".08em", textTransform: "uppercase" }}>
                  <span>wallet</span>
                  <span style={{ textAlign: "center" }}>supply</span>
                  <span style={{ textAlign: "center" }}>pnl here</span>
                  <span style={{ textAlign: "center" }}>avg pnl / trade</span>
                  <span style={{ textAlign: "center" }}>winrate</span>
                  <span />
                </div>
                {rows.map((r) => (
                  <div key={r.addr} style={{ display: "grid", gridTemplateColumns: "1.4fr .8fr .9fr 1.1fr .8fr 1.2fr", gap: 12, padding: "10px 24px", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
                    {r.addrFull ? (
                      <a href={`https://robinhood.blockscout.com/address/${r.addrFull}`} target="_blank" rel="noopener" style={{ color: "var(--bone-light)" }}>{r.addr}</a>
                    ) : (
                      <Link href="/holders" style={{ color: "var(--bone-light)" }}>{r.addr}</Link>
                    )}
                    <span style={{ textAlign: "center", color: "var(--text)" }}>{r.supply}</span>
                    <span style={{ textAlign: "center", color: r.pnlColor }}>{r.pnl}</span>
                    <span style={{ textAlign: "center", color: r.avgColor }}>{r.avg}</span>
                    <span style={{ textAlign: "center", color: r.winrate === "—" ? "var(--text-dim)" : "var(--text)" }}>{r.winrate}</span>
                    <span style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                      {r.badges.map((b) => (
                        <span key={b.text} style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", border: `1px solid ${b.color}`, color: b.color, padding: "2px 6px" }}>{b.text}</span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {rows.length > 0 && isMobile && (
              <div className="tabular" style={{ display: "flex", flexDirection: "column", borderTop: "1px solid var(--border)", fontSize: 12 }}>
                {rows.map((r) => (
                  <div key={r.addr} style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ color: "var(--bone-light)" }}>{r.addr}</span>
                      <span style={{ color: "var(--text)" }}>{r.supply} supply</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ color: "var(--text-dim)" }}>pnl here <span style={{ color: r.pnlColor }}>{r.pnl}</span></span>
                      <span style={{ color: "var(--text-dim)" }}>avg <span style={{ color: r.avgColor }}>{r.avg}</span></span>
                      <span style={{ color: "var(--text-dim)" }}>wr <span style={{ color: "var(--text)" }}>{r.winrate}</span></span>
                    </div>
                    <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {r.badges.map((b) => (
                        <span key={b.text} style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", border: `1px solid ${b.color}`, color: b.color, padding: "2px 6px" }}>{b.text}</span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ padding: "14px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap", borderTop: "1px solid var(--border)" }}>
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>showing {Math.min(loaded, D.rows.length)} of {D.total}</span>
              <button onClick={() => setLoaded((l) => Math.min(40, l + 10))} style={smallBtn}>
                load 10 more
              </button>
            </div>
          </div>

          <div className="tabular" style={{ border: "1px solid var(--border)", background: "var(--bg-panel)", padding: "14px 24px", display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
            <span style={{ color: "var(--text-dim)" }}>exited fully: <span style={{ color: "var(--text)" }}>{D.exited.wallets}</span> wallets</span>
            <span style={{ color: "var(--text-dim)" }}>their avg pnl here <span style={{ color: D.exited.pnlColor }}>{D.exited.pnl}</span></span>
            <span style={{ color: "var(--text-dim)" }}>their winrate overall <span style={{ color: "var(--text)" }}>{D.exited.wr}</span></span>
          </div>

          <div className="tabular" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 1, background: "var(--border)", border: "1px solid var(--border)", fontSize: 12 }}>
            {D.flags.map(([t, v]) => (
              <div key={t} style={{ background: "var(--bg-panel)", padding: "12px 16px", display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ color: "var(--text-dim)" }}>{t}</span>
                <span style={{ color: "var(--text)" }}>{v}</span>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
              {D.source ? `source ${D.source.label} · ${D.source.requests} requests · ${D.source.seconds.toFixed(1)}s` : <>demo fixture data · <a href="#" onClick={(e) => { e.preventDefault(); startFixture(); }}>replay the run</a></>}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={() => cardUrl && setCardOpen(true)} style={smallBtn}>preview card</button>
              <button onClick={copyImage} style={smallBtn}>{copiedImg ? copiedImg.toLowerCase() : "copy image"}</button>
              <button onClick={downloadImage} style={smallBtn}>download png</button>
              <button
                onClick={() => {
                  const url = live ? `${location.origin}/terminal?token=${live.token.address}` : location.href;
                  void navigator.clipboard.writeText(url);
                  setLinked(true);
                  setTimeout(() => setLinked(false), 1200);
                }}
                style={smallBtn}
              >
                {linked ? "link copied" : "copy link"}
              </button>
            </div>
          </div>
        </>
      )}

      {cardOpen && <CardLightbox url={cardUrl} onClose={() => setCardOpen(false)} />}
    </div>
  );
}

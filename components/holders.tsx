"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AgentGif } from "./motion";

// /holders: one wallet, read. A port of design/XRAY Holders.dc.html with
// its four states (empty / running / result / error). Fixture result until
// mode B (Bitquery) is live; the layout and contracts are final.

type View = "empty" | "running" | "result" | "error";

const DEMO_WALLET = "0x3f9a71c0e8b2d4a6f51c93e0a7b2d8f4c6e1c21e";

const TOKENS: [string, string, string, number, string, "HEALTHY" | "CRACKED" | "SHATTERED"][] = [
  ["$MARROW", "holding · 3h", "4.21%", 184.2, "3h 12m", "HEALTHY"],
  ["$FEMUR", "exited · 1d", "-", 62.0, "5h 40m", "CRACKED"],
  ["$RIBCAGE", "exited · 2d", "-", -18.3, "22m", "SHATTERED"],
  ["$CALCIUM", "holding · 4d", "0.88%", 31.7, "4d 2h", "HEALTHY"],
  ["$PATELLA", "exited · 6d", "-", 210.5, "1h 05m", "CRACKED"],
  ["$TIBIA", "exited · 9d", "-", -44.0, "9m", "SHATTERED"],
  ["$OSSIFY", "exited · 12d", "-", 12.4, "3h 30m", "CRACKED"],
  ["$SKULLCAP", "holding · 16d", "1.30%", 96.1, "16d", "HEALTHY"],
  ["$HUMERUS", "exited · 20d", "-", -7.9, "48m", "SHATTERED"],
  ["$CLAVICLE", "exited · 27d", "-", 55.2, "2h 10m", "HEALTHY"],
];
const GC = { HEALTHY: "#60F080", CRACKED: "#FFD640", SHATTERED: "#FF605C" } as const;

export function Holders() {
  const [view, setView] = useState<View>("empty");
  const [query, setQuery] = useState("");
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (t.current) clearTimeout(t.current);
  }, []);

  const check = (raw?: string) => {
    const q = (raw ?? query).trim();
    setQuery(q);
    if (!/^0x[0-9a-f]{40}$/i.test(q)) return setView("error");
    setView("running");
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => setView("result"), 2200);
  };

  const tokens = TOKENS.map((x) => ({
    name: x[0],
    status: x[1],
    supply: x[2],
    pnl: (x[3] >= 0 ? "+" : "−") + Math.abs(x[3]).toFixed(1) + "%",
    pnlColor: x[3] > 20 ? "#60F080" : x[3] < -20 ? "#FF605C" : "#FFD640",
    held: x[4],
    grade: x[5],
    gradeColor: GC[x[5]],
  }));

  const badge: React.CSSProperties = { fontSize: 11, letterSpacing: ".14em", border: "1px solid var(--border)", padding: "4px 8px", color: "var(--text-dim)" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 24, alignItems: "end", padding: "16px 0 0" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="font-tiny" style={{ fontSize: 32, lineHeight: 1, color: "var(--bone-bright)" }}>
            ONE WALLET, <span style={{ color: "var(--accent)" }}>READ</span>
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--text)", maxWidth: 640, textWrap: "pretty" }}>
            nothing connects. nothing gets signed. paste a public address and XRAY reads its Pons record the same way a block
            explorer would - trades, tokens, what each one made or lost.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span style={badge}>no wallet connect</span>
          <span style={badge}>no signing</span>
          <span style={badge}>public address only</span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", border: `1px solid ${view === "error" ? "var(--loss)" : view === "running" ? "var(--bone-mid)" : "var(--border)"}`, background: "var(--bg-panel)" }}>
          <span style={{ padding: "14px 0 14px 16px", fontSize: 14, color: "var(--bone-mid)" }}>&gt;</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") check();
            }}
            placeholder="paste a public wallet address - 0x..."
            style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: "var(--bone-bright)", fontSize: 14, padding: "14px 12px" }}
          />
          <button
            onClick={() => check()}
            style={{ fontFamily: "inherit", fontSize: 14, fontWeight: 700, letterSpacing: ".08em", background: view === "running" ? "var(--bone-mid)" : "var(--accent)", color: "var(--bg-deep)", border: "none", padding: "0 28px", cursor: "pointer", boxShadow: "0 0 24px rgba(120,220,255,.4)" }}
          >
            {view === "running" ? "READING" : "CHECK"}
          </button>
        </div>
        {view === "error" && (
          <div style={{ border: "1px solid var(--loss)", background: "var(--bg-panel)", padding: "14px 16px", display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 13, color: "var(--loss)", fontWeight: 700 }}>not an address</div>
              <div style={{ fontSize: 12, color: "var(--text)" }}>a wallet address is 42 characters starting with 0x. contracts and ENS names are not supported yet.</div>
            </div>
            <button
              onClick={() => {
                setView("empty");
                setQuery("");
              }}
              style={{ fontFamily: "inherit", fontSize: 12, background: "transparent", color: "var(--accent)", border: "1px solid var(--border)", padding: "8px 14px", cursor: "pointer" }}
            >
              clear
            </button>
          </div>
        )}
      </div>

      {view === "empty" && (
        <div style={{ border: "1px dashed var(--border)", padding: "48px 24px", textAlign: "center", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/lightbox.png" alt="" style={{ width: 96, height: 96, display: "block", opacity: 0.6 }} />
          <div className="font-tiny" style={{ fontSize: 24, lineHeight: 1, color: "var(--bone-dark)" }}>NO WALLET ON THE FILM</div>
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
            try{" "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                check(DEMO_WALLET);
              }}
            >
              0x3f9a…c21e
            </a>{" "}
            - the top holder from the $MARROW scan
          </div>
        </div>
      )}

      {view === "running" && (
        <div style={{ border: "1px solid var(--accent)", background: "var(--bg-panel)", padding: "12px 16px", display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 56, height: 62, background: "var(--sprite-bg)", flexShrink: 0 }}>
            <AgentGif src="/assets/work-tracer.gif" style={{ width: 56, height: 62, display: "block" }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div className="font-tiny" style={{ fontSize: 16, lineHeight: 1, color: "var(--bone-bright)" }}>TRACER</div>
            <div style={{ fontSize: 12, color: "var(--bone-light)" }}>following this wallet across every Pons token it touched…</div>
          </div>
        </div>
      )}

      {view === "result" && (
        <>
          <div style={{ border: "1px solid var(--border)", background: "var(--bg-panel)", padding: "16px 20px", display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700, fontSize: 18, lineHeight: 1, color: "var(--bone-bright)", letterSpacing: ".02em" }}>0x3f9a71c0…c21e</span>
              <a href="#" style={{ fontSize: 12 }}>blockscout</a>
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>first Pons trade 41 days ago · last trade 2h ago</span>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", border: "1px solid var(--accent)", color: "var(--accent)", padding: "2px 6px" }}>SMART</span>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", border: "1px solid var(--neutral)", color: "var(--neutral)", padding: "2px 6px" }}>WHALE</span>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 1, background: "var(--border)", border: "1px solid var(--border)" }}>
            {[
              ["avg pnl per trade", "+38.4%", "median +21.0%", "var(--profit)"],
              ["winrate", "67%", "a trade counts as a win above 0% after fees", "var(--profit)"],
              ["closed trades", "48", "across 19 tokens · 3 still open", "var(--bone-bright)"],
              ["total profit", "+14.2 ETH", "realised, fees deducted · ≈ $61k", "var(--profit)"],
            ].map(([t2, v, sub, color]) => (
              <div key={t2} style={{ background: "var(--bg-panel)", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 11, color: "var(--text-dim)", letterSpacing: ".08em", textTransform: "uppercase" }}>{t2}</div>
                <div className="tabular" style={{ fontWeight: 700, fontSize: 44, lineHeight: 1, color, letterSpacing: "-.03em", whiteSpace: "nowrap" }}>{v}</div>
                <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{sub}</div>
              </div>
            ))}
          </div>

          <div style={{ border: "1px solid var(--border)", background: "var(--bg-panel)", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, padding: "20px 24px", flexWrap: "wrap" }}>
              <div className="font-tiny" style={{ fontSize: 24, lineHeight: 1, color: "var(--bone-bright)" }}>PONS TOKENS</div>
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>newest first · grade is the token&apos;s current skeleton</div>
            </div>
            <div className="tabular" style={{ fontSize: 13, borderTop: "1px solid var(--border)" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr .8fr .9fr .9fr .9fr", gap: 12, padding: "10px 24px", borderBottom: "1px solid var(--border)", fontSize: 11, color: "var(--text-dim)", letterSpacing: ".08em", textTransform: "uppercase" }}>
                <span>token</span>
                <span>status</span>
                <span style={{ textAlign: "right" }}>supply</span>
                <span style={{ textAlign: "right" }}>pnl</span>
                <span style={{ textAlign: "right" }}>held</span>
                <span style={{ textAlign: "right" }}>grade</span>
              </div>
              {tokens.map((tk) => (
                <Link key={tk.name} href="/terminal?view=result" style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr .8fr .9fr .9fr .9fr", gap: 12, padding: "10px 24px", borderBottom: "1px solid var(--border)", alignItems: "center", color: "inherit", textShadow: "none" }}>
                  <span style={{ color: "var(--bone-light)" }}>{tk.name}</span>
                  <span style={{ color: "var(--text-dim)" }}>{tk.status}</span>
                  <span style={{ textAlign: "right", color: "var(--text)" }}>{tk.supply}</span>
                  <span style={{ textAlign: "right", color: tk.pnlColor }}>{tk.pnl}</span>
                  <span style={{ textAlign: "right", color: "var(--text)" }}>{tk.held}</span>
                  <span style={{ textAlign: "right", color: tk.gradeColor, fontWeight: 700, fontSize: 12, letterSpacing: ".08em" }}>{tk.grade}</span>
                </Link>
              ))}
            </div>
            <div style={{ padding: "14px 24px", fontSize: 12, color: "var(--text-dim)" }}>
              19 tokens · every row opens the token in the terminal · trades on other venues are outside the universe
            </div>
          </div>
        </>
      )}
    </div>
  );
}

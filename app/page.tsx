import { CaBlock } from "../components/ca-block";
import { EngineLog } from "../components/engine-log";
import { HeroInput } from "../components/hero-input";
import { VerdictPanel } from "../components/verdict-panel";

// Home page. Section order and every value from design/XRAY Home.dc.html.
// The agent walk-and-talk animation arrives with M4; the stations and the
// engine log are already live.

const CHART_URL: string = ""; // pool embed url goes here at launch

const label: React.CSSProperties = {
  fontSize: 12,
  color: "var(--bone-mid)",
  letterSpacing: ".14em",
  textTransform: "uppercase",
  marginBottom: 10,
};

const h2: React.CSSProperties = {
  fontSize: 40,
  lineHeight: 1,
  color: "var(--bone-bright)",
  textShadow: "0 0 14px rgba(120,220,255,.5)",
};

function Stat({ title, value, sub, bright }: { title: string; value: string; sub: string; bright?: boolean }) {
  return (
    <div
      style={{
        background: "var(--bg-panel)",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        borderRight: "1px solid var(--border)",
        marginRight: -1,
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 11, color: "var(--text-dim)", letterSpacing: ".14em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{title}</div>
      <div
        className="tabular"
        style={{
          fontWeight: 700,
          fontSize: 40,
          lineHeight: 1,
          color: bright ? "var(--bone-bright)" : "var(--accent)",
          textShadow: bright ? "0 0 18px rgba(120,220,255,.5)" : "0 0 18px rgba(120,220,255,.7)",
          letterSpacing: "-.02em",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 12, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{sub}</div>
    </div>
  );
}

const STATIONS = [
  { n: "01", name: "SCANNER", gif: "work-scanner.gif" },
  { n: "02", name: "LEDGER", gif: "work-ledger.gif" },
  { n: "03", name: "TRACER", gif: "work-tracer.gif" },
  { n: "04", name: "AUDITOR", gif: "work-auditor.gif" },
  { n: "05", name: "SORTER", gif: "work-sorter.gif" },
  { n: "06", name: "FLAGGER", gif: "work-flagger.gif" },
];

const HOW = [
  { n: "01", name: "SCANNER", sub: "pulls every trade", body: "every buy and sell of the token, straight off chain. no wallet connect, no signature.", line: <>18 920 trades · 1 043 holders · from block 59 570 827 · <a href="#">blockscout</a></> },
  { n: "02", name: "LEDGER", sub: "rebuilds each book", body: "what each wallet paid, what it took out, what still sits there at current price.", line: <>0x3f9a…c21e · in 2.10 ETH · out 0.90 ETH · holds 4.21% · pnl <span style={{ color: "var(--profit)" }}>+184.2%</span></> },
  { n: "03", name: "TRACER", sub: "follows the wallets", body: "the same addresses across every other Pons token they touched. history, not vibes.", line: <>0x3f9a…c21e → $FEMUR $RIBCAGE $CALCIUM +16 more · 212 wallets with ≥ 5 past trades</> },
  { n: "04", name: "AUDITOR", sub: "grades the traders", body: "average pnl per trade and winrate, wallet by wallet. says how many wallets each number rests on.", line: <>0x3f9a…c21e · avg <span style={{ color: "var(--profit)" }}>+38.4%</span> / trade · winrate 67% over 48 → <span style={{ color: "var(--accent)" }}>SMART</span></> },
  { n: "05", name: "SORTER", sub: "bands the holders", body: 'holders grouped by winrate, five points wide, at most three groups - so you read "31% of supply sits with traders who win 60–65% of the time".', line: <><span style={{ color: "var(--profit)" }}>31.2%</span> supply · wr 60–65 · 188 wallets &nbsp; <span style={{ color: "var(--neutral)" }}>22.9%</span> · wr 50–55 · 302 &nbsp; <span style={{ color: "var(--loss)" }}>18.4%</span> · wr 35–40 · 553</> },
  { n: "06", name: "FLAGGER", sub: "cleans the sample", body: "dust, transfers-in, infrastructure and first-ever trades are counted, shown and kept out of the averages.", line: <>dust 214 · transfers-in 87 · infra 6 · first trades 312</> },
];

const GRADE_CARDS = [
  { img: "h-healthy.png", name: "HEALTHY", color: "var(--profit)", glow: "rgba(96,240,128", text: "holders are in profit and they win elsewhere too" },
  { img: "h-cracked.png", name: "CRACKED", color: "var(--neutral)", glow: "rgba(255,214,64", text: "flat book, average traders - could go either way" },
  { img: "h-shattered.png", name: "SHATTERED", color: "var(--loss)", glow: "rgba(255,96,92", text: "most holders underwater and they lose everywhere else" },
];

export default function Home() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 96, paddingTop: 40 }}>
      {/* hero */}
      <section style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 440px", gap: 48, alignItems: "center", position: "relative" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 24, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: "var(--bone-mid)", letterSpacing: ".14em", textTransform: "uppercase" }}>
            holder pnl terminal · Robinhood Chain · Pons V2 · read-only
          </div>
          <div
            className="font-tiny"
            style={{ fontSize: 72, lineHeight: 0.95, color: "var(--bone-bright)", letterSpacing: ".02em", animation: "breathe 4s ease-in-out infinite", textWrap: "balance" }}
          >
            SEE THE BONES OF ANY TOKEN.
          </div>
          <div style={{ fontSize: 16, lineHeight: 1.6, color: "var(--text)", maxWidth: 600, textWrap: "pretty" }}>
            who in it is in profit, who is underwater - and whether those wallets can trade at all. six agents rebuild every
            holder&apos;s book and check its record across every other Pons token.
          </div>
          <HeroInput />
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, fontSize: 12, color: "var(--text-dim)", flexWrap: "wrap", maxWidth: 680 }}>
            <span>reads public state only · no wallet connect · nothing signed</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 6, height: 6, background: "var(--accent)", display: "inline-block", boxShadow: "0 0 8px #78DCFF" }} />
              <span className="tabular" style={{ color: "var(--bone-bright)" }}>12 408</span> tokens checked
            </span>
          </div>
        </div>
        <div style={{ position: "relative", width: 440, height: 510, flexShrink: 0, border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ position: "relative", width: 392, height: 462, overflow: "hidden", background: "var(--bg-deep)" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/assets/logo-film.gif" alt="XRAY film" style={{ position: "absolute", left: -56, top: -35, width: 560, height: 560, display: "block", maxWidth: "none" }} />
          </div>
          <div style={{ position: "absolute", top: 8, right: 12, fontSize: 10, letterSpacing: ".14em", color: "var(--bone-mid)", textTransform: "uppercase" }}>kV 78 · mA 60</div>
          <div style={{ position: "absolute", bottom: 8, left: 12, fontSize: 10, letterSpacing: ".14em", color: "var(--bone-mid)", textTransform: "uppercase" }}>film 001 · brand mark</div>
          {[
            { top: -1, left: -1, borderTop: "2px solid var(--accent)", borderLeft: "2px solid var(--accent)" },
            { top: -1, right: -1, borderTop: "2px solid var(--accent)", borderRight: "2px solid var(--accent)" },
            { bottom: -1, left: -1, borderBottom: "2px solid var(--accent)", borderLeft: "2px solid var(--accent)" },
            { bottom: -1, right: -1, borderBottom: "2px solid var(--accent)", borderRight: "2px solid var(--accent)" },
          ].map((s, i) => (
            <div key={i} style={{ position: "absolute", width: 22, height: 22, ...s }} />
          ))}
        </div>
      </section>

      {/* stat grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", border: "1px solid var(--border)", background: "var(--bg-panel)", boxShadow: "0 0 40px rgba(120,220,255,.08)", marginTop: -32 }}>
        <Stat title="tokens checked" value="12 408" sub="since 2026-08-01" />
        <Stat title="wallets in the book" value="338 112" sub="addresses with a Pons record" />
        <Stat title="launches a day" value="1 940" sub="Pons V2 · 7-day average" />
        <Stat title="keys held" value="0" sub="no accounts · no signing" bright />
      </div>

      {/* agents at work */}
      <section style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
          <div>
            <div style={label}>live visualization · one full scan every ~14 seconds</div>
            <div className="font-tiny" style={h2}>
              AGENTS <span style={{ color: "var(--accent)" }}>AT WORK</span>
            </div>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", maxWidth: 420, textAlign: "right", textWrap: "pretty" }}>
            the film travels station to station. every line in the log is the shape of a real row the terminal produces.
          </div>
        </div>
        <div style={{ border: "1px solid var(--border)", background: "var(--sprite-bg)", boxShadow: "0 0 48px rgba(120,220,255,.1)", position: "relative", overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <EngineLog />
          <div style={{ position: "relative", padding: "28px 12px 20px", overflow: "hidden" }}>
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: "calc(58% + 8px)",
                height: 2,
                background: "repeating-linear-gradient(90deg,#78DCFF 0 12px,transparent 12px 32px)",
                opacity: 0.35,
                animation: "flow .6s linear infinite",
              }}
            />
            <div style={{ position: "relative", display: "grid", gridTemplateColumns: "repeat(6,minmax(0,1fr))", columnGap: 8 }}>
              {STATIONS.map((s) => (
                <div key={s.name} style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "8px 4px", border: "1px solid transparent" }}>
                  <div style={{ fontSize: 10, letterSpacing: ".14em", color: "var(--bone-mid)" }}>{s.n}</div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/assets/${s.gif}`} alt="" style={{ width: 112, height: 124, display: "block" }} />
                  <div className="font-tiny" style={{ fontSize: 16, lineHeight: 1, color: "var(--bone-light)" }}>{s.name}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* how it works + verdict */}
      <section style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 380px", gap: 48, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div>
            <div style={label}>one scan · six stages · one verdict</div>
            <div className="font-tiny" style={h2}>HOW IT WORKS</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", border: "1px solid var(--border)", background: "var(--bg-panel)" }}>
            {HOW.map((s, i) => (
              <div key={s.n} style={{ display: "grid", gridTemplateColumns: "48px minmax(0,1fr)", gap: 20, padding: "20px 24px", borderBottom: i < HOW.length - 1 ? "1px solid var(--border)" : "none" }}>
                <div className="font-tiny" style={{ fontSize: 24, lineHeight: 1, color: "var(--bg-deep)", background: "var(--accent)", width: 48, height: 48, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 16px rgba(120,220,255,.5)" }}>{s.n}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                  <div className="font-tiny" style={{ fontSize: 24, lineHeight: 1, color: "var(--bone-bright)" }}>
                    {s.name} <span style={{ fontFamily: "var(--font-mono),monospace", fontSize: 12, color: "var(--text-dim)" }}>{s.sub}</span>
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--text)" }}>{s.body}</div>
                  <div className="tabular" style={{ fontSize: 12, color: "var(--bone-mid)" }}>{s.line}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <VerdictPanel />
      </section>

      {/* grades */}
      <section style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div>
          <div style={label}>one skeleton per token · the film shows the fracture</div>
          <div className="font-tiny" style={h2}>GRADES</div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 16 }}>
          {GRADE_CARDS.map((g) => (
            <div key={g.name} style={{ border: "1px solid var(--border)", background: "var(--bg-deep)", padding: "32px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 16, textAlign: "center", position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at 50% 35%,${g.glow},.14),transparent 60%)` }} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/assets/${g.img}`} alt="" style={{ position: "relative", width: 200, height: 200, display: "block", imageRendering: "auto", filter: `drop-shadow(0 0 18px ${g.glow},.7))` }} />
              <div className="font-tiny" style={{ position: "relative", fontSize: 32, lineHeight: 1, color: g.color, textShadow: `0 0 18px ${g.glow},.8)` }}>{g.name}</div>
              <div style={{ position: "relative", fontSize: 13, color: "var(--text)" }}>{g.text}</div>
            </div>
          ))}
        </div>
      </section>

      <CaBlock />

      {/* chart */}
      <section style={{ border: "1px solid var(--border)", background: "var(--bg-panel)", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, padding: "20px 24px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
            <div className="font-tiny" style={{ fontSize: 32, lineHeight: 1, color: "var(--bone-bright)", textShadow: "0 0 14px rgba(120,220,255,.5)" }}>
              $XRAY <span style={{ color: "var(--accent)" }}>CHART</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>live · via GeckoTerminal · read-only</div>
          </div>
          {CHART_URL && (
            <a href={CHART_URL.split("?")[0]} target="_blank" rel="noopener" style={{ fontSize: 12 }}>
              open on GeckoTerminal →
            </a>
          )}
        </div>
        <div style={{ height: 440, background: "var(--bg-deep)", borderTop: "1px solid var(--border)", position: "relative" }}>
          {CHART_URL ? (
            <iframe src={CHART_URL} title="$XRAY chart" loading="lazy" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none", display: "block" }} />
          ) : (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                background:
                  "repeating-linear-gradient(0deg,rgba(22,50,74,.25) 0 1px,transparent 1px 44px),repeating-linear-gradient(90deg,rgba(22,50,74,.25) 0 1px,transparent 1px 44px)",
              }}
            >
              <div className="font-tiny" style={{ fontSize: 24, lineHeight: 1, color: "var(--bone-dark)" }}>LIVE CHART LOADS HERE AT LAUNCH</div>
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>pool embed url goes into app/page.tsx → CHART_URL</div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

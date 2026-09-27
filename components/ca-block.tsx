"use client";

import { useState } from "react";

// OFFICIAL CA section: full contract with a copy button, placeholder until
// the token launches.
export const OFFICIAL_CA = "0xe4a71f0c9b3d28e6a5f1047cb92d3e8f61a0c7b9";

export function CaBlock() {
  const [copied, setCopied] = useState(false);
  return (
    <section
      style={{
        border: "1px solid var(--bone-dark)",
        background: "var(--bg-panel)",
        padding: 32,
        display: "flex",
        flexDirection: "column",
        gap: 20,
        boxShadow: "0 0 0 1px rgba(120,220,255,.08),0 0 48px rgba(120,220,255,.12)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
        <div className="font-tiny" style={{ fontSize: 32, lineHeight: 1, color: "var(--bone-bright)", textShadow: "0 0 14px rgba(120,220,255,.5)" }}>
          OFFICIAL CA
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>one contract. verify every character.</div>
      </div>
      <div style={{ display: "flex", border: "1px solid var(--border)", background: "var(--bg-deep)", alignItems: "center", flexWrap: "wrap" }}>
        <span className="tabular" style={{ flex: 1, minWidth: 0, padding: "16px 20px", fontSize: 14, color: "var(--bone-bright)", wordBreak: "break-all" }}>
          <span style={{ color: "var(--accent)" }}>$XRAY</span> · {OFFICIAL_CA}
        </span>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(OFFICIAL_CA);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          style={{
            fontFamily: "inherit",
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: ".12em",
            background: "transparent",
            color: "var(--accent)",
            border: "none",
            borderLeft: "1px solid var(--border)",
            padding: "16px 24px",
            cursor: "pointer",
            outline: "none",
          }}
        >
          {copied ? "COPIED" : "COPY CA"}
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, fontSize: 12, flexWrap: "wrap" }}>
        {["TRADE", "DEXSCREENER", "BLOCKSCOUT"].map((t) => (
          <a key={t} href="#" style={{ border: "1px solid var(--border)", padding: "8px 14px", letterSpacing: ".08em" }}>
            {t}
          </a>
        ))}
      </div>
    </section>
  );
}


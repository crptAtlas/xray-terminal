"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function HeroInput() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const go = () => router.push(q.trim() ? `/terminal?q=${encodeURIComponent(q.trim())}` : "/terminal");
  return (
    <div
      style={{
        display: "flex",
        border: "1px solid var(--bone-dark)",
        background: "var(--bg-panel)",
        maxWidth: 680,
        boxShadow: "0 0 0 1px rgba(120,220,255,.08),0 0 32px rgba(120,220,255,.12)",
      }}
    >
      <span style={{ padding: "16px 0 16px 18px", fontSize: 15, color: "var(--accent)", textShadow: "0 0 8px rgba(120,220,255,.8)" }}>
        &gt;
      </span>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") go();
        }}
        placeholder="paste a contract address or a ticker"
        style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: "var(--bone-bright)", fontSize: 15, padding: "16px 12px" }}
      />
      <button
        onClick={go}
        style={{
          display: "flex",
          alignItems: "center",
          fontFamily: "inherit",
          fontSize: 14,
          fontWeight: 700,
          letterSpacing: ".12em",
          background: "var(--accent)",
          color: "var(--bg-deep)",
          border: "none",
          padding: "0 32px",
          cursor: "pointer",
          boxShadow: "0 0 24px rgba(120,220,255,.45)",
        }}
      >
        SCAN
      </button>
    </div>
  );
}


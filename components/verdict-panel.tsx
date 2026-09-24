"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { cardDataFor } from "../lib/site/fixtures";
import { CardLightbox, useCardActions, useCardUrl } from "./share-card";

// The VERDICT panel on the home page: rendered share card, copy and
// download buttons, click opens the lightbox.
export function VerdictPanel() {
  const data = useMemo(() => cardDataFor("healthy"), []);
  const url = useCardUrl(data);
  const [open, setOpen] = useState(false);
  const { copied, copy, download } = useCardActions(data, "xray-MARROW.png");

  const btn: React.CSSProperties = {
    fontFamily: "inherit",
    fontSize: 12,
    letterSpacing: ".08em",
    background: "transparent",
    color: "var(--accent)",
    border: "1px solid var(--bone-dark)",
    padding: "10px 12px",
    cursor: "pointer",
  };

  return (
    <div style={{ position: "sticky", top: 24, display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <div style={{ fontSize: 12, color: "var(--bone-mid)", letterSpacing: ".14em", textTransform: "uppercase", marginBottom: 10 }}>
          share card · $MARROW · 2026-09-16
        </div>
        <div className="font-tiny" style={{ fontSize: 40, lineHeight: 1, color: "var(--bone-bright)", textShadow: "0 0 14px rgba(120,220,255,.5)" }}>
          VERDICT
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div
          onClick={() => url && setOpen(true)}
          style={{
            position: "relative",
            width: "100%",
            aspectRatio: "1",
            border: "1px solid var(--border)",
            background: "var(--bg-deep)",
            cursor: "zoom-in",
            overflow: "hidden",
            boxShadow: "0 0 0 1px rgba(120,220,255,.08),0 0 40px rgba(120,220,255,.12)",
          }}
        >
          {url ? (
            <div
              role="img"
              aria-label="Xray-terminal share card for $MARROW"
              style={{ width: "100%", height: "100%", backgroundImage: `url(${url})`, backgroundSize: "cover", backgroundPosition: "center" }}
            />
          ) : (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--text-dim)" }}>
              rendering card…
            </div>
          )}
          <div
            style={{
              position: "absolute",
              right: 10,
              bottom: 10,
              fontSize: 10,
              letterSpacing: ".14em",
              color: "var(--bone-mid)",
              textTransform: "uppercase",
              background: "rgba(4,10,18,.8)",
              padding: "4px 8px",
              border: "1px solid var(--border)",
            }}
          >
            click to enlarge
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <button onClick={copy} style={btn}>
            {copied || "COPY IMAGE"}
          </button>
          <button onClick={download} style={btn}>
            DOWNLOAD PNG
          </button>
        </div>
        <Link href="/terminal?q=MARROW" style={{ fontSize: 12, color: "var(--bone-light)" }}>
          open $MARROW in the terminal →
        </Link>
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
          numbers rest on 956 wallets with known cost basis and 212 with ≥ 5 past Pons trades. every row links its wallet on
          Blockscout.
        </div>
      </div>
      {open && <CardLightbox url={url} onClose={() => setOpen(false)} />}
    </div>
  );
}

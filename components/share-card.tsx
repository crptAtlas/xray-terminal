"use client";

import { useCallback, useEffect, useState } from "react";
import { renderCard, copyCard, downloadCard } from "../lib/site/card";
import type { CardData } from "../lib/site/types";

// Share card: preview box, copy / download buttons and a fullscreen
// lightbox (click to open, Esc or click to close).

export function useCardUrl(data: CardData): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let alive = true;
    renderCard(data)
      .then((c) => {
        if (alive) setUrl(c.toDataURL("image/png"));
      })
      .catch((e) => console.warn("card", e));
    return () => {
      alive = false;
    };
  }, [data]);
  return url;
}

export function CardLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "rgba(4,10,18,.92)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "zoom-out",
        padding: 24,
      }}
    >
      {url ? (
        <div
          role="img"
          aria-label="Xray-terminal share card"
          style={{
            width: "min(90vw,90vh)",
            height: "min(90vw,90vh)",
            backgroundImage: `url(${url})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            border: "1px solid var(--bone-dark)",
            boxShadow: "0 0 0 1px rgba(120,220,255,.1),0 0 80px rgba(120,220,255,.25)",
          }}
        />
      ) : (
        <div style={{ fontSize: 13, color: "var(--text-dim)" }}>rendering card…</div>
      )}
      <div style={{ position: "absolute", top: 20, right: 24, fontSize: 12, letterSpacing: ".14em", color: "var(--text-dim)" }}>
        ESC · click anywhere to close
      </div>
    </div>
  );
}

export function useCardActions(data: CardData, filename: string) {
  const [copied, setCopied] = useState("");
  const copy = useCallback(() => {
    copyCard(data)
      .then(() => setCopied("COPIED"))
      .catch(() => setCopied("NOT ALLOWED"))
      .then(() => setTimeout(() => setCopied(""), 1400));
  }, [data]);
  const download = useCallback(() => {
    void downloadCard(data, filename);
  }, [data, filename]);
  return { copied, copy, download };
}


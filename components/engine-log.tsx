"use client";

import { useEffect, useRef, useState } from "react";
import { script, TOK } from "../lib/site/fixtures";

interface Line {
  tag: string;
  text: string;
  stage: number;
  color: string;
  tagColor: string;
  shadow: string;
}

// The engine log on the home page: one line every 1400ms, keep the last 7,
// older lines fade by opacity, blinking cursor at the end. Verbatim port of
// the prototype behavior.
export function EngineLog() {
  const [log, setLog] = useState<Line[]>([]);
  const [tok, setTok] = useState(0);
  const pos = useRef({ i: 0, tok: 0 });

  useEffect(() => {
    const t = setInterval(() => {
      const p = pos.current;
      const sc = script(TOK[p.tok]!);
      const line = sc[p.i]!;
      setLog((prev) =>
        [
          ...prev,
          {
            tag: line[1],
            text: line[2],
            stage: line[0],
            color: line[0] === 6 ? line[3] : "#D9D9D9",
            tagColor: line[3],
            shadow: line[0] === 6 ? `0 0 10px ${line[3]}` : "none",
          },
        ].slice(-7),
      );
      p.i += 1;
      if (p.i >= sc.length) {
        p.i = 0;
        p.tok = (p.tok + 1) % TOK.length;
        setTok(p.tok);
      }
    }, 1400);
    return () => clearInterval(t);
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        fontSize: 12,
        lineHeight: 1.7,
        height: 196,
        overflow: "hidden",
        padding: "14px 20px 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          paddingBottom: 8,
          marginBottom: 6,
          fontSize: 11,
          letterSpacing: ".14em",
          textTransform: "uppercase",
          color: "var(--text-dim)",
        }}
      >
        <span>engine log</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 6, height: 6, background: "#60F080", display: "inline-block", boxShadow: "0 0 8px #60F080" }} />
          scanning {TOK[tok]!.t}
        </span>
      </div>
      {log.map((l, idx) => (
        <div
          key={idx}
          className="tabular"
          style={{
            display: "grid",
            gridTemplateColumns: "64px minmax(0,1fr)",
            gap: 12,
            color: l.color,
            opacity: 0.45 + 0.55 * ((idx + 1) / log.length),
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          <span style={{ color: l.tagColor, textShadow: l.shadow }}>{l.tag}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{l.text}</span>
        </div>
      ))}
      <div style={{ color: "var(--accent)" }}>
        <span
          style={{
            display: "inline-block",
            width: 8,
            height: 14,
            background: "var(--accent)",
            verticalAlign: -2,
            boxShadow: "0 0 8px #78DCFF",
            animation: "blink 1s steps(1) infinite",
          }}
        />
      </div>
    </div>
  );
}

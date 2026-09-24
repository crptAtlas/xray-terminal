"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TALK } from "../lib/site/fixtures";
import { EngineLog } from "./engine-log";
import { AgentGif, useReducedMotion } from "./motion";

// AGENTS AT WORK: six stations, the conveyor line and the walk-and-talk
// animation - a verbatim port of spawn() from design/XRAY Home.dc.html.
// Every 2600ms a random agent walks over to another station by a TALK
// scenario, says its line in a bubble, gets an answer and walks back.
// Under reduced motion nothing spawns.

const N = 6;
const deskX = (k: number) => ((k + 0.5) / N) * 100;

const STATIONS = [
  { n: "01", name: "SCANNER", gif: "work-scanner.gif" },
  { n: "02", name: "LEDGER", gif: "work-ledger.gif" },
  { n: "03", name: "TRACER", gif: "work-tracer.gif" },
  { n: "04", name: "AUDITOR", gif: "work-auditor.gif" },
  { n: "05", name: "SORTER", gif: "work-sorter.gif" },
  { n: "06", name: "FLAGGER", gif: "work-flagger.gif" },
];

interface AgentState {
  mode: "desk" | "walk" | "talk";
  x: number;
  off: number;
  dur: number;
  flip: boolean;
  bubble: string;
  host: number;
}

const restAgent = (k: number): AgentState => ({ mode: "desk", x: deskX(k), off: -60, dur: 0, flip: false, bubble: "", host: -1 });

function anchor(x: number): { left: string; right: string; transform: string } {
  if (x > 70) return { left: "auto", right: "0", transform: "none" };
  if (x < 20) return { left: "0", right: "auto", transform: "none" };
  return { left: "50%", right: "auto", transform: "translateX(-50%)" };
}

export function AgentsAtWork() {
  const rm = useReducedMotion();
  const [ag, setAg] = useState<AgentState[]>(() => Array.from({ length: N }, (_, k) => restAgent(k)));
  const [deskBubble, setDeskBubble] = useState<string[]>(() => Array(N).fill(""));
  const agRef = useRef(ag);
  agRef.current = ag;
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const rmRef = useRef(rm);
  rmRef.current = rm;

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);

  const patch = useCallback((k: number, p: Partial<AgentState>) => {
    setAg((s) => {
      const next = s.slice();
      next[k] = { ...next[k]!, ...p };
      return next;
    });
  }, []);

  const spawn = useCallback(() => {
    if (rmRef.current) return;
    const cur = agRef.current;
    const away = cur.filter((a) => a.mode !== "desk").length;
    if (away >= 2 || Math.random() < 0.3) return;
    const busy = new Set<number>();
    cur.forEach((a, k) => {
      if (a.mode !== "desk") {
        busy.add(k);
        busy.add(a.host);
      }
    });
    const pool = TALK.filter(([a, b]) => !busy.has(a) && !busy.has(b));
    if (!pool.length) return;
    const [k, j, lines] = pool[Math.floor(Math.random() * pool.length)]!;
    const from = deskX(k);
    const to = deskX(j);
    const side = k < j ? -1 : 1;
    const dur = Math.max(1200, Math.abs(to - from) * 55);
    patch(k, { mode: "walk", x: to, off: side * 104, dur, flip: to < from, host: j, bubble: "" });
    later(() => patch(k, { mode: "talk", bubble: lines[0], flip: side > 0 }), dur);
    later(() => {
      setDeskBubble((s) => {
        const next = s.slice();
        next[j] = lines[1];
        return next;
      });
      patch(k, { bubble: "" });
    }, dur + 1800);
    later(() => {
      setDeskBubble((s) => {
        const next = s.slice();
        next[j] = "";
        return next;
      });
      patch(k, { mode: "walk", x: from, off: -60, dur, flip: from < to });
    }, dur + 3600);
    later(() => patch(k, { mode: "desk", host: -1, flip: false }), dur + 3600 + dur);
  }, [later, patch]);

  useEffect(() => {
    const t0 = setTimeout(spawn, 800);
    const sp = setInterval(spawn, 2600);
    const saved = timers.current;
    return () => {
      clearTimeout(t0);
      clearInterval(sp);
      saved.forEach(clearTimeout);
    };
  }, [spawn]);

  const hosting = new Set(ag.filter((a) => a.mode === "talk").map((a) => a.host));

  return (
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
          {STATIONS.map((s, k) => {
            const host = hosting.has(k);
            const awayK = ag[k]!.mode !== "desk";
            const a = anchor(deskX(k));
            return (
              <div
                key={s.name}
                style={{
                  position: "relative",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 4px",
                  border: `1px solid ${host ? "var(--accent)" : "transparent"}`,
                  background: host ? "rgba(120,220,255,.06)" : "transparent",
                  animation: host && !rm ? "glow 1.2s ease-in-out infinite" : "none",
                }}
              >
                {deskBubble[k] && (
                  <div style={{ position: "absolute", top: -22, left: a.left, right: a.right, transform: a.transform, zIndex: 6, background: "var(--bg-deep)", border: "1px solid var(--accent)", color: "var(--bone-bright)", fontSize: 12, fontWeight: 500, padding: "6px 10px", whiteSpace: "nowrap", boxShadow: "0 0 16px rgba(120,220,255,.5)" }}>
                    {deskBubble[k]}
                  </div>
                )}
                <div style={{ fontSize: 10, letterSpacing: ".14em", color: "var(--bone-mid)" }}>{s.n}</div>
                <AgentGif src={`/assets/${s.gif}`} style={{ width: 112, height: 124, display: "block", opacity: awayK ? 0.3 : 1, transition: "opacity .6s" }} />
                <div className="font-tiny" style={{ fontSize: 16, lineHeight: 1, color: host ? "var(--bone-bright)" : "var(--bone-light)" }}>{s.name}</div>
              </div>
            );
          })}
        </div>
        {ag.map((a, k) => {
          const away = a.mode !== "desk";
          const b = anchor(a.x + a.off / 12);
          return (
            <div
              key={k}
              style={{
                position: "absolute",
                top: 69,
                left: `${a.x}%`,
                marginLeft: a.off - 38,
                width: 76,
                height: 104,
                zIndex: 3,
                opacity: away ? 1 : 0,
                transition: a.mode === "walk" && !rm ? `left ${a.dur}ms linear, margin-left ${a.dur}ms linear, opacity .3s` : "opacity .3s",
                pointerEvents: "none",
              }}
            >
              {a.bubble && (
                <div style={{ position: "absolute", bottom: 132, left: b.left, right: b.right, transform: b.transform, background: "var(--bg-deep)", border: "1px solid var(--bone-light)", color: "var(--bone-bright)", fontSize: 12, fontWeight: 500, padding: "6px 10px", whiteSpace: "nowrap", boxShadow: "0 0 16px rgba(120,220,255,.5)", zIndex: 6 }}>
                  {a.bubble}
                </div>
              )}
              <div className="font-tiny" style={{ position: "absolute", top: -16, left: "50%", transform: "translateX(-50%)", fontSize: 16, lineHeight: 1, color: "var(--accent)", textShadow: "0 0 8px rgba(120,220,255,.8)", whiteSpace: "nowrap" }}>
                {STATIONS[k]!.name}
              </div>
              <div
                style={{
                  width: 76,
                  height: 104,
                  background: "url(/assets/run-sheet.png) 0 0/456px 104px no-repeat",
                  imageRendering: "pixelated",
                  animation: a.mode === "walk" && !rm ? "runframes .54s steps(6) infinite" : "none",
                  transform: a.flip ? "scaleX(-1)" : "none",
                  filter: "drop-shadow(0 0 10px rgba(120,220,255,.8))",
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}


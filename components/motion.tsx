"use client";

import { useEffect, useState } from "react";

/** prefers-reduced-motion, live. */
export function useReducedMotion(): boolean {
  const [rm, setRm] = useState(false);
  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const upd = () => setRm(mq.matches);
    upd();
    mq.addEventListener("change", upd);
    return () => mq.removeEventListener("change", upd);
  }, []);
  return rm;
}

/**
 * An agent gif that freezes to its first frame under reduced motion
 * (design rule: gifs stop, glow and pulses go out). Expects the still
 * frame at /assets/still/<name>.png for /assets/<name>.gif.
 */
export function AgentGif({ src, style, alt = "" }: { src: string; style?: React.CSSProperties; alt?: string }) {
  const rm = useReducedMotion();
  const real = rm ? src.replace("/assets/", "/assets/still/").replace(".gif", ".png") : src;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={real} alt={alt} style={style} />;
}

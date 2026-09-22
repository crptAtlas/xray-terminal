import { closeSync, openSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A one-file handshake between the site and any background digger on the
 * same host. The node serves one IP strictly in order, so a backfill and
 * a visitor's scan compete for the same queue: the scan wins. The site
 * touches the flag while it works; a digger waits while the flag is
 * fresh.
 */

const FLAG = join(tmpdir(), "xray-scanning");
const FRESH_MS = 20_000;

export function touchScan(): void {
  try {
    const now = new Date();
    try {
      utimesSync(FLAG, now, now);
    } catch {
      closeSync(openSync(FLAG, "w"));
    }
  } catch {
    /* the flag is an optimisation, never a requirement */
  }
}

export function scanInProgress(): boolean {
  try {
    return Date.now() - statSync(FLAG).mtimeMs < FRESH_MS;
  } catch {
    return false;
  }
}

/** Block while a scan is running, up to a cap so a digger never stalls forever. */
export async function yieldToScans(maxWaitMs = 120_000): Promise<void> {
  const until = Date.now() + maxWaitMs;
  while (scanInProgress() && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1500));
  }
}

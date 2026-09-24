/**
 * Pipeline stage events. One agent per computation step; surfaces (the CLI,
 * the site's agent row) subscribe to show real progress instead of a
 * spinner. The order here is the order they light up.
 */

export const AGENTS = ["scanner", "ledger", "tracer", "auditor", "sorter", "flagger"] as const;

export type Agent = (typeof AGENTS)[number];

export const AGENT_CAPTIONS: Record<Agent, string> = {
  scanner: "pulling every trade of this token",
  ledger: "rebuilding each wallet's book: bought, sold, left",
  tracer: "following the same wallets across other tokens",
  auditor: "avg pnl and winrate, wallet by wallet",
  sorter: "splitting holders into groups",
  flagger: "dust, transfers in, first-ever trades",
};

export interface StageEvent {
  agent: Agent;
  status: "start" | "done" | "skip";
  detail?: string;
}

export type StageReporter = (event: StageEvent) => void;

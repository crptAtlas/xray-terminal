// Data contracts between the site and the engine (design prompt, section
// "Данные"). While the engine is not wired in, /api routes serve fixtures
// with exactly these shapes; swapping fixtures for the engine later must
// not change the interface.

export type Grade = "healthy" | "cracked" | "shattered";

export interface ScanToken {
  ticker: string;
  address: string;
  age: string;
  stage: string;
  mcap: string;
  liquidity: string;
  vol24h: string;
  holders: string;
}

export interface ScanVerdict {
  pnl: string;
  winrate: string;
  counted: number;
  traced: number;
  grade: Grade;
  hint: string;
}

export interface ScanBand {
  supply: number;
  pnlFrom: number;
  pnlTo: number;
  wallets: number;
  avgPnl: string;
}

export interface ScanHolder {
  addr: string;
  supply: string;
  pnlHere: string;
  avgPnl: string;
  winrate: string;
  badges: string[];
}

export interface Scan {
  token: ScanToken;
  verdict: ScanVerdict;
  bands: ScanBand[];
  holders: ScanHolder[];
  flags: { dust: number; transfersIn: number; infra: number; firstTrades: number };
}

export interface WalletScanToken {
  name: string;
  status: string;
  supply: string;
  pnl: string;
  held: string;
  grade: Grade;
}

export interface WalletScan {
  addr: string;
  firstTrade: string;
  lastTrade: string;
  badges: string[];
  avgPnl: string;
  medianPnl: string;
  winrate: string;
  closedTrades: number;
  tokensTouched: number;
  openPositions: number;
  totalProfit: string;
  tokens: WalletScanToken[];
}

export interface CardData {
  ticker: string;
  addr: string;
  pnl: string;
  winrate: string;
  grade: Grade;
  gradeColor: string;
  gradeLabel: string;
  hint: string;
  time: string;
  groups: { supply: number; range: string; mid: number; wallets: number }[];
}

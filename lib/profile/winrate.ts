/**
 * Winrate (spec 3.5): one virtual losing trade in the denominator -
 * winrate = wins / (trades + 1). It cuts a newcomer's percentage and
 * dissolves for a veteran. Not shown at all below two closed trades.
 */

export function winrate(trades: number, wins: number): number | null {
  if (trades < 2) return null;
  return (wins / (trades + 1)) * 100;
}


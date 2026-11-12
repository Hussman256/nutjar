// Integer split math for Value4Value boosts.
// Podcasting 2.0 splits are relative shares ("split" attributes need not add up to 100).

export interface Share {
  key: string;
  split: number;
}

/**
 * Divide `total` sats across shares proportionally to `split`, in whole sats.
 * Uses the largest-remainder method so the result always sums to exactly `total`.
 * Shares with split <= 0 get nothing.
 */
export function allocate(total: number, shares: Share[]): Map<string, number> {
  const out = new Map<string, number>();
  const live = shares.filter((s) => s.split > 0);
  for (const s of shares) out.set(s.key, 0);
  if (total <= 0 || live.length === 0) return out;

  const sum = live.reduce((a, s) => a + s.split, 0);
  const parts = live.map((s) => {
    const exact = (total * s.split) / sum;
    return { key: s.key, floor: Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let left = total - parts.reduce((a, p) => a + p.floor, 0);
  // Highest remainder first; ties keep feed order (stable sort).
  const byRem = [...parts].sort((a, b) => b.rem - a.rem);
  for (const p of byRem) {
    if (left <= 0) break;
    p.floor += 1;
    left -= 1;
  }
  for (const p of parts) out.set(p.key, p.floor);
  return out;
}

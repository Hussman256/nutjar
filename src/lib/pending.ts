// Safety net: anything the listener has paid but not yet delivered lives in localStorage
// until it is delivered or handed back as a token. Closing the tab never loses sats silently.
import type { WireProof } from './proofs';

export interface PendingBoost {
  id: string;
  mint: string;
  amount: number;
  createdAt: number;
  quote?: string; // unpaid / unminted bolt11 mint quote
  proofs: WireProof[]; // ecash held by the widget right now
}

const KEY = 'cashu-boost:pending';

function readAll(): PendingBoost[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as PendingBoost[];
  } catch {
    return [];
  }
}

function writeAll(list: PendingBoost[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable (private mode); recovery is best-effort */
  }
}

export function savePending(p: PendingBoost): void {
  writeAll([...readAll().filter((x) => x.id !== p.id), p]);
}

export function removePending(id: string): void {
  writeAll(readAll().filter((x) => x.id !== id));
}

export function listPending(): PendingBoost[] {
  // Drop stale quotes that never got paid (mint quotes expire; 2 days is generous).
  return readAll().filter((p) => p.proofs.length > 0 || (p.quote && Date.now() - p.createdAt < 2 * 864e5));
}

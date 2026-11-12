// JSON-safe proof handling. cashu-ts v4 uses an Amount class; the wire (NIP-61, NUT-00) wants numbers.
import { Amount, type Proof } from '@cashu/cashu-ts';

export interface WireProof {
  id: string;
  amount: number;
  secret: string;
  C: string;
  dleq?: { e: string; s: string; r?: string };
  witness?: string;
}

export function amountOf(p: { amount: unknown }): number {
  const a = p.amount as { toNumber?: () => number } | number | string | bigint;
  if (typeof a === 'object' && a && typeof a.toNumber === 'function') return a.toNumber();
  return Number(a);
}

export function sum(proofs: Array<{ amount: unknown }>): number {
  return proofs.reduce((t, p) => t + amountOf(p), 0);
}

export function toWire(p: Proof | WireProof): WireProof {
  const src = p as unknown as Record<string, unknown>;
  const out: WireProof = { id: p.id, amount: amountOf(p), secret: p.secret, C: p.C };
  const dleq = src.dleq as WireProof['dleq'] | undefined;
  if (dleq) out.dleq = { e: dleq.e, s: dleq.s, ...(dleq.r ? { r: dleq.r } : {}) };
  if (typeof src.witness === 'string') out.witness = src.witness;
  else if (src.witness) out.witness = JSON.stringify(src.witness);
  return out;
}

export function fromWire(p: WireProof): Proof {
  return { ...p, amount: Amount.from(p.amount) } as unknown as Proof;
}

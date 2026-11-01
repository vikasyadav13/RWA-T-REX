import type { Address } from '../issuance/chain.js';

export interface Holding {
  holder: Address;
  /** Whole shares (token has 0 decimals). */
  balance: bigint;
}

/** An exact fraction of ONE share: numerator / denominator, with 0 <= numerator < denominator. */
export interface ShareFraction {
  numerator: bigint;
  denominator: bigint;
}

export interface SplitLine {
  holder: Address;
  balance: bigint;
  /** Whole shares to mint to this holder. */
  toMint: bigint;
  /** Entitlement left over after rounding down, owed to the holder off-chain (cash in lieu). */
  fraction: ShareFraction;
}

export interface SplitPlan {
  lines: SplitLine[];
  oldSupply: bigint;
  totalToMint: bigint;
  /** Sum of all fractional entitlements, as a fraction of one share (same denominator). */
  totalFraction: ShareFraction;
}

/**
 * Plans a numerator-for-denominator forward split (3-for-2: every 2 shares become 3).
 *
 * Rounding rule: round DOWN per holder. A holder with b shares is entitled to exactly b*n/d shares;
 * they keep b, are minted floor(b*n/d) - b, and are owed the remainder ((b*n) mod d)/d of a share off-chain
 * (cash in lieu at the split reference price). Fractions are never pooled into minted shares: a share
 * minted from pooled fractions would belong to no holder, and handing it to anyone would give them more
 * than their exact entitlement.
 *
 * Exactness: for every holder, (b + toMint) * d + fraction.numerator == b * n, so summed over holders,
 * new holdings + fractions == oldSupply * n / d exactly. All arithmetic is bigint; nothing is rounded twice.
 */
export function planSplit(holders: Holding[], numerator: bigint, denominator: bigint): SplitPlan {
  if (denominator <= 0n || numerator <= 0n) throw new Error('ratio must be positive');
  if (numerator < denominator) {
    throw new Error('reverse splits (numerator < denominator) need burns and are out of scope');
  }
  const seen = new Set<string>();
  const lines: SplitLine[] = [];
  let oldSupply = 0n;
  let totalToMint = 0n;
  let totalRemainder = 0n;

  for (const { holder, balance } of holders) {
    const key = holder.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate holder ${holder}`);
    seen.add(key);
    if (balance < 0n) throw new Error(`negative balance for ${holder}`);

    const exactTimesD = balance * numerator; // entitlement, in units of 1/denominator share
    const newBalance = exactTimesD / denominator; // bigint division floors for non-negative values
    const remainder = exactTimesD % denominator;
    const toMint = newBalance - balance;

    lines.push({ holder, balance, toMint, fraction: { numerator: remainder, denominator } });
    oldSupply += balance;
    totalToMint += toMint;
    totalRemainder += remainder;
  }

  return { lines, oldSupply, totalToMint, totalFraction: { numerator: totalRemainder, denominator } };
}

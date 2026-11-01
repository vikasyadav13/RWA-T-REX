import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { planSplit, type Holding } from '../src/split/planSplit.js';
import type { Hex } from '../src/issuance/chain.js';

const addr = (i: number): Hex => `0x${i.toString(16).padStart(40, '0')}`;

/** Any list of distinct holders with whole-share balances, including zero and very large balances. */
const holdingsArb = fc
  .array(fc.oneof(fc.bigInt(0n, 10n), fc.bigInt(0n, 10n ** 6n), fc.bigInt(0n, 10n ** 30n)), { maxLength: 60 })
  .map((balances): Holding[] => balances.map((balance, i) => ({ holder: addr(i + 1), balance })));

describe('planSplit 3-for-2', () => {
  it('small holdings, worked by hand', () => {
    const plan = planSplit(
      [
        { holder: addr(1), balance: 1n }, // 1.5  -> 1 share, 1/2 owed
        { holder: addr(2), balance: 2n }, // 3    -> 3 shares
        { holder: addr(3), balance: 3n }, // 4.5  -> 4 shares, 1/2 owed
        { holder: addr(4), balance: 0n },
      ],
      3n,
      2n,
    );
    expect(plan.lines.map((l) => [l.toMint, l.fraction.numerator])).toEqual([
      [0n, 1n],
      [1n, 0n],
      [1n, 1n],
      [0n, 0n],
    ]);
    expect(plan.oldSupply).toBe(6n);
    expect(plan.totalToMint).toBe(2n); // 6 -> 8 whole shares
    expect(plan.totalFraction).toEqual({ numerator: 2n, denominator: 2n }); // + 1 share owed in cash = 9 = 6 * 3/2
  });

  it('property: new holdings + fractional entitlements == old supply × 3/2, exactly', () => {
    fc.assert(
      fc.property(holdingsArb, (holders) => {
        const plan = planSplit(holders, 3n, 2n);
        // Compare in halves to stay in integers: (oldSupply + minted) + fractions == oldSupply * 3/2
        const newHoldings = plan.oldSupply + plan.totalToMint;
        expect(newHoldings * 2n + plan.totalFraction.numerator).toBe(plan.oldSupply * 3n);
        // The same statement for the increase alone: minted + fractions == oldSupply * 1/2
        expect(plan.totalToMint * 2n + plan.totalFraction.numerator).toBe(plan.oldSupply);
      }),
      { numRuns: 1000 },
    );
  });

  it('property: no holder gets more than their exact entitlement, and loses less than one share', () => {
    fc.assert(
      fc.property(holdingsArb, (holders) => {
        for (const l of planSplit(holders, 3n, 2n).lines) {
          const exactTimes2 = l.balance * 3n;
          const newTimes2 = (l.balance + l.toMint) * 2n;
          expect(newTimes2).toBeLessThanOrEqual(exactTimes2);
          expect(newTimes2 + l.fraction.numerator).toBe(exactTimes2);
          expect(l.fraction.numerator >= 0n && l.fraction.numerator < l.fraction.denominator).toBe(true);
          expect(l.toMint >= 0n).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe('planSplit, any forward ratio', () => {
  it('property: exactness and the per-holder cap hold for any n >= d', () => {
    const ratio = fc
      .tuple(fc.bigInt(1n, 1000n), fc.bigInt(0n, 1000n))
      .map(([d, extra]) => ({ n: d + extra, d }));
    fc.assert(
      fc.property(holdingsArb, ratio, (holders, { n, d }) => {
        const plan = planSplit(holders, n, d);
        expect((plan.oldSupply + plan.totalToMint) * d + plan.totalFraction.numerator).toBe(plan.oldSupply * n);
        for (const l of plan.lines) expect((l.balance + l.toMint) * d).toBeLessThanOrEqual(l.balance * n);
      }),
      { numRuns: 500 },
    );
  });

  it('rejects reverse splits, non-positive ratios, duplicate holders and negative balances', () => {
    expect(() => planSplit([], 2n, 3n)).toThrow(/reverse/);
    expect(() => planSplit([], 3n, 0n)).toThrow(/positive/);
    expect(() => planSplit([], 0n, 2n)).toThrow(/positive/);
    const h = addr(1);
    expect(() =>
      planSplit(
        [
          { holder: h, balance: 1n },
          { holder: h.toUpperCase().replace('0X', '0x') as Hex, balance: 1n },
        ],
        3n,
        2n,
      ),
    ).toThrow(/duplicate/);
    expect(() => planSplit([{ holder: h, balance: -1n }], 3n, 2n)).toThrow(/negative/);
  });
});

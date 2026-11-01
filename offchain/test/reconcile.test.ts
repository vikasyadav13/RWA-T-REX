import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { id } from 'ethers';
import {
  emptyState,
  reconcile,
  type Batch,
  type BackendState,
  type TokenEvent,
  type TokenEventBody,
} from '../src/reconcile/reconcile.js';
import type { Hex } from '../src/issuance/chain.js';

const CONF = 3; // small depth keeps the tests readable; production default is DEFAULT_CONFIRMATIONS
const ZERO: Hex = '0x0000000000000000000000000000000000000000';
const ALICE: Hex = '0x00000000000000000000000000000000000a11ce';
const BOB: Hex = '0x0000000000000000000000000000000000000b0b';
const ALICE2: Hex = '0x00000000000000000000000000000000000a1102';
const ISS1: Hex = `0x${'1'.padStart(64, '0')}`;
const AUTH1: Hex = `0x${'a'.padStart(64, '0')}`;

const blockHash = (n: number, fork = 'a') => id(`block-${n}-${fork}`) as Hex; // keccak256 of the UTF-8 string
const txHash = (label: string) => id(`tx-${label}`) as Hex;

/** Builds the events of one transaction in block `n` of `fork`. */
function tx(n: number, label: string, bodies: TokenEventBody[], fork = 'a', firstLogIndex = 0): TokenEvent[] {
  return bodies.map((b, i) => ({
    ...b,
    blockNumber: BigInt(n),
    blockHash: blockHash(n, fork),
    txHash: txHash(label),
    logIndex: firstLogIndex + i,
  }));
}

function batch(events: TokenEvent[], head: number, forks: Record<number, string> = {}): Batch {
  const canonicalHashes: Record<string, Hex> = {};
  for (let n = 0; n <= head; n++) canonicalHashes[String(n)] = blockHash(n, forks[n] ?? 'a');
  return { events, headBlock: BigInt(head), canonicalHashes };
}

const mint = (issuanceId: Hex, to: Hex, amount: bigint): TokenEventBody[] => [
  { type: 'Transfer', from: ZERO, to, value: amount },
  { type: 'Issued', issuanceId, to, amount },
];

const authorisedTransfer = (authId: Hex, from: Hex, to: Hex, amount: bigint): TokenEventBody[] => [
  { type: 'Transfer', from, to, value: amount },
  { type: 'AuthorisationConsumed', authId, from, to, amount },
];

/** Alice has 1000, both in the register and on-chain, plus whatever `extra` sets up. */
function stateWithAlice(extra: (s: BackendState) => void = () => {}): BackendState {
  const s = emptyState();
  s.issuances[ISS1] = { to: ALICE, amount: 1000n, status: 'requested' };
  const r = reconcile(s, batch(tx(1, 'mint', mint(ISS1, ALICE, 1000n)), 1 + CONF), { confirmations: CONF });
  expect(r.discrepancies).toEqual([]);
  extra(r.state);
  return r.state;
}

const kinds = (r: { discrepancies: { kind: string }[] }) => r.discrepancies.map((d) => d.kind);

describe('reconcile: happy paths', () => {
  it('completes a requested issuance and credits the register', () => {
    const s = stateWithAlice();
    expect(s.issuances[ISS1]!.status).toBe('completed');
    expect(s.balances[ALICE]).toBe(1000n);
    expect(s.observed.balances[ALICE]).toBe(1000n);
  });

  it('applies an authorised transfer and marks the authorisation used', () => {
    const s = stateWithAlice((s) => {
      s.authorisations[AUTH1] = { from: ALICE, to: BOB, amount: 100n, status: 'outstanding' };
    });
    const r = reconcile(s, batch(tx(5, 't', authorisedTransfer(AUTH1, ALICE, BOB, 100n)), 5 + CONF), { confirmations: CONF });
    expect(r.discrepancies).toEqual([]);
    expect(r.state.authorisations[AUTH1]!.status).toBe('used');
    expect(r.state.balances).toEqual({ [ALICE]: 900n, [BOB]: 100n });
  });

  it('accepts mixed-case addresses in events', () => {
    const s = stateWithAlice((s) => {
      s.authorisations[AUTH1] = { from: ALICE, to: BOB, amount: 100n, status: 'outstanding' };
    });
    const events = tx(5, 't', authorisedTransfer(AUTH1, ALICE, BOB, 100n)).map((e) =>
      e.type === 'Transfer' ? { ...e, to: e.to.toUpperCase().replace('0X', '0x') as Hex } : e,
    );
    expect(reconcile(s, batch(events, 5 + CONF), { confirmations: CONF }).discrepancies).toEqual([]);
  });
});

describe('reconcile: finality and reorgs', () => {
  it('defers events until they are `confirmations` deep, then applies them', () => {
    const s = emptyState();
    s.issuances[ISS1] = { to: ALICE, amount: 1000n, status: 'requested' };
    const events = tx(10, 'mint', mint(ISS1, ALICE, 1000n));

    const early = reconcile(s, batch(events, 10 + CONF - 2), { confirmations: CONF });
    expect(early.deferred).toBe(2);
    expect(early.state).toEqual(s);

    const later = reconcile(early.state, batch(events, 10 + CONF - 1), { confirmations: CONF });
    expect(later.deferred).toBe(0);
    expect(later.state.balances[ALICE]).toBe(1000n);
  });

  it('ignores events from blocks that are no longer canonical, and applies the replacement fork', () => {
    const s = emptyState();
    s.issuances[ISS1] = { to: ALICE, amount: 1000n, status: 'requested' };
    // The mint was first seen in 10a; the reorg re-included it in 11b.
    const stale = tx(10, 'mint', mint(ISS1, ALICE, 1000n), 'a');
    const replacement = tx(11, 'mint', mint(ISS1, ALICE, 1000n), 'b');
    const r = reconcile(s, batch([...stale, ...replacement], 11 + CONF, { 10: 'b', 11: 'b' }), { confirmations: CONF });
    expect(r.orphaned).toBe(2);
    expect(r.discrepancies).toEqual([]);
    expect(r.state.balances[ALICE]).toBe(1000n);
    expect(Object.keys(r.state.applied).every((k) => k.startsWith(blockHash(11, 'b')))).toBe(true);
  });

  it('a reorged-out transfer that never re-appears is never applied', () => {
    const s = stateWithAlice((s) => {
      s.authorisations[AUTH1] = { from: ALICE, to: BOB, amount: 100n, status: 'outstanding' };
    });
    const r = reconcile(s, batch(tx(5, 't', authorisedTransfer(AUTH1, ALICE, BOB, 100n), 'a'), 5 + CONF, { 5: 'b' }), {
      confirmations: CONF,
    });
    expect(r.orphaned).toBe(2);
    expect(r.state.authorisations[AUTH1]!.status).toBe('outstanding');
    expect(r.state.balances[ALICE]).toBe(1000n);
  });

  it('flags a reorg deeper than the confirmation depth (an applied block changed hash)', () => {
    const s = stateWithAlice();
    const r = reconcile(s, batch([], 50, { 1: 'evil' }), { confirmations: CONF });
    expect(kinds(r)).toContain('DEEP_REORG');
    expect(r.state).toEqual(s); // flagged, not silently rewritten
  });

  it('defers events whose canonical hash was not supplied', () => {
    const s = emptyState();
    const b = batch(tx(10, 'mint', mint(ISS1, ALICE, 1n)), 20);
    delete b.canonicalHashes['10'];
    const r = reconcile(s, b, { confirmations: CONF });
    expect(r.deferred).toBe(2);
    expect(r.state).toEqual(s);
  });
});

describe('reconcile: discrepancies', () => {
  it('transfer with no matching authorisation: reported, not adopted into the register', () => {
    const s = stateWithAlice();
    const r = reconcile(s, batch(tx(5, 't', [{ type: 'Transfer', from: ALICE, to: BOB, value: 100n }]), 5 + CONF), {
      confirmations: CONF,
    });
    expect(kinds(r)).toEqual(['UNAUTHORISED_TRANSFER', 'BALANCE_MISMATCH', 'BALANCE_MISMATCH']);
    expect(r.state.balances[ALICE]).toBe(1000n);
    expect(r.state.observed.balances[ALICE]).toBe(900n);
  });

  it('transfer consuming an authorisation the backend had revoked (revoke tx lost the race)', () => {
    const s = stateWithAlice((s) => {
      s.authorisations[AUTH1] = { from: ALICE, to: BOB, amount: 100n, status: 'revoked' };
    });
    const r = reconcile(s, batch(tx(5, 't', authorisedTransfer(AUTH1, ALICE, BOB, 100n)), 5 + CONF), { confirmations: CONF });
    expect(kinds(r)[0]).toBe('UNAUTHORISED_TRANSFER');
    expect(r.state.authorisations[AUTH1]!.status).toBe('revoked');
  });

  it('duplicate issuance: the second mint for a completed issuance ID', () => {
    const s = stateWithAlice();
    const r = reconcile(s, batch(tx(5, 'mint-again', mint(ISS1, ALICE, 1000n)), 5 + CONF), { confirmations: CONF });
    expect(kinds(r)).toEqual(['DUPLICATE_ISSUANCE', 'BALANCE_MISMATCH']);
    expect(r.state.balances[ALICE]).toBe(1000n);
    expect(r.state.observed.balances[ALICE]).toBe(2000n);
  });

  it('duplicate issuance inside a single batch', () => {
    const s = emptyState();
    s.issuances[ISS1] = { to: ALICE, amount: 10n, status: 'requested' };
    const r = reconcile(s, batch([...tx(3, 'm1', mint(ISS1, ALICE, 10n)), ...tx(4, 'm2', mint(ISS1, ALICE, 10n))], 4 + CONF), {
      confirmations: CONF,
    });
    expect(kinds(r)).toEqual(['DUPLICATE_ISSUANCE', 'BALANCE_MISMATCH']);
  });

  it('issuance the backend never requested, and one minted with the wrong amount', () => {
    const s = emptyState();
    const other: Hex = `0x${'2'.padStart(64, '0')}`;
    s.issuances[other] = { to: BOB, amount: 5n, status: 'requested' };
    const r = reconcile(s, batch([...tx(3, 'u', mint(ISS1, ALICE, 1n)), ...tx(4, 'w', mint(other, BOB, 6n))], 4 + CONF), {
      confirmations: CONF,
    });
    expect(kinds(r)).toEqual(['UNKNOWN_ISSUANCE', 'ISSUANCE_MISMATCH', 'BALANCE_MISMATCH', 'BALANCE_MISMATCH']);
    expect(r.state.issuances[other]!.status).toBe('requested');
  });

  it('mint that bypassed the gateway', () => {
    const r = reconcile(emptyState(), batch(tx(3, 'm', [{ type: 'Transfer', from: ZERO, to: ALICE, value: 7n }]), 3 + CONF), {
      confirmations: CONF,
    });
    expect(kinds(r)).toEqual(['UNEXPECTED_MINT', 'BALANCE_MISMATCH']);
  });

  it('balance that differs from the record (register drifted on its own)', () => {
    const s = stateWithAlice((s) => {
      s.balances[ALICE] = 1200n; // e.g. a bad manual edit
      s.authorisations[AUTH1] = { from: ALICE, to: BOB, amount: 100n, status: 'outstanding' };
    });
    const r = reconcile(s, batch(tx(5, 't', authorisedTransfer(AUTH1, ALICE, BOB, 100n)), 5 + CONF), { confirmations: CONF });
    expect(r.discrepancies).toEqual([{ kind: 'BALANCE_MISMATCH', address: ALICE, record: 1100n, onChain: 900n }]);
  });

  it('freeze nobody asked for', () => {
    const s = stateWithAlice();
    const r = reconcile(s, batch(tx(5, 'f', [{ type: 'TokensFrozen', holder: ALICE, amount: 10n }]), 5 + CONF), {
      confirmations: CONF,
    });
    expect(kinds(r)).toEqual(['UNEXPECTED_FREEZE_CHANGE', 'FROZEN_MISMATCH']);
  });
});

describe('reconcile: interventions initiated by the backend', () => {
  it('court-ordered reversal via forcedTransfer (with the automatic unfreeze)', () => {
    const s = stateWithAlice((s) => {
      s.authorisations[AUTH1] = { from: ALICE, to: BOB, amount: 100n, status: 'outstanding' };
    });
    const s1 = reconcile(s, batch(tx(5, 't', authorisedTransfer(AUTH1, ALICE, BOB, 100n)), 5 + CONF), { confirmations: CONF }).state;
    // Bob had 50 of the 100 frozen pending the court case; forcedTransfer unfreezes what it needs.
    s1.agentOperations['freeze-bob'] = { kind: 'freeze', holder: BOB, amount: 50n, status: 'pending' };
    s1.agentOperations['court-123'] = { kind: 'forcedTransfer', from: BOB, to: ALICE, amount: 100n, status: 'pending' };
    const events = [
      ...tx(6, 'freeze', [{ type: 'TokensFrozen', holder: BOB, amount: 50n }]),
      ...tx(7, 'reverse', [
        { type: 'TokensUnfrozen', holder: BOB, amount: 50n },
        { type: 'Transfer', from: BOB, to: ALICE, value: 100n },
      ]),
    ];
    const r = reconcile(s1, batch(events, 7 + CONF), { confirmations: CONF });
    expect(r.discrepancies).toEqual([]);
    expect(r.state.balances).toEqual({ [ALICE]: 1000n });
    expect(r.state.frozen).toEqual({});
    expect(r.state.agentOperations['court-123']!.status).toBe('done');
  });

  it('wallet recovery moves balance and frozen amount to the new wallet', () => {
    const s = stateWithAlice((s) => {
      s.agentOperations['f'] = { kind: 'freeze', holder: ALICE, amount: 300n, status: 'pending' };
      s.agentOperations['rec-1'] = { kind: 'recovery', lostWallet: ALICE, newWallet: ALICE2, status: 'pending' };
    });
    // Log order as emitted by Token.recoveryAddress -> forcedTransfer + freezePartialTokens.
    const events = [
      ...tx(4, 'freeze', [{ type: 'TokensFrozen', holder: ALICE, amount: 300n }]),
      ...tx(6, 'recover', [
        { type: 'TokensUnfrozen', holder: ALICE, amount: 300n },
        { type: 'Transfer', from: ALICE, to: ALICE2, value: 1000n },
        { type: 'TokensFrozen', holder: ALICE2, amount: 300n },
        { type: 'RecoverySuccess', lostWallet: ALICE, newWallet: ALICE2, investorOnchainID: BOB },
      ]),
    ];
    const r = reconcile(s, batch(events, 6 + CONF), { confirmations: CONF });
    expect(r.discrepancies).toEqual([]);
    expect(r.state.balances).toEqual({ [ALICE2]: 1000n });
    expect(r.state.frozen).toEqual({ [ALICE2]: 300n });
  });

  it('a forced transfer the backend did not initiate is unauthorised', () => {
    const s = stateWithAlice();
    const r = reconcile(s, batch(tx(5, 'f', [{ type: 'Transfer', from: ALICE, to: BOB, value: 1n }]), 5 + CONF), {
      confirmations: CONF,
    });
    expect(kinds(r)[0]).toBe('UNAUTHORISED_TRANSFER');
  });
});

describe('reconcile: idempotency', () => {
  it('reprocessing the same batch changes nothing and reports nothing new', () => {
    const s = stateWithAlice();
    const b = batch(
      [
        ...tx(5, 'bad', [{ type: 'Transfer', from: ALICE, to: BOB, value: 1n }]),
        ...tx(6, 'dup', mint(ISS1, ALICE, 1000n)),
        ...tx(7, 'late', [{ type: 'Transfer', from: ALICE, to: BOB, value: 2n }]),
      ],
      6 + CONF,
    );
    const first = reconcile(s, b, { confirmations: CONF });
    expect(first.discrepancies.length).toBeGreaterThan(0);
    const second = reconcile(first.state, b, { confirmations: CONF });
    expect(second.state).toEqual(first.state);
    expect(second.discrepancies).toEqual([]);
  });

  it('property: for random event streams, replaying any batch is a no-op and split batches equal one batch', () => {
    const addr = fc.constantFrom(ALICE, BOB, ALICE2);
    const body = fc.oneof(
      fc.record({ type: fc.constant('Transfer' as const), from: addr, to: addr, value: fc.bigInt(1n, 50n) }),
      fc.record({ type: fc.constant('TokensFrozen' as const), holder: addr, amount: fc.bigInt(1n, 5n) }),
      fc
        .tuple(fc.constantFrom(ISS1, AUTH1), addr, fc.bigInt(1n, 50n))
        .map(([id, to, amount]) => ({ type: 'Issued' as const, issuanceId: id, to, amount })),
    );
    const block = fc.record({ fork: fc.constantFrom('a', 'b'), bodies: fc.array(body, { maxLength: 3 }) });
    fc.assert(
      fc.property(fc.array(block, { maxLength: 12 }), fc.nat(12), (blocks, split) => {
        const events = blocks.flatMap((b, i) => tx(i + 1, `t${i}`, b.bodies, b.fork));
        const head = blocks.length + CONF;
        const s = stateWithAlice();
        const whole = batch(events, head);

        const once = reconcile(s, whole, { confirmations: CONF });
        const twice = reconcile(once.state, whole, { confirmations: CONF });
        expect(twice.state).toEqual(once.state);
        expect(twice.discrepancies.filter((d) => d.kind !== 'DEEP_REORG')).toEqual([]);

        // Same events delivered as two batches (at a block boundary) give the same final state.
        const cut = Math.min(split, blocks.length) + 1;
        const a = reconcile(s, batch(events.filter((e) => e.blockNumber < BigInt(cut)), head), { confirmations: CONF });
        const b = reconcile(a.state, batch(events.filter((e) => e.blockNumber >= BigInt(cut)), head), { confirmations: CONF });
        expect(b.state).toEqual(once.state);
      }),
      { numRuns: 300 },
    );
  });
});

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { FakeChain, FakeSigner } from './fakeChain.js';
import { InMemoryIssuanceStore, type IssuanceRecord } from '../src/issuance/store.js';
import {
  ConflictingIssuanceError,
  IssuanceStillPendingError,
  IssuanceSubmitter,
  type SubmitterOptions,
} from '../src/issuance/submitter.js';
import type { Hex, IssuanceRequest } from '../src/issuance/chain.js';

const ISSUER: Hex = '0x00000000000000000000000000000000000000a1';
const ALICE: Hex = '0x00000000000000000000000000000000000a11ce';
const REQ: IssuanceRequest = { issuanceId: `0x${'01'.padStart(64, '0')}`, to: ALICE, amount: 100n };
const CONFIRMATIONS = 3;

class Crash extends Error {}

/** "confirmed" must mean the mint survives any reorg shallower than the confirmation depth. */
function assertConfirmedSurvivesShallowReorg(chain: FakeChain) {
  chain.reorg(CONFIRMATIONS - 1, { evict: true });
  expect(chain.mintCount(REQ.issuanceId)).toBe(1);
}

/** Wires a submitter to the fake chain. Each poll's sleep runs `onTick(tick)` and then mines one block. */
function harness(onTick: (tick: number, chain: FakeChain, rec: () => Promise<IssuanceRecord | undefined>) => void = () => {}) {
  const chain = new FakeChain();
  const store = new InMemoryIssuanceStore();
  let tick = 0;
  const rec = () => store.get(REQ.issuanceId);
  const make = (overrides: Partial<SubmitterOptions> = {}) =>
    new IssuanceSubmitter(chain, new FakeSigner(ISSUER), store, {
      confirmations: CONFIRMATIONS,
      pollIntervalMs: 0,
      maxPolls: 200,
      bumpAfterPolls: 10,
      sleep: async () => {
        onTick(tick++, chain, rec);
        chain.mine();
      },
      ...overrides,
    });
  return { chain, store, make, rec };
}

/** The "process restarts" loop: on Crash, build a fresh submitter over the same store and chain. */
async function runWithRestarts(make: () => IssuanceSubmitter, maxRestarts = 20) {
  for (let i = 0; ; i++) {
    try {
      return await make().submitIssuance(REQ);
    } catch (e) {
      if (!(e instanceof Crash) || i >= maxRestarts) throw e;
    }
  }
}

describe('submitIssuance', () => {
  it('happy path: one tx, confirmed only after the confirmation depth', async () => {
    const seen: (string | undefined)[] = [];
    const { chain, make, rec } = harness((_t, _c, r) => void r().then((x) => seen.push(x?.status)));
    const result = await make().submitIssuance(REQ);
    expect(result.status).toBe('confirmed');
    expect(chain.mintCount(REQ.issuanceId)).toBe(1);
    expect(chain.sends).toBe(1);
    const r = (await rec())!;
    expect(result).toMatchObject({ mintedBy: r.attempts[0]!.hash });
    // mined in block 1, final once head = 3
    expect(chain.head()).toBe(BigInt(CONFIRMATIONS));
    assertConfirmedSurvivesShallowReorg(chain);
  });

  it('RPC timeout after the tx was broadcast: does not sign a second tx', async () => {
    const { chain, make, rec } = harness();
    chain.sendBehaviours = ['timeoutAfterBroadcast'];
    const result = await make().submitIssuance(REQ);
    expect(result.status).toBe('confirmed');
    expect(chain.mintCount(REQ.issuanceId)).toBe(1);
    expect((await rec())!.attempts).toHaveLength(1);
  });

  it('RPC timeout before the tx reached the node: rebroadcasts the same signed bytes', async () => {
    const { chain, make, rec } = harness();
    chain.sendBehaviours = ['timeoutBeforeBroadcast', 'timeoutBeforeBroadcast'];
    const result = await make().submitIssuance(REQ);
    expect(result.status).toBe('confirmed');
    expect(chain.mintCount(REQ.issuanceId)).toBe(1);
    expect((await rec())!.attempts).toHaveLength(1);
    expect(chain.sends).toBe(3);
  });

  it('crash after persisting the signed tx but before broadcasting: restart broadcasts the same tx', async () => {
    const { chain, store, make, rec } = harness();
    const realPut = store.put.bind(store);
    let crashed = false;
    store.put = async (r) => {
      await realPut(r); // durable...
      if (!crashed && r.attempts.length === 1) {
        crashed = true;
        throw new Crash(); // ...and the process dies before sendRawTransaction
      }
    };
    const result = await runWithRestarts(() => make());
    expect(result.status).toBe('confirmed');
    expect(chain.mintCount(REQ.issuanceId)).toBe(1);
    expect((await rec())!.attempts).toHaveLength(1);
    expect(chain.sends).toBe(1);
  });

  it('crash after broadcast, and again while waiting for confirmations: no new tx, mints once', async () => {
    const crashAt = new Set([0, 2]);
    const { chain, make, rec } = harness((t) => {
      if (crashAt.delete(t)) throw new Crash();
    });
    const result = await runWithRestarts(() => make());
    expect(result.status).toBe('confirmed');
    expect(chain.mintCount(REQ.issuanceId)).toBe(1);
    expect((await rec())!.attempts).toHaveLength(1);
  });

  it('tx dropped from the mempool: rebroadcasts it', async () => {
    const { chain, make, rec } = harness((t, c) => {
      if (t === 0) for (const h of c.mempool.keys()) c.drop(h);
    });
    const result = await make().submitIssuance(REQ);
    expect(result.status).toBe('confirmed');
    expect(chain.mintCount(REQ.issuanceId)).toBe(1);
    expect((await rec())!.attempts).toHaveLength(1);
  });

  it('tx dropped and its nonce taken by another tx from the same key: re-signs on a fresh nonce once that is final', async () => {
    const { chain, make, rec } = harness((t, c) => {
      if (t === 0) {
        for (const h of c.mempool.keys()) c.drop(h);
        c.injectOtherTx(ISSUER, 0);
      }
    });
    const result = await make().submitIssuance(REQ);
    expect(result.status).toBe('confirmed');
    expect(chain.mintCount(REQ.issuanceId)).toBe(1);
    expect((await rec())!.attempts.map((a) => a.nonce)).toEqual([0, 1]);
  });

  it('stuck tx (fee too low): replaces it at the same nonce with higher fees', async () => {
    const { chain, make, rec } = harness();
    chain.minPriorityFee = 2n * 10n ** 9n; // estimate is 1 gwei
    const result = await make({ bumpAfterPolls: 2 }).submitIssuance(REQ);
    expect(result.status).toBe('confirmed');
    expect(chain.mintCount(REQ.issuanceId)).toBe(1);
    const attempts = (await rec())!.attempts;
    expect(attempts.length).toBeGreaterThan(1);
    expect(new Set(attempts.map((a) => a.nonce))).toEqual(new Set([0]));
  });

  it('reorg removes the included tx before it is final (evicted): not confirmed early, rebroadcast, mints once', async () => {
    const statuses: string[] = [];
    const { chain, make, rec } = harness((t, c, r) => {
      void r().then((x) => statuses.push(x!.status));
      if (t === 1) {
        // tx was mined in block 1 at tick 0; now orphan blocks 1..2 and drop the tx entirely
        c.reorg(2, { evict: true });
      }
    });
    const result = await make().submitIssuance(REQ);
    expect(result.status).toBe('confirmed');
    expect(chain.mintCount(REQ.issuanceId)).toBe(1);
    const r = (await rec())!;
    expect(r.attempts).toHaveLength(1);
    expect(r.includedIn!.blockHash).toBe(await chain.getBlockHash(r.includedIn!.blockNumber));
    expect(statuses.slice(0, 3)).not.toContain('confirmed');
  });

  it('reorg returns the tx to the mempool and it is re-mined in a different block', async () => {
    const { chain, make, rec } = harness((t, c) => {
      if (t === 1) c.reorg(2);
    });
    const result = await make().submitIssuance(REQ);
    expect(result.status).toBe('confirmed');
    expect(chain.mintCount(REQ.issuanceId)).toBe(1);
    expect(result).toMatchObject({ mintedBy: (await rec())!.attempts[0]!.hash });
  });

  it('reorg after which another tx holds our nonce: re-nonces, still mints once', async () => {
    const { chain, make, rec } = harness((t, c) => {
      if (t === 1) {
        c.reorg(2, { evict: true });
        c.injectOtherTx(ISSUER, 0);
      }
    });
    const result = await make().submitIssuance(REQ);
    expect(result.status).toBe('confirmed');
    expect(chain.mintCount(REQ.issuanceId)).toBe(1);
    expect((await rec())!.attempts.map((a) => a.nonce)).toEqual([0, 1]);
  });

  it('regression (found by the chaos property): re-nonce past a foreign tx that a reorg then evicts leaves a gap; fills it', async () => {
    // Shrunk counterexample, verbatim: [foreignTx, none, reorg2Evict, foreignTx, none, reorg2Evict].
    // A foreign tx (nonce read before the block, inserted after it) wins our nonce 0 after the first reorg;
    // we re-nonce to 2 from the head count, which included a foreign nonce-1 tx that the second reorg
    // evicts. Nonce 1 is then a gap below ours, and without the fix we fee-bump forever.
    const foreignTx = (c: FakeChain) => void c.getTransactionCount(ISSUER, c.head()).then((n) => c.injectOtherTx(ISSUER, n));
    const { chain, make, rec } = harness((t, c) => {
      if (t === 0 || t === 3) foreignTx(c);
      if (t === 2 || t === 5) c.reorg(2, { evict: true });
    });
    const result = await make({ bumpAfterPolls: 4, maxPolls: 40 }).submitIssuance(REQ);
    expect(result.status).toBe('confirmed');
    expect(chain.mintCount(REQ.issuanceId)).toBe(1);
    expect((await rec())!.attempts.map((a) => a.nonce)).toEqual([0, 2, 1]); // came back down to fill the gap
  });

  it('issuance already on-chain but missing from the store (restored backup): sends nothing', async () => {
    const { chain, make } = harness();
    await make().submitIssuance(REQ);
    const sends = chain.sends;
    const fresh = new IssuanceSubmitter(chain, new FakeSigner(ISSUER), new InMemoryIssuanceStore(), {
      confirmations: CONFIRMATIONS,
      pollIntervalMs: 0,
      maxPolls: 10,
      bumpAfterPolls: 10,
      sleep: async () => chain.mine(),
    });
    expect((await fresh.submitIssuance(REQ)).status).toBe('confirmed');
    expect(chain.sends).toBe(sends);
    expect(chain.mintCount(REQ.issuanceId)).toBe(1);
  });

  it('a final revert (recipient not verified) is a permanent failure and is not retried', async () => {
    const { chain, make, rec } = harness();
    chain.unverified.add(ALICE.toLowerCase());
    const result = await make().submitIssuance(REQ);
    expect(result.status).toBe('failed');
    expect(chain.mintCount(REQ.issuanceId)).toBe(0);
    expect((await rec())!.attempts).toHaveLength(1);
  });

  it('a failed issuance stays failed on resubmit, and mints once on an explicit retry after onboarding', async () => {
    const { chain, make, rec } = harness();
    chain.unverified.add(ALICE.toLowerCase());
    const s = make();
    expect((await s.submitIssuance(REQ)).status).toBe('failed');
    expect((await s.submitIssuance(REQ)).status).toBe('failed'); // no silent auto-retry

    chain.unverified.delete(ALICE.toLowerCase()); // recipient onboarded
    expect((await s.retryFailedIssuance(REQ)).status).toBe('confirmed');
    expect(chain.mintCount(REQ.issuanceId)).toBe(1);
    const r = (await rec())!;
    expect(r.attempts).toHaveLength(1);
    expect(r.failedAttempts).toHaveLength(1);
    assertConfirmedSurvivesShallowReorg(chain);
  });

  it('retryFailedIssuance refuses anything that is not failed', async () => {
    const { make } = harness();
    const s = make();
    await expect(s.retryFailedIssuance(REQ)).rejects.toThrow('not failed');
    await s.submitIssuance(REQ);
    await expect(s.retryFailedIssuance(REQ)).rejects.toThrow('not failed');
  });

  it('resubmitting a confirmed issuance returns the stored result without touching the chain', async () => {
    const { chain, make } = harness();
    const s = make();
    await s.submitIssuance(REQ);
    const sends = chain.sends;
    expect((await s.submitIssuance(REQ)).status).toBe('confirmed');
    expect(chain.sends).toBe(sends);
  });

  it('concurrent calls for the same request share one tx', async () => {
    const { chain, make, rec } = harness();
    const s = make();
    const [a, b] = await Promise.all([s.submitIssuance(REQ), s.submitIssuance(REQ)]);
    expect(a.status).toBe('confirmed');
    expect(b.status).toBe('confirmed');
    expect((await rec())!.attempts).toHaveLength(1);
    expect(chain.mintCount(REQ.issuanceId)).toBe(1);
  });

  it('rejects the same issuance ID with different parameters', async () => {
    const { make } = harness();
    const s = make();
    await s.submitIssuance(REQ);
    await expect(s.submitIssuance({ ...REQ, amount: 101n })).rejects.toBeInstanceOf(ConflictingIssuanceError);
  });

  it('gives up after maxPolls with the record persisted, and resumes on the next call', async () => {
    const { chain, make } = harness();
    chain.minPriorityFee = 10n ** 30n; // nothing gets mined
    await expect(make({ maxPolls: 5 }).submitIssuance(REQ)).rejects.toBeInstanceOf(IssuanceStillPendingError);
    chain.minPriorityFee = 0n;
    expect((await make().submitIssuance(REQ)).status).toBe('confirmed');
    expect(chain.mintCount(REQ.issuanceId)).toBe(1);
  });

  it('property: any mix of timeouts, drops, reorgs, foreign txs and crashes mints exactly once', async () => {
    const event = fc.constantFrom(
      'none',
      'drop',
      'reorg1',
      'reorg2Evict',
      'crash',
      'timeoutAfter',
      'timeoutBefore',
      'foreignTx',
    );
    await fc.assert(
      fc.asyncProperty(fc.array(event, { maxLength: 25 }), async (events) => {
        let maxMints = 0;
        const { chain, make } = harness((t, c) => {
          maxMints = Math.max(maxMints, c.mintCount(REQ.issuanceId));
          switch (events[t]) {
            case 'drop':
              for (const h of c.mempool.keys()) c.drop(h);
              break;
            case 'reorg1':
              if (c.head() >= 1n) c.reorg(1);
              break;
            case 'reorg2Evict':
              if (c.head() >= 2n) c.reorg(2, { evict: true });
              break;
            case 'crash':
              throw new Crash();
            case 'timeoutAfter':
              c.sendBehaviours.push('timeoutAfterBroadcast');
              break;
            case 'timeoutBefore':
              c.sendBehaviours.push('timeoutBeforeBroadcast');
              break;
            case 'foreignTx':
              void c.getTransactionCount(ISSUER, c.head()).then((n) => c.injectOtherTx(ISSUER, n));
              break;
          }
        });
        const result = await runWithRestarts(() => make({ bumpAfterPolls: 4 }), 50);
        expect(result.status).toBe('confirmed');
        expect(chain.mintCount(REQ.issuanceId)).toBe(1);
        expect(maxMints).toBeLessThanOrEqual(1);
        assertConfirmedSurvivesShallowReorg(chain);
      }),
      { numRuns: 300 },
    );
  });
});

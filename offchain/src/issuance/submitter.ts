import type { ChainClient, Fees, Hex, IssuanceRequest, TxSigner } from './chain.js';
import type { Attempt, IssuanceRecord, IssuanceStore } from './store.js';

export interface SubmitterOptions {
  /**
   * An issuance is final once the IssuanceGateway reports it issued at a block with this many
   * confirmations (the block itself counts as 1). Same depth as reconciliation; see DESIGN.md / README.
   */
  confirmations: number;
  pollIntervalMs: number;
  /** Give up (leaving the record persisted and resumable) after this many polls. */
  maxPolls: number;
  /** Replace a still-pending tx with a higher-fee one after this many polls without inclusion. */
  bumpAfterPolls: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export type IssuanceResult =
  | { status: 'confirmed'; issuanceId: Hex; mintedBy?: Hex }
  | { status: 'failed'; issuanceId: Hex; reason: string };

export class IssuanceStillPendingError extends Error {
  constructor(readonly issuanceId: Hex) {
    super(`issuance ${issuanceId} not final yet; call submitIssuance again to resume`);
  }
}

export class ConflictingIssuanceError extends Error {
  constructor(readonly issuanceId: Hex) {
    super(`issuance ${issuanceId} was already submitted with different parameters`);
  }
}

/** Geth's txpool needs >= 10% on both fee fields to accept a same-nonce replacement; use 20%. */
const bump = (v: bigint) => (v * 120n) / 100n + 1n;

/**
 * Gets IssuanceGateway.issue(issuanceId, to, amount) on-chain exactly once.
 *
 * Safety (at most once) comes from the contract: the gateway reverts on a reused issuance ID, so no
 * sequence of resubmissions, replacements or re-nonced txs can mint twice. This class provides liveness
 * (at least once) and a correct final status:
 *  - final status is read from contract state at a block `confirmations` deep, never from a receipt or
 *    an RPC response alone, so reorgs and lost responses cannot produce a wrong "confirmed";
 *  - every signed tx is persisted before it is broadcast, so after a crash we rebroadcast the same bytes
 *    (same hash, same nonce) instead of signing something new;
 *  - one in-flight issuance per signer key (see `lock`), so nonces are allocated sequentially from the
 *    chain's view, without a local nonce counter that could drift.
 */
export class IssuanceSubmitter {
  private lock: Promise<unknown> = Promise.resolve();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: NonNullable<SubmitterOptions['log']>;

  constructor(
    private readonly chain: ChainClient,
    private readonly signer: TxSigner,
    private readonly store: IssuanceStore,
    private readonly opts: SubmitterOptions,
  ) {
    if (opts.confirmations < 1) throw new Error('confirmations must be >= 1');
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? (() => {});
  }

  submitIssuance(request: IssuanceRequest): Promise<IssuanceResult> {
    // Serialise per signer: the nonce logic assumes nothing else of ours is in flight.
    const run = this.lock.then(() => this.drive(request));
    this.lock = run.catch(() => {});
    return run;
  }

  private async drive(request: IssuanceRequest): Promise<IssuanceResult> {
    let rec = await this.store.get(request.issuanceId);
    if (!rec) {
      rec = { request, status: 'pending', attempts: [], pollsSinceLastAttempt: 0 };
      await this.store.put(rec);
    } else if (rec.request.to.toLowerCase() !== request.to.toLowerCase() || rec.request.amount !== request.amount) {
      throw new ConflictingIssuanceError(request.issuanceId);
    }

    for (let i = 0; i < this.opts.maxPolls; i++) {
      const done = toResult(rec);
      if (done) return done;
      rec = await this.step(rec);
      const after = toResult(rec);
      if (after) return after;
      await this.sleep(this.opts.pollIntervalMs);
    }
    throw new IssuanceStillPendingError(request.issuanceId);
  }

  /** One poll of the state machine. Reads chain state, persists any decision, then acts. */
  private async step(rec: IssuanceRecord): Promise<IssuanceRecord> {
    const { issuanceId } = rec.request;
    const head = await this.chain.getBlockNumber();
    const finalBlock = head - BigInt(this.opts.confirmations) + 1n; // newest block that is deep enough

    // 1. The only success criterion: the contract says issued, at a final block.
    if (finalBlock >= 0n && (await this.chain.isIssued(issuanceId, finalBlock))) {
      const mintedBy = await this.findOwnSuccessfulAttempt(rec.attempts, finalBlock);
      return this.save({ ...rec, status: 'confirmed', mintedBy });
    }

    // 2. Nothing sent yet.
    const current = rec.attempts.at(-1);
    if (!current) {
      // Already issued at head (another replica, or our store was restored from a backup): never send,
      // just wait for it to become final or be reorged out.
      if (await this.chain.isIssued(issuanceId, head)) return rec;
      const nonce = await this.chain.getTransactionCount(this.signer.address, head);
      return this.sendNewAttempt(rec, nonce, await this.chain.estimateFees());
    }

    // 3. Is one of our attempts included in the canonical chain?
    const included = await this.findCanonicalReceipt(rec.attempts);
    if (included) {
      rec = { ...rec, includedIn: included.at };
      if (included.at.blockNumber <= finalBlock && included.status === 'reverted') {
        // Final revert and not issued at a final block (checked in 1): a permanent failure, e.g. the
        // recipient is not verified. Retrying would not help; a human has to look.
        return this.save({ ...rec, status: 'failed', failure: `tx ${included.at.hash} reverted` });
      }
      return this.save(rec); // included but not deep enough yet
    }
    if (rec.includedIn) {
      this.log('previously included tx no longer canonical (reorg)', { issuanceId, ...rec.includedIn });
      rec = { ...rec, includedIn: undefined };
    }

    // 4. Not included. Has our nonce been used by something else, irreversibly?
    const finalNonce = finalBlock >= 0n ? await this.chain.getTransactionCount(this.signer.address, finalBlock) : 0;
    if (finalNonce > current.nonce) {
      // A tx that is not ours (none of our attempts is canonical) took the nonce at a final block, so
      // none of our attempts can ever be mined. Not issued (checked in 1): sign again on a fresh nonce.
      // Should an old attempt still surface, the gateway rejects it as a duplicate.
      const nonce = await this.chain.getTransactionCount(this.signer.address, head);
      this.log('nonce consumed by another tx; re-nonce', { issuanceId, oldNonce: current.nonce, nonce });
      return this.sendNewAttempt(rec, nonce, await this.chain.estimateFees());
    }
    const headNonce = await this.chain.getTransactionCount(this.signer.address, head);
    if (headNonce > current.nonce) return this.save(rec); // taken in a non-final block: wait and see
    if (headNonce < current.nonce) {
      // A nonce below ours is free again: we re-nonced past a foreign tx that a reorg then evicted. Ours
      // can never be mined until that gap is filled, and fee bumps will not help, so fill it ourselves.
      // If the old attempt still lands later, the gateway rejects it as a duplicate.
      this.log('nonce gap below current attempt; re-nonce down', { issuanceId, oldNonce: current.nonce, nonce: headNonce });
      return this.sendNewAttempt(rec, headNonce, await this.chain.estimateFees());
    }

    // 5. Pending or lost. Rebroadcast if the node forgot it (dropped, timed out before reaching it,
    //    crashed before broadcast, or evicted by a reorg), and bump fees if it is stuck.
    rec = { ...rec, pollsSinceLastAttempt: rec.pollsSinceLastAttempt + 1 };
    if (rec.pollsSinceLastAttempt >= this.opts.bumpAfterPolls) {
      const est = await this.chain.estimateFees();
      const fees: Fees = {
        maxFeePerGas: max(bump(current.fees.maxFeePerGas), est.maxFeePerGas),
        maxPriorityFeePerGas: max(bump(current.fees.maxPriorityFeePerGas), est.maxPriorityFeePerGas),
      };
      this.log('fee bump', { issuanceId, nonce: current.nonce });
      return this.sendNewAttempt(rec, current.nonce, fees);
    }
    if (!(await this.chain.isTransactionKnown(current.hash))) {
      this.log('rebroadcast', { issuanceId, hash: current.hash });
      rec = await this.broadcast(rec, current);
    }
    return this.save(rec);
  }

  /** Sign, persist (write-ahead), then broadcast. */
  private async sendNewAttempt(rec: IssuanceRecord, nonce: number, fees: Fees): Promise<IssuanceRecord> {
    const signed = await this.signer.signIssue({ request: rec.request, nonce, fees });
    const attempt: Attempt = { ...signed, nonce, fees };
    rec = { ...rec, attempts: [...rec.attempts, attempt], pollsSinceLastAttempt: 0 };
    await this.store.put(rec);
    return this.save(await this.broadcast(rec, attempt));
  }

  private async broadcast(rec: IssuanceRecord, attempt: Attempt): Promise<IssuanceRecord> {
    try {
      await this.chain.sendRawTransaction(attempt.raw);
      return { ...rec, lastSendError: undefined };
    } catch (e) {
      // Timeout, "already known", "nonce too low", replacement underpriced...: in every case the tx
      // may or may not be in a mempool. Do not guess; the next poll reads the chain.
      const msg = e instanceof Error ? e.message : String(e);
      this.log('send failed; outcome will be read from chain', { hash: attempt.hash, error: msg });
      return { ...rec, lastSendError: msg };
    }
  }

  private async findCanonicalReceipt(attempts: Attempt[]) {
    for (const a of attempts) {
      const r = await this.chain.getTransactionReceipt(a.hash);
      if (!r) continue;
      // Guard against a node or cache returning a receipt from an orphaned block.
      if ((await this.chain.getBlockHash(r.blockNumber)) !== r.blockHash) continue;
      return { status: r.status, at: { hash: a.hash, blockNumber: r.blockNumber, blockHash: r.blockHash } };
    }
    return undefined;
  }

  private async findOwnSuccessfulAttempt(attempts: Attempt[], finalBlock: bigint): Promise<Hex | undefined> {
    const r = await this.findCanonicalReceipt(attempts);
    return r && r.status === 'success' && r.at.blockNumber <= finalBlock ? r.at.hash : undefined;
  }

  private async save(rec: IssuanceRecord): Promise<IssuanceRecord> {
    await this.store.put(rec);
    return rec;
  }
}

function toResult(rec: IssuanceRecord): IssuanceResult | undefined {
  if (rec.status === 'confirmed') return { status: 'confirmed', issuanceId: rec.request.issuanceId, mintedBy: rec.mintedBy };
  if (rec.status === 'failed') return { status: 'failed', issuanceId: rec.request.issuanceId, reason: rec.failure ?? 'unknown' };
  return undefined;
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);

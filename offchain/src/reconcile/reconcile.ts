import type { Address, Hex } from '../issuance/chain.js';

/**
 * Confirmation depth for treating an event as final. 64 blocks is two Ethereum epochs: by then the block
 * is normally behind a finalized checkpoint, and reverting it would need >1/3 of stake to be slashed.
 * A share register wants economic finality, not "probably won't reorg", and ~13 minutes of latency is
 * acceptable for it. On another chain, use that chain's finality signal instead (e.g. an L2's L1 batch
 * finality). The issuance submitter should use the same depth.
 */
export const DEFAULT_CONFIRMATIONS = 64;

// ------------------------------------------------------------------ events (decoded logs)

export type TokenEventBody =
  | { type: 'Transfer'; from: Address; to: Address; value: bigint }
  | { type: 'Issued'; issuanceId: Hex; to: Address; amount: bigint }
  | { type: 'AuthorisationConsumed'; authId: Hex; from: Address; to: Address; amount: bigint }
  | { type: 'TokensFrozen'; holder: Address; amount: bigint }
  | { type: 'TokensUnfrozen'; holder: Address; amount: bigint }
  | { type: 'RecoverySuccess'; lostWallet: Address; newWallet: Address; investorOnchainID: Address };

export type TokenEvent = TokenEventBody & { blockNumber: bigint; blockHash: Hex; txHash: Hex; logIndex: number };

/**
 * Assumption: a batch carries every log of the token, gateway and module for each block it covers.
 * A transaction's logs are never split across batches.
 */
export interface Batch {
  events: TokenEvent[];
  headBlock: bigint;
  /** Canonical block hash for every block number that appears in `events` (keys are decimal strings). */
  canonicalHashes: Record<string, Hex>;
}

// ------------------------------------------------------------------ backend state

export type AgentOperation =
  | { kind: 'forcedTransfer'; from: Address; to: Address; amount: bigint }
  | { kind: 'burn'; from: Address; amount: bigint }
  | { kind: 'freeze'; holder: Address; amount: bigint }
  | { kind: 'unfreeze'; holder: Address; amount: bigint }
  | { kind: 'recovery'; lostWallet: Address; newWallet: Address };

/** All addresses and ids used as keys are lower-case hex. */
export interface BackendState {
  /** The register: the system of record for who owns what. */
  balances: Record<Address, bigint>;
  frozen: Record<Address, bigint>;
  authorisations: Record<Hex, { from: Address; to: Address; amount: bigint; status: 'outstanding' | 'used' | 'revoked' }>;
  issuances: Record<Hex, { to: Address; amount: bigint; status: 'requested' | 'completed' }>;
  /** Interventions the backend has sent and expects to see on-chain (court orders, recoveries...). */
  agentOperations: Record<string, AgentOperation & { status: 'pending' | 'done' }>;
  /** What final, canonical events say the chain holds. Never edited by hand; compared with the register. */
  observed: { balances: Record<Address, bigint>; frozen: Record<Address, bigint> };
  /** `${blockHash}:${logIndex}` of every event already applied: makes reprocessing a no-op. */
  applied: Record<string, { blockNumber: bigint }>;
}

export type Discrepancy =
  | { kind: 'UNAUTHORISED_TRANSFER'; txHash: Hex; from: Address; to: Address; amount: bigint; detail: string }
  | { kind: 'DUPLICATE_ISSUANCE'; txHash: Hex; issuanceId: Hex }
  | { kind: 'UNKNOWN_ISSUANCE'; txHash: Hex; issuanceId: Hex }
  | { kind: 'ISSUANCE_MISMATCH'; txHash: Hex; issuanceId: Hex; detail: string }
  | { kind: 'UNEXPECTED_MINT'; txHash: Hex; to: Address; amount: bigint }
  | { kind: 'UNEXPECTED_BURN'; txHash: Hex; from: Address; amount: bigint }
  | { kind: 'UNEXPECTED_FREEZE_CHANGE'; txHash: Hex; holder: Address; delta: bigint }
  | { kind: 'UNEXPECTED_RECOVERY'; txHash: Hex; lostWallet: Address; newWallet: Address }
  | { kind: 'BALANCE_MISMATCH'; address: Address; record: bigint; onChain: bigint }
  | { kind: 'FROZEN_MISMATCH'; address: Address; record: bigint; onChain: bigint }
  | { kind: 'DEEP_REORG'; blockNumber: bigint; detail: string };

export interface ReconcileResult {
  state: BackendState;
  discrepancies: Discrepancy[];
  /** Canonical events not yet `confirmations` deep: send them again in a later batch. */
  deferred: number;
  /** Events from blocks that are no longer canonical: ignored. */
  orphaned: number;
}

export function emptyState(): BackendState {
  return {
    balances: {},
    frozen: {},
    authorisations: {},
    issuances: {},
    agentOperations: {},
    observed: { balances: {}, frozen: {} },
    applied: {},
  };
}

/**
 * Applies the final, canonical, not-yet-applied events of `batch` and reports anything the backend
 * cannot explain. Pure: returns a new state. Reprocessing a batch changes nothing and reports no new
 * per-event discrepancies (DEEP_REORG alarms repeat until a human resolves them).
 *
 * Rule: the register only moves for transactions the backend can explain (a known issuance, a consumed
 * authorisation it issued, or an intervention it initiated). Everything else updates `observed` only,
 * so it surfaces as a discrepancy plus a BALANCE/FROZEN_MISMATCH, and is never silently adopted.
 */
export function reconcile(
  state: BackendState,
  batch: Batch,
  { confirmations = DEFAULT_CONFIRMATIONS }: { confirmations?: number } = {},
): ReconcileResult {
  const s = structuredClone(state);
  const discrepancies: Discrepancy[] = [];
  let deferred = 0;
  let orphaned = 0;

  // Applied events whose block is no longer canonical: a reorg deeper than our finality assumption.
  for (const [key, { blockNumber }] of Object.entries(s.applied)) {
    const canonical = batch.canonicalHashes[blockNumber.toString()];
    if (canonical && !key.startsWith(canonical.toLowerCase() + ':')) {
      discrepancies.push({ kind: 'DEEP_REORG', blockNumber, detail: `applied event ${key} is no longer canonical` });
    }
  }

  const fresh: TokenEvent[] = [];
  for (const raw of batch.events) {
    const e = normalise(raw);
    const canonical = batch.canonicalHashes[e.blockNumber.toString()]?.toLowerCase();
    if (canonical !== e.blockHash) {
      // Not canonical (or we were not told the canonical hash, so we cannot vouch for it): skip.
      if (canonical === undefined) deferred++;
      else orphaned++;
      continue;
    }
    if (batch.headBlock - e.blockNumber + 1n < BigInt(confirmations)) {
      deferred++;
      continue;
    }
    if (s.applied[eventKey(e)]) continue;
    fresh.push(e);
  }

  // Process whole transactions in chain order: classification needs every log of the tx.
  fresh.sort((a, b) => cmp(a.blockNumber, b.blockNumber) || a.logIndex - b.logIndex);
  const txs = new Map<string, TokenEvent[]>();
  for (const e of fresh) {
    const k = `${e.blockHash}:${e.txHash}`;
    txs.set(k, [...(txs.get(k) ?? []), e]);
  }

  const touched = new Set<Address>();
  for (const events of txs.values()) {
    applyTransaction(s, events, discrepancies, touched);
    for (const e of events) s.applied[eventKey(e)] = { blockNumber: e.blockNumber };
  }

  for (const a of [...touched].sort()) {
    const record = s.balances[a] ?? 0n;
    const onChain = s.observed.balances[a] ?? 0n;
    if (record !== onChain) discrepancies.push({ kind: 'BALANCE_MISMATCH', address: a, record, onChain });
    const fr = s.frozen[a] ?? 0n;
    const fo = s.observed.frozen[a] ?? 0n;
    if (fr !== fo) discrepancies.push({ kind: 'FROZEN_MISMATCH', address: a, record: fr, onChain: fo });
  }

  return { state: s, discrepancies, deferred, orphaned };
}

// ------------------------------------------------------------------ per-transaction logic

function applyTransaction(s: BackendState, events: TokenEvent[], out: Discrepancy[], touched: Set<Address>) {
  const txHash = events[0]!.txHash;

  // 1. The chain's view always follows the events.
  for (const e of events) {
    if (e.type === 'Transfer') {
      add(s.observed.balances, e.from, -e.value, e.from !== ZERO);
      add(s.observed.balances, e.to, e.value, e.to !== ZERO);
      touched.add(e.from).add(e.to);
    } else if (e.type === 'TokensFrozen') {
      add(s.observed.frozen, e.holder, e.amount);
      touched.add(e.holder);
    } else if (e.type === 'TokensUnfrozen') {
      add(s.observed.frozen, e.holder, -e.amount);
      touched.add(e.holder);
    }
  }
  touched.delete(ZERO);

  // 2. The register only follows what the backend can explain.
  const transfers = events.filter((e): e is Extract<TokenEvent, { type: 'Transfer' }> => e.type === 'Transfer');
  const explained = new Set<TokenEvent>();
  const applyToRecord = (e: TokenEvent) => {
    explained.add(e);
    if (e.type === 'Transfer') {
      add(s.balances, e.from, -e.value, e.from !== ZERO);
      add(s.balances, e.to, e.value, e.to !== ZERO);
    } else if (e.type === 'TokensFrozen') add(s.frozen, e.holder, e.amount);
    else if (e.type === 'TokensUnfrozen') add(s.frozen, e.holder, -e.amount);
  };
  const takeTransfer = (from: Address, to: Address, value: bigint) =>
    transfers.find((t) => !explained.has(t) && t.from === from && t.to === to && t.value === value);

  // Recovery: one agent call that moves the whole balance (and its frozen part) to the new wallet.
  for (const e of events) {
    if (e.type !== 'RecoverySuccess') continue;
    const op = takeOp(s, (o) => o.kind === 'recovery' && o.lostWallet === e.lostWallet && o.newWallet === e.newWallet);
    if (!op) {
      out.push({ kind: 'UNEXPECTED_RECOVERY', txHash, lostWallet: e.lostWallet, newWallet: e.newWallet });
      continue;
    }
    for (const x of events) if (x !== e && !explained.has(x)) applyToRecord(x);
  }

  // Issuance through the gateway.
  for (const e of events) {
    if (e.type !== 'Issued') continue;
    const mint = takeTransfer(ZERO, e.to, e.amount);
    const iss = s.issuances[e.issuanceId];
    if (!iss) out.push({ kind: 'UNKNOWN_ISSUANCE', txHash, issuanceId: e.issuanceId });
    else if (iss.status === 'completed') out.push({ kind: 'DUPLICATE_ISSUANCE', txHash, issuanceId: e.issuanceId });
    else if (norm(iss.to) !== e.to || iss.amount !== e.amount) {
      out.push({
        kind: 'ISSUANCE_MISMATCH',
        txHash,
        issuanceId: e.issuanceId,
        detail: `expected ${iss.amount} to ${iss.to}, minted ${e.amount} to ${e.to}`,
      });
    } else if (mint) {
      iss.status = 'completed';
      applyToRecord(mint);
    }
    // A rejected Issued has already been reported; its mint is not adopted into the register (so it also
    // shows up as a BALANCE_MISMATCH) and must not be reported a second time as UNEXPECTED_MINT.
    if (mint) explained.add(mint);
  }

  // Holder transfers: the module emitted AuthorisationConsumed in the same tx.
  for (const e of events) {
    if (e.type !== 'AuthorisationConsumed') continue;
    const t = takeTransfer(e.from, e.to, e.amount);
    if (!t) continue; // would mean the batch split a tx; left unexplained below
    const auth = s.authorisations[e.authId];
    if (!auth) {
      out.push({ kind: 'UNAUTHORISED_TRANSFER', txHash, from: e.from, to: e.to, amount: e.amount, detail: `unknown authorisation ${e.authId}` });
    } else if (auth.status !== 'outstanding' || norm(auth.from) !== e.from || norm(auth.to) !== e.to || auth.amount !== e.amount) {
      out.push({
        kind: 'UNAUTHORISED_TRANSFER',
        txHash,
        from: e.from,
        to: e.to,
        amount: e.amount,
        detail: `authorisation ${e.authId} is ${auth.status} in the backend or does not match`,
      });
    } else {
      auth.status = 'used';
      applyToRecord(t);
      continue;
    }
    explained.add(t);
  }

  // Remaining transfers: interventions the backend initiated, or nothing it knows about.
  let explainedByOp = false;
  for (const t of transfers) {
    if (explained.has(t)) continue;
    if (t.from === ZERO) {
      out.push({ kind: 'UNEXPECTED_MINT', txHash, to: t.to, amount: t.value });
      continue;
    }
    if (t.to === ZERO) {
      if (takeOp(s, (o) => o.kind === 'burn' && o.from === t.from && o.amount === t.value)) {
        applyToRecord(t);
        explainedByOp = true;
      } else out.push({ kind: 'UNEXPECTED_BURN', txHash, from: t.from, amount: t.value });
      continue;
    }
    if (takeOp(s, (o) => o.kind === 'forcedTransfer' && o.from === t.from && o.to === t.to && o.amount === t.value)) {
      applyToRecord(t);
      explainedByOp = true;
    } else {
      out.push({ kind: 'UNAUTHORISED_TRANSFER', txHash, from: t.from, to: t.to, amount: t.value, detail: 'no matching authorisation or intervention' });
    }
  }

  // Freezes. forcedTransfer and burn unfreeze automatically (Token.sol), so in a tx we already explained
  // by an intervention, its TokensUnfrozen is part of that intervention.
  for (const e of events) {
    if (explained.has(e) || (e.type !== 'TokensFrozen' && e.type !== 'TokensUnfrozen')) continue;
    const kind = e.type === 'TokensFrozen' ? 'freeze' : 'unfreeze';
    if ((kind === 'unfreeze' && explainedByOp) || takeOp(s, (o) => o.kind === kind && o.holder === e.holder && o.amount === e.amount)) {
      applyToRecord(e);
    } else {
      out.push({ kind: 'UNEXPECTED_FREEZE_CHANGE', txHash, holder: e.holder, delta: kind === 'freeze' ? e.amount : -e.amount });
    }
  }
}

// ------------------------------------------------------------------ helpers

const ZERO: Address = '0x0000000000000000000000000000000000000000';

const norm = (a: Hex) => a.toLowerCase() as Hex;

function normalise(e: TokenEvent): TokenEvent {
  const out: Record<string, unknown> = { ...e };
  for (const k of ['from', 'to', 'holder', 'lostWallet', 'newWallet', 'investorOnchainID', 'blockHash', 'txHash', 'authId', 'issuanceId']) {
    if (typeof out[k] === 'string') out[k] = (out[k] as string).toLowerCase();
  }
  return out as TokenEvent;
}

const eventKey = (e: TokenEvent) => `${e.blockHash}:${e.logIndex}`;

const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

function add(m: Record<Address, bigint>, a: Address, delta: bigint, when = true) {
  if (!when) return;
  const v = (m[a] ?? 0n) + delta;
  if (v === 0n) delete m[a];
  else m[a] = v;
}

/** Marks the first matching pending operation (by id order) done and returns it. */
function takeOp(s: BackendState, match: (o: AgentOperation) => boolean) {
  const id = Object.keys(s.agentOperations)
    .sort()
    .find((k) => {
      const o = s.agentOperations[k]!;
      return o.status === 'pending' && match(normaliseOp(o));
    });
  if (id === undefined) return undefined;
  s.agentOperations[id]!.status = 'done';
  return s.agentOperations[id];
}

function normaliseOp(o: AgentOperation): AgentOperation {
  const out: Record<string, unknown> = { ...o };
  for (const k of ['from', 'to', 'holder', 'lostWallet', 'newWallet']) if (typeof out[k] === 'string') out[k] = norm(out[k] as Hex);
  return out as AgentOperation;
}

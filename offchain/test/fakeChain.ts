import { hexlify, keccak256 as ethersKeccak, toUtf8Bytes, toUtf8String } from 'ethers';
import type { Address, ChainClient, Fees, Hex, SignedTx, TxReceipt, TxSigner, UnsignedIssueTx } from '../src/issuance/chain.js';

const keccak256 = (data: Hex) => ethersKeccak(data) as Hex;
const stringToHex = (s: string) => hexlify(toUtf8Bytes(s)) as Hex;
const hexToString = (h: Hex) => toUtf8String(h);

/**
 * Deterministic in-memory chain + mempool for the submitter tests. State (issued IDs, nonces) is always
 * derived by replaying the canonical blocks, so a reorg really does undo a mint.
 */
interface Tx {
  hash: Hex;
  from: Address;
  nonce: number;
  priorityFee: bigint;
  kind: 'issue' | 'other';
  issuanceId?: Hex;
  to?: Address;
  amount?: bigint;
}

interface Block {
  number: bigint;
  hash: Hex;
  txs: { tx: Tx; status: 'success' | 'reverted' }[];
}

export type SendBehaviour = 'ok' | 'timeoutAfterBroadcast' | 'timeoutBeforeBroadcast';

const encode = (tx: Omit<Tx, 'hash'>): Hex =>
  stringToHex(JSON.stringify(tx, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));

const decode = (raw: Hex): Omit<Tx, 'hash'> =>
  JSON.parse(hexToString(raw), (_k, v) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));

export class FakeChain implements ChainClient {
  blocks: Block[] = [{ number: 0n, hash: keccak256(stringToHex('genesis')), txs: [] }];
  mempool = new Map<Hex, Tx>();
  /** Recipients the gateway would reject (mint reverts: identity not verified). */
  unverified = new Set<string>();
  /** Txs paying less priority fee than this stay in the mempool. */
  minPriorityFee = 0n;
  sendBehaviours: SendBehaviour[] = [];
  sends = 0;
  private salt = 0;

  // ---------------------------------------------------------------- test controls

  mine(n = 1): void {
    for (let i = 0; i < n; i++) this.mineOne();
  }

  /** Drop the last `depth` blocks. Their txs go back to the mempool, or vanish if `evict`. */
  reorg(depth: number, { evict = false } = {}): void {
    const orphaned = this.blocks.splice(this.blocks.length - depth, depth);
    this.salt++;
    if (!evict) for (const b of orphaned) for (const { tx } of b.txs) this.mempool.set(tx.hash, tx);
  }

  drop(hash: Hex): void {
    this.mempool.delete(hash);
  }

  /** Another tx from the same key (e.g. an operator using it by hand) that takes a nonce. */
  injectOtherTx(from: Address, nonce: number): void {
    const body = { from, nonce, priorityFee: 10n ** 12n, kind: 'other' as const };
    const raw = encode(body);
    this.mempool.set(keccak256(raw), { ...body, hash: keccak256(raw) });
  }

  /** Number of successful mints for an issuance ID in the canonical chain. The property under test. */
  mintCount(issuanceId: Hex): number {
    return this.blocks.flatMap((b) => b.txs).filter((t) => t.status === 'success' && t.tx.issuanceId === issuanceId).length;
  }

  head(): bigint {
    return BigInt(this.blocks.length - 1);
  }

  // ---------------------------------------------------------------- ChainClient

  async getBlockNumber() {
    return this.head();
  }

  async getBlockHash(n: bigint) {
    return this.blocks[Number(n)]?.hash ?? null;
  }

  async getTransactionCount(address: Address, block: bigint) {
    return this.nonceAt(address, block);
  }

  async getTransactionReceipt(hash: Hex): Promise<TxReceipt | null> {
    for (const b of this.blocks) {
      const t = b.txs.find((x) => x.tx.hash === hash);
      if (t) return { transactionHash: hash, status: t.status, blockNumber: b.number, blockHash: b.hash };
    }
    return null;
  }

  async isTransactionKnown(hash: Hex) {
    return this.mempool.has(hash) || (await this.getTransactionReceipt(hash)) !== null;
  }

  async sendRawTransaction(raw: Hex) {
    this.sends++;
    const behaviour = this.sendBehaviours.shift() ?? 'ok';
    if (behaviour === 'timeoutBeforeBroadcast') throw new Error('RPC timeout');
    const hash = keccak256(raw);
    const body = decode(raw);
    if (body.nonce < this.nonceAt(body.from, this.head())) {
      if (behaviour === 'timeoutAfterBroadcast') throw new Error('RPC timeout');
      throw new Error('nonce too low');
    }
    const known = this.mempool.has(hash);
    this.mempool.set(hash, { ...body, hash });
    if (behaviour === 'timeoutAfterBroadcast') throw new Error('RPC timeout');
    if (known) throw new Error('already known');
  }

  async isIssued(issuanceId: Hex, block: bigint) {
    return this.blocks
      .slice(0, Number(block) + 1)
      .some((b) => b.txs.some((t) => t.status === 'success' && t.tx.issuanceId === issuanceId));
  }

  async estimateFees(): Promise<Fees> {
    return { maxFeePerGas: 30n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n };
  }

  // ---------------------------------------------------------------- internals

  private nonceAt(address: Address, block: bigint): number {
    return this.blocks
      .slice(0, Number(block) + 1)
      .flatMap((b) => b.txs)
      .filter((t) => t.tx.from.toLowerCase() === address.toLowerCase()).length;
  }

  private mineOne(): void {
    const number = BigInt(this.blocks.length);
    const txs: Block['txs'] = [];
    const nonces = new Map<string, number>();
    const issued = new Set(this.blocks.flatMap((b) => b.txs).filter((t) => t.status === 'success').map((t) => t.tx.issuanceId));
    for (;;) {
      // Next executable tx per sender: nonce matches, fee high enough; highest fee wins a nonce.
      const candidates = [...this.mempool.values()].filter((tx) => {
        const next = nonces.get(tx.from) ?? this.nonceAt(tx.from, number - 1n);
        return tx.nonce === next && tx.priorityFee >= this.minPriorityFee;
      });
      if (candidates.length === 0) break;
      candidates.sort((a, b) => (b.priorityFee > a.priorityFee ? 1 : -1));
      const tx = candidates[0]!;
      let status: 'success' | 'reverted' = 'success';
      if (tx.kind === 'issue') {
        if (issued.has(tx.issuanceId) || this.unverified.has(tx.to!.toLowerCase())) status = 'reverted';
        else issued.add(tx.issuanceId);
      }
      txs.push({ tx, status });
      nonces.set(tx.from, tx.nonce + 1);
      // Included, plus anything else from this sender at that nonce (replaced), leaves the mempool.
      for (const [h, m] of this.mempool) if (m.from === tx.from && m.nonce <= tx.nonce) this.mempool.delete(h);
    }
    const hash = keccak256(stringToHex(`${number}:${this.salt}:${txs.map((t) => t.tx.hash).join(',')}`));
    this.blocks.push({ number, hash, txs });
  }
}

export class FakeSigner implements TxSigner {
  constructor(readonly address: Address) {}

  async signIssue({ request, nonce, fees }: UnsignedIssueTx): Promise<SignedTx> {
    const raw = encode({
      from: this.address,
      nonce,
      priorityFee: fees.maxPriorityFeePerGas,
      kind: 'issue',
      issuanceId: request.issuanceId,
      to: request.to,
      amount: request.amount,
    });
    return { raw, hash: keccak256(raw) };
  }
}

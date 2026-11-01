import type { Fees, Hex, IssuanceRequest } from './chain.js';

export interface Attempt {
  hash: Hex;
  raw: Hex;
  nonce: number;
  fees: Fees;
}

export type IssuanceStatus = 'pending' | 'confirmed' | 'failed';

export interface IssuanceRecord {
  request: IssuanceRequest;
  status: IssuanceStatus;
  /** Every signed tx for this issuance, oldest first. The last one carries the current nonce. */
  attempts: Attempt[];
  /** Pending polls since the last new attempt; drives fee bumps. */
  pollsSinceLastAttempt: number;
  /** Where we last saw an attempt included. Informational: it is re-checked against the canonical chain on every poll. */
  includedIn?: { hash: Hex; blockNumber: bigint; blockHash: Hex };
  /** Tx hash that minted, when known (it may be unknown if another sender minted the same issuance ID). */
  mintedBy?: Hex;
  failure?: string;
  lastSendError?: string;
}

/**
 * Durable store. `put` must not resolve until the write is durable (DB commit / fsync): the submitter
 * relies on "persisted before broadcast" to recover after a crash.
 */
export interface IssuanceStore {
  get(issuanceId: Hex): Promise<IssuanceRecord | undefined>;
  put(record: IssuanceRecord): Promise<void>;
}

export class InMemoryIssuanceStore implements IssuanceStore {
  private readonly records = new Map<string, IssuanceRecord>();

  async get(issuanceId: Hex): Promise<IssuanceRecord | undefined> {
    const r = this.records.get(issuanceId.toLowerCase());
    return r && structuredClone(r);
  }

  async put(record: IssuanceRecord): Promise<void> {
    this.records.set(record.request.issuanceId.toLowerCase(), structuredClone(record));
  }
}

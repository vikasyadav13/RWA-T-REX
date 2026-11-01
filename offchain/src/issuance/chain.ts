export type Hex = `0x${string}`;
export type Address = Hex;

/** One backend issuance request. `issuanceId` is the bytes32 passed to IssuanceGateway.issue. */
export interface IssuanceRequest {
  issuanceId: Hex;
  to: Address;
  amount: bigint;
}

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface UnsignedIssueTx {
  request: IssuanceRequest;
  nonce: number;
  fees: Fees;
}

export interface SignedTx {
  hash: Hex;
  raw: Hex;
}

export interface TxReceipt {
  transactionHash: Hex;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  blockHash: Hex;
}

/**
 * The narrow slice of an RPC node the submitter needs. Everything the submitter decides is derived from
 * these calls, never from what a previous call returned, so a restarted process reaches the same answer.
 */
export interface ChainClient {
  getBlockNumber(): Promise<bigint>;
  /** Canonical hash at a height, or null if the node has no such block. */
  getBlockHash(blockNumber: bigint): Promise<Hex | null>;
  /** Next nonce for `address` as of the given block (number of its txs included up to that block). */
  getTransactionCount(address: Address, block: bigint): Promise<number>;
  /** Receipt of a tx in the node's canonical chain, or null. */
  getTransactionReceipt(hash: Hex): Promise<TxReceipt | null>;
  /** True if the node has the tx in its mempool or chain. */
  isTransactionKnown(hash: Hex): Promise<boolean>;
  /** May throw (timeout, "already known", "nonce too low"...). The outcome is always re-derived by polling. */
  sendRawTransaction(raw: Hex): Promise<void>;
  /** IssuanceGateway.isIssued(issuanceId) evaluated at a specific block. */
  isIssued(issuanceId: Hex, block: bigint): Promise<boolean>;
  estimateFees(): Promise<Fees>;
}

/** Signs IssuanceGateway.issue(issuanceId, to, amount) as an EIP-1559 tx from the backend's ISSUER_ROLE key. */
export interface TxSigner {
  readonly address: Address;
  signIssue(tx: UnsignedIssueTx): Promise<SignedTx>;
}

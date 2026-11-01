import { describe, expect, it } from 'vitest';
import { Interface, Transaction, Wallet } from 'ethers';
import { EthersTxSigner, issuanceGatewayAbi } from '../src/issuance/ethersAdapter.js';
import type { Hex, UnsignedIssueTx } from '../src/issuance/chain.js';

const GATEWAY: Hex = '0x000000000000000000000000000000000000009a';
const TX: UnsignedIssueTx = {
  request: { issuanceId: `0x${'01'.padStart(64, '0')}`, to: '0x00000000000000000000000000000000000a11ce', amount: 100n },
  nonce: 7,
  fees: { maxFeePerGas: 30n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n },
};

describe('EthersTxSigner (local signing only; no node needed)', () => {
  const wallet = new Wallet('0x' + '11'.repeat(32));
  const signer = new EthersTxSigner(wallet, 1n, GATEWAY);

  it('signs an EIP-1559 IssuanceGateway.issue tx with exactly the nonce and fees it was given', async () => {
    const { raw, hash } = await signer.signIssue(TX);
    const tx = Transaction.from(raw);
    expect(tx.type).toBe(2);
    expect(tx.hash).toBe(hash);
    expect(tx.from).toBe(wallet.address);
    expect(tx.to!.toLowerCase()).toBe(GATEWAY.toLowerCase());
    expect(tx.nonce).toBe(7);
    expect(tx.chainId).toBe(1n);
    expect(tx.maxFeePerGas).toBe(TX.fees.maxFeePerGas);
    expect(tx.maxPriorityFeePerGas).toBe(TX.fees.maxPriorityFeePerGas);
    const [issuanceId, to, amount] = new Interface(issuanceGatewayAbi).decodeFunctionData('issue', tx.data);
    expect([issuanceId, (to as string).toLowerCase(), amount]).toEqual([TX.request.issuanceId, TX.request.to, 100n]);
  });

  it('is deterministic: re-signing the same inputs after a crash yields the same bytes and hash', async () => {
    const a = await signer.signIssue(TX);
    const b = await signer.signIssue(TX);
    expect(b).toEqual(a);
    const bumped = await signer.signIssue({ ...TX, fees: { ...TX.fees, maxPriorityFeePerGas: 2n * 10n ** 9n } });
    expect(bumped.hash).not.toBe(a.hash);
  });
});

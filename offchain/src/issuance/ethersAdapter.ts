import { Contract, Interface, keccak256, type JsonRpcProvider, type Wallet } from 'ethers';
import type { Address, ChainClient, Fees, Hex, SignedTx, TxReceipt, TxSigner, UnsignedIssueTx } from './chain.js';

/**
 * ethers v6 implementations of ChainClient / TxSigner.
 * NOTE: this file is type-checked but not exercised by the test suite (the submitter is tested against
 * test/fakeChain.ts). See README "Unfinished".
 */
export const issuanceGatewayAbi = [
  'function issue(bytes32 issuanceId, address to, uint256 amount)',
  'function isIssued(bytes32 issuanceId) view returns (bool)',
  'event Issued(bytes32 indexed issuanceId, address indexed to, uint256 amount)',
];

const gatewayInterface = new Interface(issuanceGatewayAbi);

export class EthersChainClient implements ChainClient {
  private readonly gateway: Contract;

  constructor(
    private readonly provider: JsonRpcProvider,
    gatewayAddress: Address,
  ) {
    this.gateway = new Contract(gatewayAddress, gatewayInterface, provider);
  }

  async getBlockNumber() {
    return BigInt(await this.provider.getBlockNumber());
  }

  async getBlockHash(blockNumber: bigint) {
    const block = await this.provider.getBlock(Number(blockNumber));
    return (block?.hash ?? null) as Hex | null;
  }

  getTransactionCount(address: Address, block: bigint) {
    return this.provider.getTransactionCount(address, Number(block));
  }

  async getTransactionReceipt(hash: Hex): Promise<TxReceipt | null> {
    const r = await this.provider.getTransactionReceipt(hash);
    if (!r) return null;
    return {
      transactionHash: hash,
      status: r.status === 1 ? 'success' : 'reverted',
      blockNumber: BigInt(r.blockNumber),
      blockHash: r.blockHash as Hex,
    };
  }

  async isTransactionKnown(hash: Hex) {
    return (await this.provider.getTransaction(hash)) !== null;
  }

  async sendRawTransaction(raw: Hex) {
    await this.provider.broadcastTransaction(raw);
  }

  async isIssued(issuanceId: Hex, block: bigint): Promise<boolean> {
    // eth_call at a historical block: needs an archive node if `block` is older than ~128 blocks.
    return this.gateway.getFunction('isIssued').staticCall(issuanceId, { blockTag: Number(block) });
  }

  async estimateFees(): Promise<Fees> {
    const f = await this.provider.getFeeData();
    if (f.maxFeePerGas === null || f.maxPriorityFeePerGas === null) throw new Error('node does not support EIP-1559 fees');
    return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
  }
}

export class EthersTxSigner implements TxSigner {
  constructor(
    /** Used only to sign locally: never connected to a provider, so it never picks a nonce or fees itself. */
    private readonly wallet: Wallet,
    private readonly chainId: bigint,
    private readonly gateway: Address,
    /** Fixed so that re-signing identical inputs yields identical bytes. Measured issue() ~270k gas. */
    private readonly gasLimit = 400_000n,
  ) {}

  get address() {
    return this.wallet.address as Address;
  }

  async signIssue({ request, nonce, fees }: UnsignedIssueTx): Promise<SignedTx> {
    const raw = (await this.wallet.signTransaction({
      type: 2,
      chainId: this.chainId,
      to: this.gateway,
      nonce,
      gasLimit: this.gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      data: gatewayInterface.encodeFunctionData('issue', [request.issuanceId, request.to, request.amount]),
    })) as Hex;
    return { raw, hash: keccak256(raw) as Hex };
  }
}

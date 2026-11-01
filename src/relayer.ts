import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { ErrorCode, RpcError } from './errors.js';
import { inboxAbi } from './inbox.js';
import { log } from './log.js';

export function hyperEvmChain(id: number, rpcUrl: string): Chain {
  return defineChain({
    id,
    name: 'HyperEVM',
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export function makeHyperEvmClients(rpcUrl: string, chainId: number, pk: Hex) {
  const chain = hyperEvmChain(chainId, rpcUrl);
  const transport = http(rpcUrl, { timeout: 10_000, retryCount: 2 });
  const account = privateKeyToAccount(pk);
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  const walletClient = createWalletClient({ chain, transport, account });
  return { chain, account, publicClient, walletClient };
}

export interface RelayResult {
  parentTxHash: Hex;
  parentNonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint;
}

/** Anything that can push a delayed message into the Inbox. Abstracted for tests. */
export interface Relayer {
  readonly address: Address;
  relay(messageData: Hex): Promise<RelayResult>;
}

export interface InboxRelayerOptions {
  inbox: Address;
  /** Reject relays whose estimated gas exceeds this (HyperEVM small blocks are 2M gas). */
  maxGas: bigint;
  /** Multiplier on estimated gas, in percent. */
  gasBufferPct: bigint;
}

const NONCE_ERR = /nonce too low|nonce too high|already known|replacement transaction underpriced|invalid nonce/i;

/**
 * Sends `Inbox.sendL2Message(messageData)` from the relayer EOA. All sends go through one promise
 * queue with a locally tracked nonce, so concurrent relays never collide on the HyperEVM nonce.
 */
export class InboxRelayer implements Relayer {
  readonly address: Address;
  private nonce?: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly account: PrivateKeyAccount,
    private readonly chain: Chain,
    private readonly opts: InboxRelayerOptions,
  ) {
    this.address = account.address;
  }

  relay(messageData: Hex): Promise<RelayResult> {
    const job = this.queue.then(() => this.send(messageData, 0));
    this.queue = job.catch(() => undefined);
    return job;
  }

  get localNonce(): number | undefined {
    return this.nonce;
  }

  private async send(messageData: Hex, attempt: number): Promise<RelayResult> {
    const data = encodeFunctionData({ abi: inboxAbi, functionName: 'sendL2Message', args: [messageData] });

    // Estimate first: a revert (paused, allow-list, too large) surfaces here and costs nothing.
    let est: bigint;
    try {
      est = await this.publicClient.estimateContractGas({
        address: this.opts.inbox,
        abi: inboxAbi,
        functionName: 'sendL2Message',
        args: [messageData],
        account: this.account,
      });
    } catch (e) {
      throw new RpcError(ErrorCode.TxRejected, `relay rejected by Inbox: ${revertReason(e)}`);
    }
    const gas = (est * this.opts.gasBufferPct) / 100n;
    if (gas > this.opts.maxGas) {
      throw new RpcError(
        ErrorCode.TxRejected,
        `oversized data: relay needs ~${gas} HyperEVM gas, above RELAY_MAX_GAS ${this.opts.maxGas}`,
      );
    }

    if (this.nonce === undefined) {
      this.nonce = await this.publicClient.getTransactionCount({ address: this.address, blockTag: 'pending' });
    }
    const nonce = this.nonce;
    const fees = await this.publicClient.estimateFeesPerGas();

    try {
      const parentTxHash = await this.walletClient.sendTransaction({
        account: this.account,
        chain: this.chain,
        to: this.opts.inbox,
        data,
        gas,
        nonce,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      this.nonce = nonce + 1;
      return { parentTxHash, parentNonce: nonce, gasLimit: gas, maxFeePerGas: fees.maxFeePerGas! };
    } catch (e) {
      // We don't know whether the tx reached the mempool: resync from chain on the next send.
      this.nonce = undefined;
      const msg = e instanceof BaseError ? e.shortMessage : String(e);
      if (attempt === 0 && NONCE_ERR.test(fullMessage(e))) {
        log.warn('relayer nonce conflict, resyncing and retrying once', { nonce, error: msg });
        return this.send(messageData, 1);
      }
      throw new RpcError(ErrorCode.Internal, `relay to HyperEVM failed: ${msg}`);
    }
  }
}

function fullMessage(e: unknown): string {
  return e instanceof BaseError ? `${e.shortMessage} ${e.details ?? ''}` : String(e);
}

function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError) {
      const d = rev.data;
      if (d) return `${d.errorName}(${(d.args ?? []).map(String).join(', ')})`;
      if (rev.reason) return rev.reason;
    }
    return e.shortMessage;
  }
  return String(e);
}

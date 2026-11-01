import {
  isHex,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type TransactionSerialized,
} from 'viem';
import { hexByteLength, l2TxHash } from './encoding.js';
import { ErrorCode, RpcError } from './errors.js';
import type { InFlightStore } from './inflight.js';

export interface DecodedTx {
  hash: Hex;
  raw: Hex;
  sender: Address;
  nonce: number;
  chainId: number;
  type: string;
  gas: bigint;
  /** maxFeePerGas for typed-1559 txs, gasPrice for legacy/2930. */
  maxFeePerGas: bigint;
  value: bigint;
  /** gas × maxFeePerGas + value */
  maxCost: bigint;
}

export interface L2StateReader {
  getBalance(addr: Address): Promise<bigint>;
  /** Upstream `latest` transaction count. */
  getLatestNonce(addr: Address): Promise<number>;
  /** Current L2 base fee, or undefined if unknown (check is then skipped). */
  getBaseFee(): Promise<bigint | undefined>;
}

const reject = (msg: string) => new RpcError(ErrorCode.TxRejected, msg);

/** Stateless checks: size, decoding, signature, chain ID. Throws RpcError. */
export async function decodeRawTx(rawInput: unknown, opts: { chainId: number; maxTxBytes: number }): Promise<DecodedTx> {
  if (typeof rawInput !== 'string' || !isHex(rawInput, { strict: true }) || rawInput.length < 4 || rawInput.length % 2) {
    throw new RpcError(ErrorCode.InvalidParams, 'invalid raw transaction: expected 0x-prefixed hex bytes');
  }
  const raw = rawInput.toLowerCase() as Hex;
  if (hexByteLength(raw) > opts.maxTxBytes) {
    throw reject(`oversized data: transaction size ${hexByteLength(raw)}, limit ${opts.maxTxBytes}`);
  }

  let tx: ReturnType<typeof parseTransaction>;
  try {
    tx = parseTransaction(raw as TransactionSerialized);
  } catch (e) {
    throw new RpcError(ErrorCode.InvalidParams, `rlp: failed to decode transaction: ${(e as Error).message.split('\n')[0]}`);
  }

  if (tx.type === 'eip4844') throw reject('transaction type not supported: blob transactions');
  if (tx.r === undefined || tx.s === undefined) throw reject('transaction is not signed');
  if (tx.chainId === undefined) throw reject('only replay-protected (EIP-155) transactions allowed over RPC');
  if (tx.chainId !== opts.chainId) {
    throw reject(`invalid chain id for signer: have ${tx.chainId} want ${opts.chainId}`);
  }

  let sender: Address;
  try {
    sender = await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized });
  } catch {
    throw reject('invalid sender: signature recovery failed');
  }

  const gas = tx.gas ?? 0n;
  if (gas === 0n) throw reject('intrinsic gas too low: gas limit is 0');
  const maxFeePerGas =
    'maxFeePerGas' in tx && tx.maxFeePerGas !== undefined ? tx.maxFeePerGas : ('gasPrice' in tx ? (tx.gasPrice ?? 0n) : 0n);
  const value = tx.value ?? 0n;

  return {
    hash: l2TxHash(raw),
    raw,
    sender,
    nonce: tx.nonce ?? 0,
    chainId: tx.chainId,
    type: tx.type ?? 'legacy',
    gas,
    maxFeePerGas,
    value,
    maxCost: gas * maxFeePerGas + value,
  };
}

/**
 * Stateful checks against upstream L2 state plus our in-flight set:
 *  - nonce must equal next pending nonce (= latest + our in-flight for sender)
 *  - balance ≥ this tx's max cost + max cost of the sender's other in-flight txs
 *  - maxFeePerGas ≥ current base fee (if known)
 * Returns the upstream latest nonce observed.
 */
export async function checkAgainstState(
  tx: DecodedTx,
  state: L2StateReader,
  inflight: InFlightStore,
): Promise<{ latestNonce: number; expectedNonce: number }> {
  let balance: bigint, latestNonce: number, baseFee: bigint | undefined;
  try {
    [balance, latestNonce, baseFee] = await Promise.all([
      state.getBalance(tx.sender),
      state.getLatestNonce(tx.sender),
      state.getBaseFee().catch(() => undefined),
    ]);
  } catch (e) {
    throw new RpcError(ErrorCode.Internal, `could not read L2 state from upstream: ${(e as Error).message}`);
  }

  const expectedNonce = inflight.pendingNonce(tx.sender, latestNonce);
  if (tx.nonce < expectedNonce) throw reject(`nonce too low: next nonce ${expectedNonce}, tx nonce ${tx.nonce}`);
  if (tx.nonce > expectedNonce) throw reject(`nonce too high: next nonce ${expectedNonce}, tx nonce ${tx.nonce}`);

  const reserved = inflight.reservedCost(tx.sender, latestNonce);
  const need = tx.maxCost + reserved;
  if (balance < need) {
    throw reject(
      `insufficient funds for gas * price + value: address ${tx.sender} have ${balance} want ${need}` +
        (reserved > 0n ? ` (including ${reserved} reserved by in-flight txs)` : ''),
    );
  }

  if (baseFee !== undefined && tx.maxFeePerGas < baseFee) {
    throw reject(`max fee per gas less than block base fee: address ${tx.sender}, maxFeePerGas: ${tx.maxFeePerGas}, baseFee: ${baseFee}`);
  }

  return { latestNonce, expectedNonce };
}

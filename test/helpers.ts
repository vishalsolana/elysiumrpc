import { parseEther, parseGwei, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { RelayResult, Relayer } from '../src/relayer.js';
import type { L2StateReader } from '../src/validate.js';

export const CHAIN_ID = 99901;
export const account = privateKeyToAccount(generatePrivateKey());

export async function signTx(over: Partial<{ nonce: number; chainId: number; value: bigint; gas: bigint; maxFeePerGas: bigint }> = {}): Promise<Hex> {
  return account.signTransaction({
    type: 'eip1559',
    chainId: over.chainId ?? CHAIN_ID,
    nonce: over.nonce ?? 0,
    to: account.address,
    value: over.value ?? parseEther('0.0001'),
    gas: over.gas ?? 21_000n,
    maxFeePerGas: over.maxFeePerGas ?? parseGwei('1'),
    maxPriorityFeePerGas: 0n,
  });
}

export class FakeState implements L2StateReader {
  balances = new Map<string, bigint>();
  nonces = new Map<string, number>();
  baseFee: bigint | undefined = parseGwei('0.01');
  receipts = new Map<string, { status: string; blockNumber: string }>();

  async getBalance(a: Address) {
    return this.balances.get(a.toLowerCase()) ?? 0n;
  }
  async getLatestNonce(a: Address) {
    return this.nonces.get(a.toLowerCase()) ?? 0;
  }
  async getBaseFee() {
    return this.baseFee;
  }
  async getReceipt(h: Hex) {
    return this.receipts.get(h.toLowerCase()) ?? null;
  }
  fund(a: Address, wei: bigint) {
    this.balances.set(a.toLowerCase(), wei);
  }
  setNonce(a: Address, n: number) {
    this.nonces.set(a.toLowerCase(), n);
  }
}

export class FakeRelayer implements Relayer {
  readonly address = '0x000000000000000000000000000000000000dEaD' as Address;
  sent: Hex[] = [];
  failNext?: Error;

  async relay(messageData: Hex): Promise<RelayResult> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      throw e;
    }
    this.sent.push(messageData);
    const n = this.sent.length;
    return {
      parentTxHash: `0x${n.toString(16).padStart(64, '0')}` as Hex,
      parentNonce: n - 1,
      gasLimit: 100_000n,
      maxFeePerGas: 1n,
    };
  }
}

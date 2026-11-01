import { beforeEach, describe, expect, it } from 'vitest';
import { parseEther, parseGwei, type Hex } from 'viem';
import { RpcError } from '../src/errors.js';
import { InFlightStore } from '../src/inflight.js';
import { checkAgainstState, decodeRawTx } from '../src/validate.js';
import { account, CHAIN_ID, FakeState, signTx } from './helpers.js';

const opts = { chainId: CHAIN_ID, maxTxBytes: 128 * 1024 };

async function rejection(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RpcError);
    return e as RpcError;
  }
  throw new Error('expected rejection');
}

describe('decodeRawTx', () => {
  it('decodes a valid tx and recovers the sender', async () => {
    const tx = await decodeRawTx(await signTx({ nonce: 3 }), opts);
    expect(tx.sender).toBe(account.address);
    expect(tx.nonce).toBe(3);
    expect(tx.chainId).toBe(CHAIN_ID);
    expect(tx.maxCost).toBe(21_000n * parseGwei('1') + parseEther('0.0001'));
  });

  it('rejects the wrong chain ID', async () => {
    const e = await rejection(decodeRawTx(await signTx({ chainId: 999 }), opts));
    expect(e.code).toBe(-32000);
    expect(e.message).toMatch(/invalid chain id.*have 999 want 99901/);
  });

  it('rejects pre-EIP-155 legacy txs (no chain id)', async () => {
    const raw = await account.signTransaction({ type: 'legacy', nonce: 0, to: account.address, gas: 21000n, gasPrice: 1n, value: 0n });
    const e = await rejection(decodeRawTx(raw, opts));
    expect(e.message).toMatch(/replay-protected/);
  });

  it('accepts EIP-155 legacy txs and uses gasPrice for cost', async () => {
    const raw = await account.signTransaction({ type: 'legacy', chainId: CHAIN_ID, nonce: 0, to: account.address, gas: 21000n, gasPrice: 5n, value: 1n });
    const tx = await decodeRawTx(raw, opts);
    expect(tx.maxCost).toBe(21000n * 5n + 1n);
  });

  it('rejects garbage and oversized input', async () => {
    expect((await rejection(decodeRawTx('0xzz', opts))).code).toBe(-32602);
    expect((await rejection(decodeRawTx('0x02c0ffee', opts))).code).toBe(-32602);
    expect((await rejection(decodeRawTx(42, opts))).code).toBe(-32602);
    const big = (`0x02${'00'.repeat(200)}`) as Hex;
    expect((await rejection(decodeRawTx(big, { ...opts, maxTxBytes: 100 }))).message).toMatch(/oversized/);
  });
});

describe('checkAgainstState', () => {
  let state: FakeState;
  let inflight: InFlightStore;
  beforeEach(() => {
    state = new FakeState();
    inflight = new InFlightStore();
    state.fund(account.address, parseEther('1'));
    state.setNonce(account.address, 5);
  });

  it('accepts the next nonce with enough balance', async () => {
    const tx = await decodeRawTx(await signTx({ nonce: 5 }), opts);
    await expect(checkAgainstState(tx, state, inflight)).resolves.toEqual({ latestNonce: 5, expectedNonce: 5 });
  });

  it('rejects nonce too low', async () => {
    const tx = await decodeRawTx(await signTx({ nonce: 4 }), opts);
    const e = await rejection(checkAgainstState(tx, state, inflight));
    expect(e.code).toBe(-32000);
    expect(e.message).toBe('nonce too low: next nonce 5, tx nonce 4');
  });

  it('rejects nonce gaps (too high)', async () => {
    const tx = await decodeRawTx(await signTx({ nonce: 6 }), opts);
    expect((await rejection(checkAgainstState(tx, state, inflight))).message).toBe('nonce too high: next nonce 5, tx nonce 6');
  });

  it('expects latest + in-flight as the next nonce', async () => {
    inflight.add({ hash: '0x01', raw: '0x', sender: account.address, nonce: 5, maxCost: 0n, status: 'inflight', firstRelayedAt: 0, relayedAt: 0, relayCount: 1 });
    const same = await decodeRawTx(await signTx({ nonce: 5 }), opts);
    expect((await rejection(checkAgainstState(same, state, inflight))).message).toMatch(/nonce too low: next nonce 6/);
    const next = await decodeRawTx(await signTx({ nonce: 6 }), opts);
    await expect(checkAgainstState(next, state, inflight)).resolves.toMatchObject({ expectedNonce: 6 });
  });

  it('rejects insufficient funds (gas × maxFeePerGas + value)', async () => {
    state.fund(account.address, 21_000n * parseGwei('1') + parseEther('0.0001') - 1n);
    const tx = await decodeRawTx(await signTx({ nonce: 5 }), opts);
    const e = await rejection(checkAgainstState(tx, state, inflight));
    expect(e.code).toBe(-32000);
    expect(e.message).toMatch(/^insufficient funds for gas \* price \+ value/);
  });

  it('accepts balance exactly equal to max cost', async () => {
    state.fund(account.address, 21_000n * parseGwei('1') + parseEther('0.0001'));
    const tx = await decodeRawTx(await signTx({ nonce: 5 }), opts);
    await expect(checkAgainstState(tx, state, inflight)).resolves.toBeTruthy();
  });

  it('counts in-flight costs against the balance', async () => {
    state.fund(account.address, parseEther('0.5'));
    inflight.add({ hash: '0x01', raw: '0x', sender: account.address, nonce: 5, maxCost: parseEther('0.45'), status: 'inflight', firstRelayedAt: 0, relayedAt: 0, relayCount: 1 });
    const tx = await decodeRawTx(await signTx({ nonce: 6, value: parseEther('0.1') }), opts);
    expect((await rejection(checkAgainstState(tx, state, inflight))).message).toMatch(/insufficient funds.*reserved by in-flight/);
  });

  it('rejects maxFeePerGas below the current base fee', async () => {
    state.baseFee = parseGwei('2');
    const tx = await decodeRawTx(await signTx({ nonce: 5 }), opts);
    expect((await rejection(checkAgainstState(tx, state, inflight))).message).toMatch(/max fee per gas less than block base fee/);
  });

  it('skips the base fee check when unknown', async () => {
    state.baseFee = undefined;
    const tx = await decodeRawTx(await signTx({ nonce: 5, maxFeePerGas: 1n }), opts);
    await expect(checkAgainstState(tx, state, inflight)).resolves.toBeTruthy();
  });
});

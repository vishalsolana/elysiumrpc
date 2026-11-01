import { beforeEach, describe, expect, it } from 'vitest';
import { keccak256, parseEther, type Address, type Hex } from 'viem';
import { RpcError } from '../src/errors.js';
import { InFlightStore, type InFlightEntry } from '../src/inflight.js';
import { RelayService } from '../src/service.js';
import { account, CHAIN_ID, FakeRelayer, FakeState, signTx } from './helpers.js';

const WINDOW = 2 * 60_000;

function entry(sender: Address, nonce: number, hash: Hex = keccak256(`0x${nonce.toString(16).padStart(2, '0')}`)): InFlightEntry {
  return { hash, raw: '0x', sender, nonce, maxCost: 0n, status: 'inflight', firstRelayedAt: 0, relayedAt: 0, relayCount: 1 };
}

describe('pending-nonce math', () => {
  const a = account.address;
  const b = '0x1111111111111111111111111111111111111111' as Address;

  it('is latest when nothing is in flight', () => {
    expect(new InFlightStore().pendingNonce(a, 10)).toBe(10);
  });

  it('is latest + in-flight count for that sender only', () => {
    const s = new InFlightStore();
    s.add(entry(a, 10));
    s.add(entry(a, 11));
    s.add(entry(b, 0));
    expect(s.pendingNonce(a, 10)).toBe(12);
    expect(s.pendingNonce(b, 0)).toBe(1);
  });

  it('is case-insensitive on the address', () => {
    const s = new InFlightStore();
    s.add(entry(a, 3));
    expect(s.pendingNonce(a.toLowerCase() as Address, 3)).toBe(4);
  });

  it('does not double count entries already mined but not yet pruned', () => {
    const s = new InFlightStore();
    s.add(entry(a, 10));
    s.add(entry(a, 11));
    // upstream latest moved to 11: nonce 10 is consumed on L2, 11 still pending
    expect(s.pendingNonce(a, 11)).toBe(12);
    expect(s.pendingNonce(a, 12)).toBe(12);
  });

  it('drops a tx from the count once it is completed', () => {
    const s = new InFlightStore();
    const e = entry(a, 0);
    s.add(e);
    s.complete(e.hash, 'mined', 1);
    expect(s.pendingNonce(a, 0)).toBe(0);
  });
});

describe('RelayService', () => {
  let state: FakeState;
  let relayer: FakeRelayer;
  let store: InFlightStore;
  let now: number;
  let svc: RelayService;

  beforeEach(() => {
    state = new FakeState();
    state.fund(account.address, parseEther('1'));
    relayer = new FakeRelayer();
    store = new InFlightStore();
    now = 1_000_000;
    svc = new RelayService({ l2ChainId: CHAIN_ID, maxTxBytes: 131072, dedupeWindowMs: WINDOW }, state, store, relayer, () => now);
  });

  it('relays 0x04 ++ raw and returns keccak256(raw)', async () => {
    const raw = await signTx({ nonce: 0 });
    const hash = await svc.sendRawTransaction(raw);
    expect(hash).toBe(keccak256(raw));
    expect(relayer.sent).toEqual([`0x04${raw.slice(2)}`]);
    const e = store.get(hash)!;
    expect(e).toMatchObject({ sender: account.address, nonce: 0, status: 'inflight', relayCount: 1 });
    expect(e.parentTxHash).toMatch(/^0x0+1$/);
  });

  it('pending nonce reflects in-flight sends', async () => {
    await svc.sendRawTransaction(await signTx({ nonce: 0 }));
    await svc.sendRawTransaction(await signTx({ nonce: 1 }));
    expect(await svc.pendingNonce(account.address)).toBe(2);
    state.setNonce(account.address, 1);
    expect(await svc.pendingNonce(account.address)).toBe(2);
  });

  describe('dedupe', () => {
    it('a resend of the same raw tx returns the same hash without relaying again', async () => {
      const raw = await signTx({ nonce: 0 });
      const h1 = await svc.sendRawTransaction(raw);
      now += 60_000;
      const h2 = await svc.sendRawTransaction(raw);
      expect(h2).toBe(h1);
      expect(relayer.sent).toHaveLength(1);
      expect(store.size).toBe(1);
    });

    it('re-relays once unconfirmed for more than 2 minutes', async () => {
      const raw = await signTx({ nonce: 0 });
      const h1 = await svc.sendRawTransaction(raw);
      now += WINDOW + 1;
      const h2 = await svc.sendRawTransaction(raw);
      expect(h2).toBe(h1);
      expect(relayer.sent).toHaveLength(2);
      expect(store.get(h1)).toMatchObject({ relayCount: 2, relayedAt: now });
      // and the window restarts from the re-relay
      now += 1000;
      await svc.sendRawTransaction(raw);
      expect(relayer.sent).toHaveLength(2);
    });

    it('does not re-relay after the window if the tx was meanwhile mined', async () => {
      const raw = await signTx({ nonce: 0 });
      const h = await svc.sendRawTransaction(raw);
      now += WINDOW + 1;
      state.receipts.set(h, { status: '0x1', blockNumber: '0x10' });
      expect(await svc.sendRawTransaction(raw)).toBe(h);
      expect(relayer.sent).toHaveLength(1);
      expect(store.getCompleted(h)?.outcome).toBe('mined');
      // and a later resend is still a no-op
      expect(await svc.sendRawTransaction(raw)).toBe(h);
      expect(relayer.sent).toHaveLength(1);
    });

    it('concurrent identical sends relay only once', async () => {
      const raw = await signTx({ nonce: 0 });
      const hs = await Promise.all([svc.sendRawTransaction(raw), svc.sendRawTransaction(raw), svc.sendRawTransaction(raw)]);
      expect(new Set(hs).size).toBe(1);
      expect(relayer.sent).toHaveLength(1);
    });
  });

  it('two different txs with the same nonce sent concurrently: only one is accepted', async () => {
    const a = await signTx({ nonce: 0, value: 1n });
    const b = await signTx({ nonce: 0, value: 2n });
    const res = await Promise.allSettled([svc.sendRawTransaction(a), svc.sendRawTransaction(b)]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rej = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rej.reason as RpcError).message).toMatch(/nonce too low/);
    expect(relayer.sent).toHaveLength(1);
  });

  it('does not relay invalid txs', async () => {
    await expect(svc.sendRawTransaction(await signTx({ chainId: 1 }))).rejects.toThrow(/chain id/);
    await expect(svc.sendRawTransaction(await signTx({ nonce: 3 }))).rejects.toThrow(/nonce too high/);
    state.fund(account.address, 0n);
    await expect(svc.sendRawTransaction(await signTx({ nonce: 0 }))).rejects.toThrow(/insufficient funds/);
    expect(relayer.sent).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it('releases the nonce reservation when the relay fails', async () => {
    relayer.failNext = new RpcError(-32000, 'relay rejected by Inbox: NotAllowedOrigin(0x…)');
    const raw = await signTx({ nonce: 0 });
    await expect(svc.sendRawTransaction(raw)).rejects.toThrow(/NotAllowedOrigin/);
    expect(store.size).toBe(0);
    expect(await svc.pendingNonce(account.address)).toBe(0);
    // and the same tx can be retried
    await svc.sendRawTransaction(raw);
    expect(relayer.sent).toHaveLength(1);
  });

  it('refuses to relay when disabled by Inbox re-verification', async () => {
    svc.relayEnabled = false;
    svc.relayDisabledReason = 'Inbox is paused';
    await expect(svc.sendRawTransaction(await signTx({ nonce: 0 }))).rejects.toThrow(/relay disabled: Inbox is paused/);
    expect(relayer.sent).toHaveLength(0);
  });
});

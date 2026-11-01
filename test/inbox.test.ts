import { describe, expect, it } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { verifyInbox } from '../src/inbox.js';

const INBOX = '0xce59f8B65ad41C9DAE4c07A0571a39824bD92cff' as Address;
const BRIDGE = '0x503D572157113fAaaD4DbeD2647Bb10b949216B6' as Address;
const ROLLUP = '0x508C173dFe5F737B3493195Bf785d71fA76fD217' as Address;
const SEQ = '0x7f3Ff53aecB87261206ad3bDc27A88b6D8420fa6' as Address;
const RELAYER = '0x9c397bA000000000000000000000000000000001' as Address;

function fakeClient(over: Record<string, unknown> = {}): PublicClient {
  const values: Record<string, unknown> = {
    bridge: BRIDGE,
    paused: false,
    allowListEnabled: false,
    maxDataSize: 117964n,
    rollup: ROLLUP,
    sequencerInbox: SEQ,
    delayedMessageCount: 134761n,
    allowedDelayedInboxes: true,
    chainId: 99901n,
    totalDelayedMessagesRead: 128762n,
    maxTimeVariation: [69120n, 0n, 86400n, 0n],
    isAllowed: false,
    ...over,
  };
  return {
    getCode: async () => '0x6080',
    getChainId: async () => 999,
    readContract: async ({ functionName, address }: { functionName: string; address: Address }) => {
      if (functionName === 'bridge' && address === SEQ) return BRIDGE;
      const v = values[functionName];
      if (v === undefined || v instanceof Error) throw v ?? new Error(`${functionName} reverted`);
      return v;
    },
  } as unknown as PublicClient;
}

const opts = { inbox: INBOX, relayer: RELAYER, l2ChainId: 99901 };

describe('verifyInbox', () => {
  it('reads allowListEnabled() (the nitro-contracts getter), not only isAllowListEnabled()', async () => {
    const r = await verifyInbox(fakeClient(), opts);
    expect(r.allowListEnabled).toBe(false);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.rollupChainId).toBe(99901n);
  });

  it('falls back to isAllowListEnabled() when allowListEnabled() is absent', async () => {
    const r = await verifyInbox(fakeClient({ allowListEnabled: undefined, isAllowListEnabled: true }), opts);
    expect(r.allowListEnabled).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/allow-list is ENABLED/);
  });

  it('fails when the rollup is a different chain or the inbox is paused', async () => {
    expect((await verifyInbox(fakeClient({ chainId: 1n }), opts)).ok).toBe(false);
    expect((await verifyInbox(fakeClient({ paused: true }), opts)).problems).toContain('Inbox is paused');
  });

  it('reports the L2-side backlog from the block nonce and warns only when it is large', async () => {
    const drained = await verifyInbox(fakeClient(), { ...opts, getL2DelayedRead: async () => 134760n });
    expect(drained.l2Backlog).toBe(1n);
    expect(drained.delayedBacklog).toBe(5999n);
    expect(drained.warnings).toEqual([]);

    const stalled = await verifyInbox(fakeClient(), { ...opts, getL2DelayedRead: async () => 128762n });
    expect(stalled.l2Backlog).toBe(5999n);
    expect(stalled.warnings.join()).toMatch(/not yet included on L2/);
    expect(stalled.ok).toBe(true); // a backlog is a warning, not a hard failure
  });
});

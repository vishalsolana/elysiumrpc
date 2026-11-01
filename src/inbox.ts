import { getAddress, parseAbi, zeroAddress, type Address, type PublicClient } from 'viem';

/** Subset of Arbitrum Nitro nitro-contracts ABIs we need. */
export const inboxAbi = parseAbi([
  'function bridge() view returns (address)',
  'function sequencerInbox() view returns (address)',
  'function paused() view returns (bool)',
  // nitro-contracts AbsInbox: `bool public allowListEnabled` (older/forked builds may expose isAllowListEnabled)
  'function allowListEnabled() view returns (bool)',
  'function isAllowListEnabled() view returns (bool)',
  'function isAllowed(address) view returns (bool)',
  'function maxDataSize() view returns (uint256)',
  'function sendL2Message(bytes messageData) returns (uint256)',
  'event InboxMessageDelivered(uint256 indexed messageNum, bytes data)',
  'error NotOrigin()',
  'error NotAllowedOrigin(address origin)',
  'error DataTooLarge(uint256 dataLength, uint256 maxDataLength)',
  'error L1Forked()',
]);

export const bridgeAbi = parseAbi([
  'function rollup() view returns (address)',
  'function sequencerInbox() view returns (address)',
  'function delayedMessageCount() view returns (uint256)',
  'function sequencerMessageCount() view returns (uint256)',
  'function allowedDelayedInboxes(address) view returns (bool)',
  'event MessageDelivered(uint256 indexed messageIndex, bytes32 indexed beforeInboxAcc, address inbox, uint8 kind, address sender, bytes32 messageDataHash, uint256 baseFeeL1, uint64 timestamp)',
]);

export const sequencerInboxAbi = parseAbi([
  'function bridge() view returns (address)',
  'function totalDelayedMessagesRead() view returns (uint256)',
  'function maxTimeVariation() view returns (uint256 delayBlocks, uint256 futureBlocks, uint256 delaySeconds, uint256 futureSeconds)',
]);

export const rollupAbi = parseAbi(['function chainId() view returns (uint256)']);

export interface InboxReport {
  ok: boolean;
  /** Hard failures: the relay must not run. */
  problems: string[];
  warnings: string[];
  inbox: Address;
  bridge?: Address;
  rollup?: Address;
  sequencerInbox?: Address;
  rollupChainId?: bigint;
  delayedMessageCount?: bigint;
  totalDelayedMessagesRead?: bigint;
  /** delayedMessageCount − totalDelayedMessagesRead: delayed messages not yet in a batch posted to HyperEVM. */
  delayedBacklog?: bigint;
  /** Delayed messages the sequencer has included on L2 (Nitro L2 block header `nonce`). */
  l2DelayedRead?: bigint;
  /** delayedMessageCount − l2DelayedRead: delayed messages the sequencer has NOT included on L2 yet. */
  l2Backlog?: bigint;
  paused?: boolean;
  allowListEnabled?: boolean;
  relayerAllowed?: boolean;
  maxDataSize?: bigint;
  forceInclusionDelay?: { blocks: bigint; seconds: bigint };
}

export interface VerifyOptions {
  inbox: Address;
  relayer: Address;
  l2ChainId: number;
  expectedBridge?: Address;
  expectedRollup?: Address;
  expectedSequencerInbox?: Address;
  /** Optional: returns the L2 head's delayed-messages-read count (Nitro block header `nonce`). */
  getL2DelayedRead?: () => Promise<bigint>;
}

const eq = (a?: Address, b?: Address) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Step 0: verify that `inbox` really is Elysium's delayed Inbox on HyperEVM and that our relayer can
 * use it. Every check reads chain state; nothing is assumed.
 */
export async function verifyInbox(client: PublicClient, o: VerifyOptions): Promise<InboxReport> {
  const r: InboxReport = { ok: false, problems: [], warnings: [], inbox: getAddress(o.inbox) };
  const read = async <T>(label: string, p: Promise<T>): Promise<T | undefined> => {
    try {
      return await p;
    } catch (e) {
      r.problems.push(`${label} failed: ${(e as Error).message.split('\n')[0]}`);
      return undefined;
    }
  };
  const optRead = async <T>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined);

  const code = await read('getCode(inbox)', client.getCode({ address: o.inbox }));
  if (!code || code === '0x') {
    r.problems.push(`no contract code at ${o.inbox} on chain ${await client.getChainId()}`);
    return r;
  }

  const inboxC = { address: o.inbox, abi: inboxAbi } as const;
  r.bridge = await read('inbox.bridge()', client.readContract({ ...inboxC, functionName: 'bridge' }));
  r.paused = await read('inbox.paused()', client.readContract({ ...inboxC, functionName: 'paused' }));
  r.allowListEnabled =
    (await optRead(client.readContract({ ...inboxC, functionName: 'allowListEnabled' }))) ??
    (await read('inbox.allowListEnabled() / isAllowListEnabled()', client.readContract({ ...inboxC, functionName: 'isAllowListEnabled' })));
  r.maxDataSize = await optRead(client.readContract({ ...inboxC, functionName: 'maxDataSize' }));

  if (r.paused) r.problems.push('Inbox is paused');
  if (r.allowListEnabled) {
    r.relayerAllowed = await read(
      'inbox.isAllowed(relayer)',
      client.readContract({ ...inboxC, functionName: 'isAllowed', args: [o.relayer] }),
    );
    if (!r.relayerAllowed) {
      r.problems.push(`Inbox allow-list is ENABLED and relayer ${o.relayer} is not allow-listed — relaying is impossible`);
    }
  }

  if (!r.bridge || r.bridge === zeroAddress) {
    r.problems.push('inbox.bridge() returned no bridge');
    return r;
  }
  const bridgeC = { address: r.bridge, abi: bridgeAbi } as const;
  r.rollup = await read('bridge.rollup()', client.readContract({ ...bridgeC, functionName: 'rollup' }));
  r.sequencerInbox = await read('bridge.sequencerInbox()', client.readContract({ ...bridgeC, functionName: 'sequencerInbox' }));
  r.delayedMessageCount = await read(
    'bridge.delayedMessageCount()',
    client.readContract({ ...bridgeC, functionName: 'delayedMessageCount' }),
  );
  const inboxAllowed = await read(
    'bridge.allowedDelayedInboxes(inbox)',
    client.readContract({ ...bridgeC, functionName: 'allowedDelayedInboxes', args: [o.inbox] }),
  );
  if (inboxAllowed === false) r.problems.push('bridge does not list this Inbox as an allowed delayed inbox');

  if (r.rollup) {
    r.rollupChainId = await read('rollup.chainId()', client.readContract({ address: r.rollup, abi: rollupAbi, functionName: 'chainId' }));
    if (r.rollupChainId !== undefined && r.rollupChainId !== BigInt(o.l2ChainId)) {
      r.problems.push(`rollup.chainId() is ${r.rollupChainId}, expected ${o.l2ChainId} — this is not Elysium's rollup`);
    }
  }

  if (r.sequencerInbox) {
    const siC = { address: r.sequencerInbox, abi: sequencerInboxAbi } as const;
    const siBridge = await optRead(client.readContract({ ...siC, functionName: 'bridge' }));
    if (siBridge && !eq(siBridge, r.bridge)) r.problems.push('sequencerInbox.bridge() does not point back at the bridge');
    r.totalDelayedMessagesRead = await optRead(client.readContract({ ...siC, functionName: 'totalDelayedMessagesRead' }));
    const mtv = await optRead(client.readContract({ ...siC, functionName: 'maxTimeVariation' }));
    if (mtv) r.forceInclusionDelay = { blocks: mtv[0], seconds: mtv[2] };
    if (r.delayedMessageCount !== undefined && r.totalDelayedMessagesRead !== undefined) {
      r.delayedBacklog = r.delayedMessageCount - r.totalDelayedMessagesRead;
    }
  }

  if (o.getL2DelayedRead && r.delayedMessageCount !== undefined) {
    r.l2DelayedRead = await optRead(o.getL2DelayedRead());
    if (r.l2DelayedRead !== undefined) r.l2Backlog = r.delayedMessageCount - r.l2DelayedRead;
  }
  if (r.l2Backlog !== undefined) {
    if (r.l2Backlog > 50n) {
      r.warnings.push(`${r.l2Backlog} delayed messages are not yet included on L2 by the sequencer — inclusion may be slow or stalled`);
    }
  } else if (r.delayedBacklog !== undefined && r.delayedBacklog > 50n) {
    r.warnings.push(
      `${r.delayedBacklog} delayed messages are not yet in a posted batch (L2-side count unavailable; may just be batch-posting lag)`,
    );
  }

  if (o.expectedBridge && !eq(o.expectedBridge, r.bridge)) r.problems.push(`bridge ${r.bridge} != ELYSIUM_BRIDGE ${o.expectedBridge}`);
  if (o.expectedRollup && !eq(o.expectedRollup, r.rollup)) r.problems.push(`rollup ${r.rollup} != ELYSIUM_ROLLUP ${o.expectedRollup}`);
  if (o.expectedSequencerInbox && !eq(o.expectedSequencerInbox, r.sequencerInbox)) {
    r.problems.push(`sequencerInbox ${r.sequencerInbox} != ELYSIUM_SEQUENCER_INBOX ${o.expectedSequencerInbox}`);
  }

  r.ok = r.problems.length === 0;
  return r;
}

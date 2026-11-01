/**
 * Step 0: verify the configured ELYSIUM_INBOX on HyperEVM without starting the server.
 *
 *   npm run verify-inbox                     # uses .env / environment
 *   npm run verify-inbox -- 0xInboxAddress   # check a candidate address
 *
 * Exit code 0 = verified and usable by the relayer; 2 = verification failed.
 */
import { createPublicClient, getAddress, http, isAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyInbox } from '../src/inbox.js';
import { hyperEvmChain } from '../src/relayer.js';

process.loadEnvFile?.('.env');

const rpc = process.env.HYPEREVM_RPC_URL ?? 'https://rpc.hyperliquid.xyz/evm';
const chainId = Number(process.env.HYPEREVM_CHAIN_ID ?? 999);
const l2ChainId = Number(process.env.L2_CHAIN_ID ?? 99901);
const arg = process.argv[2] ?? process.env.ELYSIUM_INBOX;
if (!arg || !isAddress(arg, { strict: false })) {
  console.error('usage: verify-inbox <inboxAddress>   (or set ELYSIUM_INBOX)');
  process.exit(1);
}
const relayer: Address = process.env.RELAYER_PRIVATE_KEY
  ? privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as `0x${string}`).address
  : (process.env.RELAYER_ADDRESS as Address | undefined) ?? '0x0000000000000000000000000000000000000001';

const client = createPublicClient({ chain: hyperEvmChain(chainId, rpc), transport: http(rpc, { timeout: 15_000 }) });
const actual = await client.getChainId();
if (actual !== chainId) {
  console.error(`HyperEVM RPC reports chain ${actual}, expected ${chainId}`);
  process.exit(1);
}

const r = await verifyInbox(client, {
  inbox: getAddress(arg),
  relayer,
  l2ChainId,
  expectedBridge: process.env.ELYSIUM_BRIDGE as Address | undefined,
  expectedRollup: process.env.ELYSIUM_ROLLUP as Address | undefined,
  expectedSequencerInbox: process.env.ELYSIUM_SEQUENCER_INBOX as Address | undefined,
});

const row = (k: string, v: unknown) => console.log(`  ${k.padEnd(26)} ${v === undefined ? '—' : String(v)}`);
console.log(`\nElysium Inbox verification on chain ${chainId} (${rpc})\n`);
row('Inbox', r.inbox);
row('Bridge (inbox.bridge())', r.bridge);
row('Rollup (bridge.rollup())', r.rollup);
row('SequencerInbox', r.sequencerInbox);
row('rollup.chainId()', r.rollupChainId);
row('delayedMessageCount', r.delayedMessageCount);
row('totalDelayedMessagesRead', r.totalDelayedMessagesRead);
row('delayed backlog', r.delayedBacklog);
row('paused()', r.paused);
row('isAllowListEnabled()', r.allowListEnabled);
row(`isAllowed(${relayer.slice(0, 10)}…)`, r.allowListEnabled ? r.relayerAllowed : 'n/a');
row('maxDataSize()', r.maxDataSize);
row('force-inclusion delay', r.forceInclusionDelay ? `${r.forceInclusionDelay.blocks} blocks / ${r.forceInclusionDelay.seconds} s` : undefined);
for (const w of r.warnings) console.log(`\n  WARNING: ${w}`);
for (const p of r.problems) console.log(`\n  PROBLEM: ${p}`);
console.log(`\n${r.ok ? 'VERIFIED' : 'NOT VERIFIED — do not relay through this address'}\n`);
if (r.ok) {
  console.log('Suggested .env lines:');
  console.log(`  ELYSIUM_INBOX=${r.inbox}\n  ELYSIUM_BRIDGE=${r.bridge}\n  ELYSIUM_ROLLUP=${r.rollup}\n  ELYSIUM_SEQUENCER_INBOX=${r.sequencerInbox}\n`);
}
process.exit(r.ok ? 0 : 2);

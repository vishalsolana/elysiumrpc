/**
 * Step 0: verify the configured ELYSIUM_INBOX on HyperEVM without starting the server.
 *
 *   npm run verify-inbox                              # uses .env / environment
 *   npm run verify-inbox -- 0xInboxAddress            # check a candidate address
 *   npm run verify-inbox -- 0xInboxAddress --watch    # sample the delayed backlog every 60 s
 *
 * Exit code 0 = verified and usable by the relayer; 2 = verification failed.
 */
import { createPublicClient, getAddress, http, isAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bridgeAbi, sequencerInboxAbi, verifyInbox } from '../src/inbox.js';
import { hyperEvmChain } from '../src/relayer.js';
import { UpstreamPool } from '../src/upstream.js';

try {
  process.loadEnvFile('.env');
} catch {
  /* no .env */
}

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const rpc = process.env.HYPEREVM_RPC_URL ?? 'https://rpc.hyperliquid.xyz/evm';
const chainId = Number(process.env.HYPEREVM_CHAIN_ID ?? 999);
const l2ChainId = Number(process.env.L2_CHAIN_ID ?? 99901);
const upstreamUrls = (process.env.UPSTREAM_RPC_URLS ?? 'https://rpc.stockium.fun,https://rpc-live.elysp.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const arg = args.find((a) => !a.startsWith('--')) ?? process.env.ELYSIUM_INBOX;
if (!arg || !isAddress(arg, { strict: false })) {
  console.error('usage: verify-inbox <inboxAddress> [--watch]   (or set ELYSIUM_INBOX)');
  process.exit(1);
}
const relayer: Address = process.env.RELAYER_PRIVATE_KEY
  ? privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as `0x${string}`).address
  : ((process.env.RELAYER_ADDRESS as Address | undefined) ?? '0x0000000000000000000000000000000000000001');

const client = createPublicClient({
  chain: hyperEvmChain(chainId, rpc),
  transport: http(rpc, { timeout: 20_000, retryCount: 6, retryDelay: 1000 }),
});
const l2 = new UpstreamPool(upstreamUrls, 8000);

/** Nitro stores the number of delayed messages read in each L2 block header's `nonce` field. */
async function l2DelayedRead(): Promise<bigint> {
  const b = await l2.call<{ nonce?: string } | null>('eth_getBlockByNumber', ['latest', false]);
  if (!b?.nonce) throw new Error('L2 block has no nonce field');
  return BigInt(b.nonce);
}

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
  getL2DelayedRead: l2DelayedRead,
});

const row = (k: string, v: unknown) => console.log(`  ${k.padEnd(30)} ${v === undefined ? '—' : String(v)}`);
console.log(`\nElysium Inbox verification on chain ${chainId} (${rpc})\n`);
row('Inbox', r.inbox);
row('Bridge (inbox.bridge())', r.bridge);
row('Rollup (bridge.rollup())', r.rollup);
row('SequencerInbox', r.sequencerInbox);
row('rollup.chainId()', r.rollupChainId);
row('paused()', r.paused);
row('allowListEnabled()', r.allowListEnabled);
row(`isAllowed(${relayer.slice(0, 10)}…)`, r.allowListEnabled ? r.relayerAllowed : 'n/a');
row('maxDataSize()', r.maxDataSize);
row('force-inclusion delay', r.forceInclusionDelay ? `${r.forceInclusionDelay.blocks} blocks / ${r.forceInclusionDelay.seconds} s` : undefined);
console.log('');
row('delayedMessageCount (HyperEVM)', r.delayedMessageCount);
row('read by posted batches', `${r.totalDelayedMessagesRead ?? '—'}   (backlog ${r.delayedBacklog ?? '—'})`);
row('included on L2 (block nonce)', `${r.l2DelayedRead ?? '— (L2 read failed)'}   (backlog ${r.l2Backlog ?? '—'})`);
for (const w of r.warnings) console.log(`\n  WARNING: ${w}`);
for (const p of r.problems) console.log(`\n  PROBLEM: ${p}`);
console.log(`\n${r.ok ? 'VERIFIED' : 'NOT VERIFIED — do not relay through this address'}\n`);
if (r.ok && !watch) {
  console.log('Suggested .env lines:');
  console.log(`  ELYSIUM_INBOX=${r.inbox}\n  ELYSIUM_BRIDGE=${r.bridge}\n  ELYSIUM_ROLLUP=${r.rollup}\n  ELYSIUM_SEQUENCER_INBOX=${r.sequencerInbox}\n`);
}

if (watch && r.bridge && r.sequencerInbox) {
  // Is the sequencer draining the delayed inbox? Sample every 60 s.
  const bridge = r.bridge;
  const si = r.sequencerInbox;
  console.log('watching delayed backlog every 60 s (Ctrl+C to stop)\n');
  console.log('time      delivered   +Δ    onL2(nonce)  +Δ    L2 backlog   batches-read  +Δ');
  let prev: { c: bigint; l: bigint | undefined; s: bigint } | undefined;
  for (;;) {
    try {
      const [c, s, l] = await Promise.all([
        client.readContract({ address: bridge, abi: bridgeAbi, functionName: 'delayedMessageCount' }),
        client.readContract({ address: si, abi: sequencerInboxAbi, functionName: 'totalDelayedMessagesRead' }),
        l2DelayedRead().catch(() => undefined),
      ]);
      const d = (a: bigint | undefined, b: bigint | undefined) => (a !== undefined && b !== undefined ? `+${a - b}` : '');
      console.log(
        `${new Date().toISOString().slice(11, 19)}  ${String(c).padEnd(11)} ${d(c, prev?.c).padEnd(5)} ${String(l ?? '—').padEnd(12)} ${d(l, prev?.l).padEnd(5)} ${String(l !== undefined ? c - l : '—').padEnd(12)} ${String(s).padEnd(13)} ${d(s, prev?.s)}`,
      );
      prev = { c, l, s };
    } catch (e) {
      console.log(`${new Date().toISOString().slice(11, 19)}  read failed: ${(e as Error).message.split('\n')[0]}`);
    }
    await new Promise((res) => setTimeout(res, 60_000));
  }
}
process.exit(r.ok ? 0 : 2);

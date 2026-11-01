/**
 * Step 0 discovery: find Elysium's Inbox on HyperEVM from chain data alone (no guessing).
 *
 * Every Arbitrum Orbit Inbox emits `InboxMessageDelivered(uint256 indexed, bytes)` on each
 * sendL2Message / deposit. We scan recent HyperEVM blocks for that event, collect the emitting
 * contracts, and keep only those whose inbox.bridge().rollup().chainId() == 99901.
 *
 *   npm run find-inbox -- [blocksBack=200000] [chunk=1000]
 *   npm run find-inbox -- --check 0xCandidate     # classify one address only
 *
 * The public HyperEVM RPC is heavily rate limited: requests are throttled (SCAN_DELAY_MS, default
 * 1500) and retried with backoff. A read that fails because of rate limiting never classifies a
 * contract as "not an Inbox". Set HYPEREVM_RPC_URL to a private HyperEVM endpoint to go faster.
 *
 * Then confirm the winner with `npm run verify-inbox -- <address>`.
 */
import { createPublicClient, getAddress, http, isAddress, type Address } from 'viem';
import { bridgeAbi, inboxAbi, rollupAbi } from '../src/inbox.js';
import { hyperEvmChain } from '../src/relayer.js';

try {
  process.loadEnvFile('.env');
} catch {
  /* no .env */
}

const rpc = process.env.HYPEREVM_RPC_URL ?? 'https://rpc.hyperliquid.xyz/evm';
const chainId = Number(process.env.HYPEREVM_CHAIN_ID ?? 999);
const l2ChainId = BigInt(process.env.L2_CHAIN_ID ?? 99901);
const delayMs = Number(process.env.SCAN_DELAY_MS ?? 1500);

const client = createPublicClient({
  chain: hyperEvmChain(chainId, rpc),
  transport: http(rpc, { timeout: 20_000, retryCount: 0 }), // we retry ourselves, with longer backoff
});
const event = inboxAbi.find((x) => x.type === 'event' && x.name === 'InboxMessageDelivered')!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0]! : String(e));

/** Transient failures: rate limits, timeouts, gateway errors. Anything else is a real answer. */
function isTransient(e: unknown): boolean {
  const m = e instanceof Error ? `${e.message} ${(e as { details?: string }).details ?? ''}` : String(e);
  return /exceeds defined limit|rate.?limit|too many|429|RPC Request failed|timed? ?out|took too long|fetch failed|ECONNRESET|503|502|504|HTTP request failed/i.test(m);
}

/** Retries transient failures with exponential backoff (2s → 64s, 7 attempts). */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await sleep(delayMs);
    try {
      return await fn();
    } catch (e) {
      if (!isTransient(e) || attempt >= 6) throw e;
      const wait = 2000 * 2 ** attempt;
      console.log(`    (${label}: ${short(e)} — retrying in ${wait / 1000}s)`);
      await sleep(wait);
    }
  }
}

type Verdict = { kind: 'match' | 'other' | 'notInbox' | 'unknown'; text: string };

async function classify(inbox: Address): Promise<Verdict> {
  try {
    const bridge = await withRetry('inbox.bridge()', () => client.readContract({ address: inbox, abi: inboxAbi, functionName: 'bridge' }));
    const rollup = await withRetry('bridge.rollup()', () => client.readContract({ address: bridge, abi: bridgeAbi, functionName: 'rollup' }));
    const cid = await withRetry('rollup.chainId()', () => client.readContract({ address: rollup, abi: rollupAbi, functionName: 'chainId' }));
    return cid === l2ChainId
      ? { kind: 'match', text: `MATCH chainId ${cid}  bridge ${bridge}  rollup ${rollup}` }
      : { kind: 'other', text: `other Orbit chain (chainId ${cid})` };
  } catch (e) {
    if (isTransient(e)) return { kind: 'unknown', text: `could not check, RPC kept failing (${short(e)}) — will retry later` };
    return { kind: 'notInbox', text: `not an Orbit Inbox (${short(e)})` };
  }
}

function reportMatch(addr: Address, where: string): never {
  console.log(`\nFound Elysium Inbox candidate: ${addr} ${where}`);
  console.log(`Next: npm run verify-inbox -- ${addr}\n`);
  process.exit(0);
}

// --check <address>: classify a single candidate and exit.
if (process.argv[2] === '--check') {
  const a = process.argv[3];
  if (!a || !isAddress(a, { strict: false })) {
    console.error('usage: find-inbox --check <address>');
    process.exit(1);
  }
  const v = await classify(getAddress(a));
  console.log(`${getAddress(a)}  ${v.text}`);
  if (v.kind === 'match') reportMatch(getAddress(a), '');
  process.exit(v.kind === 'unknown' ? 3 : 2);
}

const blocksBack = BigInt(process.argv[2] ?? 200_000);
const chunk = BigInt(process.argv[3] ?? 1000);

const head = await withRetry('eth_blockNumber', () => client.getBlockNumber());
const stop = head > blocksBack ? head - blocksBack : 0n;
console.log(`scanning HyperEVM ${stop}..${head} for InboxMessageDelivered (chunks of ${chunk}, ${delayMs}ms between requests)`);

const emitters = new Map<Address, number>();
const verdicts = new Map<Address, Verdict>();

async function consider(addr: Address, where: string): Promise<void> {
  emitters.set(addr, (emitters.get(addr) ?? 0) + 1);
  const prev = verdicts.get(addr);
  if (prev && prev.kind !== 'unknown') return;
  const v = await classify(addr);
  verdicts.set(addr, v);
  console.log(`  ${addr}  ${v.text}`);
  if (v.kind === 'match') reportMatch(addr, where);
}

let scanned = 0n;
let failedChunks = 0;
for (let to = head; to > stop; to -= chunk) {
  const from = to - chunk + 1n > stop ? to - chunk + 1n : stop;
  let logs;
  try {
    logs = await withRetry(`getLogs ${from}-${to}`, () => client.getLogs({ event, fromBlock: from, toBlock: to }));
  } catch (e) {
    failedChunks++;
    console.error(`getLogs ${from}-${to} failed after retries: ${short(e)}`);
    continue;
  }
  scanned += to - from + 1n;
  for (const l of logs) await consider(l.address, `(seen in block ${l.blockNumber}, tx ${l.transactionHash})`);
  if ((scanned / chunk) % 20n === 0n) console.log(`  … scanned ${scanned} blocks, down to ${from}`);
}

// Give contracts we couldn't classify (RPC trouble) one more try.
for (const [addr, v] of verdicts) {
  if (v.kind !== 'unknown') continue;
  const again = await classify(addr);
  verdicts.set(addr, again);
  console.log(`  ${addr}  ${again.text}`);
  if (again.kind === 'match') reportMatch(addr, '');
}

console.log(`\nNo Inbox with rollup.chainId() == ${l2ChainId} found in the last ${blocksBack} blocks (${failedChunks} chunks failed).`);
console.log('Emitters seen:');
for (const [a, n] of emitters) console.log(`  ${a}  ${n} msgs  ${verdicts.get(a)?.text}`);
process.exit(2);

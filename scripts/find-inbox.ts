/**
 * Step 0 discovery: find Elysium's Inbox on HyperEVM from chain data alone (no guessing).
 *
 * Every Arbitrum Orbit Inbox emits `InboxMessageDelivered(uint256 indexed, bytes)` on each
 * sendL2Message / deposit. We scan recent HyperEVM blocks for that event, collect the emitting
 * contracts, and keep only those whose inbox.bridge().rollup().chainId() == 99901.
 *
 *   npm run find-inbox -- [blocksBack=200000] [chunk=1000]
 *
 * Then confirm the winner with `npm run verify-inbox -- <address>`.
 */
import { createPublicClient, http, type Address } from 'viem';
import { bridgeAbi, inboxAbi, rollupAbi } from '../src/inbox.js';
import { hyperEvmChain } from '../src/relayer.js';

process.loadEnvFile?.('.env');

const rpc = process.env.HYPEREVM_RPC_URL ?? 'https://rpc.hyperliquid.xyz/evm';
const chainId = Number(process.env.HYPEREVM_CHAIN_ID ?? 999);
const l2ChainId = BigInt(process.env.L2_CHAIN_ID ?? 99901);
const blocksBack = BigInt(process.argv[2] ?? 200_000);
const chunk = BigInt(process.argv[3] ?? 1000);

const client = createPublicClient({ chain: hyperEvmChain(chainId, rpc), transport: http(rpc, { timeout: 20_000, retryCount: 3 }) });
const event = inboxAbi.find((x) => x.type === 'event' && x.name === 'InboxMessageDelivered')!;

const head = await client.getBlockNumber();
const stop = head > blocksBack ? head - blocksBack : 0n;
console.log(`scanning HyperEVM ${stop}..${head} for InboxMessageDelivered (chunks of ${chunk})`);

const emitters = new Map<Address, number>();
const checked = new Map<Address, string>();

async function classify(inbox: Address): Promise<string> {
  try {
    const bridge = await client.readContract({ address: inbox, abi: inboxAbi, functionName: 'bridge' });
    const rollup = await client.readContract({ address: bridge, abi: bridgeAbi, functionName: 'rollup' });
    const cid = await client.readContract({ address: rollup, abi: rollupAbi, functionName: 'chainId' });
    return cid === l2ChainId ? `MATCH chainId ${cid} bridge ${bridge} rollup ${rollup}` : `other Orbit chain ${cid}`;
  } catch (e) {
    return `not an Orbit Inbox (${(e as Error).message.split('\n')[0]})`;
  }
}

for (let to = head; to > stop; to -= chunk) {
  const from = to - chunk + 1n > stop ? to - chunk + 1n : stop;
  let logs;
  try {
    logs = await client.getLogs({ event, fromBlock: from, toBlock: to });
  } catch (e) {
    console.error(`getLogs ${from}-${to} failed: ${(e as Error).message.split('\n')[0]} — try a smaller chunk`);
    continue;
  }
  for (const l of logs) {
    emitters.set(l.address, (emitters.get(l.address) ?? 0) + 1);
    if (!checked.has(l.address)) {
      const c = await classify(l.address);
      checked.set(l.address, c);
      console.log(`  ${l.address}  ${c}`);
      if (c.startsWith('MATCH')) {
        console.log(`\nFound Elysium Inbox candidate: ${l.address} (seen in block ${l.blockNumber}, tx ${l.transactionHash})`);
        console.log(`Next: npm run verify-inbox -- ${l.address}\n`);
        process.exit(0);
      }
    }
  }
}

console.log(`\nNo Inbox with rollup.chainId() == ${l2ChainId} found in the last ${blocksBack} blocks.`);
console.log('Emitters seen:', Object.fromEntries([...emitters].map(([a, n]) => [a, `${n} msgs; ${checked.get(a)}`])));
process.exit(2);

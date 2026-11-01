/**
 * End-to-end relay test: signs a 0.0001 HYPE self-transfer with a funded L2 TEST wallet, sends it
 * through the local relay server, and reports the HyperEVM relay tx + gas cost, time to L2 receipt,
 * and final status. Gives up after 10 minutes.
 *
 *   TEST_L2_PRIVATE_KEY=0x... npm run relay-test
 *
 * TEST_L2_PRIVATE_KEY is a dedicated test wallet the operator owns. It is used only by this script
 * to sign locally; the relay server itself never sees any private key but its own relayer key.
 */
import {
  createPublicClient,
  decodeEventLog,
  formatEther,
  formatGwei,
  http,
  parseEther,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeSignedTxMessage } from '../src/encoding.js';
import { inboxAbi } from '../src/inbox.js';
import { hyperEvmChain } from '../src/relayer.js';

process.loadEnvFile?.('.env');

const TIMEOUT_MS = 10 * 60_000;
const pk = process.env.TEST_L2_PRIVATE_KEY as Hex | undefined;
if (!pk) {
  console.error('set TEST_L2_PRIVATE_KEY (a funded Elysium test wallet)');
  process.exit(1);
}
const relayUrl = process.env.RELAY_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8545}`;
const apiKey = process.env.API_KEY;
const headers: Record<string, string> = apiKey ? { 'x-api-key': apiKey } : {};
const hyperRpc = process.env.HYPEREVM_RPC_URL ?? 'https://rpc.hyperliquid.xyz/evm';
const hyperChainId = Number(process.env.HYPEREVM_CHAIN_ID ?? 999);
const amount = parseEther(process.env.TEST_AMOUNT_HYPE ?? '0.0001');

const account = privateKeyToAccount(pk);
const l2 = createPublicClient({ transport: http(relayUrl, { fetchOptions: { headers }, timeout: 30_000 }) });
const parent = createPublicClient({ chain: hyperEvmChain(hyperChainId, hyperRpc), transport: http(hyperRpc) });
const t = () => new Date().toISOString().slice(11, 19);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const chainId = await l2.getChainId();
const [balance, nonce, block] = await Promise.all([
  l2.getBalance({ address: account.address }),
  l2.getTransactionCount({ address: account.address, blockTag: 'pending' }),
  l2.getBlock({ blockTag: 'latest' }),
]);
const relayerKey = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
if (relayerKey && /^0x[0-9a-fA-F]{64}$/.test(relayerKey) && privateKeyToAccount(relayerKey).address === account.address) {
  if (process.env.ALLOW_RELAYER_AS_TEST_WALLET === '1') {
    console.log(`[${t()}] NOTE: testing with the relayer wallet itself (ALLOW_RELAYER_AS_TEST_WALLET=1)`);
  } else {
    console.error(`\n${account.address} is the RELAYER wallet (HyperEVM gas payer), not an L2 test wallet.`);
    console.error('Use a separate wallet that holds HYPE on Elysium L2, or set ALLOW_RELAYER_AS_TEST_WALLET=1 to test with it anyway.');
    process.exit(1);
  }
}
if (balance < amount + parseEther('0.0005')) {
  console.error(`\nTest wallet ${account.address} has ${formatEther(balance)} HYPE on Elysium L2 (chain ${chainId}).`);
  console.error(`It needs at least ${formatEther(amount + parseEther('0.0005'))} HYPE ON L2 (not on HyperEVM) for this test. Nothing was sent.`);
  process.exit(1);
}
const baseFee = block.baseFeePerGas ?? (await l2.getGasPrice());
const maxFeePerGas = baseFee * 2n;
const gas = await l2.estimateGas({ account: account.address, to: account.address, value: amount });
console.log(`[${t()}] relay ${relayUrl}  L2 chain ${chainId}`);
console.log(`[${t()}] test wallet ${account.address}  balance ${formatEther(balance)} HYPE  pending nonce ${nonce}`);
console.log(`[${t()}] L2 base fee ${formatGwei(baseFee)} gwei, gas ${gas}`);

const raw = await account.signTransaction({
  type: 'eip1559',
  chainId,
  nonce,
  to: account.address,
  value: amount,
  gas,
  maxFeePerGas,
  maxPriorityFeePerGas: 0n,
});

const sentAt = Date.now();
const hash = await l2.request({ method: 'eth_sendRawTransaction', params: [raw] });
console.log(`[${t()}] eth_sendRawTransaction → ${hash}`);

// Relay details from the server's tx endpoint.
const statusRes = await fetch(`${relayUrl}/tx/${hash}`, { headers });
const status = (await statusRes.json()) as { parentTxHash?: Hex };
const parentTxHash = status.parentTxHash;
if (!parentTxHash) {
  console.error('server did not report a HyperEVM relay tx hash', status);
  process.exit(1);
}
console.log(`[${t()}] HyperEVM relay tx ${parentTxHash}`);

const pr = await parent.waitForTransactionReceipt({ hash: parentTxHash, timeout: 120_000 });
const cost = pr.gasUsed * pr.effectiveGasPrice;
const delivered = pr.logs
  .map((l) => {
    try {
      return decodeEventLog({ abi: inboxAbi, data: l.data, topics: l.topics });
    } catch {
      return undefined;
    }
  })
  .find((e) => e?.eventName === 'InboxMessageDelivered');
console.log(
  `[${t()}] relay tx ${pr.status} in HyperEVM block ${pr.blockNumber}: gasUsed ${pr.gasUsed} × ${formatGwei(pr.effectiveGasPrice)} gwei = ${formatEther(cost)} HYPE`,
);
if (delivered?.eventName === 'InboxMessageDelivered') {
  const ok = delivered.args.data.toLowerCase() === encodeSignedTxMessage(raw);
  console.log(`[${t()}] InboxMessageDelivered #${delivered.args.messageNum}; payload ${ok ? 'matches 0x04 ++ raw tx' : 'DOES NOT MATCH'}`);
} else {
  console.log(`[${t()}] WARNING: no InboxMessageDelivered event in relay receipt`);
}
if (pr.status !== 'success') process.exit(1);

while (Date.now() - sentAt < TIMEOUT_MS) {
  const rcpt = await l2.getTransactionReceipt({ hash }).catch(() => null);
  if (rcpt) {
    const secs = ((Date.now() - sentAt) / 1000).toFixed(1);
    console.log(`\n=== RESULT ===`);
    console.log(`L2 tx            ${hash}`);
    console.log(`HyperEVM relay   ${parentTxHash}`);
    console.log(`relay gas cost   ${formatEther(cost)} HYPE (${pr.gasUsed} gas)`);
    console.log(`time to receipt  ${secs} s`);
    console.log(`L2 block         ${rcpt.blockNumber}`);
    console.log(`final status     ${rcpt.status}`);
    process.exit(rcpt.status === 'success' ? 0 : 1);
  }
  await sleep(2000);
}

console.log(`\n=== NOT INCLUDED within ${TIMEOUT_MS / 60_000} minutes ===`);
console.log(`L2 tx ${hash}\nHyperEVM relay ${parentTxHash} (cost ${formatEther(cost)} HYPE)`);
console.log('The delayed message is in the Inbox but the sequencer has not included it. Stop and investigate:');
console.log('  - npm run verify-inbox   (check delayed backlog: delayedMessageCount vs totalDelayedMessagesRead)');
console.log('  - the sequencer may only include delayed messages after the force-inclusion delay.');
process.exit(3);

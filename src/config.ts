import { getAddress, isAddress, type Address, type Hex } from 'viem';

export interface Config {
  hyperEvmRpcUrl: string;
  hyperEvmChainId: number;
  relayerPrivateKey: Hex;
  inbox: Address;
  /** Optional cross-checks: if set, startup verification requires the on-chain values to match. */
  expectedBridge?: Address;
  expectedRollup?: Address;
  expectedSequencerInbox?: Address;
  upstreamRpcUrls: string[];
  upstreamTimeoutMs: number;
  l2ChainId: number;
  port: number;
  apiKey?: string;
  maxTxBytes: number;
  dedupeWindowMs: number;
  receiptPollMs: number;
  stuckAfterMs: number;
  inflightExpiryMs: number;
  relayerBalanceWarnWei: bigint;
  relayerBalancePollMs: number;
  stateFile?: string;
  relayMaxGas: bigint;
  relayGasBufferPct: bigint;
  inboxRecheckMs: number;
  /** Skip the startup Inbox verification gate (tests only — never in production). */
  skipInboxVerification: boolean;
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]?.trim();
  if (!v) throw new Error(`missing required env var ${key}`);
  return v;
}

function opt(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

function num(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const v = opt(env, key);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`env var ${key} must be a non-negative number`);
  return n;
}

function addr(env: NodeJS.ProcessEnv, key: string, required: true): Address;
function addr(env: NodeJS.ProcessEnv, key: string, required: false): Address | undefined;
function addr(env: NodeJS.ProcessEnv, key: string, required: boolean): Address | undefined {
  const v = required ? req(env, key) : opt(env, key);
  if (v === undefined) return undefined;
  if (!isAddress(v, { strict: false })) throw new Error(`env var ${key} is not an address`);
  return getAddress(v);
}

/** Parses a decimal HYPE amount (e.g. "0.5") into wei without float rounding. */
export function parseHype(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(s.trim());
  if (!m) throw new Error(`invalid HYPE amount: ${s}`);
  return BigInt(m[1]!) * 10n ** 18n + BigInt((m[2] ?? '').padEnd(18, '0') || '0');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const pk = req(env, 'RELAYER_PRIVATE_KEY');
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('RELAYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key');

  const upstreams = req(env, 'UPSTREAM_RPC_URLS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (upstreams.length === 0) throw new Error('UPSTREAM_RPC_URLS must list at least one URL');
  for (const u of upstreams) new URL(u); // throws on garbage

  const minutes = (key: string, def: number) => num(env, key, def) * 60_000;

  return {
    hyperEvmRpcUrl: req(env, 'HYPEREVM_RPC_URL'),
    hyperEvmChainId: num(env, 'HYPEREVM_CHAIN_ID', 999),
    relayerPrivateKey: pk as Hex,
    inbox: addr(env, 'ELYSIUM_INBOX', true),
    expectedBridge: addr(env, 'ELYSIUM_BRIDGE', false),
    expectedRollup: addr(env, 'ELYSIUM_ROLLUP', false),
    expectedSequencerInbox: addr(env, 'ELYSIUM_SEQUENCER_INBOX', false),
    upstreamRpcUrls: upstreams,
    upstreamTimeoutMs: num(env, 'UPSTREAM_TIMEOUT_MS', 4000),
    l2ChainId: num(env, 'L2_CHAIN_ID', 99901),
    port: num(env, 'PORT', 8545),
    apiKey: opt(env, 'API_KEY'),
    maxTxBytes: num(env, 'MAX_TX_BYTES', 128 * 1024),
    dedupeWindowMs: minutes('DEDUPE_RESEND_AFTER_MINUTES', 2),
    receiptPollMs: num(env, 'RECEIPT_POLL_MS', 3000),
    stuckAfterMs: minutes('STUCK_AFTER_MINUTES', 5),
    inflightExpiryMs: minutes('INFLIGHT_EXPIRY_MINUTES', 60),
    relayerBalanceWarnWei: parseHype(opt(env, 'RELAYER_BALANCE_WARN_HYPE') ?? '0.5'),
    relayerBalancePollMs: num(env, 'RELAYER_BALANCE_POLL_MS', 30_000),
    stateFile: opt(env, 'STATE_FILE') ?? 'data/inflight.json',
    relayMaxGas: BigInt(num(env, 'RELAY_MAX_GAS', 2_000_000)),
    relayGasBufferPct: BigInt(100 + num(env, 'RELAY_GAS_BUFFER_PCT', 20)),
    inboxRecheckMs: minutes('INBOX_RECHECK_MINUTES', 10),
    skipInboxVerification: opt(env, 'UNSAFE_SKIP_INBOX_VERIFICATION') === '1',
  };
}

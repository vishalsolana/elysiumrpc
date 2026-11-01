import { formatEther } from 'viem';
import { loadConfig } from './config.js';
import { verifyInbox, type InboxReport } from './inbox.js';
import { InFlightStore } from './inflight.js';
import { log } from './log.js';
import { Monitor } from './monitor.js';
import { InboxRelayer, makeHyperEvmClients } from './relayer.js';
import { createRpcServer, RpcHandler } from './server.js';
import { RelayService, UpstreamStateReader } from './service.js';
import { UpstreamPool } from './upstream.js';

/** The server only ever listens on loopback; the bot runs on the same machine. */
const BIND_HOST = '127.0.0.1';

export function printInboxReport(r: InboxReport): void {
  log[r.ok ? 'info' : 'error'](r.ok ? 'Inbox verified' : 'Inbox verification FAILED', {
    inbox: r.inbox,
    bridge: r.bridge,
    rollup: r.rollup,
    sequencerInbox: r.sequencerInbox,
    rollupChainId: r.rollupChainId,
    delayedMessageCount: r.delayedMessageCount,
    totalDelayedMessagesRead: r.totalDelayedMessagesRead,
    delayedBacklog: r.delayedBacklog,
    l2DelayedRead: r.l2DelayedRead,
    l2Backlog: r.l2Backlog,
    paused: r.paused,
    allowListEnabled: r.allowListEnabled,
    relayerAllowed: r.relayerAllowed,
    maxDataSize: r.maxDataSize,
    forceInclusionDelay: r.forceInclusionDelay,
    problems: r.problems,
    warnings: r.warnings,
  });
}

async function main(): Promise<void> {
  // systemd passes env via EnvironmentFile; for local runs also read ./.env if present.
  try {
    process.loadEnvFile('.env');
  } catch {
    /* no .env */
  }
  const cfg = loadConfig();
  const { chain, account, publicClient, walletClient } = makeHyperEvmClients(cfg.hyperEvmRpcUrl, cfg.hyperEvmChainId, cfg.relayerPrivateKey);

  const parentChainId = await publicClient.getChainId();
  if (parentChainId !== cfg.hyperEvmChainId) {
    throw new Error(`HYPEREVM_RPC_URL reports chain ${parentChainId}, expected ${cfg.hyperEvmChainId}`);
  }

  const upstream = new UpstreamPool(cfg.upstreamRpcUrls, cfg.upstreamTimeoutMs);
  const l2ChainId = Number(await upstream.call<string>('eth_chainId'));
  if (l2ChainId !== cfg.l2ChainId) throw new Error(`upstream reports chain ${l2ChainId}, expected ${cfg.l2ChainId}`);

  const verifyOpts = {
    inbox: cfg.inbox,
    relayer: account.address,
    l2ChainId: cfg.l2ChainId,
    expectedBridge: cfg.expectedBridge,
    expectedRollup: cfg.expectedRollup,
    expectedSequencerInbox: cfg.expectedSequencerInbox,
    // Nitro L2 block header `nonce` = delayed messages the sequencer has included on L2.
    getL2DelayedRead: async () => {
      const b = await upstream.call<{ nonce?: string } | null>('eth_getBlockByNumber', ['latest', false]);
      if (!b?.nonce) throw new Error('L2 block has no nonce');
      return BigInt(b.nonce);
    },
  };

  let startupReport: InboxReport | undefined;
  // Step 0 gate: refuse to start unless the configured Inbox verifies on chain.
  if (cfg.skipInboxVerification) {
    log.error('UNSAFE_SKIP_INBOX_VERIFICATION=1 — Inbox NOT verified. Never use this in production.');
  } else {
    const report = await verifyInbox(publicClient, verifyOpts);
    startupReport = report;
    printInboxReport(report);
    if (!report.ok) process.exit(2);
  }

  const inflight = new InFlightStore(cfg.stateFile);
  inflight.load();
  if (inflight.size) log.info('restored in-flight txs from state file', { count: inflight.size, stateFile: cfg.stateFile });

  const state = new UpstreamStateReader(upstream);
  const relayer = new InboxRelayer(publicClient, walletClient, account, chain, {
    inbox: cfg.inbox,
    maxGas: cfg.relayMaxGas,
    gasBufferPct: cfg.relayGasBufferPct,
  });
  const service = new RelayService(
    { l2ChainId: cfg.l2ChainId, maxTxBytes: cfg.maxTxBytes, dedupeWindowMs: cfg.dedupeWindowMs },
    state,
    inflight,
    relayer,
  );
  const monitor = new Monitor(
    {
      receiptPollMs: cfg.receiptPollMs,
      stuckAfterMs: cfg.stuckAfterMs,
      inflightExpiryMs: cfg.inflightExpiryMs,
      relayerBalanceWarnWei: cfg.relayerBalanceWarnWei,
      relayerBalancePollMs: cfg.relayerBalancePollMs,
      inboxRecheckMs: cfg.inboxRecheckMs,
    },
    inflight,
    state,
    publicClient,
    account.address,
    service,
    verifyOpts,
  );

  const handler = new RpcHandler({
    service,
    upstream,
    monitor,
    l2ChainId: cfg.l2ChainId,
    apiKey: cfg.apiKey,
    relayerAddress: account.address,
    inbox: cfg.inbox,
    relayerBalanceWarnWei: cfg.relayerBalanceWarnWei,
  });
  const server = createRpcServer(handler);
  server.listen(cfg.port, BIND_HOST, () => {
    log.info('elysium rpc relay listening', {
      url: `http://${BIND_HOST}:${cfg.port}`,
      relayer: account.address,
      inbox: cfg.inbox,
      upstreams: upstream.statsSnapshot().map((s) => s.url),
      apiKey: cfg.apiKey ? 'required' : 'disabled',
    });
  });
  if (startupReport) {
    monitor.lastInboxReport = startupReport;
    monitor.lastInboxCheckAt = Date.now();
  }
  monitor.start();
  await monitor.checkRelayerBalance().catch(() => undefined);
  if (monitor.relayerBalance !== undefined) log.info('relayer balance', { hype: formatEther(monitor.relayerBalance) });

  const shutdown = (sig: string) => {
    log.info('shutting down', { signal: sig, inflight: inflight.size });
    monitor.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  log.error('fatal', { error: (e as Error).stack ?? String(e) });
  process.exit(1);
});

import { formatEther, type Address, type PublicClient } from 'viem';
import { verifyInbox, type InboxReport, type VerifyOptions } from './inbox.js';
import type { InFlightStore } from './inflight.js';
import { log } from './log.js';
import type { RelayService, UpstreamStateReader } from './service.js';

export interface MonitorOptions {
  receiptPollMs: number;
  stuckAfterMs: number;
  inflightExpiryMs: number;
  relayerBalanceWarnWei: bigint;
  relayerBalancePollMs: number;
  inboxRecheckMs: number;
}

/** Background loops: L2 receipt polling, stuck/expiry detection, relayer balance, Inbox re-verification. */
export class Monitor {
  relayerBalance?: bigint;
  relayerBalanceAt?: number;
  lastInboxReport?: InboxReport;
  lastInboxCheckAt?: number;
  private timers: NodeJS.Timeout[] = [];
  private polling = false;

  constructor(
    private readonly opts: MonitorOptions,
    private readonly inflight: InFlightStore,
    private readonly state: UpstreamStateReader,
    private readonly parent: PublicClient,
    private readonly relayerAddress: Address,
    private readonly service: RelayService,
    private readonly verifyOpts: VerifyOptions,
  ) {}

  start(): void {
    const every = (ms: number, fn: () => Promise<void>) => {
      const run = () => fn().catch((e) => log.error('monitor loop error', { error: (e as Error).message }));
      void run();
      this.timers.push(setInterval(run, ms));
    };
    every(this.opts.receiptPollMs, () => this.pollReceipts());
    every(this.opts.relayerBalancePollMs, () => this.checkRelayerBalance());
    this.timers.push(setInterval(() => void this.recheckInbox(), this.opts.inboxRecheckMs));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  async pollReceipts(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const now = Date.now();
      const entries = this.inflight.entries().filter((e) => e.status === 'inflight');
      const latestBySender = new Map<string, Promise<number | undefined>>();
      const latestFor = (a: Address) => {
        const k = a.toLowerCase();
        if (!latestBySender.has(k)) latestBySender.set(k, this.state.getLatestNonce(a).catch(() => undefined));
        return latestBySender.get(k)!;
      };

      await Promise.all(
        entries.map(async (e) => {
          // 1. HyperEVM side: did the relay tx itself succeed?
          if (e.parentTxHash && !e.parentStatus) {
            const pr = await this.parent.getTransactionReceipt({ hash: e.parentTxHash }).catch(() => null);
            if (pr) {
              const cost = pr.gasUsed * pr.effectiveGasPrice;
              this.inflight.update(e.hash, { parentStatus: pr.status, parentGasCostWei: cost.toString() });
              if (pr.status === 'reverted') {
                log.error('relay tx REVERTED on HyperEVM', { hash: e.hash, parentTxHash: e.parentTxHash });
                this.inflight.complete(e.hash, 'relay-failed', now, { detail: 'HyperEVM relay tx reverted' });
                return;
              }
            }
          }

          // 2. L2 side: is there a receipt?
          const rcpt = await this.state.getReceipt(e.hash).catch(() => null);
          if (rcpt) {
            const done = this.inflight.complete(e.hash, 'mined', Date.now(), {
              l2Status: rcpt.status === '0x1' ? 'success' : 'reverted',
              l2BlockNumber: rcpt.blockNumber,
            });
            log.info('L2 tx included', {
              hash: e.hash,
              l2Block: Number(rcpt.blockNumber),
              l2Status: done?.l2Status,
              inclusionLatencyMs: done?.inclusionLatencyMs,
            });
            return;
          }

          // 3. Nonce consumed without our receipt → the delayed message was dropped or superseded.
          const latest = await latestFor(e.sender);
          if (latest !== undefined && latest > e.nonce) {
            const again = await this.state.getReceipt(e.hash).catch(() => null);
            if (!again) {
              log.warn('L2 nonce consumed but no receipt for our hash: dropped/superseded', { hash: e.hash, sender: e.sender, nonce: e.nonce, latest });
              this.inflight.complete(e.hash, 'dropped', Date.now(), { detail: `sender nonce advanced to ${latest}` });
              return;
            }
          }

          // 4. Stuck / expired.
          const age = now - e.relayedAt;
          if (now - e.firstRelayedAt > this.opts.inflightExpiryMs) {
            log.error('IN-FLIGHT TX EXPIRED without inclusion; releasing its nonce reservation', {
              hash: e.hash,
              sender: e.sender,
              nonce: e.nonce,
              parentTxHash: e.parentTxHash,
              ageMin: Math.round((now - e.firstRelayedAt) / 60_000),
            });
            this.inflight.complete(e.hash, 'expired', now);
          } else if (age > this.opts.stuckAfterMs && !e.stuckWarnedAt) {
            log.warn('tx not included on L2 yet', {
              hash: e.hash,
              sender: e.sender,
              nonce: e.nonce,
              parentTxHash: e.parentTxHash,
              parentStatus: e.parentStatus,
              ageSec: Math.round(age / 1000),
            });
            this.inflight.update(e.hash, { stuckWarnedAt: now });
          }
        }),
      );
    } finally {
      this.polling = false;
    }
  }

  async checkRelayerBalance(): Promise<void> {
    const bal = await this.parent.getBalance({ address: this.relayerAddress });
    this.relayerBalance = bal;
    this.relayerBalanceAt = Date.now();
    if (bal < this.opts.relayerBalanceWarnWei) {
      log.error('!!!!! RELAYER HYPEREVM BALANCE LOW — TOP UP OR RELAYS WILL FAIL !!!!!', {
        relayer: this.relayerAddress,
        balanceHype: formatEther(bal),
        thresholdHype: formatEther(this.opts.relayerBalanceWarnWei),
      });
    }
  }

  /** Re-reads Inbox state periodically; disables relaying if it gets paused or allow-listed. */
  async recheckInbox(): Promise<InboxReport | undefined> {
    try {
      const r = await verifyInbox(this.parent, this.verifyOpts);
      this.lastInboxReport = r;
      this.lastInboxCheckAt = Date.now();
      if (!r.ok) {
        this.service.relayEnabled = false;
        this.service.relayDisabledReason = r.problems.join('; ');
        log.error('Inbox re-verification FAILED; relaying disabled', { problems: r.problems });
      } else {
        if (!this.service.relayEnabled) log.info('Inbox re-verified; relaying re-enabled');
        this.service.relayEnabled = true;
        this.service.relayDisabledReason = undefined;
        for (const w of r.warnings) log.warn(w);
      }
      return r;
    } catch (e) {
      log.warn('Inbox re-check could not complete (HyperEVM unreachable?)', { error: (e as Error).message });
      return undefined;
    }
  }
}

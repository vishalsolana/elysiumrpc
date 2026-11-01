import type { Address, Hex } from 'viem';
import { encodeSignedTxMessage } from './encoding.js';
import { ErrorCode, RpcError } from './errors.js';
import { KeyedMutex, type InFlightStore } from './inflight.js';
import { log } from './log.js';
import type { Relayer } from './relayer.js';
import type { UpstreamPool } from './upstream.js';
import { checkAgainstState, decodeRawTx, type L2StateReader } from './validate.js';

/** Reads L2 state through the upstream pool. */
export class UpstreamStateReader implements L2StateReader {
  private baseFeeCache?: { at: number; value: bigint | undefined };

  constructor(private readonly upstream: UpstreamPool) {}

  async getBalance(addr: Address): Promise<bigint> {
    return BigInt(await this.upstream.call<string>('eth_getBalance', [addr, 'latest']));
  }

  async getLatestNonce(addr: Address): Promise<number> {
    return Number(await this.upstream.call<string>('eth_getTransactionCount', [addr, 'latest']));
  }

  async getBaseFee(): Promise<bigint | undefined> {
    const now = Date.now();
    if (this.baseFeeCache && now - this.baseFeeCache.at < 2000) return this.baseFeeCache.value;
    const block = await this.upstream.call<{ baseFeePerGas?: string } | null>('eth_getBlockByNumber', ['latest', false]);
    const value = block?.baseFeePerGas ? BigInt(block.baseFeePerGas) : undefined;
    this.baseFeeCache = { at: now, value };
    return value;
  }

  async getReceipt(hash: Hex): Promise<{ status: string; blockNumber: string } | null> {
    return this.upstream.call('eth_getTransactionReceipt', [hash]);
  }
}

export interface RelayServiceOptions {
  l2ChainId: number;
  maxTxBytes: number;
  dedupeWindowMs: number;
}

export class RelayService {
  private readonly senderLock = new KeyedMutex();
  /** Set false by the monitor when re-verification of the Inbox fails (paused, allow-listed…). */
  relayEnabled = true;
  relayDisabledReason?: string;

  constructor(
    private readonly opts: RelayServiceOptions,
    private readonly state: UpstreamStateReader | L2StateReader,
    readonly inflight: InFlightStore,
    private readonly relayer: Relayer,
    private readonly now: () => number = Date.now,
  ) {}

  /** eth_sendRawTransaction: validate, dedupe, relay via Inbox. Returns keccak256(raw). */
  async sendRawTransaction(raw: unknown): Promise<Hex> {
    const tx = await decodeRawTx(raw, { chainId: this.opts.l2ChainId, maxTxBytes: this.opts.maxTxBytes });

    return this.senderLock.run(tx.sender.toLowerCase(), async () => {
      const d = this.inflight.dedupe(tx.hash, this.now(), this.opts.dedupeWindowMs);
      if (d.action === 'duplicate') {
        log.info('duplicate send, not relaying again', { hash: tx.hash });
        return tx.hash;
      }
      this.assertEnabled();

      if (d.action === 'resend') {
        // Make sure it hasn't landed (or been superseded) before paying for another delivery.
        if ('getReceipt' in this.state) {
          const rcpt = await this.state.getReceipt(tx.hash).catch(() => null);
          if (rcpt) {
            this.inflight.complete(tx.hash, 'mined', this.now(), { l2Status: rcpt.status === '0x1' ? 'success' : 'reverted', l2BlockNumber: rcpt.blockNumber });
            return tx.hash;
          }
        }
        const latest = await this.state.getLatestNonce(tx.sender);
        if (latest > tx.nonce) {
          this.inflight.complete(tx.hash, 'dropped', this.now(), { detail: 'nonce consumed by another tx' });
          throw new RpcError(ErrorCode.TxRejected, `nonce too low: next nonce ${latest}, tx nonce ${tx.nonce}`);
        }
        log.warn('re-relaying tx unconfirmed past dedupe window', {
          hash: tx.hash,
          sender: tx.sender,
          nonce: tx.nonce,
          ageSec: Math.round((this.now() - d.entry.relayedAt) / 1000),
          relayCount: d.entry.relayCount,
        });
        this.inflight.update(tx.hash, { status: 'relaying' });
        await this.relayAndRecord(tx.hash, tx.raw, /*isResend*/ true);
        return tx.hash;
      }

      await checkAgainstState(tx, this.state, this.inflight);

      const t = this.now();
      this.inflight.add({
        hash: tx.hash,
        raw: tx.raw,
        sender: tx.sender,
        nonce: tx.nonce,
        maxCost: tx.maxCost,
        status: 'relaying',
        firstRelayedAt: t,
        relayedAt: t,
        relayCount: 0,
      });
      await this.relayAndRecord(tx.hash, tx.raw, false);
      return tx.hash;
    });
  }

  private async relayAndRecord(hash: Hex, raw: Hex, isResend: boolean): Promise<void> {
    try {
      const r = await this.relayer.relay(encodeSignedTxMessage(raw));
      this.inflight.markRelayed(hash, r.parentTxHash, this.now());
      log.info('relayed via Inbox', { hash, parentTxHash: r.parentTxHash, parentNonce: r.parentNonce, gasLimit: r.gasLimit, resend: isResend });
    } catch (e) {
      if (isResend) {
        // The earlier delivery may still land; keep it in flight.
        this.inflight.update(hash, { status: 'inflight' });
      } else {
        this.inflight.complete(hash, 'relay-failed', this.now(), { detail: (e as Error).message });
      }
      log.error('relay failed', { hash, error: (e as Error).message });
      throw e instanceof RpcError ? e : new RpcError(ErrorCode.Internal, (e as Error).message);
    }
  }

  private assertEnabled(): void {
    if (!this.relayEnabled) {
      throw new RpcError(ErrorCode.TxRejected, `relay disabled: ${this.relayDisabledReason ?? 'Inbox verification failed'}`);
    }
  }

  /** eth_getTransactionCount(addr, "pending") = upstream latest + our in-flight for addr. */
  async pendingNonce(addr: Address): Promise<number> {
    const latest = await this.state.getLatestNonce(addr);
    return this.inflight.pendingNonce(addr, latest);
  }
}

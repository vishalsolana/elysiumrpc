import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Address, Hex } from 'viem';

export type InFlightStatus =
  /** Reserved; the HyperEVM relay tx is being built/broadcast. Counts toward pending nonce. */
  | 'relaying'
  /** Delivered to the Inbox (HyperEVM tx broadcast); waiting for the L2 receipt. */
  | 'inflight';

export interface InFlightEntry {
  hash: Hex;
  raw: Hex;
  sender: Address;
  nonce: number;
  /** Worst-case L2 cost: gas × maxFeePerGas + value. Reserved against the sender's balance. */
  maxCost: bigint;
  status: InFlightStatus;
  firstRelayedAt: number;
  relayedAt: number;
  relayCount: number;
  parentTxHash?: Hex;
  /** HyperEVM receipt of the relay tx, once seen. */
  parentStatus?: 'success' | 'reverted';
  parentGasCostWei?: string;
  /** Set once the "not included after N minutes" warning was logged, so it fires once per relay. */
  stuckWarnedAt?: number;
}

export interface CompletedEntry {
  hash: Hex;
  sender: Address;
  nonce: number;
  parentTxHash?: Hex;
  parentStatus?: 'success' | 'reverted';
  parentGasCostWei?: string;
  relayedAt: number;
  firstRelayedAt: number;
  completedAt: number;
  outcome: 'mined' | 'dropped' | 'relay-failed' | 'expired';
  l2Status?: 'success' | 'reverted';
  l2BlockNumber?: string;
  inclusionLatencyMs?: number;
  detail?: string;
}

export type DedupeDecision =
  | { action: 'new' }
  /** Already relayed recently (or already mined): return the same hash, do not relay. */
  | { action: 'duplicate' }
  /** Relayed but unconfirmed for longer than the window: relay the same message again. */
  | { action: 'resend'; entry: InFlightEntry };

const COMPLETED_RETENTION_MS = 30 * 60_000;
const COMPLETED_MAX = 5000;

/**
 * Tracks transactions we relayed and have not yet seen on L2.
 *
 * Pending-nonce math: next nonce = upstream `latest` count + number of our in-flight txs for that
 * sender whose nonce is still >= `latest`. Entries below `latest` are already consumed on L2 (mined
 * but not yet pruned by the receipt poller, or superseded) and must not be counted twice.
 */
export class InFlightStore {
  private readonly byHash = new Map<Hex, InFlightEntry>();
  private readonly completed = new Map<Hex, CompletedEntry>();
  private readonly latencies: number[] = [];
  lastRelayAt?: number;

  constructor(private readonly stateFile?: string) {}

  get size(): number {
    return this.byHash.size;
  }

  entries(): InFlightEntry[] {
    return [...this.byHash.values()];
  }

  get(hash: Hex): InFlightEntry | undefined {
    return this.byHash.get(hash.toLowerCase() as Hex);
  }

  getCompleted(hash: Hex): CompletedEntry | undefined {
    return this.completed.get(hash.toLowerCase() as Hex);
  }

  /** Entries for `sender` still counted toward its pending nonce. */
  pendingFor(sender: Address, latestNonce: number): InFlightEntry[] {
    const s = sender.toLowerCase();
    return this.entries().filter((e) => e.sender.toLowerCase() === s && e.nonce >= latestNonce);
  }

  pendingNonce(sender: Address, latestNonce: number): number {
    return latestNonce + this.pendingFor(sender, latestNonce).length;
  }

  /** Sum of worst-case costs of the sender's still-pending txs (reserved against its balance). */
  reservedCost(sender: Address, latestNonce: number): bigint {
    return this.pendingFor(sender, latestNonce).reduce((acc, e) => acc + e.maxCost, 0n);
  }

  dedupe(hash: Hex, now: number, resendAfterMs: number): DedupeDecision {
    const h = hash.toLowerCase() as Hex;
    const c = this.completed.get(h);
    if (c && c.outcome === 'mined') return { action: 'duplicate' };
    const e = this.byHash.get(h);
    if (!e) return { action: 'new' };
    if (e.status === 'relaying') return { action: 'duplicate' };
    if (now - e.relayedAt > resendAfterMs) return { action: 'resend', entry: e };
    return { action: 'duplicate' };
  }

  add(entry: InFlightEntry): void {
    const h = entry.hash.toLowerCase() as Hex;
    this.completed.delete(h);
    this.byHash.set(h, { ...entry, hash: h });
    this.persist();
  }

  update(hash: Hex, patch: Partial<InFlightEntry>): void {
    const h = hash.toLowerCase() as Hex;
    const e = this.byHash.get(h);
    if (!e) return;
    Object.assign(e, patch);
    this.persist();
  }

  markRelayed(hash: Hex, parentTxHash: Hex, at: number): void {
    const e = this.get(hash);
    if (!e) return;
    e.status = 'inflight';
    e.parentTxHash = parentTxHash;
    e.relayedAt = at;
    e.relayCount += 1;
    e.stuckWarnedAt = undefined;
    e.parentStatus = undefined;
    e.parentGasCostWei = undefined;
    this.lastRelayAt = at;
    this.persist();
  }

  /** Removes an in-flight entry and records how it ended. */
  complete(
    hash: Hex,
    outcome: CompletedEntry['outcome'],
    at: number,
    extra: Pick<CompletedEntry, 'l2Status' | 'l2BlockNumber' | 'detail'> = {},
  ): CompletedEntry | undefined {
    const h = hash.toLowerCase() as Hex;
    const e = this.byHash.get(h);
    if (!e) return undefined;
    this.byHash.delete(h);
    const done: CompletedEntry = {
      hash: h,
      sender: e.sender,
      nonce: e.nonce,
      parentTxHash: e.parentTxHash,
      parentStatus: e.parentStatus,
      parentGasCostWei: e.parentGasCostWei,
      relayedAt: e.relayedAt,
      firstRelayedAt: e.firstRelayedAt,
      completedAt: at,
      outcome,
      ...extra,
    };
    if (outcome === 'mined') {
      done.inclusionLatencyMs = at - e.relayedAt;
      this.latencies.push(done.inclusionLatencyMs);
      if (this.latencies.length > 50) this.latencies.shift();
    }
    this.completed.set(h, done);
    this.pruneCompleted(at);
    this.persist();
    return done;
  }

  latencyStats(): { last?: number; avg?: number; samples: number } {
    const n = this.latencies.length;
    if (n === 0) return { samples: 0 };
    return {
      last: this.latencies[n - 1],
      avg: Math.round(this.latencies.reduce((a, b) => a + b, 0) / n),
      samples: n,
    };
  }

  private pruneCompleted(now: number): void {
    for (const [h, c] of this.completed) {
      if (now - c.completedAt > COMPLETED_RETENTION_MS || this.completed.size > COMPLETED_MAX) {
        this.completed.delete(h);
      } else break; // insertion order ≈ completion order
    }
  }

  // ---- persistence: in-flight entries survive restarts so pending nonces stay correct ----

  load(): void {
    if (!this.stateFile) return;
    let text: string;
    try {
      text = readFileSync(this.stateFile, 'utf8');
    } catch {
      return;
    }
    const data = JSON.parse(text) as { inflight?: Array<Record<string, unknown>> };
    for (const raw of data.inflight ?? []) {
      const e = { ...raw, maxCost: BigInt(raw.maxCost as string) } as unknown as InFlightEntry;
      // A 'relaying' entry at shutdown may or may not have reached HyperEVM; keep it as in-flight
      // so its nonce stays reserved. The receipt poller resolves it either way.
      if (e.status === 'relaying') e.status = 'inflight';
      this.byHash.set(e.hash.toLowerCase() as Hex, e);
    }
  }

  private persist(): void {
    if (!this.stateFile) return;
    const body = JSON.stringify(
      { inflight: this.entries(), lastRelayAt: this.lastRelayAt },
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    );
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, this.stateFile);
  }
}

/** Per-key async mutex: serializes validate+reserve for one sender so two concurrent sends cannot take the same nonce. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => next);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

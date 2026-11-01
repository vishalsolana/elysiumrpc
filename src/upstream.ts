import { ErrorCode, RpcError } from './errors.js';
import { log } from './log.js';

export interface JsonRpcErrorObj {
  code: number;
  message: string;
  data?: unknown;
}

export type UpstreamResult = { result: unknown } | { error: JsonRpcErrorObj };

/** Errors that are a property of the request, not of the upstream: never retried elsewhere. */
export function isExecutionRevert(err: JsonRpcErrorObj): boolean {
  return err.code === 3 || /revert/i.test(err.message ?? '');
}

/** JSON-RPC errors that mean "this upstream can't serve you right now": fall back to the next one. */
export function isRetryableRpcError(err: JsonRpcErrorObj): boolean {
  if (isExecutionRevert(err)) return false;
  if (err.code === ErrorCode.LimitExceeded) return true; // -32005 rate limited
  if (err.code === -32002 || err.code === ErrorCode.Internal) return true; // resource unavailable / internal
  return /rate.?limit|too many requests|capacity|timeout|timed out|unavailable|exceeded/i.test(err.message ?? '');
}

interface UpstreamStat {
  url: string;
  ok: number;
  failed: number;
  lastError?: string;
  lastErrorAt?: number;
}

type FetchFn = typeof fetch;

/** Proxies JSON-RPC calls to an ordered list of upstreams, with per-call timeout and fallback. */
export class UpstreamPool {
  private readonly stats: UpstreamStat[];
  private nextId = 1;

  constructor(
    readonly urls: string[],
    private readonly timeoutMs: number,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    if (urls.length === 0) throw new Error('UpstreamPool needs at least one URL');
    this.stats = urls.map((url) => ({ url, ok: 0, failed: 0 }));
  }

  /** Sends one call to a single upstream. Throws on transport-level failure. */
  async callOne(url: string, method: string, params: unknown[]): Promise<UpstreamResult> {
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    const body = (await res.json()) as { result?: unknown; error?: JsonRpcErrorObj };
    if (body && typeof body === 'object' && body.error) return { error: body.error };
    if (body && typeof body === 'object' && 'result' in body) return { result: body.result };
    throw new Error('malformed JSON-RPC response');
  }

  /**
   * Tries upstreams in order. Falls back on timeouts, HTTP errors and rate limits; returns the first
   * definitive answer (a result, or a non-retryable JSON-RPC error such as an execution revert).
   */
  async request(method: string, params: unknown[] = []): Promise<UpstreamResult> {
    let lastErr: JsonRpcErrorObj | undefined;
    let lastMsg = 'no upstreams';
    for (let i = 0; i < this.urls.length; i++) {
      const url = this.urls[i]!;
      const stat = this.stats[i]!;
      try {
        const out = await this.callOne(url, method, params);
        if ('error' in out && isRetryableRpcError(out.error)) {
          lastErr = out.error;
          lastMsg = `rpc error ${out.error.code}: ${out.error.message}`;
          this.fail(stat, lastMsg, method);
          continue;
        }
        stat.ok++;
        return out;
      } catch (e) {
        lastMsg = describe(e, this.timeoutMs);
        this.fail(stat, lastMsg, method);
      }
    }
    return {
      error: lastErr ?? { code: ErrorCode.Internal, message: `all upstreams failed (last: ${lastMsg})` },
    };
  }

  /** Like request() but unwraps the result, throwing RpcError on error. */
  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const out = await this.request(method, params);
    if ('error' in out) throw new RpcError(out.error.code, out.error.message, out.error.data);
    return out.result as T;
  }

  /** Block height per upstream, for /health. */
  async heights(): Promise<Array<{ url: string; blockNumber?: number; latencyMs?: number; error?: string }>> {
    return Promise.all(
      this.urls.map(async (url) => {
        const t0 = Date.now();
        try {
          const out = await this.callOne(url, 'eth_blockNumber', []);
          if ('error' in out) return { url: redact(url), error: out.error.message };
          return { url: redact(url), blockNumber: Number(out.result as string), latencyMs: Date.now() - t0 };
        } catch (e) {
          return { url: redact(url), error: describe(e, this.timeoutMs) };
        }
      }),
    );
  }

  statsSnapshot(): UpstreamStat[] {
    return this.stats.map((s) => ({ ...s, url: redact(s.url) }));
  }

  private fail(stat: UpstreamStat, msg: string, method: string): void {
    stat.failed++;
    stat.lastError = msg;
    stat.lastErrorAt = Date.now();
    log.debug('upstream failed, falling back', { upstream: redact(stat.url), method, error: msg });
  }
}

function describe(e: unknown, timeoutMs: number): string {
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return `timeout after ${timeoutMs}ms`;
  return e instanceof Error ? e.message : String(e);
}

/** Hides API keys embedded in upstream URL paths/queries when reporting. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.length > 1 ? '/…' : ''}`;
  } catch {
    return '<invalid url>';
  }
}

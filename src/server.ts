import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { formatEther, getAddress, isAddress, isHex, toHex, type Address, type Hex } from 'viem';
import { ErrorCode, RpcError } from './errors.js';
import { log } from './log.js';
import type { Monitor } from './monitor.js';
import type { RelayService } from './service.js';
import type { UpstreamPool } from './upstream.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_BATCH = 200;

/** Methods that would need a key on our side. We never handle user keys. */
const REFUSED = new Set([
  'eth_sendTransaction',
  'eth_sign',
  'eth_signTransaction',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'personal_sign',
  'personal_sendTransaction',
  'personal_unlockAccount',
  'personal_importRawKey',
]);

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string; data?: unknown } };

export interface ServerDeps {
  service: RelayService;
  upstream: UpstreamPool;
  monitor?: Monitor;
  l2ChainId: number;
  apiKey?: string;
  relayerAddress: Address;
  inbox: Address;
  relayerBalanceWarnWei: bigint;
}

export class RpcHandler {
  constructor(private readonly d: ServerDeps) {}

  async handleBody(body: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(body)) {
      if (body.length === 0) return errResp(null, new RpcError(ErrorCode.InvalidRequest, 'empty batch'));
      if (body.length > MAX_BATCH) return errResp(null, new RpcError(ErrorCode.InvalidRequest, `batch too large (max ${MAX_BATCH})`));
      const out = await Promise.all(body.map((r) => this.handleOne(r as JsonRpcRequest)));
      const filtered = out.filter((r): r is JsonRpcResponse => r !== null);
      return filtered.length ? filtered : null;
    }
    return this.handleOne(body as JsonRpcRequest);
  }

  async handleOne(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    if (!req || typeof req !== 'object' || typeof req.method !== 'string') {
      return errResp(req?.id ?? null, new RpcError(ErrorCode.InvalidRequest, 'invalid request'));
    }
    const isNotification = !('id' in req);
    const id = req.id ?? null;
    const params = req.params === undefined ? [] : req.params;
    if (!Array.isArray(params)) return errResp(id, new RpcError(ErrorCode.InvalidParams, 'params must be an array'));

    let resp: JsonRpcResponse;
    try {
      resp = { jsonrpc: '2.0', id, result: await this.dispatch(req.method, params) };
    } catch (e) {
      if (e instanceof RpcError) resp = errResp(id, e);
      else {
        log.error('unhandled error', { method: req.method, error: (e as Error).message });
        resp = errResp(id, new RpcError(ErrorCode.Internal, 'internal error'));
      }
    }
    return isNotification ? null : resp;
  }

  private async dispatch(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case 'eth_sendRawTransaction':
        return this.d.service.sendRawTransaction(params[0]);

      case 'eth_getTransactionCount': {
        const [addr, tag] = params;
        if (tag === 'pending') {
          if (typeof addr !== 'string' || !isAddress(addr, { strict: false })) {
            throw new RpcError(ErrorCode.InvalidParams, 'invalid address');
          }
          return toHex(await this.d.service.pendingNonce(getAddress(addr)));
        }
        break; // other tags: proxy
      }

      case 'eth_chainId':
        return toHex(this.d.l2ChainId);
      case 'net_version':
        return String(this.d.l2ChainId);
      case 'eth_accounts':
        return [];
    }

    if (REFUSED.has(method)) {
      throw new RpcError(ErrorCode.MethodNotFound, `${method} is not supported: this node only accepts already-signed transactions`);
    }

    const out = await this.d.upstream.request(method, params);
    if ('error' in out) throw new RpcError(out.error.code, out.error.message, out.error.data);
    return out.result;
  }

  async health(): Promise<Record<string, unknown>> {
    const m = this.d.monitor;
    const inflight = this.d.service.inflight;
    const now = Date.now();
    const oldest = inflight.entries().reduce<number | undefined>((acc, e) => (acc === undefined || e.relayedAt < acc ? e.relayedAt : acc), undefined);
    const upstreams = await this.d.upstream.heights();
    const lat = inflight.latencyStats();
    const balanceLow = m?.relayerBalance !== undefined && m.relayerBalance < this.d.relayerBalanceWarnWei;
    const healthy = this.d.service.relayEnabled && !balanceLow && upstreams.some((u) => u.blockNumber !== undefined);
    return {
      ok: healthy,
      chainId: this.d.l2ChainId,
      relayEnabled: this.d.service.relayEnabled,
      relayDisabledReason: this.d.service.relayDisabledReason,
      upstreams,
      upstreamStats: this.d.upstream.statsSnapshot(),
      relayer: {
        address: this.d.relayerAddress,
        balanceHype: m?.relayerBalance !== undefined ? formatEther(m.relayerBalance) : null,
        balanceCheckedAt: m?.relayerBalanceAt ? new Date(m.relayerBalanceAt).toISOString() : null,
        low: balanceLow,
      },
      inbox: {
        address: this.d.inbox,
        bridge: m?.lastInboxReport?.bridge,
        delayedBacklog: m?.lastInboxReport?.delayedBacklog?.toString(),
        l2DelayedBacklog: m?.lastInboxReport?.l2Backlog?.toString(),
        lastCheckedAt: m?.lastInboxCheckAt ? new Date(m.lastInboxCheckAt).toISOString() : null,
      },
      inflight: {
        count: inflight.size,
        oldestAgeSec: oldest !== undefined ? Math.round((now - oldest) / 1000) : null,
      },
      lastRelayAt: inflight.lastRelayAt ? new Date(inflight.lastRelayAt).toISOString() : null,
      inclusionLatencyMs: { last: lat.last ?? null, avg: lat.avg ?? null, samples: lat.samples },
    };
  }

  txStatus(hash: Hex): Record<string, unknown> | null {
    const e = this.d.service.inflight.get(hash);
    if (e) return { state: e.status, ...e, raw: undefined, maxCost: e.maxCost.toString() };
    const c = this.d.service.inflight.getCompleted(hash);
    return c ? { state: c.outcome, ...c } : null;
  }

  authorized(req: IncomingMessage, url: URL): boolean {
    if (!this.d.apiKey) return true;
    const auth = req.headers.authorization;
    const supplied =
      (req.headers['x-api-key'] as string | undefined) ??
      (auth?.startsWith('Bearer ') ? auth.slice(7) : undefined) ??
      url.searchParams.get('apikey') ??
      undefined;
    if (!supplied) return false;
    const a = Buffer.from(supplied);
    const b = Buffer.from(this.d.apiKey);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

function errResp(id: string | number | null, e: RpcError): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: e.toJSON() };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RpcError(ErrorCode.InvalidRequest, 'request body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createRpcServer(handler: RpcHandler): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        const h = await handler.health();
        return send(res, h.ok ? 200 : 503, h);
      }
      if (!handler.authorized(req, url)) {
        return send(res, 401, { jsonrpc: '2.0', id: null, error: { code: ErrorCode.Unauthorized, message: 'unauthorized' } });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/tx/')) {
        const hash = url.pathname.slice(4);
        if (!isHex(hash) || hash.length !== 66) return send(res, 400, { error: 'bad hash' });
        const s = handler.txStatus(hash);
        return send(res, s ? 200 : 404, s ?? { error: 'unknown hash' });
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'POST JSON-RPC to /' });

      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        const err = e instanceof RpcError ? e : new RpcError(ErrorCode.ParseError, 'parse error');
        return send(res, 200, errResp(null, err));
      }
      const out = await handler.handleBody(body);
      if (out === null) {
        res.writeHead(204).end();
        return;
      }
      send(res, 200, out);
    } catch (e) {
      log.error('request handling failed', { error: (e as Error).message });
      if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', id: null, error: { code: ErrorCode.Internal, message: 'internal error' } });
    }
  });
}

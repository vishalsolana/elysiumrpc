import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { keccak256, parseEther } from 'viem';
import { InFlightStore } from '../src/inflight.js';
import { createRpcServer, RpcHandler } from '../src/server.js';
import { RelayService } from '../src/service.js';
import { UpstreamPool } from '../src/upstream.js';
import { account, CHAIN_ID, FakeRelayer, FakeState, signTx } from './helpers.js';

describe('HTTP JSON-RPC server', () => {
  let server: Server;
  let url: string;
  const state = new FakeState();
  const relayer = new FakeRelayer();
  const upstreamCalls: string[] = [];

  beforeAll(async () => {
    state.fund(account.address, parseEther('1'));
    state.setNonce(account.address, 4);
    const fetchFn = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(init.body as string);
      upstreamCalls.push(b.method);
      return Response.json({ jsonrpc: '2.0', id: b.id, result: b.method === 'eth_getTransactionCount' ? '0x4' : '0xabc' });
    }) as unknown as typeof fetch;
    const upstream = new UpstreamPool(['http://up'], 1000, fetchFn);
    const service = new RelayService({ l2ChainId: CHAIN_ID, maxTxBytes: 131072, dedupeWindowMs: 120_000 }, state, new InFlightStore(), relayer);
    const handler = new RpcHandler({
      service,
      upstream,
      l2ChainId: CHAIN_ID,
      apiKey: 'secret',
      relayerAddress: relayer.address,
      inbox: '0x0000000000000000000000000000000000000001',
      relayerBalanceWarnWei: 0n,
    });
    server = createRpcServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const post = (body: unknown, key = 'secret') =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body) });

  it('requires the API key', async () => {
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, 'wrong')).status).toBe(401);
  });

  it('handles a batch: local chainId, proxied call, send, pending nonce', async () => {
    const raw = await signTx({ nonce: 4 });
    const res = await post([
      { jsonrpc: '2.0', id: 1, method: 'eth_chainId' },
      { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber' },
      { jsonrpc: '2.0', id: 3, method: 'eth_sendRawTransaction', params: [raw] },
    ]);
    const out = (await res.json()) as Array<{ id: number; result?: unknown; error?: unknown }>;
    expect(out.find((r) => r.id === 1)?.result).toBe('0x1863d');
    expect(out.find((r) => r.id === 2)?.result).toBe('0xabc');
    expect(out.find((r) => r.id === 3)?.result).toBe(keccak256(raw));

    const n = (await (await post({ jsonrpc: '2.0', id: 4, method: 'eth_getTransactionCount', params: [account.address, 'pending'] })).json()) as { result: string };
    expect(n.result).toBe('0x5');
  });

  it('returns standard JSON-RPC errors', async () => {
    const out = (await (await post({ jsonrpc: '2.0', id: 9, method: 'eth_sendRawTransaction', params: [await signTx({ nonce: 1 })] })).json()) as {
      error: { code: number; message: string };
    };
    expect(out.error.code).toBe(-32000);
    expect(out.error.message).toMatch(/^nonce too low/);
  });

  it('refuses key-handling methods without forwarding them', async () => {
    const before = upstreamCalls.length;
    const out = (await (await post({ jsonrpc: '2.0', id: 5, method: 'eth_sendTransaction', params: [{}] })).json()) as { error: { code: number } };
    expect(out.error.code).toBe(-32601);
    expect(upstreamCalls.length).toBe(before);
  });
});

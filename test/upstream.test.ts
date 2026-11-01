import { describe, expect, it } from 'vitest';
import { UpstreamPool } from '../src/upstream.js';

type Behaviour = (body: { method: string; id: number }) => Promise<Response> | Response;

function fakeFetch(map: Record<string, Behaviour>) {
  const calls: string[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push(url);
    const body = JSON.parse(init.body as string);
    const b = map[url];
    if (!b) throw new Error('ECONNREFUSED');
    return new Promise<Response>((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
      Promise.resolve(b(body)).then(resolve, reject);
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = (result: unknown) => (b: { id: number }) => Response.json({ jsonrpc: '2.0', id: b.id, result });
const rpcErr = (code: number, message: string) => (b: { id: number }) => Response.json({ jsonrpc: '2.0', id: b.id, error: { code, message } });

describe('UpstreamPool fallback', () => {
  it('uses the first upstream when healthy', async () => {
    const { fn, calls } = fakeFetch({ 'http://a': ok('0x1'), 'http://b': ok('0x2') });
    const p = new UpstreamPool(['http://a', 'http://b'], 1000, fn);
    expect(await p.call('eth_blockNumber')).toBe('0x1');
    expect(calls).toEqual(['http://a']);
  });

  it('falls back on timeout', async () => {
    const { fn, calls } = fakeFetch({ 'http://a': () => new Promise(() => {}), 'http://b': ok('0x2') });
    const p = new UpstreamPool(['http://a', 'http://b'], 50, fn);
    expect(await p.call('eth_blockNumber')).toBe('0x2');
    expect(calls).toEqual(['http://a', 'http://b']);
  });

  it('falls back on HTTP errors (429/5xx) and network errors', async () => {
    const { fn, calls } = fakeFetch({ 'http://a': () => new Response('slow down', { status: 429 }), 'http://c': ok('0x3') });
    const p = new UpstreamPool(['http://a', 'http://b', 'http://c'], 1000, fn);
    expect(await p.call('eth_blockNumber')).toBe('0x3');
    expect(calls).toEqual(['http://a', 'http://b', 'http://c']);
  });

  it('falls back on JSON-RPC rate limit -32005', async () => {
    const { fn } = fakeFetch({ 'http://a': rpcErr(-32005, 'limit exceeded'), 'http://b': ok('0x2') });
    expect(await new UpstreamPool(['http://a', 'http://b'], 1000, fn).call('eth_getLogs', [{}])).toBe('0x2');
  });

  it('never retries execution reverts', async () => {
    const { fn, calls } = fakeFetch({ 'http://a': rpcErr(3, 'execution reverted: nope'), 'http://b': ok('0x') });
    const out = await new UpstreamPool(['http://a', 'http://b'], 1000, fn).request('eth_call', [{}, 'latest']);
    expect(out).toEqual({ error: { code: 3, message: 'execution reverted: nope' } });
    expect(calls).toEqual(['http://a']);
  });

  it('does not retry reverts reported with -32000 either', async () => {
    const { fn, calls } = fakeFetch({ 'http://a': rpcErr(-32000, 'execution reverted'), 'http://b': ok('0x') });
    await new UpstreamPool(['http://a', 'http://b'], 1000, fn).request('eth_estimateGas', [{}]);
    expect(calls).toEqual(['http://a']);
  });

  it('returns the last retryable error when all upstreams fail', async () => {
    const { fn } = fakeFetch({ 'http://a': rpcErr(-32005, 'rate limited'), 'http://b': rpcErr(-32005, 'rate limited') });
    const out = await new UpstreamPool(['http://a', 'http://b'], 1000, fn).request('eth_blockNumber');
    expect(out).toEqual({ error: { code: -32005, message: 'rate limited' } });
  });
});

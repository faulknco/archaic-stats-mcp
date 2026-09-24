import { describe, it, expect } from 'vitest';
import { handleRequest, type Env } from '../src/index';

const env: Env = { MCP_RATE_LIMITER: { limit: async () => ({ success: true }) } };

describe('router', () => {
  it('answers /health with ok', async () => {
    const res = await handleRequest(new Request('https://stats.archaic.ie/health'), env, {
      fetch: async () => new Response('{"result":[]}', { status: 200 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, upstream: 'ok' });
  });

  it('reports degraded upstream on /health when CSO fails', async () => {
    const res = await handleRequest(new Request('https://stats.archaic.ie/health'), env, {
      fetch: async () => new Response('boom', { status: 503 }),
    });
    expect(await res.json()).toEqual({ ok: true, upstream: 'degraded' });
  });

  it('404s unknown paths', async () => {
    const res = await handleRequest(new Request('https://stats.archaic.ie/nope'), env);
    expect(res.status).toBe(404);
  });
});

describe('landing, mcp, rate limit', () => {
  const env2: Env = { MCP_RATE_LIMITER: { limit: async () => ({ success: true }) } };
  it('serves the landing page', async () => {
    const res = await handleRequest(new Request('https://stats.archaic.ie/'), env2);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Ireland Stats MCP');
    expect(html).toContain('claude mcp add --transport http');
    expect(html).toContain('Co. No. 811858');
  });
  it('answers an MCP initialize on /mcp', async () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
    const res = await handleRequest(new Request('https://stats.archaic.ie/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) }), env2);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
  it('returns 429 when the limiter says no', async () => {
    const limited: Env = { MCP_RATE_LIMITER: { limit: async () => ({ success: false }) } };
    const res = await handleRequest(new Request('https://stats.archaic.ie/mcp', { method: 'POST', body: '{}' }), limited);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
  });
});

describe('health protection', () => {
  it('rate limits /health like /mcp', async () => {
    const limited: Env = { MCP_RATE_LIMITER: { limit: async () => ({ success: false }) } };
    const res = await handleRequest(new Request('https://stats.archaic.ie/health'), limited);
    expect(res.status).toBe(429);
  });
});

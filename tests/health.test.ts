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

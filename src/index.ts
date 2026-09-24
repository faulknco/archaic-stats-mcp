import { createMcpHandler } from '@modelcontextprotocol/server';
import { createServer } from './server';
import { LANDING_HTML } from './landing';

export type RateLimiter = { limit(opts: { key: string }): Promise<{ success: boolean }> };
export type Env = { MCP_RATE_LIMITER: RateLimiter };
export type Deps = { fetch?: typeof fetch };

const NAV_URL = 'https://ws.cso.ie/public/api.jsonrpc';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, mcp-session-id, mcp-protocol-version',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
};

function withCors(res: Response): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

const HEALTH_TTL_MS = 60_000;
let healthCache: { at: number; ok: boolean } | null = null;

async function upstreamOk(fetchImpl: typeof fetch, useCache: boolean): Promise<boolean> {
  if (useCache && healthCache && Date.now() - healthCache.at < HEALTH_TTL_MS) return healthCache.ok;
  try {
    const body = { jsonrpc: '2.0', method: 'PxStat.System.Navigation.Navigation_API.Read', params: { LngIsoCode: 'en' }, id: 1 };
    const r = await fetchImpl(NAV_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cf: { cacheTtl: 60, cacheEverything: true } } as RequestInit);
    healthCache = { at: Date.now(), ok: r.ok };
    return r.ok;
  } catch {
    healthCache = { at: Date.now(), ok: false };
    return false;
  }
}

// One handler for production; tests inject a fetch and get a throwaway handler.
const defaultHandler = createMcpHandler(() => createServer(fetch), { legacy: 'stateless', onerror: (e) => console.error('mcp', e) });

async function rateLimited(request: Request, env: Env): Promise<boolean> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.MCP_RATE_LIMITER.limit({ key: ip });
  return !success;
}

export async function handleRequest(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const fetchImpl = deps.fetch ?? fetch;
  const url = new URL(request.url);

  if (url.pathname === '/health') {
    if (await rateLimited(request, env)) return new Response('Too many requests', { status: 429, headers: { 'retry-after': '60' } });
    const ok = await upstreamOk(fetchImpl, !deps.fetch); // injected fetch = tests: no memoisation
    return Response.json({ ok: true, upstream: ok ? 'ok' : 'degraded' }, { headers: { 'cache-control': 'public, max-age=60' } });
  }
  if (url.pathname === '/' && request.method === 'GET') {
    return new Response(LANDING_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
  }
  if (url.pathname === '/mcp') {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (await rateLimited(request, env)) return withCors(new Response('Too many requests', { status: 429, headers: { 'retry-after': '60' } }));
    const handler = deps.fetch
      ? createMcpHandler(() => createServer(fetchImpl), { legacy: 'stateless', onerror: (e) => console.error('mcp', e) })
      : defaultHandler;
    return withCors(await handler.fetch(request));
  }
  return new Response('Not found', { status: 404 });
}

export default {
  fetch: (request: Request, env: Env) => handleRequest(request, env),
};

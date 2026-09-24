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

async function upstreamOk(fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const body = { jsonrpc: '2.0', method: 'PxStat.System.Navigation.Navigation_API.Read', params: { LngIsoCode: 'en' }, id: 1 };
    const r = await fetchImpl(NAV_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function handleRequest(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const fetchImpl = deps.fetch ?? fetch;
  const url = new URL(request.url);

  if (url.pathname === '/health') {
    const ok = await upstreamOk(fetchImpl);
    return Response.json({ ok: true, upstream: ok ? 'ok' : 'degraded' });
  }
  if (url.pathname === '/' && request.method === 'GET') {
    return new Response(LANDING_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
  }
  if (url.pathname === '/mcp') {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await env.MCP_RATE_LIMITER.limit({ key: ip });
    if (!success) return withCors(new Response('Too many requests', { status: 429, headers: { 'retry-after': '60' } }));
    const handler = createMcpHandler(() => createServer(fetchImpl), { legacy: 'stateless', onerror: (e) => console.error('mcp', e) });
    return withCors(await handler.fetch(request));
  }
  return new Response('Not found', { status: 404 });
}

export default {
  fetch: (request: Request, env: Env) => handleRequest(request, env),
};

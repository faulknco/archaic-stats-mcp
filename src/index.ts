export type RateLimiter = { limit(opts: { key: string }): Promise<{ success: boolean }> };
export type Env = { MCP_RATE_LIMITER: RateLimiter };
export type Deps = { fetch?: typeof fetch };

const NAV_URL = 'https://ws.cso.ie/public/api.jsonrpc';

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
  return new Response('Not found', { status: 404 });
}

export default {
  fetch: (request: Request, env: Env) => handleRequest(request, env),
};

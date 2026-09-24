import { describe, it, expect } from 'vitest';
import meta from './fixtures/EHQ03.metadata.json';
import query from './fixtures/EHQ03.query.json';
import bad from './fixtures/EHQ03.badcode.json';
import search from './fixtures/search.json';
import { createPxStat, PxStatError } from '../src/pxstat';

type Call = { url: string; init?: RequestInit };
function fakeFetch(routes: Array<{ match: (c: Call) => boolean; body: unknown; status?: number }>, calls: Call[] = []) {
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call = { url, init };
    calls.push(call);
    const r = routes.find((x) => x.match(call));
    if (!r) return new Response('NotFound', { status: 404 });
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

describe('createPxStat', () => {
  it('reads metadata via the RESTful URL built from the matrix and sets a cache TTL', async () => {
    const { fetch, calls } = fakeFetch([{ match: (c) => c.url.includes('ReadMetadata/EHQ03/JSON-stat/2.0/en'), body: meta }]);
    const px = createPxStat(fetch);
    const m = await px.metadata('ehq03');
    expect(m.extension.matrix).toBe('EHQ03');
    expect(calls[0].url).toBe('https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadMetadata/EHQ03/JSON-stat/2.0/en');
    expect((calls[0].init as { cf?: { cacheTtl: number } }).cf?.cacheTtl).toBe(21600);
  });

  it('throws unknown_table on 404', async () => {
    const px = createPxStat(fakeFetch([]).fetch);
    await expect(px.metadata('ZZZ99')).rejects.toMatchObject({ kind: 'unknown_table' });
  });

  it('posts a class:query body with dimension filters and returns the dataset', async () => {
    const { fetch, calls } = fakeFetch([{ match: (c) => c.url.endsWith('/api.jsonrpc') && c.init?.method === 'POST', body: query }]);
    const px = createPxStat(fetch);
    const ds = await px.query('EHQ03', { STATISTIC: ['EHQ03C02'], 'TLIST(Q1)': ['20241', '20242'] });
    expect(ds.size).toEqual([1, 2, 21, 4]);
    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent.params.class).toBe('query');
    expect(sent.params.dimension.STATISTIC.category.index).toEqual(['EHQ03C02']);
    expect(sent.params.extension.matrix).toBe('EHQ03');
  });

  it('turns the CSO empty-result shape into unknown_codes', async () => {
    const px = createPxStat(fakeFetch([{ match: (c) => c.url.endsWith('/api.jsonrpc'), body: bad }]).fetch);
    await expect(px.query('EHQ03', { STATISTIC: ['Average Weekly Earnings'] })).rejects.toMatchObject({ kind: 'unknown_codes' });
  });

  it('maps search hits', async () => {
    const px = createPxStat(fakeFetch([{ match: (c) => String(c.init?.body).includes('Navigation_API.Search'), body: search }]).fetch);
    const hits = await px.search('weekly earnings');
    expect(hits.length).toBe(100);
    expect(hits[0].MtrCode).toBe('EHA05');
  });

  it('reports upstream 5xx as upstream errors', async () => {
    const px = createPxStat(fakeFetch([{ match: () => true, body: 'down', status: 503 }]).fetch);
    await expect(px.search('x')).rejects.toBeInstanceOf(PxStatError);
    await expect(px.search('x')).rejects.toMatchObject({ kind: 'upstream' });
  });
});

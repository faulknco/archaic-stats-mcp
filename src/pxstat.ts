import { isEmptyResult, type Dataset, type Filters } from './jsonstat';

export const BASE = 'https://ws.cso.ie/public/';
export const TTL = { data: 3600, metadata: 21600, navigation: 86400, search: 3600, product: 21600, since: 3600 } as const;
const TIMEOUT_MS = 10_000;

export class PxStatError extends Error {
  constructor(public kind: 'unknown_table' | 'unknown_codes' | 'upstream' | 'timeout', message: string) {
    super(message);
    this.name = 'PxStatError';
  }
}

export type SearchHit = { MtrCode: string; MtrTitle: string; ThmValue: string; SbjValue: string; PrcCode: string; PrcValue: string; FrqCode: string; RlsLiveDatetimeFrom: string; period: string[]; classification: Array<{ ClsCode: string; ClsValue: string }> };
export type NavTheme = { ThmCode: string; ThmValue: string; subject: Array<{ SbjCode: string; SbjValue: string; product: Array<{ PrcCode: string; PrcValue: string; PrcReleaseCount: number }> }> };
export type CollectionItem = { label: string; id: string[]; updated: string; extension: { matrix: string } };

type RpcEnvelope<T> = { result?: T; error?: { message?: string } };

export function normaliseMatrix(m: string): string {
  const code = m.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(code)) throw new PxStatError('unknown_table', `"${m}" is not a CSO table code (expected letters and digits, e.g. EHQ03).`);
  return code;
}

export function createPxStat(fetchImpl: typeof fetch = fetch) {
  async function doFetch(url: string, init: RequestInit & { ttl: number }): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const { ttl, ...rest } = init;
      return await fetchImpl(url, { ...rest, signal: controller.signal, cf: { cacheTtl: ttl, cacheEverything: true } } as RequestInit);
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new PxStatError('timeout', 'CSO API timed out, try again shortly.');
      throw new PxStatError('upstream', 'CSO API unavailable, try again shortly.');
    } finally {
      clearTimeout(timer);
    }
  }

  async function rpc<T>(method: string, params: Record<string, unknown>, ttl: number): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 });
    const r = await doFetch(`${BASE}api.jsonrpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, ttl });
    if (!r.ok) throw new PxStatError('upstream', 'CSO API unavailable, try again shortly.');
    const env = (await r.json()) as RpcEnvelope<T>;
    if (env.error) throw new PxStatError('upstream', `CSO API error: ${env.error.message ?? 'unknown'}`);
    if (env.result === undefined || env.result === null) throw new PxStatError('unknown_codes', 'CSO returned no result for that request.');
    return env.result;
  }

  return {
    async search(q: string): Promise<SearchHit[]> {
      const hits = await rpc<unknown>('PxStat.System.Navigation.Navigation_API.Search', { Search: q, LngIsoCode: 'en' }, TTL.search);
      if (!Array.isArray(hits)) throw new PxStatError('upstream', 'CSO search returned an unexpected response, try again shortly.');
      return hits as SearchHit[];
    },
    async navigation(): Promise<NavTheme[]> {
      return rpc<NavTheme[]>('PxStat.System.Navigation.Navigation_API.Read', { LngIsoCode: 'en' }, TTL.navigation);
    },
    async collectionByProduct(code: string): Promise<CollectionItem[]> {
      const res = await rpc<{ link: { item: CollectionItem[] } }>('PxStat.Data.Cube_API.ReadCollection', { language: 'en', product: code }, TTL.product);
      return res.link?.item ?? [];
    },
    async collectionSince(isoDate: string): Promise<CollectionItem[]> {
      const res = await rpc<{ link: { item: CollectionItem[] } }>('PxStat.Data.Cube_API.ReadCollection', { language: 'en', datefrom: isoDate }, TTL.since);
      return res.link?.item ?? [];
    },
    async metadata(matrix: string): Promise<Dataset> {
      const code = normaliseMatrix(matrix);
      const r = await doFetch(`${BASE}api.restful/PxStat.Data.Cube_API.ReadMetadata/${code}/JSON-stat/2.0/en`, { method: 'GET', ttl: TTL.metadata });
      if (r.status === 404) throw new PxStatError('unknown_table', `No CSO table with code ${code}. Use search_tables to find the right code.`);
      if (!r.ok) throw new PxStatError('upstream', 'CSO API unavailable, try again shortly.');
      return (await r.json()) as Dataset;
    },
    async query(matrix: string, filters: Filters): Promise<Dataset> {
      const code = normaliseMatrix(matrix);
      const dimension: Record<string, { category: { index: string[] } }> = {};
      for (const [dim, codes] of Object.entries(filters)) if (codes.length > 0) dimension[dim] = { category: { index: codes } };
      const params = {
        class: 'query',
        id: Object.keys(dimension),
        dimension,
        extension: { codes: false, language: { code: 'en' }, format: { type: 'JSON-stat', version: '2.0' }, matrix: code },
        version: '2.0',
      };
      const ds = await rpc<Dataset>('PxStat.Data.Cube_API.ReadDataset', params, TTL.data);
      if (isEmptyResult(ds)) throw new PxStatError('unknown_codes', 'One or more codes are not valid for this table.');
      return ds;
    },
  };
}
export type PxStat = ReturnType<typeof createPxStat>;

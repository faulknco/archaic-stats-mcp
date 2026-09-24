# Ireland Stats MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `https://stats.archaic.ie/mcp`, a public, read-only, no-auth MCP server over the CSO PxStat API, as one stateless Cloudflare Worker with six tools, a landing page, tests, CI and a live smoke check.

**Architecture:** A Worker routes `/` (landing HTML), `/health`, and `/mcp` (Streamable HTTP via `createMcpHandler`). Tool handlers call a thin typed PxStat client that builds URLs from matrix codes, applies Cache API TTLs through `cf.cacheTtl`, and converts CSO's silent failures into typed errors. Pure modules (`jsonstat.ts`, `format.ts`) do all the shaping and are unit-tested against recorded fixtures; the six tools are integration-tested in-process with an MCP client over an in-memory transport and a mocked `fetch`.

**Tech Stack:** TypeScript, Cloudflare Workers (`wrangler` 4), `@modelcontextprotocol/server` 2.1.x, `@modelcontextprotocol/client` 2.1.x (tests/smoke only), `zod` 4, `vitest`, Node ≥ 22.

**Spec:** `docs/superpowers/specs/2026-09-24-cso-stats-mcp-design.md`

## Global Constraints

- Base host `https://ws.cso.ie/public/`. Never fetch the unfiltered collection. Never follow catalogue `href`s; build URLs from the matrix code.
- Six tools exactly: `search_tables`, `browse_catalog`, `list_tables`, `get_table_metadata`, `query_table`, `recent_updates`. All `annotations: { readOnlyHint: true, idempotentHint: true }`.
- `query_table` default `max_cells` 2000, hard max 5000; compute the cell count from metadata before any data fetch.
- Cache TTLs (seconds): data 3600, metadata 21600, navigation 86400, search 3600, collection-by-product 21600, collection-by-date 3600.
- Attribution string: `Source: Central Statistics Office, Ireland (CC BY 4.0) — https://data.cso.ie/table/<matrix>`.
- Every tool response ≤ ~50 KB of text; truncation is explicit (`truncated: true` + hint), never silent.
- Rate limit `/mcp`: 60 requests / 60 s per client IP → 429 with `Retry-After: 60`.
- Upstream timeout 10 s; upstream failure → tool `isError` "CSO API unavailable, try again shortly", never an unhandled exception.
- No numbers in landing-page copy other than none; company line `Archaic Limited · Registered in Ireland · Co. No. 811858`. Cinzel uppercase.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Work directly on `main` in this new repo (nothing deployed until Task 7). Run `npm test` and `npx tsc --noEmit` before every commit that touches `src/`.
- Exact API facts (verified against the installed packages, 2.1.0): `createMcpHandler(factory: (ctx) => McpServer, { legacy: 'stateless' }) → { fetch(request: Request): Promise<Response> }`; `new McpServer({ name, version })`; `server.registerTool(name, { title, description, inputSchema: z.object({...}), annotations }, async (args) => CallToolResult)`; client: `new Client({ name, version })`, `client.connect(transport)`, `client.callTool({ name, arguments })`, `client.listTools()`; `InMemoryTransport.createLinkedPair()` exists in both packages.
- CSO bad-code behaviour (verified 2026-09-24): a query with a code that does not exist returns HTTP 200 and a dataset whose offending dimension has `category.index: []` and whose `size` contains `0`, with `value: []`. A wholly unknown matrix returns 404. Treat `size` containing 0 (or any empty index) as `unknown_codes`.

---

## File map

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts` | Project scaffold |
| `src/index.ts` | Worker entry: routing, CORS, rate limit, `/health`, `/`, `/mcp` |
| `src/server.ts` | `createServer(fetchImpl)` registering the six tools |
| `src/pxstat.ts` | Typed PxStat client + `PxStatError` |
| `src/jsonstat.ts` | Pure JSON-stat helpers: cell counting, flattening, time labels, BBCode stripping |
| `src/format.ts` | Pure output shaping: metadata summary, rows → text table, truncation, attribution |
| `src/landing.ts` | Landing page HTML string |
| `tests/fixtures/*.json` | Recorded CSO responses (EHQ03 metadata, filtered query, bad-code query, search, navigation, ELCQ collection) |
| `tests/jsonstat.test.ts`, `tests/format.test.ts`, `tests/pxstat.test.ts`, `tests/tools.test.ts` | Unit + in-process integration tests |
| `scripts/smoke.mjs` | Live check over HTTP through the real MCP client |
| `.github/workflows/ci.yml`, `.github/dependabot.yml`, `README.md`, `LICENSE`, `server.json` | CI, hygiene, registry manifest |

---

### Task 1: Scaffold and a Worker that answers `/health`

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `.gitignore`, `src/index.ts`, `tests/health.test.ts`

**Interfaces:**
- Produces: `export default { fetch(request: Request, env: Env): Promise<Response> }` in `src/index.ts`; `export type Env = { MCP_RATE_LIMITER: { limit(o: { key: string }): Promise<{ success: boolean }> } }`; `export function handleRequest(request: Request, env: Env, deps?: { fetch?: typeof fetch }): Promise<Response>` (the testable router).

- [ ] **Step 1: Create the scaffold files**

```bash
cd /Users/faulknco/Projects/archaic-stats-mcp
cat > package.json <<'EOF'
{
  "name": "archaic-stats-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Public, read-only MCP server over Ireland's CSO PxStat statistics API.",
  "license": "MIT",
  "engines": { "node": ">=22.12.0" },
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "smoke": "node scripts/smoke.mjs"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^2.1.0",
    "zod": "^4.1.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260901.0",
    "@modelcontextprotocol/client": "^2.1.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0",
    "wrangler": "^4.115.0"
  }
}
EOF
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src", "tests"]
}
EOF
cat > wrangler.jsonc <<'EOF'
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "archaic-stats-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-11",
  "routes": [{ "pattern": "stats.archaic.ie", "custom_domain": true }],
  "observability": { "logs": { "enabled": true } },
  "ratelimits": [
    { "name": "MCP_RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 60, "period": 60 } }
  ]
}
EOF
cat > vitest.config.ts <<'EOF'
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
EOF
printf 'node_modules/\ndist/\n.wrangler/\n.dev.vars\n' > .gitignore
npm install 2>&1 | tail -2
```

- [ ] **Step 2: Write the failing health test**

`tests/health.test.ts`:

```ts
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
```

- [ ] **Step 3: Run it to see it fail**

Run: `npm test`
Expected: FAIL, cannot resolve `../src/index`.

- [ ] **Step 4: Write the minimal router**

`src/index.ts`:

```ts
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
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: 3 passing, no type errors.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "scaffold: worker, vitest, wrangler config, /health

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: JSON-stat helpers (pure, TDD on fixtures)

**Files:**
- Create: `tests/fixtures/EHQ03.metadata.json`, `tests/fixtures/EHQ03.query.json`, `tests/fixtures/EHQ03.badcode.json`, `tests/fixtures/search.json`, `tests/fixtures/navigation.json`, `tests/fixtures/collection.ELCQ.json` (copy from `/private/tmp/claude-501/-Users-faulknco/311aaaba-641a-4bd2-a897-96efbb4ad18f/scratchpad/fixtures/` or re-record with the curl commands in the spec's facts section), `src/jsonstat.ts`, `tests/jsonstat.test.ts`

**Interfaces:**
- Produces (all exported from `src/jsonstat.ts`):
  - `type Dataset = { class: string; label: string; id: string[]; size: number[]; role?: { time?: string[]; metric?: string[] }; dimension: Record<string, { label: string; category: { index: string[]; label: Record<string, string>; unit?: Record<string, { label: string; decimals: number }> } }>; value?: (number | null)[]; extension: { matrix: string; elimination?: Record<string, string>; subject?: { code: number; value: string }; product?: { code: string; value: string }; contact?: { name: string; email: string; phone?: string }; copyright?: { name: string; href: string } }; note?: string[]; updated: string }`
  - `type Filters = Record<string, string[]>`
  - `cellCount(meta: Dataset, filters: Filters): number`
  - `widestDimensions(meta: Dataset, filters: Filters, n = 3): Array<{ id: string; label: string; size: number }>`
  - `flatten(ds: Dataset): Array<Record<string, string | number | null>>` — one object per cell, keys = dimension labels, plus `value`
  - `timeDimension(meta: Dataset): string | undefined` — the id starting with `TLIST(`
  - `lastN(meta: Dataset, n: number): string[]` — the last n time codes
  - `stripBBCode(s: string): string`
  - `unknownCodes(meta: Dataset, filters: Filters): Array<{ dimension: string; code: string }>`
  - `isEmptyResult(ds: Dataset): boolean` — true when `size` contains 0

- [ ] **Step 1: Copy fixtures**

```bash
mkdir -p tests/fixtures
cp /private/tmp/claude-501/-Users-faulknco/311aaaba-641a-4bd2-a897-96efbb4ad18f/scratchpad/fixtures/*.json tests/fixtures/
ls -la tests/fixtures
```

Expected: six files, EHQ03.metadata.json ≈ 9 KB, search.json ≈ 100 KB.

- [ ] **Step 2: Write the failing tests**

`tests/jsonstat.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import meta from './fixtures/EHQ03.metadata.json';
import query from './fixtures/EHQ03.query.json';
import bad from './fixtures/EHQ03.badcode.json';
import { cellCount, widestDimensions, flatten, timeDimension, lastN, stripBBCode, unknownCodes, isEmptyResult, type Dataset } from '../src/jsonstat';

const m = meta as unknown as Dataset;
const q = (query as { result: Dataset }).result;
const b = (bad as { result: Dataset }).result;

describe('cellCount', () => {
  it('is the product of sizes with no filters', () => {
    expect(cellCount(m, {})).toBe(21 * 74 * 21 * 4);
  });
  it('multiplies filtered category counts', () => {
    expect(cellCount(m, { STATISTIC: ['EHQ03C02'], 'TLIST(Q1)': ['20241', '20242'] })).toBe(1 * 2 * 21 * 4);
  });
});

describe('widestDimensions', () => {
  it('ranks unfiltered dimensions by size', () => {
    const w = widestDimensions(m, { STATISTIC: ['EHQ03C02'] }, 2);
    expect(w.map((d) => d.id)).toEqual(['TLIST(Q1)', 'C02665V03225']);
    expect(w[0]).toMatchObject({ label: 'Quarter', size: 74 });
  });
});

describe('flatten', () => {
  it('yields one row per cell in row-major order with labels', () => {
    const rows = flatten(q);
    expect(rows).toHaveLength(168);
    expect(rows[0]).toMatchObject({ Statistic: 'Average Weekly Earnings', Quarter: '2024Q1', 'Economic Sector NACE Rev 2': 'All NACE economic sectors', 'Type of Employee': 'All employees', value: 972.2 });
    expect(rows[1].value).toBeNull();
  });
});

describe('time helpers', () => {
  it('finds the time dimension and the last n codes', () => {
    expect(timeDimension(m)).toBe('TLIST(Q1)');
    expect(lastN(m, 2)).toEqual(['20261', '20262']);
  });
});

describe('stripBBCode', () => {
  it('turns [url=x]y[/url] into "y (x)" and collapses CRLF', () => {
    expect(stripBBCode('See [url=https://a.b/c]note[/url].\r\n\r\nMore')).toBe('See note (https://a.b/c).\n\nMore');
  });
});

describe('unknownCodes / isEmptyResult', () => {
  it('lists codes absent from metadata', () => {
    expect(unknownCodes(m, { STATISTIC: ['Average Weekly Earnings', 'EHQ03C02'], NOPE: ['x'] })).toEqual([
      { dimension: 'STATISTIC', code: 'Average Weekly Earnings' },
      { dimension: 'NOPE', code: 'x' },
    ]);
  });
  it('detects the CSO empty-result shape', () => {
    expect(isEmptyResult(b)).toBe(true);
    expect(isEmptyResult(q)).toBe(false);
  });
});
```

- [ ] **Step 3: Run to see it fail**

Run: `npm test -- tests/jsonstat.test.ts`
Expected: FAIL, cannot resolve `../src/jsonstat`.

- [ ] **Step 4: Implement**

`src/jsonstat.ts`:

```ts
export type Category = { index: string[]; label: Record<string, string>; unit?: Record<string, { label: string; decimals: number }> };
export type Dimension = { label: string; category: Category };
export type Dataset = {
  class: string;
  label: string;
  id: string[];
  size: number[];
  role?: { time?: string[]; metric?: string[] };
  dimension: Record<string, Dimension>;
  value?: (number | null)[];
  extension: {
    matrix: string;
    elimination?: Record<string, string>;
    subject?: { code: number; value: string };
    product?: { code: string; value: string };
    contact?: { name: string; email: string; phone?: string };
    copyright?: { name: string; href: string };
  };
  note?: string[];
  updated: string;
};
export type Filters = Record<string, string[]>;

function filteredSize(meta: Dataset, filters: Filters, id: string, i: number): number {
  const f = filters[id];
  return f && f.length > 0 ? f.length : meta.size[i];
}

export function cellCount(meta: Dataset, filters: Filters): number {
  return meta.id.reduce((acc, id, i) => acc * filteredSize(meta, filters, id, i), 1);
}

export function widestDimensions(meta: Dataset, filters: Filters, n = 3): Array<{ id: string; label: string; size: number }> {
  return meta.id
    .map((id, i) => ({ id, label: meta.dimension[id].label, size: filteredSize(meta, filters, id, i) }))
    .filter((d) => d.size > 1)
    .sort((a, b) => b.size - a.size)
    .slice(0, n);
}

export function flatten(ds: Dataset): Array<Record<string, string | number | null>> {
  const values = ds.value ?? [];
  const dims = ds.id.map((id) => ({ label: ds.dimension[id].label, codes: ds.dimension[id].category.index, labels: ds.dimension[id].category.label }));
  const rows: Array<Record<string, string | number | null>> = [];
  const idx = new Array(dims.length).fill(0);
  for (let cell = 0; cell < values.length; cell++) {
    const row: Record<string, string | number | null> = {};
    let rem = cell;
    for (let d = dims.length - 1; d >= 0; d--) {
      const size = ds.size[d];
      idx[d] = rem % size;
      rem = Math.floor(rem / size);
    }
    dims.forEach((dim, d) => { const code = dim.codes[idx[d]]; row[dim.label] = dim.labels[code] ?? code; });
    row.value = values[cell];
    rows.push(row);
  }
  return rows;
}

export function timeDimension(meta: Dataset): string | undefined {
  return meta.role?.time?.[0] ?? meta.id.find((id) => id.startsWith('TLIST('));
}

export function lastN(meta: Dataset, n: number): string[] {
  const t = timeDimension(meta);
  if (!t) return [];
  const codes = meta.dimension[t].category.index;
  return codes.slice(Math.max(0, codes.length - n));
}

export function stripBBCode(s: string): string {
  return s
    .replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/g, '$2 ($1)')
    .replace(/\[\/?[a-z]+(?:=[^\]]+)?\]/g, '')
    .replace(/\r\n/g, '\n');
}

export function unknownCodes(meta: Dataset, filters: Filters): Array<{ dimension: string; code: string }> {
  const out: Array<{ dimension: string; code: string }> = [];
  for (const [dim, codes] of Object.entries(filters)) {
    const cat = meta.dimension[dim]?.category;
    for (const code of codes) if (!cat || !(code in cat.label)) out.push({ dimension: dim, code });
  }
  return out;
}

export function isEmptyResult(ds: Dataset): boolean {
  return ds.size.some((s) => s === 0) || ds.id.some((id) => ds.dimension[id]?.category.index.length === 0);
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/jsonstat.test.ts && npm run typecheck`
Expected: all passing. If `resolveJsonModule` complains about the fixture import type, the `as unknown as Dataset` casts in the test cover it.

- [ ] **Step 6: Commit**

```bash
git add src/jsonstat.ts tests/jsonstat.test.ts tests/fixtures
git commit -m "jsonstat: cell counting, flattening, time helpers, bad-code detection (fixture-tested)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: PxStat client

**Files:**
- Create: `src/pxstat.ts`, `tests/pxstat.test.ts`

**Interfaces:**
- Consumes: `Dataset`, `Filters`, `isEmptyResult` from `src/jsonstat.ts`.
- Produces (from `src/pxstat.ts`):
  - `class PxStatError extends Error { kind: 'unknown_table' | 'unknown_codes' | 'upstream' | 'timeout' }`
  - `type SearchHit = { MtrCode: string; MtrTitle: string; ThmValue: string; SbjValue: string; PrcCode: string; PrcValue: string; FrqCode: string; RlsLiveDatetimeFrom: string; period: string[]; classification: Array<{ ClsCode: string; ClsValue: string }> }`
  - `type NavTheme = { ThmCode: string; ThmValue: string; subject: Array<{ SbjCode: string; SbjValue: string; product: Array<{ PrcCode: string; PrcValue: string; PrcReleaseCount: number }> }> }`
  - `type CollectionItem = { label: string; id: string[]; updated: string; extension: { matrix: string } }`
  - `createPxStat(fetchImpl: typeof fetch = fetch): { search(q: string): Promise<SearchHit[]>; navigation(): Promise<NavTheme[]>; collectionByProduct(code: string): Promise<CollectionItem[]>; collectionSince(isoDate: string): Promise<CollectionItem[]>; metadata(matrix: string): Promise<Dataset>; query(matrix: string, filters: Filters): Promise<Dataset> }`
  - `export const TTL = { data: 3600, metadata: 21600, navigation: 86400, search: 3600, product: 21600, since: 3600 }`

- [ ] **Step 1: Write the failing tests (mocked fetch)**

`tests/pxstat.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to see it fail**

Run: `npm test -- tests/pxstat.test.ts`
Expected: FAIL, cannot resolve `../src/pxstat`.

- [ ] **Step 3: Implement**

`src/pxstat.ts`:

```ts
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
      return rpc<SearchHit[]>('PxStat.System.Navigation.Navigation_API.Search', { Search: q, LngIsoCode: 'en' }, TTL.search);
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
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- tests/pxstat.test.ts && npm run typecheck`
Expected: 6 passing. If TypeScript rejects `cf` in `RequestInit`, the `as RequestInit` cast above handles it; if it rejects `AbortSignal` in the fake, cast the fake with `as unknown as typeof fetch` (already done).

- [ ] **Step 5: Commit**

```bash
git add src/pxstat.ts tests/pxstat.test.ts
git commit -m "pxstat: typed client with cache TTLs, timeouts and typed errors

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Output formatting (pure, TDD)

**Files:**
- Create: `src/format.ts`, `tests/format.test.ts`

**Interfaces:**
- Consumes: `Dataset`, `flatten`, `stripBBCode`, `timeDimension` from `src/jsonstat.ts`; `SearchHit`, `NavTheme`, `CollectionItem` from `src/pxstat.ts`.
- Produces (from `src/format.ts`):
  - `attribution(matrix: string): string`
  - `summariseMetadata(meta: Dataset): MetadataSummary` where `MetadataSummary = { matrix; title; updated; frequency: string; total_cells: number; dimensions: Array<{ id; label; role: 'time'|'metric'|'classification'; size: number; total_code?: string; categories: Array<{ code; label }>; categories_truncated?: number }>; notes: string[]; contact?: { name; email }; attribution: string }` (categories capped at 200)
  - `frequencyOf(id: string[]): string` — `TLIST(A1)`→`annual`, `Q1`→`quarterly`, `M1`→`monthly`, `W1`→`weekly`, `D1`→`daily`, `H1`→`census`, else `unknown`
  - `rowsToText(rows: Array<Record<string, string|number|null>>, max = 100): string` — compact pipe table; appends `…and N more rows` when cut
  - `formatQuery(ds: Dataset): { structured: QueryResult; text: string }` where `QueryResult = { matrix; title; rows; cell_count; nulls; unit?: string; updated; attribution }`
  - `formatSearch(hits: SearchHit[], limit: number): { hits: Array<{ matrix; title; theme; subject; product_code; product; frequency; first_period; last_period; dimensions: string[]; updated }>; total_hits: number; truncated: boolean }`
  - `formatCollection(items: CollectionItem[], limit: number): { tables: Array<{ matrix; title; updated; frequency }>; count: number; truncated: boolean }`
  - `formatCatalog(themes: NavTheme[], theme?: string, subject?: string): CatalogResult` where with no args `{ themes: [{ code, name, subjects: number }] }`, with `theme` (code or name, case-insensitive) `{ theme: {code,name}, subjects: [{ code, name, products: [{ code, name, tables }] }] }`, with `subject` `{ subject: {code,name}, products: [...] }`; unknown → `{ error: string }`
  - `capText(text: string, maxBytes = 50_000): { text: string; truncated: boolean }`

- [ ] **Step 1: Write the failing tests**

`tests/format.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import meta from './fixtures/EHQ03.metadata.json';
import query from './fixtures/EHQ03.query.json';
import search from './fixtures/search.json';
import nav from './fixtures/navigation.json';
import coll from './fixtures/collection.ELCQ.json';
import { attribution, summariseMetadata, frequencyOf, rowsToText, formatQuery, formatSearch, formatCollection, formatCatalog, capText } from '../src/format';
import type { Dataset } from '../src/jsonstat';
import type { SearchHit, NavTheme, CollectionItem } from '../src/pxstat';

const m = meta as unknown as Dataset;
const q = (query as { result: Dataset }).result;
const hits = (search as { result: SearchHit[] }).result;
const themes = (nav as { result: NavTheme[] }).result;
const items = (coll as { result: { link: { item: CollectionItem[] } } }).result.link.item;

describe('attribution', () => {
  it('names the CSO, the licence and the table', () => {
    expect(attribution('EHQ03')).toBe('Source: Central Statistics Office, Ireland (CC BY 4.0) — https://data.cso.ie/table/EHQ03');
  });
});

describe('summariseMetadata', () => {
  it('summarises dimensions with roles, totals and capped categories', () => {
    const s = summariseMetadata(m);
    expect(s.matrix).toBe('EHQ03');
    expect(s.frequency).toBe('quarterly');
    expect(s.total_cells).toBe(21 * 74 * 21 * 4);
    const time = s.dimensions.find((d) => d.id === 'TLIST(Q1)')!;
    expect(time.role).toBe('time');
    expect(time.categories[0]).toEqual({ code: '20081', label: '2008Q1' });
    const sector = s.dimensions.find((d) => d.id === 'C02665V03225')!;
    expect(sector.total_code).toBe('-');
    expect(s.notes[0]).not.toContain('[url=');
    expect(s.attribution).toContain('EHQ03');
  });
});

describe('frequencyOf', () => {
  it('maps TLIST kinds', () => {
    expect(frequencyOf(['STATISTIC', 'TLIST(A1)'])).toBe('annual');
    expect(frequencyOf(['TLIST(M1)'])).toBe('monthly');
    expect(frequencyOf(['STATISTIC'])).toBe('unknown');
  });
});

describe('formatQuery + rowsToText', () => {
  it('shapes rows, counts nulls, carries the unit and caps the text', () => {
    const { structured, text } = formatQuery(q);
    expect(structured.cell_count).toBe(168);
    expect(structured.nulls).toBe(168 - 2);
    expect(structured.unit).toBe('Euro');
    expect(structured.rows[0].value).toBe(972.2);
    expect(text).toContain('Average Weekly Earnings');
    expect(text).toContain('…and 68 more rows');
  });
  it('rowsToText renders a header and pipe rows', () => {
    const t = rowsToText([{ A: 'x', value: 1 }, { A: 'y', value: null }]);
    expect(t.split('\n')[0]).toBe('A | value');
    expect(t).toContain('y | null');
  });
});

describe('formatSearch', () => {
  it('trims to limit and flags truncation', () => {
    const r = formatSearch(hits, 5);
    expect(r.hits).toHaveLength(5);
    expect(r.total_hits).toBe(100);
    expect(r.truncated).toBe(true);
    expect(r.hits[0]).toMatchObject({ matrix: 'EHA05', frequency: 'annual', first_period: '2008' });
    expect(r.hits[0].dimensions).toContain('Type of Employment');
  });
});

describe('formatCollection', () => {
  it('lists tables newest first', () => {
    const r = formatCollection(items, 50);
    expect(r.count).toBe(15);
    expect(r.tables[0].matrix).toMatch(/^EH/);
    expect(new Date(r.tables[0].updated) >= new Date(r.tables[1].updated)).toBe(true);
  });
});

describe('formatCatalog', () => {
  it('lists themes, then subjects for a theme, then products for a subject', () => {
    const top = formatCatalog(themes);
    expect('themes' in top && top.themes.length).toBe(9);
    const labour = formatCatalog(themes, 'Labour Market and Earnings');
    expect('subjects' in labour && labour.subjects.some((s) => s.name === 'Earnings')).toBe(true);
    const earnings = formatCatalog(themes, undefined, 'Earnings');
    expect('products' in earnings && earnings.products.some((p) => p.code === 'ELCQ')).toBe(true);
    expect('error' in formatCatalog(themes, 'Nonsense')).toBe(true);
  });
});

describe('capText', () => {
  it('cuts at the byte budget and flags it', () => {
    const r = capText('x'.repeat(60_000), 50_000);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(50_000 + 40);
    expect(capText('short').truncated).toBe(false);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npm test -- tests/format.test.ts`
Expected: FAIL, cannot resolve `../src/format`.

- [ ] **Step 3: Implement**

`src/format.ts`:

```ts
import { flatten, stripBBCode, timeDimension, cellCount, type Dataset } from './jsonstat';
import type { SearchHit, NavTheme, CollectionItem } from './pxstat';

export function attribution(matrix: string): string {
  return `Source: Central Statistics Office, Ireland (CC BY 4.0) — https://data.cso.ie/table/${matrix}`;
}

export function frequencyOf(id: string[]): string {
  const t = id.find((x) => x.startsWith('TLIST('));
  const kind = t?.match(/^TLIST\(([A-Z])\d\)$/)?.[1];
  return { A: 'annual', Q: 'quarterly', M: 'monthly', W: 'weekly', D: 'daily', H: 'census' }[kind ?? ''] ?? 'unknown';
}

export type MetadataSummary = {
  matrix: string; title: string; updated: string; frequency: string; total_cells: number;
  dimensions: Array<{ id: string; label: string; role: 'time' | 'metric' | 'classification'; size: number; total_code?: string; categories: Array<{ code: string; label: string }>; categories_truncated?: number }>;
  notes: string[]; contact?: { name: string; email: string }; attribution: string;
};

const CATEGORY_CAP = 200;

export function summariseMetadata(meta: Dataset): MetadataSummary {
  const time = timeDimension(meta);
  const metric = meta.role?.metric?.[0] ?? 'STATISTIC';
  const dimensions = meta.id.map((id, i) => {
    const d = meta.dimension[id];
    const all = d.category.index.map((code) => ({ code, label: d.category.label[code] ?? code }));
    const total = meta.extension.elimination?.[id];
    return {
      id, label: d.label,
      role: (id === time ? 'time' : id === metric ? 'metric' : 'classification') as 'time' | 'metric' | 'classification',
      size: meta.size[i],
      ...(total ? { total_code: total } : {}),
      categories: all.slice(0, CATEGORY_CAP),
      ...(all.length > CATEGORY_CAP ? { categories_truncated: all.length - CATEGORY_CAP } : {}),
    };
  });
  return {
    matrix: meta.extension.matrix, title: meta.label, updated: meta.updated, frequency: frequencyOf(meta.id),
    total_cells: cellCount(meta, {}), dimensions,
    notes: (meta.note ?? []).map(stripBBCode),
    ...(meta.extension.contact ? { contact: { name: meta.extension.contact.name, email: meta.extension.contact.email } } : {}),
    attribution: attribution(meta.extension.matrix),
  };
}

export function rowsToText(rows: Array<Record<string, string | number | null>>, max = 100): string {
  if (rows.length === 0) return '(no rows)';
  const cols = Object.keys(rows[0]);
  const lines = [cols.join(' | ')];
  for (const r of rows.slice(0, max)) lines.push(cols.map((c) => (r[c] === null ? 'null' : String(r[c]))).join(' | '));
  if (rows.length > max) lines.push(`…and ${rows.length - max} more rows`);
  return lines.join('\n');
}

export type QueryResult = { matrix: string; title: string; rows: Array<Record<string, string | number | null>>; cell_count: number; nulls: number; unit?: string; updated: string; attribution: string };

export function formatQuery(ds: Dataset): { structured: QueryResult; text: string } {
  const rows = flatten(ds);
  const metric = ds.role?.metric?.[0] ?? 'STATISTIC';
  const units = ds.dimension[metric]?.category.unit;
  const unitLabels = units ? Array.from(new Set(Object.values(units).map((u) => u.label))) : [];
  const structured: QueryResult = {
    matrix: ds.extension.matrix, title: ds.label, rows,
    cell_count: rows.length, nulls: rows.filter((r) => r.value === null).length,
    ...(unitLabels.length === 1 ? { unit: unitLabels[0] } : {}),
    updated: ds.updated, attribution: attribution(ds.extension.matrix),
  };
  const text = `${ds.label} (${ds.extension.matrix})\n${rowsToText(rows)}\n${structured.attribution}`;
  return { structured, text };
}

export function formatSearch(hits: SearchHit[], limit: number) {
  const sorted = hits.slice(0, limit).map((h) => ({
    matrix: h.MtrCode, title: h.MtrTitle, theme: h.ThmValue, subject: h.SbjValue,
    product_code: h.PrcCode, product: h.PrcValue, frequency: frequencyOf([h.FrqCode]),
    first_period: h.period?.[0] ?? '', last_period: h.period?.[h.period.length - 1] ?? '',
    dimensions: (h.classification ?? []).map((c) => c.ClsValue), updated: h.RlsLiveDatetimeFrom,
  }));
  return { hits: sorted, total_hits: hits.length, truncated: hits.length > limit };
}

export function formatCollection(items: CollectionItem[], limit: number) {
  const tables = items
    .map((i) => ({ matrix: i.extension.matrix, title: i.label, updated: i.updated, frequency: frequencyOf(i.id) }))
    .sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
  return { tables: tables.slice(0, limit), count: tables.length, truncated: tables.length > limit };
}

export type CatalogResult =
  | { themes: Array<{ code: string; name: string; subjects: number }> }
  | { theme: { code: string; name: string }; subjects: Array<{ code: string; name: string; products: Array<{ code: string; name: string; tables: number }> }> }
  | { subject: { code: string; name: string }; products: Array<{ code: string; name: string; tables: number }> }
  | { error: string };

const eq = (a: string | number, b: string) => String(a).toLowerCase() === b.trim().toLowerCase();

export function formatCatalog(themes: NavTheme[], theme?: string, subject?: string): CatalogResult {
  const products = (s: NavTheme['subject'][number]) => s.product.map((p) => ({ code: p.PrcCode, name: p.PrcValue, tables: p.PrcReleaseCount }));
  if (subject) {
    for (const t of themes) for (const s of t.subject) if (eq(s.SbjCode, subject) || eq(s.SbjValue, subject)) return { subject: { code: String(s.SbjCode), name: s.SbjValue }, products: products(s) };
    return { error: `No subject "${subject}". Call browse_catalog with a theme to see its subjects.` };
  }
  if (theme) {
    const t = themes.find((x) => eq(x.ThmCode, theme) || eq(x.ThmValue, theme));
    if (!t) return { error: `No theme "${theme}". Call browse_catalog with no arguments to list themes.` };
    return { theme: { code: String(t.ThmCode), name: t.ThmValue }, subjects: t.subject.map((s) => ({ code: String(s.SbjCode), name: s.SbjValue, products: products(s) })) };
  }
  return { themes: themes.map((t) => ({ code: String(t.ThmCode), name: t.ThmValue, subjects: t.subject.length })) };
}

export function capText(text: string, maxBytes = 50_000): { text: string; truncated: boolean } {
  if (text.length <= maxBytes) return { text, truncated: false };
  return { text: text.slice(0, maxBytes) + '\n…[truncated; narrow the request]', truncated: true };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- tests/format.test.ts && npm run typecheck`
Expected: all passing. If `frequencyOf` returns `annual` for `EHA05` it is because search hits carry `FrqCode: "TLIST(A1)"` (they do in the fixture).

- [ ] **Step 5: Commit**

```bash
git add src/format.ts tests/format.test.ts
git commit -m "format: metadata summary, query rows/text, search, collection, catalog, text cap

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The six tools, tested in-process through a real MCP client

**Files:**
- Create: `src/server.ts`, `tests/tools.test.ts`

**Interfaces:**
- Consumes: `createPxStat`, `PxStatError` (Task 3); `jsonstat` helpers (Task 2); `format` helpers (Task 4).
- Produces: `export function createServer(fetchImpl: typeof fetch = fetch): McpServer` from `src/server.ts`; tool names exactly `search_tables`, `browse_catalog`, `list_tables`, `get_table_metadata`, `query_table`, `recent_updates`.

- [ ] **Step 1: Write the failing integration test**

`tests/tools.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import meta from './fixtures/EHQ03.metadata.json';
import query from './fixtures/EHQ03.query.json';
import bad from './fixtures/EHQ03.badcode.json';
import search from './fixtures/search.json';
import nav from './fixtures/navigation.json';
import coll from './fixtures/collection.ELCQ.json';
import { createServer } from '../src/server';

const calls: Array<{ url: string; body?: string }> = [];
const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const body = init?.body ? String(init.body) : undefined;
  calls.push({ url, body });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('ReadMetadata/EHQ03/')) return json(meta);
  if (url.includes('ReadMetadata/')) return new Response('NotFound', { status: 404 });
  if (body?.includes('Navigation_API.Search')) return json(search);
  if (body?.includes('Navigation_API.Read')) return json(nav);
  if (body?.includes('ReadCollection')) return json(coll);
  if (body?.includes('ReadDataset')) return body.includes('Average Weekly Earnings') ? json(bad) : json(query);
  return new Response('NotFound', { status: 404 });
}) as unknown as typeof fetch;

let client: Client;
beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(fetchImpl);
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
});

const text = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text ?? '';

describe('tool list', () => {
  it('exposes exactly the six read-only tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['browse_catalog', 'get_table_metadata', 'list_tables', 'query_table', 'recent_updates', 'search_tables']);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });
});

describe('search_tables', () => {
  it('returns trimmed hits with a truncation flag', async () => {
    const r = await client.callTool({ name: 'search_tables', arguments: { query: 'weekly earnings', limit: 3 } });
    const s = r.structuredContent as { hits: unknown[]; total_hits: number; truncated: boolean };
    expect(s.hits).toHaveLength(3);
    expect(s.truncated).toBe(true);
    expect(text(r)).toContain('EHA05');
  });
});

describe('browse_catalog / list_tables / recent_updates', () => {
  it('browses themes then a subject', async () => {
    const top = await client.callTool({ name: 'browse_catalog', arguments: {} });
    expect((top.structuredContent as { themes: unknown[] }).themes).toHaveLength(9);
    const sub = await client.callTool({ name: 'browse_catalog', arguments: { subject: 'Earnings' } });
    expect(text(sub)).toContain('ELCQ');
  });
  it('lists tables for a product', async () => {
    const r = await client.callTool({ name: 'list_tables', arguments: { product_code: 'ELCQ' } });
    expect((r.structuredContent as { count: number }).count).toBe(15);
  });
  it('lists recent updates', async () => {
    const r = await client.callTool({ name: 'recent_updates', arguments: { since: '2026-09-17' } });
    expect((r.structuredContent as { tables: unknown[] }).tables.length).toBeGreaterThan(0);
  });
});

describe('get_table_metadata', () => {
  it('summarises EHQ03', async () => {
    const r = await client.callTool({ name: 'get_table_metadata', arguments: { matrix: 'ehq03' } });
    const s = r.structuredContent as { matrix: string; frequency: string; dimensions: Array<{ id: string }> };
    expect(s.matrix).toBe('EHQ03');
    expect(s.frequency).toBe('quarterly');
    expect(s.dimensions.map((d) => d.id)).toContain('TLIST(Q1)');
  });
  it('errors clearly on an unknown table', async () => {
    const r = await client.callTool({ name: 'get_table_metadata', arguments: { matrix: 'ZZZ99' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('search_tables');
  });
});

describe('query_table', () => {
  it('refuses over-budget queries before fetching data', async () => {
    calls.length = 0;
    const r = await client.callTool({ name: 'query_table', arguments: { matrix: 'EHQ03' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/would return 130536 cells/);
    expect(text(r)).toContain('Quarter');
    expect(calls.some((c) => c.body?.includes('ReadDataset'))).toBe(false);
  });
  it('returns rows for a filtered query', async () => {
    const r = await client.callTool({ name: 'query_table', arguments: { matrix: 'EHQ03', filters: { STATISTIC: ['EHQ03C02'], 'TLIST(Q1)': ['20241', '20242'] } } });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { cell_count: number; rows: Array<{ value: number | null }>; attribution: string };
    expect(s.cell_count).toBe(168);
    expect(s.rows[0].value).toBe(972.2);
    expect(s.attribution).toContain('EHQ03');
  });
  it('explains bad codes, naming them', async () => {
    const r = await client.callTool({ name: 'query_table', arguments: { matrix: 'EHQ03', filters: { STATISTIC: ['Average Weekly Earnings'] } } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Average Weekly Earnings');
    expect(text(r)).toContain('get_table_metadata');
  });
  it('applies last_n_periods to the time dimension', async () => {
    calls.length = 0;
    await client.callTool({ name: 'query_table', arguments: { matrix: 'EHQ03', filters: { STATISTIC: ['EHQ03C02'] }, last_n_periods: 2 } });
    const sent = JSON.parse(calls.find((c) => c.body?.includes('ReadDataset'))!.body!);
    expect(sent.params.dimension['TLIST(Q1)'].category.index).toEqual(['20261', '20262']);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npm test -- tests/tools.test.ts`
Expected: FAIL, cannot resolve `../src/server`.

- [ ] **Step 3: Implement the server**

`src/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createPxStat, PxStatError } from './pxstat';
import { cellCount, widestDimensions, unknownCodes, lastN, timeDimension, type Filters } from './jsonstat';
import { summariseMetadata, formatQuery, formatSearch, formatCollection, formatCatalog, capText } from './format';

const RO = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true };
const MATRIX = z.string().min(2).max(12).describe('CSO table code, e.g. EHQ03. Get codes from search_tables, list_tables or browse_catalog.');

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(structured: Record<string, unknown>, textOverride?: string): ToolResult {
  const { text, truncated } = capText(textOverride ?? JSON.stringify(structured, null, 1));
  return { content: [{ type: 'text', text }], structuredContent: truncated ? { ...structured, truncated: true } : structured };
}
function err(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
function fromPxStatError(e: unknown): ToolResult {
  if (e instanceof PxStatError) return err(e.message);
  return err('CSO API unavailable, try again shortly.');
}

export function createServer(fetchImpl: typeof fetch = fetch): McpServer {
  const px = createPxStat(fetchImpl);
  const server = new McpServer({ name: 'ireland-stats', version: '0.1.0' });

  server.registerTool('search_tables', {
    title: 'Search CSO tables',
    description: 'Full-text search over every table published by the Central Statistics Office of Ireland. Start here (or with browse_catalog), then call get_table_metadata on a matrix code before query_table. Returns up to `limit` ranked hits with the table code, title, theme, subject, frequency, period range and dimension names.',
    inputSchema: z.object({ query: z.string().min(2).describe('Words to search for, e.g. "average weekly earnings" or "population by county"'), limit: z.number().int().min(1).max(50).default(20) }),
    annotations: RO,
  }, async ({ query, limit }) => {
    try { return ok(formatSearch(await px.search(query), limit)); } catch (e) { return fromPxStatError(e); }
  });

  server.registerTool('browse_catalog', {
    title: 'Browse the CSO catalogue',
    description: 'Walk the CSO catalogue: call with no arguments to list themes; pass `theme` (code or name) to list its subjects and their products; pass `subject` (code or name) to list products. Products are groups of tables; use list_tables with a product code to see the tables.',
    inputSchema: z.object({ theme: z.string().optional(), subject: z.string().optional() }),
    annotations: RO,
  }, async ({ theme, subject }) => {
    try {
      const r = formatCatalog(await px.navigation(), theme, subject);
      return 'error' in r ? err(r.error) : ok(r as unknown as Record<string, unknown>);
    } catch (e) { return fromPxStatError(e); }
  });

  server.registerTool('list_tables', {
    title: 'List tables in a product',
    description: 'List the tables (matrix codes and titles, newest first) inside one CSO product, e.g. ELCQ. Product codes come from browse_catalog or search_tables.',
    inputSchema: z.object({ product_code: z.string().min(2).max(12), limit: z.number().int().min(1).max(200).default(50) }),
    annotations: RO,
  }, async ({ product_code, limit }) => {
    try { return ok(formatCollection(await px.collectionByProduct(product_code.toUpperCase()), limit)); } catch (e) { return fromPxStatError(e); }
  });

  server.registerTool('get_table_metadata', {
    title: 'Describe a CSO table',
    description: 'Dimensions, category codes and labels, sizes, total codes, notes and update date for one table. Always call this before query_table: filters must use the codes listed here, not labels.',
    inputSchema: z.object({ matrix: MATRIX }),
    annotations: RO,
  }, async ({ matrix }) => {
    try { return ok(summariseMetadata(await px.metadata(matrix)) as unknown as Record<string, unknown>); } catch (e) { return fromPxStatError(e); }
  });

  server.registerTool('query_table', {
    title: 'Query a CSO table',
    description: 'Fetch cells from one table, filtered by dimension codes (from get_table_metadata). Unfiltered dimensions return all their categories, so the cell count is the product of the remaining sizes; requests over `max_cells` are refused with a hint about which dimensions to narrow. Use `last_n_periods` to take only the most recent time periods. Returns rows with category labels and a value (null = not available), plus the CSO attribution.',
    inputSchema: z.object({
      matrix: MATRIX,
      filters: z.record(z.string(), z.array(z.string()).min(1)).optional().describe('Map of dimension id → list of category codes, e.g. {"STATISTIC":["EHQ03C02"],"TLIST(Q1)":["20241"]}'),
      last_n_periods: z.number().int().min(1).max(200).optional(),
      max_cells: z.number().int().min(1).max(5000).default(2000),
    }),
    annotations: RO,
  }, async ({ matrix, filters, last_n_periods, max_cells }) => {
    try {
      const meta = await px.metadata(matrix);
      const f: Filters = { ...(filters ?? {}) };
      const bad = unknownCodes(meta, f);
      if (bad.length > 0) return err(`One or more codes are not valid for ${meta.extension.matrix}. Codes come from get_table_metadata (labels are not accepted). Unknown: ${bad.map((b) => `${b.dimension}=${b.code}`).join(', ')}.`);
      const t = timeDimension(meta);
      if (last_n_periods && t && !f[t]) f[t] = lastN(meta, last_n_periods);
      const n = cellCount(meta, f);
      if (n > max_cells) {
        const widest = widestDimensions(meta, f).map((d) => `${d.label} (${d.id}, ${d.size} categories)`).join('; ');
        return err(`Query would return ${n} cells (limit ${max_cells}). Narrow these dimensions with codes from get_table_metadata: ${widest}.`);
      }
      const { structured, text } = formatQuery(await px.query(matrix, f));
      return ok(structured as unknown as Record<string, unknown>, text);
    } catch (e) { return fromPxStatError(e); }
  });

  server.registerTool('recent_updates', {
    title: 'Recently updated tables',
    description: 'Tables the CSO has released or revised since a date (default: the last seven days). Useful for "what is new" questions.',
    inputSchema: z.object({ since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('ISO date, e.g. 2026-09-17'), limit: z.number().int().min(1).max(200).default(50) }),
    annotations: RO,
  }, async ({ since, limit }) => {
    try {
      const date = since ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
      return ok({ since: date, ...formatCollection(await px.collectionSince(date), limit) });
    } catch (e) { return fromPxStatError(e); }
  });

  return server;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests across the four files pass. Likely first failures and their fixes: (a) `structuredContent` missing on results → the SDK only returns it when present; the test reads it directly, so `ok()` must set it (it does). (b) zod v4 `z.record(z.string(), …)` requires both key and value schemas (used). (c) If the SDK rejects `structuredContent` without an `outputSchema`, add `outputSchema: z.object({}).passthrough()` to each tool's config.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/tools.test.ts
git commit -m "server: six read-only CSO tools with cell guard and clear errors (in-process MCP tests)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Worker routing, rate limit, landing page, local smoke

**Files:**
- Create: `src/landing.ts`, `scripts/smoke.mjs`
- Modify: `src/index.ts`, `tests/health.test.ts`

**Interfaces:**
- Consumes: `createServer` (Task 5).
- Produces: `GET /` HTML, `POST /mcp` MCP endpoint, `OPTIONS /mcp` CORS preflight, 429 on rate limit. `scripts/smoke.mjs <baseUrl>` exits non-zero on any failed check.

- [ ] **Step 1: Extend the router tests**

Append to `tests/health.test.ts`:

```ts
import { describe as d2, it as it2, expect as ex2 } from 'vitest';
import { handleRequest as hr, type Env as E2 } from '../src/index';

d2('landing, mcp, rate limit', () => {
  const env: E2 = { MCP_RATE_LIMITER: { limit: async () => ({ success: true }) } };
  it2('serves the landing page', async () => {
    const res = await hr(new Request('https://stats.archaic.ie/'), env);
    ex2(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    ex2(html).toContain('IRELAND STATS MCP');
    ex2(html).toContain('claude mcp add --transport http');
    ex2(html).toContain('Co. No. 811858');
  });
  it2('answers an MCP initialize on /mcp', async () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
    const res = await hr(new Request('https://stats.archaic.ie/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) }), env);
    ex2(res.status).toBe(200);
    ex2(res.headers.get('access-control-allow-origin')).toBe('*');
  });
  it2('returns 429 when the limiter says no', async () => {
    const limited: E2 = { MCP_RATE_LIMITER: { limit: async () => ({ success: false }) } };
    const res = await hr(new Request('https://stats.archaic.ie/mcp', { method: 'POST', body: '{}' }), limited);
    ex2(res.status).toBe(429);
    ex2(res.headers.get('retry-after')).toBe('60');
  });
});
```

- [ ] **Step 2: Run to see the new tests fail**

Run: `npm test -- tests/health.test.ts`
Expected: the three new tests FAIL (landing 404, mcp 404, no 429).

- [ ] **Step 3: Write the landing page**

`src/landing.ts`:

```ts
export const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Ireland Stats MCP — Archaic</title>
<meta name="description" content="A public, read-only MCP server over Ireland's Central Statistics Office data. Point Claude, ChatGPT or Cursor at it and ask about Irish statistics." />
<link rel="canonical" href="https://stats.archaic.ie/" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400&family=Space+Grotesk:wght@300;400;500&display=swap" rel="stylesheet" />
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#060606;color:#686868;font-family:'Space Grotesk',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:72ch;margin:0 auto;padding:72px 24px 96px}
h1{font-family:'Cinzel',serif;text-transform:uppercase;font-size:clamp(22px,3vw,30px);letter-spacing:3px;color:#e8e4d8;margin-bottom:20px}
h2{font-family:'Cinzel',serif;text-transform:uppercase;font-size:14px;letter-spacing:2px;color:#e8e4d8;margin:48px 0 16px}
p{font-size:14px;line-height:1.8;margin-bottom:16px}
a{color:#8a8a8a;text-decoration:none;border-bottom:1px solid #333}a:hover{color:#e8e4d8}
dl{font-size:13px;line-height:1.7}dt{color:#e8e4d8;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:12px}dd{margin-left:0}
pre{background:#0d0d0d;border:1px solid #1a1a1a;padding:14px 16px;font-size:12px;line-height:1.6;overflow-x:auto;color:#b0b0b0;margin:8px 0 16px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.eyebrow{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#4a4a4a;margin-bottom:24px}
footer{margin-top:72px;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#333}
a:focus-visible{outline:1px solid #8a8a8a;outline-offset:4px}
</style>
</head>
<body>
<div class="wrap">
<p class="eyebrow">Archaic — Irish data for agents</p>
<h1>Ireland Stats MCP</h1>
<p>A public, read-only <a href="https://modelcontextprotocol.io">Model Context Protocol</a> server over every table published by Ireland's Central Statistics Office. Connect an assistant to it and ask about population, prices, earnings, housing, the labour market, trade, or anything else the CSO measures. No account, no key.</p>
<p>Endpoint: <code>https://stats.archaic.ie/mcp</code></p>

<h2>Connect</h2>
<p>Claude Code</p>
<pre><code>claude mcp add --transport http ireland-stats https://stats.archaic.ie/mcp</code></pre>
<p>Claude (claude.ai and desktop): Settings → Connectors → Add custom connector → URL above, authentication "No sign-in".</p>
<p>ChatGPT (developer mode) and Cursor take the same URL. For Cursor, <code>.cursor/mcp.json</code>:</p>
<pre><code>{ "mcpServers": { "ireland-stats": { "url": "https://stats.archaic.ie/mcp" } } }</code></pre>

<h2>Tools</h2>
<dl>
<dt>search_tables</dt><dd>Full-text search across the catalogue.</dd>
<dt>browse_catalog</dt><dd>Themes, subjects and products, top down.</dd>
<dt>list_tables</dt><dd>The tables inside one product.</dd>
<dt>get_table_metadata</dt><dd>Dimensions, codes and labels for a table. Read this before querying.</dd>
<dt>query_table</dt><dd>Filtered cells from a table, with a size guard so nothing enormous comes back.</dd>
<dt>recent_updates</dt><dd>What the CSO has released or revised lately.</dd>
</dl>

<h2>Data</h2>
<p>All data comes live from the CSO's PxStat API and is licensed <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. Every response carries the attribution: Source: Central Statistics Office, Ireland. This service is not affiliated with the CSO.</p>
<p>Source code: <a href="https://github.com/faulknco/archaic-stats-mcp">github.com/faulknco/archaic-stats-mcp</a>. Built by <a href="https://archaic.ie">Archaic</a>.</p>
<footer>Archaic Limited · Registered in Ireland · Co. No. 811858</footer>
</div>
</body>
</html>`;
```

- [ ] **Step 4: Wire the router**

Replace `src/index.ts` with:

```ts
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
```

- [ ] **Step 5: Run all tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: all passing. If the `initialize` test returns 406, add the `accept` header (it is present in the test); if it returns 400 about a session, `legacy: 'stateless'` is set and the modern era needs no session header.

- [ ] **Step 6: Write the smoke script**

`scripts/smoke.mjs`:

```js
// Live check: runs the six tools through a real MCP client over HTTP.
// Usage: node scripts/smoke.mjs http://localhost:8787   (or https://stats.archaic.ie)
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const base = (process.argv[2] || 'http://localhost:8787').replace(/\/$/, '');
let failed = 0;
const ok = (m) => console.log('ok  :', m);
const fail = (m) => { failed++; console.error('FAIL:', m); };
const text = (r) => (r.content || []).find((c) => c.type === 'text')?.text ?? '';

const health = await fetch(`${base}/health`).then((r) => r.json());
health.ok ? ok(`health ${JSON.stringify(health)}`) : fail('health');
const landing = await fetch(`${base}/`).then((r) => r.text());
landing.includes('Ireland Stats MCP') ? ok('landing page') : fail('landing page');

const client = new Client({ name: 'smoke', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
const { tools } = await client.listTools();
tools.length === 6 ? ok('six tools listed') : fail(`tools: ${tools.map((t) => t.name).join(',')}`);

const s = await client.callTool({ name: 'search_tables', arguments: { query: 'average weekly earnings', limit: 5 } });
text(s).includes('EHQ03') || text(s).includes('EHA05') ? ok('search_tables finds earnings tables') : fail(`search: ${text(s).slice(0, 200)}`);

const cat = await client.callTool({ name: 'browse_catalog', arguments: {} });
text(cat).includes('Labour Market') ? ok('browse_catalog lists themes') : fail('browse_catalog');

const lt = await client.callTool({ name: 'list_tables', arguments: { product_code: 'ELCQ' } });
text(lt).includes('EHQ03') ? ok('list_tables ELCQ includes EHQ03') : fail('list_tables');

const meta = await client.callTool({ name: 'get_table_metadata', arguments: { matrix: 'EHQ03' } });
text(meta).includes('TLIST(Q1)') ? ok('get_table_metadata EHQ03') : fail('metadata');

const guard = await client.callTool({ name: 'query_table', arguments: { matrix: 'EBQ02' } });
guard.isError && /would return \d+ cells/.test(text(guard)) ? ok('query_table refuses an unfiltered EBQ02') : fail(`guard: ${text(guard).slice(0, 200)}`);

const q = await client.callTool({ name: 'query_table', arguments: { matrix: 'EHQ03', filters: { STATISTIC: ['EHQ03C02'], 'TLIST(Q1)': ['20241', '20242'], C02665V03225: ['-'], C02397V02888: ['-'] } } });
const rows = q.structuredContent?.rows ?? [];
!q.isError && rows.length === 2 && typeof rows[0].value === 'number' ? ok(`query_table EHQ03 → ${rows.map((r) => r.value).join(', ')}`) : fail(`query: ${text(q).slice(0, 300)}`);

const badc = await client.callTool({ name: 'query_table', arguments: { matrix: 'EHQ03', filters: { STATISTIC: ['Average Weekly Earnings'] } } });
badc.isError && text(badc).includes('get_table_metadata') ? ok('query_table explains a label used as a code') : fail('bad code handling');

const ru = await client.callTool({ name: 'recent_updates', arguments: {} });
!ru.isError ? ok('recent_updates') : fail('recent_updates');

await client.close?.();
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('smoke passed');
```

- [ ] **Step 7: Run the smoke against `wrangler dev`**

```bash
(npx wrangler dev --port 8787 > /tmp/wrangler-dev.log 2>&1 &) ; sleep 6
npm run smoke -- http://localhost:8787
pkill -f "wrangler dev"
```

Expected: eleven `ok` lines and `smoke passed`. If `wrangler dev` refuses the `ratelimits` binding locally, it emulates it; if it errors, check `/tmp/wrangler-dev.log` and bump `wrangler` (≥ 4.36 required for rate limiting).

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/landing.ts scripts/smoke.mjs tests/health.test.ts
git commit -m "worker: routing, CORS, rate limit, landing page; live smoke script

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: CI, README, licence, registry manifest, deploy, live verification

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/dependabot.yml`, `README.md`, `LICENSE`, `server.json`

- [ ] **Step 1: CI and Dependabot**

`.github/workflows/ci.yml`:

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v7
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npx wrangler deploy --dry-run
  deploy:
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    needs: test
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v7
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      - run: node scripts/smoke.mjs https://stats.archaic.ie
```

`.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
    groups:
      minor-and-patch: { patterns: ["*"], update-types: [minor, patch] }
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
```

- [ ] **Step 2: README, LICENSE, server.json**

`README.md`:

```markdown
# Ireland Stats MCP

A public, read-only [MCP](https://modelcontextprotocol.io) server over Ireland's Central Statistics Office [PxStat](https://data.cso.ie) API. One Cloudflare Worker, no database, no keys.

Endpoint: `https://stats.archaic.ie/mcp` · Landing page: https://stats.archaic.ie

## Connect

```bash
claude mcp add --transport http ireland-stats https://stats.archaic.ie/mcp
```

claude.ai / Claude Desktop: Settings → Connectors → Add custom connector → the URL above, "No sign-in". ChatGPT developer mode and Cursor accept the same URL.

## Tools

| Tool | What it does |
|---|---|
| `search_tables` | Full-text search over the catalogue (up to 50 hits) |
| `browse_catalog` | Themes → subjects → products |
| `list_tables` | Tables inside a product |
| `get_table_metadata` | Dimensions, codes, labels, sizes, notes; read before querying |
| `query_table` | Filtered cells with a size guard (`max_cells`, default 2000) |
| `recent_updates` | Tables released or revised since a date |

Filters use CSO category codes, never labels. `query_table` refuses requests whose cell count exceeds the budget and says which dimensions to narrow.

## Run locally

```bash
npm install
npm test            # unit + in-process MCP tests on recorded fixtures
npm run dev         # wrangler dev on :8787
npm run smoke -- http://localhost:8787
```

## Deploy

Pushes to `main` run tests and deploy with `wrangler deploy` (custom domain `stats.archaic.ie`), then smoke the live URL. Manual: `npm run deploy`.

## Data and licence

Data is fetched live from the CSO and licensed CC BY 4.0; every response includes "Source: Central Statistics Office, Ireland". This project is not affiliated with the CSO. Code is MIT.
```

`LICENSE`: the MIT licence text with `Copyright (c) 2026 Archaic Limited`.

`server.json`:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "ie.archaic/ireland-stats",
  "description": "Read-only access to every table published by Ireland's Central Statistics Office (CSO PxStat).",
  "version": "0.1.0",
  "repository": { "url": "https://github.com/faulknco/archaic-stats-mcp", "source": "github" },
  "websiteUrl": "https://stats.archaic.ie",
  "remotes": [{ "type": "streamable-http", "url": "https://stats.archaic.ie/mcp" }]
}
```

- [ ] **Step 3: Commit**

```bash
git add .github README.md LICENSE server.json
git commit -m "ci, readme, licence, registry manifest

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin main
```

CI's deploy job will fail until the two repository secrets exist; that is expected on this first push.

- [ ] **Step 4: First deploy from the MacBook (wrangler is logged in via OAuth)**

```bash
npx wrangler deploy 2>&1 | tail -15
```

Expected: a worker URL plus "Custom Domain stats.archaic.ie" being provisioned (DNS record and certificate are created automatically because the archaic.ie zone is on this account). If the custom domain step fails with a permissions error, deploy without the `routes` block once, then add it back after Connor confirms the zone permission on the OAuth token.

- [ ] **Step 5: Verify live**

```bash
for i in $(seq 1 30); do s=$(curl -s -o /dev/null -w '%{http_code}' https://stats.archaic.ie/health); [ "$s" = 200 ] && break; sleep 10; done
curl -s https://stats.archaic.ie/health
npm run smoke -- https://stats.archaic.ie
claude mcp add --transport http ireland-stats https://stats.archaic.ie/mcp --scope user && claude mcp list | grep ireland-stats
```

Expected: `{"ok":true,"upstream":"ok"}`, `smoke passed`, and the server listed as connected in Claude Code.

- [ ] **Step 6: Hand-offs to Connor (cannot be done by Claude)**

1. Create a Cloudflare API token (Workers Scripts: Edit; Account Settings: Read; Zone DNS: Edit for archaic.ie), save it in 1Password as "Cloudflare API Token - archaic-stats-mcp deploy", and add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (`59b0155df0bdd932a1aa600e4e32f154`) as repository secrets so CI can deploy.
2. Registry publish: `brew install mcp-publisher` (or download), `mcp-publisher login dns --domain archaic.ie --private-key <key>` after adding the TXT record it prints, then `mcp-publisher publish` from the repo root.

- [ ] **Step 7: Docs**

Add `technical/repos/archaic-stats-mcp.md` to the vault (TL;DR, stack, run, deploy, gotchas: codes not labels, empty-result shape, never fetch the full collection, `is:` nothing here but `legacy: 'stateless'`), link it from `technical/repos/README.md`, update memory `project_archaic_site.md` (Ireland Stats MCP live) and the ideas note. Commit and push the vault; pull on the Mini with `git pull origin main`.

---

## Self-review

- Spec coverage: architecture and files (T1, T5, T6), six tools with exact shapes (T4, T5), cell guard before fetch (T5, tested), caching TTLs (T3), known traps: matrix-built URLs (T3), empty-result detection (T2, T3), time labels (T2/T4), attribution (T4), landing page copy and company line (T6), rate limit and 429 (T6), upstream timeout/errors (T3), CI/deploy/registry manifest (T7), verification steps (T6 smoke, T7 live + Claude Code), docs (T7). No spec item without a task.
- Placeholders: none; every code step is complete.
- Names: `createPxStat`, `PxStatError.kind`, `cellCount`, `widestDimensions`, `unknownCodes`, `lastN`, `timeDimension`, `isEmptyResult`, `summariseMetadata`, `formatQuery`, `formatSearch`, `formatCollection`, `formatCatalog`, `capText`, `createServer`, `handleRequest`, `Env.MCP_RATE_LIMITER` are consistent across tasks.

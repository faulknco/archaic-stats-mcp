# Ireland Stats MCP (stats.archaic.ie) — design

Date: 2026-09-24. Status: approved by Connor 2026-09-24 in chat; spec written after approval.

## What it is

A public, read-only, no-auth MCP server over Ireland's Central Statistics Office PxStat API, hosted as a single Cloudflare Worker at `https://stats.archaic.ie/mcp`. Any MCP client (Claude, ChatGPT, Cursor, Claude Code) can search, browse, describe and query every official CSO table. Nothing of ours is stored: the Worker proxies, filters, guards and caches the CSO's own API.

Purpose for Archaic: the cheapest concrete proof of the "Irish data for agents" thesis, a first entry in the MCP registry under the `ie.archaic` namespace, and a natural sibling for later PlanningWatch/RoleUp data tools. Near-zero upkeep.

Out of scope for version one: Irish-language output (`ga`), CSV/chart output, any Archaic-owned data, the Anthropic connector-directory listing, authentication, per-user state.

## Facts this design relies on (verified 2026-09-24, see research note in the Archaic vault)

- Base host `https://ws.cso.ie/public/`. JSON-RPC at `api.jsonrpc` (GET `?data=` or POST); RESTful GETs at `api.restful/PxStat.Data.Cube_API.{ReadMetadata|ReadDataset}/{matrix}/JSON-stat/2.0/en`.
- `Navigation_API.Search {Search, LngIsoCode}` → ranked hits, hard cap 100. `Navigation_API.Read {LngIsoCode}` → theme → subject → product tree (~57 KB). `Cube_API.ReadCollection {language, product?|datefrom?}` → tables for a product (small) or updated since a date. The unfiltered collection is 24 MB and must never be fetched.
- `Cube_API.ReadDataset` with `class:"query"` and `dimension:{DIM:{category:{index:[codes]}}}` filters server-side. Codes only. A code that does not exist returns HTTP 200 with a dataset whose offending dimension has an empty `category.index`, a `0` in `size`, and `value: []` (verified 2026-09-24; some responses may instead carry `result: null`; treat both as unknown codes). Unlisted dimensions return all categories. Totals use code `-` per `extension.elimination`.
- Metadata `size[]` × filtered category counts gives the exact cell count before any data fetch.
- Catalogue `href`s mostly point at a dead host; always build URLs from `extension.matrix`.
- Time codes differ from labels (`20241` = 2024Q1, `199004` = 1990M04, `2020W35`, `2021M01D31`, annual `2024`). Metadata carries both.
- Licence CC BY 4.0; attribution "Source: Central Statistics Office, Ireland". No CSO logo.
- CSO sets `cache-control: no-cache`; releases land at 11:00 Irish time.
- Workers free tier: 10 ms CPU per request, 50 subrequests, 100k requests/day. Cache API is free; KV writes are scarce, so KV is not used.
- Cloudflare recommends `createMcpHandler` from `@modelcontextprotocol/server` (2.1.x) for stateless servers; `McpAgent`/Durable Objects are not needed.

## Architecture

```
client ──HTTP──▶ stats.archaic.ie (Worker)
                   ├─ GET  /            → landing page (HTML, inline CSS, archaic.ie style)
                   ├─ GET  /health      → {"ok":true,"upstream":"ok"|"degraded"}
                   ├─ POST /mcp         → createMcpHandler(server)   (Streamable HTTP, stateless)
                   └─ *                 → 404 text
                          │
                          ▼  fetch() with cf.cacheTtl / cacheEverything
                    ws.cso.ie/public  (PxStat)
```

Files (`src/`):
- `index.ts` — router: `/`, `/health`, `/mcp`; wraps everything in the rate limiter; CORS headers for `/mcp`.
- `server.ts` — `createServer()` registering the six tools with descriptions and zod schemas.
- `pxstat.ts` — typed client: `search(q)`, `navigation()`, `collection({product}|{datefrom})`, `metadata(matrix)`, `query(matrix, filters)`; builds URLs from matrix codes; converts `result: null` into a typed `PxStatError('unknown_codes'|'unknown_table'|'upstream')`; sets cache TTLs.
- `jsonstat.ts` — pure: `cellCount(meta, filters)`, `widestDimensions(meta, filters, n)`, `flatten(dataset) → rows[]` (row-major `value[]` over `size[]` → `{dimLabel…, value}`), `timeLabel(code, tlistKind)`.
- `format.ts` — pure: shapes tool outputs (structuredContent + a compact text rendering), truncation flags, attribution block.
- `landing.ts` — the HTML string for `/`.
- `ratelimit.ts` — Workers Rate Limiting binding wrapper (see Limits).

## Tools (all `readOnlyHint: true`, `idempotentHint: true`)

Descriptions are written for the model and state the intended sequence: search or browse → `get_table_metadata` → `query_table` with codes.

1. `search_tables` — `{query: string(min 2), limit?: int 1–50 = 20}` → `{hits: [{matrix, title, theme, subject, product_code, product, frequency, first_period, last_period, dimensions: string[], updated}], total_hits, truncated}`. Backed by `Navigation_API.Search`. Cache 1 h.
2. `browse_catalog` — `{theme?: string, subject?: string}` → with nothing: `{themes: [{code, name, subjects: n}]}`; with `theme`: its subjects and their products `{code, name, tables}`; with `subject`: products. Backed by `Navigation_API.Read`. Cache 24 h.
3. `list_tables` — `{product_code: string}` → `{tables: [{matrix, title, updated, frequency}], count}`. Backed by `ReadCollection {product}`. Cache 6 h.
4. `get_table_metadata` — `{matrix: string /^[A-Z0-9]{2,12}$/}` → `{matrix, title, updated, frequency, total_cells, dimensions: [{id, label, role: 'time'|'metric'|'classification', size, total_code?, categories: [{code, label}] (first 200; `categories_truncated: n` if more)}], notes: string[] (BBCode stripped), contact, attribution}`. Cache 6 h. Unknown matrix → `isError` "No CSO table with code X; use search_tables."
5. `query_table` — `{matrix, filters?: Record<dimId, string[] of codes>, last_n_periods?: int 1–200, max_cells?: int 1–5000 = 2000}` →
   - reads metadata (cached), applies `last_n_periods` to the time dimension, computes `cell_count`;
   - if `cell_count > max_cells`: `isError` with "Query would return N cells (limit M). Narrow these dimensions: <top 3 by size with their ids>." No data fetch.
   - else POST `ReadDataset class:"query"`; `result: null` → `isError` "One or more codes are not valid for X. Codes come from get_table_metadata (labels are not accepted). Unknown: <codes not found in metadata>."
   - success → `structuredContent: {matrix, title, rows: [{<dim label>: <category label>, …, value: number|null}], cell_count, nulls, unit?, updated, attribution}` plus a text rendering (first 100 rows as a compact table, then "…and N more rows"). Cache 1 h.
6. `recent_updates` — `{since?: ISO date = today−7d, limit?: int ≤ 200 = 50}` → `{tables: [{matrix, title, updated}], count, truncated}`. Backed by `ReadCollection {datefrom}`, trimmed. Cache 1 h.

Every response is capped at ~50 KB of text; `truncated: true` plus a hint replaces silent cuts. Attribution string on tools 4–5: `"Source: Central Statistics Office, Ireland (CC BY 4.0) — https://data.cso.ie/table/<matrix>"`.

## Limits and protection

- Rate limit: Workers Rate Limiting binding, 60 requests per minute per client IP on `/mcp`; over-limit → HTTP 429 with `Retry-After: 60`. Courtesy to the CSO more than to us.
- Upstream timeout 10 s per fetch; upstream 5xx/timeout → `isError` "CSO API unavailable, try again shortly" (never a Worker exception).
- Input validation via zod; matrix codes uppercased and pattern-checked before any URL is built.
- No secrets. No environment variables beyond the rate-limit binding.

## Landing page (`GET /`)

One screen, self-contained HTML in the archaic.ie style (dark `#060606`, Cinzel uppercase title, Space Grotesk body, no numbers other than none): title "IRELAND STATS MCP", one sentence on what it is, the six tool names with one line each, install snippets for Claude Code (`claude mcp add --transport http cso https://stats.archaic.ie/mcp`), claude.ai connectors (custom connector, no sign-in), ChatGPT developer mode and Cursor (`.mcp.json`), the attribution and licence line, a link to the GitHub repo and to archaic.ie. Company line "Archaic Limited · Registered in Ireland · Co. No. 811858".

## Repo, CI, deploy

- Repo `faulknco/archaic-stats-mcp`, public, MIT. TypeScript, `wrangler` 4, `vitest`, `@modelcontextprotocol/server`, `zod`. Node ≥ 22.
- `wrangler.jsonc`: name `archaic-stats-mcp`, `routes: [{pattern: "stats.archaic.ie", custom_domain: true}]`, rate-limit binding, observability logs on.
- Tests: `vitest` unit tests over `jsonstat.ts` and `format.ts` with recorded fixtures (`fixtures/EHQ03.metadata.json`, `fixtures/EHQ03.query.json`, a navigation tree slice, a search result); `scripts/smoke.mjs` runs the six tools against a base URL through `@modelcontextprotocol/client` and asserts shapes, the cell guard, and the bad-code error.
- CI (`.github/workflows/ci.yml`): `npm ci`, `npm test`, `npx tsc --noEmit`, `wrangler deploy --dry-run` on PRs; on push to `main`: deploy with `wrangler deploy` using `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` repository secrets (Connor creates the token: Workers Scripts Edit + Zone DNS Edit for archaic.ie; stored in 1Password as "Cloudflare API Token - archaic-stats-mcp deploy"), then `node scripts/smoke.mjs https://stats.archaic.ie`.
- Dependabot weekly, grouped minor/patch.
- Registry: `server.json` in the repo, name `ie.archaic/cso-stats`, one remote `streamable-http` at `https://stats.archaic.ie/mcp`; publish with `mcp-publisher login dns --domain archaic.ie` after adding the TXT record via the archaic.ie DNS token. Publishing is the last step and needs Connor's go.

## Verification (definition of done)

1. `npm test` green (pure modules, fixtures).
2. `node scripts/smoke.mjs http://localhost:8787` against `wrangler dev`: six tools return the documented shapes; `query_table` on EHQ03 with `STATISTIC=[EHQ03C02]`, `TLIST(Q1)=[20241,20242]` returns 2 non-null cells; an unfiltered `query_table` on EBQ02 is refused by the cell guard without an upstream data fetch; a label instead of a code produces the unknown-codes error.
3. Same smoke against `https://stats.archaic.ie` after deploy; `/health` ok; landing page renders; `claude mcp add --transport http cso https://stats.archaic.ie/mcp` then one real question answered in Claude Code.
4. Vault repo overview `technical/repos/archaic-stats-mcp.md` written; memory updated; archaic.ie links to it later (not in this project).

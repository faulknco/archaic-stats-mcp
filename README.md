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

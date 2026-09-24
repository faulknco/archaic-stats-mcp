import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createPxStat, PxStatError } from './pxstat';
import { cellCount, widestDimensions, unknownCodes, lastN, timeDimension, type Filters } from './jsonstat';
import { summariseMetadata, formatQuery, formatSearch, formatCollection, formatCatalog, capText } from './format';

const MAX_SINCE_DAYS = 14;
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
    description: 'Tables the CSO has released or revised since a date (default: yesterday; at most 14 days back, because the CSO returns full table descriptions and the response grows quickly). Useful for "what is new" questions.',
    inputSchema: z.object({ since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('ISO date, e.g. 2026-09-23; no earlier than 14 days ago'), limit: z.number().int().min(1).max(200).default(50) }),
    annotations: RO,
  }, async ({ since, limit }) => {
    try {
      const earliest = new Date(Date.now() - MAX_SINCE_DAYS * 86_400_000).toISOString().slice(0, 10);
      const date = since ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      if (date < earliest) return err(`since must be ${earliest} or later (at most ${MAX_SINCE_DAYS} days back). Use search_tables or list_tables for older tables.`);
      return ok({ since: date, ...formatCollection(await px.collectionSince(date), limit) });
    } catch (e) { return fromPxStatError(e); }
  });

  return server;
}

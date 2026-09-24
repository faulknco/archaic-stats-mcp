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
    const since = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const r = await client.callTool({ name: 'recent_updates', arguments: { since } });
    expect((r.structuredContent as { tables: unknown[] }).tables.length).toBeGreaterThan(0);
  });
  it('refuses a since date older than 14 days', async () => {
    const r = await client.callTool({ name: 'recent_updates', arguments: { since: '2020-01-01' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('14 days');
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

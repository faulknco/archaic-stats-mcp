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

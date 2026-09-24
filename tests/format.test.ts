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
const q = (query as unknown as { result: Dataset }).result;
const hits = (search as unknown as { result: SearchHit[] }).result;
const themes = (nav as unknown as { result: NavTheme[] }).result;
const items = (coll as unknown as { result: { link: { item: CollectionItem[] } } }).result.link.item;

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
    expect(structured.nulls).toBe((q.value ?? []).filter((v) => v === null).length);
    expect(structured.nulls).toBe(126);
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

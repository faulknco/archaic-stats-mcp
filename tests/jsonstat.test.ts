import { describe, it, expect } from 'vitest';
import meta from './fixtures/EHQ03.metadata.json';
import query from './fixtures/EHQ03.query.json';
import bad from './fixtures/EHQ03.badcode.json';
import { cellCount, widestDimensions, flatten, timeDimension, lastN, stripBBCode, unknownCodes, isEmptyResult, type Dataset } from '../src/jsonstat';

const m = meta as unknown as Dataset;
const q = (query as unknown as { result: Dataset }).result;
const b = (bad as unknown as { result: Dataset }).result;

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

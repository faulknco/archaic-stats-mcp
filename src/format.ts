import { flatten, stripBBCode, timeDimension, cellCount, type Dataset } from './jsonstat';
import type { SearchHit, NavTheme, CollectionItem } from './pxstat';

export function attribution(matrix: string): string {
  return `Source: Central Statistics Office, Ireland (CC BY 4.0) — https://data.cso.ie/table/${matrix}`;
}

export function frequencyOf(id: string[]): string {
  const t = id.find((x) => x.startsWith('TLIST('));
  const kind = t?.match(/^TLIST\(([A-Z])\d\)$/)?.[1];
  const map: Record<string, string> = { A: 'annual', Q: 'quarterly', M: 'monthly', W: 'weekly', D: 'daily', H: 'census' };
  return map[kind ?? ''] ?? 'unknown';
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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function capText(text: string, maxBytes = 50_000): { text: string; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  // Decode a byte-bounded slice; a split multi-byte character at the cut is dropped.
  const head = decoder.decode(bytes.subarray(0, maxBytes)).replace(/\uFFFD$/, '');
  return { text: head + '\n…[truncated; narrow the request]', truncated: true };
}

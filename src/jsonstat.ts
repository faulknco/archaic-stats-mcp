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

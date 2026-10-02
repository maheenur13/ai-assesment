import { parse as parseCsv } from 'csv-parse/sync';

/** A file that was fetched but cannot be turned into product rows. */
export class ImportFileError extends Error {}

export const MAX_ROWS = 5_000;

export const FIELDS = [
  'sku',
  'name',
  'description',
  'category',
  'price',
  'priceCents',
  'currency',
  'stock',
  'isActive',
] as const;
export type Field = (typeof FIELDS)[number];
/** Which source column feeds each product field. */
export type Mapping = Partial<Record<Field, string>>;

export interface Table {
  headers: string[];
  records: Record<string, string>[];
}

/** CSV (comma, semicolon or tab separated) or JSON: an array of objects or `{ products: [...] }`. */
export function parseTable(body: string, contentType: string): Table {
  const text = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
  const trimmed = text.trimStart();
  const table =
    contentType === 'application/json' || trimmed.startsWith('[') || trimmed.startsWith('{')
      ? parseJson(text)
      : parseDelimited(text);
  if (table.records.length === 0) throw new ImportFileError('the file has no product rows');
  // Headers are shown to the model and echoed in errors; real ones are short.
  if (table.headers.some((h) => h.length > 200)) {
    throw new ImportFileError('a column header is longer than 200 characters');
  }
  if (table.records.length > MAX_ROWS) {
    throw new ImportFileError(`the file has more than ${MAX_ROWS} rows`);
  }
  return table;
}

function parseJson(text: string): Table {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportFileError('the file is not valid JSON');
  }
  const list = Array.isArray(data) ? data : (data as { products?: unknown } | null)?.products;
  if (!Array.isArray(list)) {
    throw new ImportFileError('expected a JSON array of products or { "products": [...] }');
  }
  const headers = new Set<string>();
  const records = list.map((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ImportFileError(`item ${i + 1} is not an object`);
    }
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      headers.add(key);
      // Numbers and booleans become their text; nested values stay JSON so they fail validation
      // visibly instead of vanishing.
      record[key] = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
    }
    return record;
  });
  return { headers: [...headers], records };
}

function parseDelimited(text: string): Table {
  const firstLine = text.split('\n', 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );
  let rows: string[][];
  try {
    rows = parseCsv(text, {
      delimiter,
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      to: MAX_ROWS + 2,
    });
  } catch (err) {
    throw new ImportFileError(`the file is not valid CSV (${(err as Error).message})`);
  }
  const [headerRow = [], ...dataRows] = rows;
  const headers = headerRow.filter((h) => h !== '');
  const records = dataRows.map((row) =>
    Object.fromEntries(headerRow.map((h, i) => [h, row[i] ?? ''] as const).filter(([h]) => h)),
  );
  return { headers, records };
}

// Header spellings of common exports (Shopify, WooCommerce, generic sheets), compared after
// lower-casing and dropping everything that is not a letter or digit.
const ALIASES: Record<Field, string[]> = {
  sku: [
    'sku',
    'variantsku',
    'productsku',
    'itemsku',
    'productcode',
    'itemcode',
    'code',
    'partnumber',
    'articlenumber',
  ],
  name: ['name', 'title', 'productname', 'producttitle', 'itemname', 'product'],
  description: [
    'description',
    'bodyhtml',
    'body',
    'productdescription',
    'details',
    'longdescription',
    'shortdescription',
    'desc',
  ],
  category: [
    'category',
    'categories',
    'producttype',
    'type',
    'productcategory',
    'collection',
    'department',
  ],
  price: ['price', 'variantprice', 'regularprice', 'unitprice', 'retailprice', 'listprice'],
  priceCents: ['pricecents', 'priceminor', 'amountcents'],
  currency: ['currency', 'currencycode'],
  stock: [
    'stock',
    'variantinventoryqty',
    'stockquantity',
    'inventory',
    'inventoryquantity',
    'quantity',
    'qty',
    'onhand',
    'available',
  ],
  isActive: ['isactive', 'active', 'status', 'published', 'enabled', 'visible'],
};

const normalise = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Deterministic header matching; each column feeds at most one field. */
export function mapByAliases(headers: string[]): Mapping {
  const mapping: Mapping = {};
  const used = new Set<string>();
  for (const field of FIELDS) {
    for (const alias of ALIASES[field]) {
      const header = headers.find((h) => !used.has(h) && normalise(h) === alias);
      if (header !== undefined) {
        mapping[field] = header;
        used.add(header);
        break;
      }
    }
  }
  return mapping;
}

export function missingFields(mapping: Mapping): string[] {
  return [
    ...(mapping.sku === undefined ? ['sku'] : []),
    ...(mapping.name === undefined ? ['name'] : []),
    ...(mapping.price === undefined && mapping.priceCents === undefined ? ['price'] : []),
  ];
}

/** Row values for the mapped fields; empty cells count as absent. */
export function pick(
  record: Record<string, string>,
  mapping: Mapping,
): Partial<Record<Field, string>> {
  const values: Partial<Record<Field, string>> = {};
  for (const field of FIELDS) {
    const header = mapping[field];
    // hasOwn: a header like "constructor" must not reach Object.prototype.
    const value =
      header !== undefined && Object.hasOwn(record, header) ? record[header]?.trim() : undefined;
    if (value) values[field] = value;
  }
  return values;
}

/** "12.99", "$1,299.00", "EUR 5", "5 EUR" → minor units. Decimal commas are rejected as ambiguous. */
export function parsePrice(value: string): number | undefined {
  const m =
    /^(?:[A-Za-z]{3}\s*|[$€£]\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?:\s*[A-Za-z]{3})?$/.exec(
      value,
    );
  if (!m?.[1]) return undefined;
  return Number(m[1].replaceAll(',', '')) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

const TRUE = new Set(['true', 'yes', 'y', '1', 'active', 'published', 'enabled', 'visible']);
const FALSE = new Set([
  'false',
  'no',
  'n',
  '0',
  'inactive',
  'draft',
  'archived',
  'disabled',
  'hidden',
]);

export function parseBoolean(value: string): boolean | undefined {
  const v = value.toLowerCase();
  return TRUE.has(v) ? true : FALSE.has(v) ? false : undefined;
}

/** Exports often carry HTML descriptions; the catalog stores plain text. */
export const htmlToText = (value: string) =>
  value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

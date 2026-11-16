import type { CellValue, SheetSummary } from './workbook';
import { cellToString } from './workbook';
import type { FulfillmentType, ImportSourceType, Marketplace } from '../types/domain';

export interface ColumnCandidate {
  /** Header text as it appears in the file. */
  name: string;
  /** 0-based column index. */
  index: number;
  score: number;
  reason: string;
}

export interface HeaderDetection {
  headerRowIndex: number;
  headers: string[];
  confidence: number;
  /** Non-fatal observations worth telling the user about. */
  notes: string[];
}

export interface DetectionResult {
  header: HeaderDetection;
  skuCandidates: ColumnCandidate[];
  quantityCandidates: ColumnCandidate[];
  fulfillmentCandidates: ColumnCandidate[];
  descriptionCandidates: ColumnCandidate[];
  statusCandidates: ColumnCandidate[];
}

function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Picks the header row by scoring the first rows on how header-like they look:
 * mostly non-empty text cells, few numbers, distinct values.
 */
export function detectHeaderRow(rows: CellValue[][], maxScan = 25): HeaderDetection {
  const notes: string[] = [];
  let best: HeaderDetection = {
    headerRowIndex: 0,
    headers: [],
    confidence: 0,
    notes,
  };

  const limit = Math.min(rows.length, maxScan);
  for (let r = 0; r < limit; r += 1) {
    const row = rows[r] ?? [];
    const cells = row.map(cellToString);
    const nonEmpty = cells.filter((c) => c.length > 0);
    if (nonEmpty.length < 2) continue;

    const textCells = nonEmpty.filter((c) => !/^-?\d+(\.\d+)?$/.test(c));
    const distinct = new Set(nonEmpty.map((c) => c.toLowerCase())).size;

    // Density of filled cells relative to the widest row seen so far.
    const width = Math.max(...rows.slice(0, limit).map((x) => (x ?? []).length), 1);
    const density = nonEmpty.length / width;
    const textRatio = textCells.length / nonEmpty.length;
    const distinctRatio = distinct / nonEmpty.length;
    // Short-ish labels are typical of headers.
    const avgLength = nonEmpty.reduce((a, c) => a + c.length, 0) / nonEmpty.length;
    const lengthScore = avgLength > 0 && avgLength <= 40 ? 1 : 0.4;

    const score =
      density * 0.3 + textRatio * 0.3 + distinctRatio * 0.25 + lengthScore * 0.15;

    if (score > best.confidence) {
      best = {
        headerRowIndex: r,
        headers: cells.map((c, i) => c || `Column ${i + 1}`),
        confidence: Number(score.toFixed(3)),
        notes,
      };
    }
  }

  if (!best.headers.length && rows.length) {
    const row = rows[0] ?? [];
    best = {
      headerRowIndex: 0,
      headers: row.map((c, i) => cellToString(c) || `Column ${i + 1}`),
      confidence: 0,
      notes: ['No clear header row was detected. Verify the selection below.'],
    };
  }

  if (best.confidence > 0 && best.confidence < 0.55) {
    notes.push(
      `Header row detection is low-confidence (${Math.round(best.confidence * 100)}%). Confirm the row and columns before importing.`,
    );
  }

  const dupes = new Map<string, number>();
  for (const h of best.headers) {
    const key = h.toLowerCase();
    dupes.set(key, (dupes.get(key) ?? 0) + 1);
  }
  const repeated = [...dupes.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  if (repeated.length) {
    notes.push(
      `Duplicate column headers found (${repeated.slice(0, 3).join(', ')}). Columns are matched by position, so pick carefully.`,
    );
  }

  return best;
}

/* ------------------------------------------------------------------ *
 * SKU column detection
 * ------------------------------------------------------------------ */

const SKU_PATTERNS: Array<{ re: RegExp; score: number; reason: string }> = [
  // Seller-controlled identifiers. These are the SKUs we reconcile on.
  { re: /^sonic sku$/, score: 1.0, reason: 'Sonic SKU column' },
  { re: /^(seller|merchant) sku$/, score: 1.0, reason: 'Seller SKU column' },
  {
    re: /^(seller|merchant|my|our|vendor) (part|item|product|sku) ?(number|no|num|#|id|code)?$/,
    score: 0.99,
    reason: 'Seller part number — the seller-controlled SKU',
  },
  { re: /^sku$/, score: 0.98, reason: 'Exact "SKU" header' },
  { re: /^(sonic )?(master|item) sku$/, score: 0.98, reason: 'Master SKU column' },
  { re: /seller sku/, score: 0.95, reason: 'Contains "seller SKU"' },
  { re: /(seller|merchant|vendor) (part|item)/, score: 0.93, reason: 'Seller-side part identifier' },
  { re: /\bsku\b/, score: 0.85, reason: 'Contains "SKU"' },
  { re: /^item number$/, score: 0.8, reason: 'Item number column' },
  { re: /^(part|item|product) (number|no|code|id)$/, score: 0.75, reason: 'Product identifier column' },
  // Marketplace-assigned identifiers. Valid columns, but they are NOT the
  // seller SKU, so they must never outrank a seller-side identifier.
  {
    re: /^(newegg|amazon|marketplace) (item|product) ?(id|#|number|no)?$/,
    score: 0.4,
    reason: 'Marketplace-assigned item id, not the seller SKU',
  },
  { re: /^asin$/, score: 0.35, reason: 'ASIN is a marketplace identifier, not a seller SKU' },
  {
    re: /^(mfr|manufacturer|mfg) part ?(number|no|#)?$/,
    score: 0.3,
    reason: 'Manufacturer part number is shared across sellers, not a seller SKU',
  },
  { re: /^(upc|ean|gtin|isbn)$/, score: 0.2, reason: 'A barcode, not a seller SKU' },
];

/* ------------------------------------------------------------------ *
 * Quantity column detection
 *
 * Deliberately opinionated: marketplace exports carry several quantity
 * columns that are NOT interchangeable. Available/fulfillable quantity is
 * preferred, reserved/inbound/unfulfillable are explicitly demoted so they
 * are never auto-selected, and everything stays visible for the user to
 * override.
 * ------------------------------------------------------------------ */

const QUANTITY_PATTERNS: Array<{ re: RegExp; score: number; reason: string }> = [
  { re: /^(quantity )?available$/, score: 0.97, reason: 'Available quantity' },
  { re: /^available (quantity|qty|units)$/, score: 0.98, reason: 'Available quantity' },
  { re: /^(qty|quantity) available$/, score: 0.98, reason: 'Available quantity' },
  { re: /^afn fulfillable quantity$/, score: 0.9, reason: 'Amazon FBA fulfillable quantity' },
  { re: /^fulfillable quantity$/, score: 0.9, reason: 'Fulfillable quantity' },
  { re: /^(sonic )?(on hand|onhand) (quantity|qty)?$/, score: 0.9, reason: 'On-hand quantity' },
  { re: /^(instock|in stock) (quantity|qty)$/, score: 0.9, reason: 'In-stock quantity' },
  { re: /^(quantity|qty)$/, score: 0.88, reason: 'Generic quantity column' },
  { re: /^(inventory|stock) (quantity|qty|level)$/, score: 0.84, reason: 'Inventory quantity' },
  { re: /^(seller|merchant) quantity$/, score: 0.88, reason: 'Seller-held quantity' },
  { re: /^total (quantity|qty)$/, score: 0.55, reason: 'Total quantity may combine several pools' },
  { re: /^afn total quantity$/, score: 0.5, reason: 'FBA total includes reserved and inbound units' },
  // Explicitly demoted: present in exports but wrong to reconcile against.
  { re: /reserved/, score: 0.1, reason: 'Reserved quantity is not available stock' },
  { re: /inbound|in transit|intransit|shipped/, score: 0.08, reason: 'Inbound quantity is not available stock' },
  { re: /unfulfillable|unsellable|damaged|defective/, score: 0.05, reason: 'Unfulfillable quantity is not sellable stock' },
  { re: /researching|withdrawn/, score: 0.05, reason: 'Not available stock' },
  { re: /\b(min|max|minimum|maximum)\b/, score: 0.05, reason: 'A threshold, not a stock level' },
  { re: /(order|sold|sales|shipped) (quantity|qty|units)/, score: 0.1, reason: 'Order volume, not stock' },
  { re: /\bqty\b|\bquantity\b|\bunits\b/, score: 0.6, reason: 'Contains a quantity term' },
];

const FULFILLMENT_PATTERNS: Array<{ re: RegExp; score: number; reason: string }> = [
  { re: /^fulfillment (channel|method|type|by)$/, score: 1.0, reason: 'Fulfillment channel column' },
  { re: /^(shipped by|ships from|shipping by)$/, score: 0.95, reason: 'Shipping responsibility column' },
  { re: /^(shipped|fulfilled) by$/, score: 0.95, reason: 'Fulfillment responsibility column' },
  { re: /fulfillment/, score: 0.85, reason: 'Contains "fulfillment"' },
  { re: /^(sbn|shipped by newegg)/, score: 0.9, reason: 'Shipped by Newegg indicator' },
  { re: /^(fba|fbm|mfn|afn)$/, score: 0.8, reason: 'Fulfillment code column' },
  { re: /warehouse/, score: 0.4, reason: 'Possibly fulfillment-related' },
];

const DESCRIPTION_PATTERNS: Array<{ re: RegExp; score: number; reason: string }> = [
  { re: /^(item|product) (name|title|description)$/, score: 1.0, reason: 'Product name column' },
  { re: /^(title|description)$/, score: 0.95, reason: 'Title/description column' },
  { re: /^(subject|listing title)$/, score: 0.8, reason: 'Listing title column' },
  { re: /(name|title|description)/, score: 0.6, reason: 'Contains a descriptive term' },
];

const STATUS_PATTERNS: Array<{ re: RegExp; score: number; reason: string }> = [
  { re: /^(listing |item )?status$/, score: 1.0, reason: 'Listing status column' },
  { re: /^(active|activation) (status|flag)$/, score: 0.95, reason: 'Activation column' },
  { re: /^(shipping )?(activation|active)$/, score: 0.75, reason: 'Active flag column' },
  { re: /status/, score: 0.6, reason: 'Contains "status"' },
];

function scoreColumns(
  headers: string[],
  patterns: Array<{ re: RegExp; score: number; reason: string }>,
  sampleBoost?: (index: number) => { delta: number; reason: string } | null,
): ColumnCandidate[] {
  const out: ColumnCandidate[] = [];
  headers.forEach((header, index) => {
    const n = norm(header);
    if (!n) return;
    let best: { score: number; reason: string } | null = null;
    for (const p of patterns) {
      if (p.re.test(n) && (!best || p.score > best.score)) {
        best = { score: p.score, reason: p.reason };
      }
    }
    if (!best) return;
    let score = best.score;
    let reason = best.reason;
    const boost = sampleBoost?.(index);
    if (boost) {
      score = Math.max(0, Math.min(1, score + boost.delta));
      reason = `${reason}; ${boost.reason}`;
    }
    out.push({ name: header, index, score: Number(score.toFixed(3)), reason });
  });
  return out.sort((a, b) => b.score - a.score);
}

/** Rows after the header, used to sanity-check candidate columns. */
function dataSample(rows: CellValue[][], headerRowIndex: number, limit = 20): CellValue[][] {
  return rows.slice(headerRowIndex + 1, headerRowIndex + 1 + limit);
}

export function detectColumns(
  rows: CellValue[][],
  header: HeaderDetection,
): DetectionResult {
  const sample = dataSample(rows, header.headerRowIndex);

  const columnStats = (index: number) => {
    const values = sample.map((r) => cellToString(r?.[index] ?? null)).filter((v) => v.length > 0);
    const numeric = values.filter((v) => /^-?\d+(\.\d+)?$/.test(v.replace(/[\s,]/g, '')));
    const distinct = new Set(values).size;
    return {
      filled: values.length,
      total: sample.length,
      numericRatio: values.length ? numeric.length / values.length : 0,
      distinctRatio: values.length ? distinct / values.length : 0,
      avgLength: values.length ? values.reduce((a, v) => a + v.length, 0) / values.length : 0,
    };
  };

  const skuCandidates = scoreColumns(header.headers, SKU_PATTERNS, (i) => {
    const s = columnStats(i);
    if (!s.filled) return { delta: -0.3, reason: 'column is empty in the sampled rows' };
    // SKUs are highly distinct and usually not purely numeric.
    if (s.distinctRatio > 0.9 && s.numericRatio < 0.9) {
      return { delta: 0.03, reason: 'values look like unique identifiers' };
    }
    if (s.distinctRatio < 0.4) {
      return { delta: -0.25, reason: 'values repeat often, unlikely to be a SKU' };
    }
    return null;
  });

  // Does this file mix channel-specific quantity pools with a plain one?
  const hasChannelQuantity = header.headers.some((h) => /^(afn|mfn)\b/.test(norm(h)));
  const hasPlainQuantity = header.headers.some((h) => /^(quantity|qty)$/.test(norm(h)));
  const mixedChannelReport = hasChannelQuantity && hasPlainQuantity;

  const quantityCandidates = scoreColumns(header.headers, QUANTITY_PATTERNS, (i) => {
    const s = columnStats(i);
    const name = norm(header.headers[i] ?? '');
    if (!s.filled) return { delta: -0.35, reason: 'column is empty in the sampled rows' };
    if (s.numericRatio < 0.6) {
      return { delta: -0.4, reason: 'values are mostly non-numeric' };
    }
    if (mixedChannelReport) {
      if (/^(quantity|qty)$/.test(name)) {
        return {
          delta: 0.09,
          reason: 'this report also lists marketplace-held (AFN) pools, so this is the seller-held quantity',
        };
      }
      if (/^(afn|mfn)\b/.test(name)) {
        return {
          delta: -0.15,
          reason: 'describes one fulfillment channel only; the plain quantity column covers seller-held stock',
        };
      }
    }
    return null;
  });

  const fulfillmentCandidates = scoreColumns(header.headers, FULFILLMENT_PATTERNS, (i) => {
    const s = columnStats(i);
    if (!s.filled) return { delta: -0.3, reason: 'column is empty in the sampled rows' };
    return null;
  });

  const descriptionCandidates = scoreColumns(header.headers, DESCRIPTION_PATTERNS, (i) => {
    const s = columnStats(i);
    if (s.avgLength > 15) return { delta: 0.05, reason: 'values are long text' };
    return null;
  });

  const statusCandidates = scoreColumns(header.headers, STATUS_PATTERNS, (i) => {
    const s = columnStats(i);
    if (s.distinctRatio > 0.5) {
      return { delta: -0.3, reason: 'too many distinct values for a status column' };
    }
    return null;
  });

  return {
    header,
    skuCandidates,
    quantityCandidates,
    fulfillmentCandidates,
    descriptionCandidates,
    statusCandidates,
  };
}

/**
 * Picks the most likely worksheet in a multi-sheet workbook: the one with the
 * most data rows that also has a plausible header.
 */
export function suggestSheet(sheets: Record<string, SheetSummary>, names: string[]): string | null {
  let bestName: string | null = null;
  let bestScore = -1;
  for (const name of names) {
    const sheet = sheets[name];
    if (!sheet || sheet.totalRows < 2) continue;
    const header = detectHeaderRow(sheet.previewRows);
    const sizeScore = Math.min(1, sheet.totalRows / 500);
    const lowered = name.toLowerCase();
    const nameBoost = /inventory|stock|report|listing|item|sku|all listings/.test(lowered)
      ? 0.2
      : /instruction|readme|help|definition|legend|template/.test(lowered)
        ? -0.6
        : 0;
    const score = header.confidence * 0.6 + sizeScore * 0.3 + nameBoost;
    if (score > bestScore) {
      bestScore = score;
      bestName = name;
    }
  }
  return bestName ?? names[0] ?? null;
}

/* ------------------------------------------------------------------ *
 * Fulfillment classification
 * ------------------------------------------------------------------ */

/**
 * Maps a raw fulfillment cell value to a classification.
 * Returns 'unknown' when the value is not recognized — never a guess.
 */
export function classifyFulfillment(
  raw: string,
  marketplace: Marketplace | null,
): FulfillmentType {
  const v = norm(raw);
  if (!v) return 'unknown';

  if (marketplace === 'amazon' || marketplace === null) {
    // Amazon exports use AMAZON_NA / AMAZON_* for FBA and DEFAULT / MFN for FBM.
    if (/^amazon/.test(v) || v === 'afn' || v === 'fba' || /fulfilled by amazon/.test(v)) {
      return 'marketplace_fulfilled';
    }
    if (v === 'default' || v === 'mfn' || v === 'fbm' || /merchant|seller/.test(v)) {
      return 'seller_fulfilled';
    }
  }

  if (marketplace === 'newegg' || marketplace === null) {
    // Newegg: "Shipped by Newegg" (SBN) vs "Shipped by Seller".
    if (/shipped by newegg|^sbn$|newegg fulfill|fulfilled by newegg/.test(v)) {
      return 'marketplace_fulfilled';
    }
    if (/shipped by seller|^sbs$|seller fulfill|drop ?ship|self ?ship/.test(v)) {
      return 'seller_fulfilled';
    }
  }

  // Generic last resort, still conservative.
  if (/^(merchant|seller|self)$/.test(v)) return 'seller_fulfilled';
  if (/^(marketplace|platform)$/.test(v)) return 'marketplace_fulfilled';

  return 'unknown';
}

/** Interprets a listing status cell. null when the value is not recognized. */
export function classifyActive(raw: string): boolean | null {
  const v = norm(raw);
  if (!v) return null;
  if (/^(active|enabled|live|listed|yes|y|true|1|published|in stock|activated)$/.test(v)) return true;
  if (/^(inactive|disabled|unlisted|no|n|false|0|suspended|ended|closed|deactivated|out of stock|incomplete)$/.test(v)) {
    return false;
  }
  if (/\bactive\b/.test(v) && !/inactive/.test(v)) return true;
  if (/inactive|suspend|disabl/.test(v)) return false;
  return null;
}

export function requiredColumnsFor(sourceType: ImportSourceType): string[] {
  return sourceType === 'sonic'
    ? ['Sonic master SKU', 'Sonic quantity']
    : ['Marketplace SKU', 'Marketplace quantity'];
}

/** Stable fingerprint of a header set, used to recognize a known file layout. */
export function headerSignature(headers: string[]): string {
  const cleaned = headers
    .map((h) => norm(h))
    .filter((h) => h.length > 0)
    .sort();
  // Simple FNV-1a so the signature stays short and comparable.
  let hash = 0x811c9dc5;
  const text = cleaned.join('|');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${cleaned.length}-${hash.toString(16)}`;
}

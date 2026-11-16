import { db } from '../db/database';
import {
  type FulfillmentType,
  type ImportMode,
  type ImportRun,
  type ImportSourceType,
  type ImportValidationIssue,
  type Marketplace,
  type MarketplaceListing,
  type SonicItem,
} from '../types/domain';
import { normalizeSku } from '../utils/sku';
import { classifyActive, classifyFulfillment } from './detection';
import { cellToQuantity, cellToString, type CellValue } from './workbook';

export interface ColumnSelection {
  skuColumn: number;
  quantityColumn: number;
  descriptionColumn: number | null;
  fulfillmentColumn: number | null;
  statusColumn: number | null;
  extraColumns: number[];
}

export interface ImportContext {
  sourceType: ImportSourceType;
  marketplace: Marketplace | null;
  accountId: string | null;
  /** Used when a marketplace file carries no fulfillment column. */
  accountDefaultFulfillment: FulfillmentType | 'none';
  mode: ImportMode;
  fileName: string;
  fileSize: number;
  sheetName: string | null;
  headers: string[];
  headerRowIndex: number;
  selection: ColumnSelection;
  profileId: number | null;
  profileName: string | null;
}

/** One parsed, validated row ready to be upserted. */
export interface ParsedRow {
  rowNumber: number;
  sku: string;
  quantity: number | null;
  description: string | null;
  fulfillmentRaw: string | null;
  fulfillmentType: FulfillmentType;
  statusRaw: string | null;
  active: boolean | null;
  extra: Record<string, string | number | null>;
}

export interface ParseSummary {
  totalRows: number;
  rows: ParsedRow[];
  issues: ImportValidationIssue[];
  /** SKUs appearing more than once in this file, with their occurrence count. */
  duplicateSkus: Array<{ sku: string; count: number; rowNumbers: number[] }>;
  missingSkuRows: number;
  missingQuantityRows: number;
  unknownFulfillmentRows: number;
}

const MAX_ISSUES_STORED = 500;

/**
 * Converts raw sheet rows into validated records.
 * Nothing is discarded silently: every rejected row produces an issue.
 *
 * Duplicate SKUs within one file are collapsed to the LAST occurrence, and the
 * duplication is reported so the user can see it in the preview.
 */
export function parseRows(rows: CellValue[][], ctx: ImportContext): ParseSummary {
  const { selection, headers, headerRowIndex } = ctx;
  const issues: ImportValidationIssue[] = [];
  const byNormalizedSku = new Map<string, ParsedRow>();
  const occurrences = new Map<string, { sku: string; rowNumbers: number[] }>();

  let missingSkuRows = 0;
  let missingQuantityRows = 0;
  let unknownFulfillmentRows = 0;
  let totalRows = 0;

  const pushIssue = (issue: ImportValidationIssue) => {
    if (issues.length < MAX_ISSUES_STORED) issues.push(issue);
  };

  for (let r = headerRowIndex + 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (!row) continue;
    // Spreadsheet row number as the user sees it in Excel (1-based).
    const rowNumber = r + 1;

    const hasAnyValue = row.some((cell) => cellToString(cell).length > 0);
    if (!hasAnyValue) continue;
    totalRows += 1;

    const sku = cellToString(row[selection.skuColumn] ?? null);
    if (!sku) {
      missingSkuRows += 1;
      pushIssue({
        rowNumber,
        field: headers[selection.skuColumn] ?? 'SKU',
        message: 'Row skipped: SKU value is empty.',
        rawValue: null,
      });
      continue;
    }

    const rawQuantityCell = row[selection.quantityColumn] ?? null;
    const { quantity, error: quantityError } = cellToQuantity(rawQuantityCell);
    if (quantity === null) {
      missingQuantityRows += 1;
      pushIssue({
        rowNumber,
        field: headers[selection.quantityColumn] ?? 'Quantity',
        message:
          quantityError === 'empty'
            ? 'Quantity is empty. Stored as unknown rather than zero.'
            : `Quantity could not be read: ${quantityError}. Stored as unknown.`,
        rawValue: cellToString(rawQuantityCell) || null,
      });
    }

    const description =
      selection.descriptionColumn !== null
        ? cellToString(row[selection.descriptionColumn] ?? null) || null
        : null;

    const fulfillmentRaw =
      selection.fulfillmentColumn !== null
        ? cellToString(row[selection.fulfillmentColumn] ?? null) || null
        : null;

    let fulfillmentType: FulfillmentType = 'unknown';
    if (ctx.sourceType === 'marketplace') {
      if (fulfillmentRaw) {
        fulfillmentType = classifyFulfillment(fulfillmentRaw, ctx.marketplace);
        if (fulfillmentType === 'unknown') {
          pushIssue({
            rowNumber,
            field: headers[selection.fulfillmentColumn ?? 0] ?? 'Fulfillment',
            message: `Fulfillment value "${fulfillmentRaw}" was not recognized. Flagged for review.`,
            rawValue: fulfillmentRaw,
          });
        }
      } else if (ctx.accountDefaultFulfillment !== 'none') {
        fulfillmentType = ctx.accountDefaultFulfillment;
      }
      if (fulfillmentType === 'unknown') unknownFulfillmentRows += 1;
    }

    const statusRaw =
      selection.statusColumn !== null
        ? cellToString(row[selection.statusColumn] ?? null) || null
        : null;
    const active = statusRaw ? classifyActive(statusRaw) : null;

    const extra: Record<string, string | number | null> = {};
    for (const idx of selection.extraColumns) {
      const key = headers[idx] ?? `Column ${idx + 1}`;
      const cell = row[idx] ?? null;
      extra[key] = typeof cell === 'number' ? cell : cellToString(cell) || null;
    }

    const parsed: ParsedRow = {
      rowNumber,
      sku,
      quantity,
      description,
      fulfillmentRaw,
      fulfillmentType,
      statusRaw,
      active,
      extra,
    };

    const key = normalizeSku(sku);
    const seen = occurrences.get(key);
    if (seen) {
      seen.rowNumbers.push(rowNumber);
      pushIssue({
        rowNumber,
        field: headers[selection.skuColumn] ?? 'SKU',
        message: `Duplicate SKU "${sku}" within this file. The last occurrence (row ${rowNumber}) will be used.`,
        rawValue: sku,
      });
    } else {
      occurrences.set(key, { sku, rowNumbers: [rowNumber] });
    }
    // Last occurrence wins.
    byNormalizedSku.set(key, parsed);
  }

  const duplicateSkus = [...occurrences.values()]
    .filter((o) => o.rowNumbers.length > 1)
    .map((o) => ({ sku: o.sku, count: o.rowNumbers.length, rowNumbers: o.rowNumbers }))
    .sort((a, b) => b.count - a.count);

  return {
    totalRows,
    rows: [...byNormalizedSku.values()],
    issues,
    duplicateSkus,
    missingSkuRows,
    missingQuantityRows,
    unknownFulfillmentRows,
  };
}

/* ------------------------------------------------------------------ *
 * Preview — computed against the database WITHOUT writing anything.
 * ------------------------------------------------------------------ */

export interface SuspiciousChange {
  sku: string;
  previous: number | null;
  next: number | null;
  reason: string;
}

export interface ImportPreview {
  parse: ParseSummary;
  toAdd: number;
  toUpdate: number;
  unchanged: number;
  /** Records known to the app but absent from this file. */
  knownNotInFile: number;
  /** Only meaningful for a full snapshot: these will be marked out of snapshot. */
  willMarkAbsent: number;
  suspicious: SuspiciousChange[];
  sampleAdds: ParsedRow[];
  sampleUpdates: Array<{ row: ParsedRow; previousQuantity: number | null }>;
}

/** Threshold beyond which a quantity change is called out for review. */
const SUSPICIOUS_DROP_RATIO = 0.9;
const SUSPICIOUS_MIN_PREVIOUS = 10;
const MAX_SUSPICIOUS = 200;

export async function buildPreview(
  parse: ParseSummary,
  ctx: ImportContext,
): Promise<ImportPreview> {
  let toAdd = 0;
  let toUpdate = 0;
  let unchanged = 0;
  const suspicious: SuspiciousChange[] = [];
  const sampleAdds: ParsedRow[] = [];
  const sampleUpdates: Array<{ row: ParsedRow; previousQuantity: number | null }> = [];

  const isSonic = ctx.sourceType === 'sonic';
  const presentKeys = new Set<string>();

  for (const row of parse.rows) {
    const key = isSonic
      ? row.sku
      : listingId(ctx.marketplace as Marketplace, ctx.accountId as string, row.sku);
    presentKeys.add(key);

    const existing = isSonic
      ? await db.sonicItems.get(row.sku)
      : await db.listings.get(key);

    if (!existing) {
      toAdd += 1;
      if (sampleAdds.length < 25) sampleAdds.push(row);
      continue;
    }

    const previousQuantity = existing.quantity;
    const changed =
      previousQuantity !== row.quantity ||
      (isSonic
        ? (existing as SonicItem).description !== row.description
        : (existing as MarketplaceListing).fulfillment.type !== row.fulfillmentType ||
          (existing as MarketplaceListing).active !== row.active);

    if (changed) {
      toUpdate += 1;
      if (sampleUpdates.length < 25) sampleUpdates.push({ row, previousQuantity });

      if (
        suspicious.length < MAX_SUSPICIOUS &&
        previousQuantity !== null &&
        previousQuantity >= SUSPICIOUS_MIN_PREVIOUS
      ) {
        if (row.quantity === 0) {
          suspicious.push({
            sku: row.sku,
            previous: previousQuantity,
            next: 0,
            reason: `Drops from ${previousQuantity} to 0`,
          });
        } else if (
          row.quantity !== null &&
          row.quantity < previousQuantity * (1 - SUSPICIOUS_DROP_RATIO)
        ) {
          suspicious.push({
            sku: row.sku,
            previous: previousQuantity,
            next: row.quantity,
            reason: `Drops by more than ${Math.round(SUSPICIOUS_DROP_RATIO * 100)}%`,
          });
        } else if (row.quantity === null) {
          suspicious.push({
            sku: row.sku,
            previous: previousQuantity,
            next: null,
            reason: 'Known quantity becomes unknown',
          });
        }
      }
    } else {
      unchanged += 1;
    }
  }

  // How many existing records this file does not mention.
  let knownTotal = 0;
  if (isSonic) {
    knownTotal = await db.sonicItems.count();
  } else {
    knownTotal = await db.listings
      .where('[marketplace+accountId]')
      .equals([ctx.marketplace as Marketplace, ctx.accountId as string])
      .count();
  }
  const knownNotInFile = Math.max(0, knownTotal - (toUpdate + unchanged));

  return {
    parse,
    toAdd,
    toUpdate,
    unchanged,
    knownNotInFile,
    willMarkAbsent: ctx.mode === 'full_snapshot' ? knownNotInFile : 0,
    suspicious,
    sampleAdds,
    sampleUpdates,
  };
}

export function listingId(
  marketplace: Marketplace,
  accountId: string,
  sku: string,
): string {
  return `${marketplace}|${accountId}|${sku}`;
}

/* ------------------------------------------------------------------ *
 * Commit — transactional upsert.
 * ------------------------------------------------------------------ */

export interface CommitResult {
  importRunId: number;
  recordsAdded: number;
  recordsUpdated: number;
  recordsUnchanged: number;
  recordsMissingFromSnapshot: number;
}

const CHUNK_SIZE = 2000;

export async function commitImport(
  parse: ParseSummary,
  ctx: ImportContext,
  onProgress?: (done: number, total: number) => void,
): Promise<CommitResult> {
  const startedAt = Date.now();

  // Create the run row first so records can reference its id.
  const runId = (await db.importRuns.add({
    startedAt,
    finishedAt: null,
    sourceType: ctx.sourceType,
    marketplace: ctx.marketplace,
    accountId: ctx.accountId,
    fileName: ctx.fileName,
    fileSize: ctx.fileSize,
    sheetName: ctx.sheetName,
    mode: ctx.mode,
    profileId: ctx.profileId,
    profileName: ctx.profileName,
    columnMapping: describeSelection(ctx),
    totalRows: parse.totalRows,
    validRows: parse.rows.length,
    invalidRows: parse.missingSkuRows,
    duplicateSkuRows: parse.duplicateSkus.reduce((a, d) => a + d.count - 1, 0),
    recordsAdded: 0,
    recordsUpdated: 0,
    recordsUnchanged: 0,
    recordsMissingFromSnapshot: 0,
    status: 'committed',
    errorMessage: null,
    issues: parse.issues,
  } as ImportRun)) as number;

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const now = Date.now();

  try {
    if (ctx.sourceType === 'sonic') {
      const result = await commitSonic(parse, ctx, runId, now, onProgress);
      added = result.added;
      updated = result.updated;
      unchanged = result.unchanged;
    } else {
      const result = await commitListings(parse, ctx, runId, now, onProgress);
      added = result.added;
      updated = result.updated;
      unchanged = result.unchanged;
    }

    // Snapshot bookkeeping: only a FULL snapshot can mark records absent, and
    // absence is a flag — records are never deleted.
    let missing = 0;
    if (ctx.mode === 'full_snapshot') {
      missing = await markSnapshotAbsence(parse, ctx, now);
    }

    await db.importRuns.update(runId, {
      finishedAt: Date.now(),
      recordsAdded: added,
      recordsUpdated: updated,
      recordsUnchanged: unchanged,
      recordsMissingFromSnapshot: missing,
    });

    return {
      importRunId: runId,
      recordsAdded: added,
      recordsUpdated: updated,
      recordsUnchanged: unchanged,
      recordsMissingFromSnapshot: missing,
    };
  } catch (err) {
    await db.importRuns.update(runId, {
      finishedAt: Date.now(),
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : 'Unknown error during import.',
    });
    throw err;
  }
}

function describeSelection(ctx: ImportContext): Record<string, string | null> {
  const h = (i: number | null) => (i === null ? null : (ctx.headers[i] ?? `Column ${i + 1}`));
  return {
    sku: h(ctx.selection.skuColumn),
    quantity: h(ctx.selection.quantityColumn),
    description: h(ctx.selection.descriptionColumn),
    fulfillment: h(ctx.selection.fulfillmentColumn),
    status: h(ctx.selection.statusColumn),
  };
}

async function commitSonic(
  parse: ParseSummary,
  _ctx: ImportContext,
  runId: number,
  now: number,
  onProgress?: (done: number, total: number) => void,
): Promise<{ added: number; updated: number; unchanged: number }> {
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const total = parse.rows.length;
  let done = 0;

  for (let i = 0; i < parse.rows.length; i += CHUNK_SIZE) {
    const chunk = parse.rows.slice(i, i + CHUNK_SIZE);
    await db.transaction('rw', db.sonicItems, async () => {
      const keys = chunk.map((r) => r.sku);
      const existingRows = await db.sonicItems.bulkGet(keys);
      const puts: SonicItem[] = [];

      chunk.forEach((row, idx) => {
        const existing = existingRows[idx];
        if (!existing) {
          added += 1;
          puts.push({
            sku: row.sku,
            skuNormalized: normalizeSku(row.sku),
            description: row.description,
            quantity: row.quantity,
            extra: row.extra,
            firstImportId: runId,
            lastImportId: runId,
            lastSeenAt: now,
            inLatestSnapshot: null,
            createdAt: now,
            updatedAt: now,
          });
          return;
        }

        const changed =
          existing.quantity !== row.quantity ||
          (row.description !== null && existing.description !== row.description);
        if (changed) updated += 1;
        else unchanged += 1;

        puts.push({
          ...existing,
          // Keep a previously known description if this file has none.
          description: row.description ?? existing.description,
          quantity: row.quantity,
          extra: { ...existing.extra, ...row.extra },
          lastImportId: runId,
          lastSeenAt: now,
          updatedAt: changed ? now : existing.updatedAt,
        });
      });

      await db.sonicItems.bulkPut(puts);
    });
    done += chunk.length;
    onProgress?.(done, total);
  }

  return { added, updated, unchanged };
}

async function commitListings(
  parse: ParseSummary,
  ctx: ImportContext,
  runId: number,
  now: number,
  onProgress?: (done: number, total: number) => void,
): Promise<{ added: number; updated: number; unchanged: number }> {
  const marketplace = ctx.marketplace as Marketplace;
  const accountId = ctx.accountId as string;
  const quantityField = ctx.headers[ctx.selection.quantityColumn] ?? null;

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const total = parse.rows.length;
  let done = 0;

  for (let i = 0; i < parse.rows.length; i += CHUNK_SIZE) {
    const chunk = parse.rows.slice(i, i + CHUNK_SIZE);
    await db.transaction('rw', db.listings, async () => {
      const keys = chunk.map((r) => listingId(marketplace, accountId, r.sku));
      const existingRows = await db.listings.bulkGet(keys);
      const puts: MarketplaceListing[] = [];

      chunk.forEach((row, idx) => {
        const id = keys[idx] as string;
        const existing = existingRows[idx];
        if (!existing) {
          added += 1;
          puts.push({
            id,
            marketplace,
            accountId,
            sku: row.sku,
            skuNormalized: normalizeSku(row.sku),
            title: row.description,
            quantity: row.quantity,
            quantityField,
            fulfillment: { type: row.fulfillmentType, rawValue: row.fulfillmentRaw },
            statusRaw: row.statusRaw,
            active: row.active,
            extra: row.extra,
            firstImportId: runId,
            lastImportId: runId,
            lastSeenAt: now,
            inLatestSnapshot: null,
            createdAt: now,
            updatedAt: now,
          });
          return;
        }

        // Do not downgrade a known fulfillment type to 'unknown' on a file
        // that simply lacks the column.
        const nextFulfillment =
          row.fulfillmentType === 'unknown' && existing.fulfillment.type !== 'unknown'
            ? existing.fulfillment
            : { type: row.fulfillmentType, rawValue: row.fulfillmentRaw };

        const nextActive = row.active ?? existing.active;

        const changed =
          existing.quantity !== row.quantity ||
          existing.fulfillment.type !== nextFulfillment.type ||
          existing.active !== nextActive ||
          (row.description !== null && existing.title !== row.description);

        if (changed) updated += 1;
        else unchanged += 1;

        puts.push({
          ...existing,
          title: row.description ?? existing.title,
          quantity: row.quantity,
          quantityField,
          fulfillment: nextFulfillment,
          statusRaw: row.statusRaw ?? existing.statusRaw,
          active: nextActive,
          extra: { ...existing.extra, ...row.extra },
          lastImportId: runId,
          lastSeenAt: now,
          updatedAt: changed ? now : existing.updatedAt,
        });
      });

      await db.listings.bulkPut(puts);
    });
    done += chunk.length;
    onProgress?.(done, total);
  }

  return { added, updated, unchanged };
}

/**
 * Marks which records were present in this full snapshot.
 * Records absent from the snapshot get inLatestSnapshot = false — they are
 * NOT deleted, and their last known quantity is preserved.
 */
async function markSnapshotAbsence(
  parse: ParseSummary,
  ctx: ImportContext,
  now: number,
): Promise<number> {
  const present = new Set(parse.rows.map((r) => r.sku));
  let missing = 0;

  if (ctx.sourceType === 'sonic') {
    const absentUpdates: Array<[string, boolean]> = [];
    await db.sonicItems.each((item) => {
      absentUpdates.push([item.sku, present.has(item.sku)]);
    });
    for (let i = 0; i < absentUpdates.length; i += CHUNK_SIZE) {
      const chunk = absentUpdates.slice(i, i + CHUNK_SIZE);
      await db.transaction('rw', db.sonicItems, async () => {
        const rows = await db.sonicItems.bulkGet(chunk.map(([sku]) => sku));
        const puts: SonicItem[] = [];
        rows.forEach((row, idx) => {
          if (!row) return;
          const inSnapshot = chunk[idx]?.[1] ?? false;
          if (!inSnapshot) missing += 1;
          if (row.inLatestSnapshot !== inSnapshot) {
            puts.push({ ...row, inLatestSnapshot: inSnapshot, updatedAt: now });
          }
        });
        if (puts.length) await db.sonicItems.bulkPut(puts);
      });
    }
    return missing;
  }

  const marketplace = ctx.marketplace as Marketplace;
  const accountId = ctx.accountId as string;
  const ids: Array<[string, boolean]> = [];
  await db.listings
    .where('[marketplace+accountId]')
    .equals([marketplace, accountId])
    .each((listing) => {
      ids.push([listing.id, present.has(listing.sku)]);
    });

  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    await db.transaction('rw', db.listings, async () => {
      const rows = await db.listings.bulkGet(chunk.map(([id]) => id));
      const puts: MarketplaceListing[] = [];
      rows.forEach((row, idx) => {
        if (!row) return;
        const inSnapshot = chunk[idx]?.[1] ?? false;
        if (!inSnapshot) missing += 1;
        if (row.inLatestSnapshot !== inSnapshot) {
          puts.push({ ...row, inLatestSnapshot: inSnapshot, updatedAt: now });
        }
      });
      if (puts.length) await db.listings.bulkPut(puts);
    });
  }
  return missing;
}

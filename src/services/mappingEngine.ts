import { db } from '../db/database';
import type {
  Marketplace,
  MarketplaceListing,
  MappingMethod,
  SkuMapping,
  SonicItem,
} from '../types/domain';
import { baseSkuCandidates, compactSku, normalizeSku, scoreSkuMatch } from '../utils/sku';

export interface MappingSuggestion {
  listingId: string;
  listingSku: string;
  marketplace: Marketplace;
  accountId: string;
  masterSku: string;
  method: MappingMethod;
  confidence: number;
  rationale: string;
}

export interface SuggestionRunResult {
  listingsScanned: number;
  exactCreated: number;
  normalizedCreated: number;
  fuzzyCreated: number;
  skippedAlreadyMapped: number;
  noCandidate: number;
}

/**
 * In-memory index of Sonic SKUs used to find candidates without scanning the
 * whole table per listing. For ~98k SKUs this is a few MB and far cheaper than
 * 98k index lookups per listing.
 */
interface SonicIndex {
  byNormalized: Map<string, string>;
  byCompact: Map<string, string>;
  /** Grouped by compact prefix so fuzzy search only visits plausible rows. */
  byPrefix: Map<string, string[]>;
  total: number;
}

const PREFIX_LENGTH = 4;

export async function buildSonicIndex(): Promise<SonicIndex> {
  const byNormalized = new Map<string, string>();
  const byCompact = new Map<string, string>();
  const byPrefix = new Map<string, string[]>();
  let total = 0;

  await db.sonicItems.each((item: SonicItem) => {
    total += 1;
    const n = item.skuNormalized || normalizeSku(item.sku);
    const c = compactSku(item.sku);
    if (!byNormalized.has(n)) byNormalized.set(n, item.sku);
    if (!byCompact.has(c)) byCompact.set(c, item.sku);
    const prefix = c.slice(0, PREFIX_LENGTH);
    const bucket = byPrefix.get(prefix);
    if (bucket) bucket.push(item.sku);
    else byPrefix.set(prefix, [item.sku]);
  });

  return { byNormalized, byCompact, byPrefix, total };
}

const MAX_FUZZY_BUCKET = 400;

/**
 * Finds the best master SKU candidates for one marketplace SKU.
 * Returns candidates sorted by confidence, highest first.
 */
export function findCandidates(
  listingSku: string,
  index: SonicIndex,
  limit = 5,
): Array<{ masterSku: string; confidence: number; method: MappingMethod; rationale: string }> {
  const out: Array<{
    masterSku: string;
    confidence: number;
    method: MappingMethod;
    rationale: string;
  }> = [];
  const seen = new Set<string>();

  const add = (
    masterSku: string,
    confidence: number,
    method: MappingMethod,
    rationale: string,
  ) => {
    if (seen.has(masterSku)) return;
    seen.add(masterSku);
    out.push({ masterSku, confidence, method, rationale });
  };

  const normalized = normalizeSku(listingSku);
  const compact = compactSku(listingSku);

  // 1. Exact (case/whitespace-insensitive) match on the complete SKU.
  const exact = index.byNormalized.get(normalized);
  if (exact) add(exact, 1, 'exact', 'Marketplace SKU matches the Sonic SKU exactly.');

  const compactHit = index.byCompact.get(compact);
  if (compactHit) {
    add(
      compactHit,
      0.99,
      'normalized',
      'Marketplace SKU matches the Sonic SKU ignoring punctuation and case.',
    );
  }

  // 2. Base-SKU match after peeling a listing suffix (the one-to-many case).
  const candidates = baseSkuCandidates(listingSku);
  for (let i = 1; i < candidates.length; i += 1) {
    const base = candidates[i] as string;
    const baseNorm = normalizeSku(base);
    const baseCompact = compactSku(base);
    const hitN = index.byNormalized.get(baseNorm);
    if (hitN) {
      add(
        hitN,
        0.97,
        'normalized',
        `Listing suffix removed ("${listingSku}" → "${base}") matches a Sonic SKU.`,
      );
    }
    const hitC = index.byCompact.get(baseCompact);
    if (hitC) {
      add(
        hitC,
        0.95,
        'normalized',
        `Listing suffix removed and punctuation ignored ("${base}") matches a Sonic SKU.`,
      );
    }
  }

  // 3. Fuzzy, limited to the matching compact prefix bucket.
  if (out.length < limit) {
    const prefixes = new Set<string>();
    for (const c of candidates) {
      const cc = compactSku(c);
      if (cc.length >= PREFIX_LENGTH) prefixes.add(cc.slice(0, PREFIX_LENGTH));
    }
    for (const prefix of prefixes) {
      const bucket = index.byPrefix.get(prefix);
      if (!bucket || bucket.length > MAX_FUZZY_BUCKET) continue;
      for (const masterSku of bucket) {
        if (seen.has(masterSku)) continue;
        const score = scoreSkuMatch(listingSku, masterSku);
        if (score >= 0.7) {
          add(
            masterSku,
            Number(score.toFixed(3)),
            'fuzzy',
            `Similar SKU (${Math.round(score * 100)}% similarity). Review before approving.`,
          );
        }
      }
    }
  }

  return out.sort((a, b) => b.confidence - a.confidence).slice(0, limit);
}

/**
 * Generates mapping suggestions for listings that have no mapping yet.
 *
 * Rules enforced here:
 *  - A listing that already has an approved or rejected mapping is left alone.
 *  - An existing SUGGESTED mapping is refreshed, never duplicated.
 *  - Only exact matches are auto-approved. Normalized and fuzzy matches are
 *    stored as 'suggested' and require explicit user approval.
 */
export async function generateSuggestions(
  options: {
    fuzzyThreshold: number;
    autoApproveExact: boolean;
    marketplace?: Marketplace | null;
    accountId?: string | null;
  },
  onProgress?: (done: number, total: number) => void,
): Promise<SuggestionRunResult> {
  const index = await buildSonicIndex();
  const now = Date.now();

  const result: SuggestionRunResult = {
    listingsScanned: 0,
    exactCreated: 0,
    normalizedCreated: 0,
    fuzzyCreated: 0,
    skippedAlreadyMapped: 0,
    noCandidate: 0,
  };

  if (index.total === 0) return result;

  // Existing mappings keyed by listing id, so nothing is duplicated.
  const existingByListing = new Map<string, SkuMapping>();
  await db.mappings.each((m) => {
    existingByListing.set(m.listingId, m);
  });

  const collection =
    options.marketplace && options.accountId
      ? db.listings.where('[marketplace+accountId]').equals([options.marketplace, options.accountId])
      : options.marketplace
        ? db.listings.where('marketplace').equals(options.marketplace)
        : db.listings.toCollection();

  const total = await collection.clone().count();
  const toWrite: SkuMapping[] = [];
  const toUpdate: Array<{ id: number; patch: Partial<SkuMapping> }> = [];

  await collection.each((listing: MarketplaceListing) => {
    result.listingsScanned += 1;
    if (result.listingsScanned % 500 === 0) onProgress?.(result.listingsScanned, total);

    const existing = existingByListing.get(listing.id);
    // Never touch a decision a user has made.
    if (existing && (existing.status === 'approved' || existing.status === 'rejected')) {
      result.skippedAlreadyMapped += 1;
      return;
    }

    const candidates = findCandidates(listing.sku, index, 1);
    const best = candidates[0];
    if (!best) {
      result.noCandidate += 1;
      return;
    }
    if (best.method === 'fuzzy' && best.confidence < options.fuzzyThreshold) {
      result.noCandidate += 1;
      return;
    }

    const status =
      best.method === 'exact' && options.autoApproveExact ? 'approved' : 'suggested';

    if (existing) {
      // Refresh the pending suggestion in place.
      if (
        existing.masterSku !== best.masterSku ||
        existing.confidence !== best.confidence ||
        existing.status !== status
      ) {
        toUpdate.push({
          id: existing.id as number,
          patch: {
            masterSku: best.masterSku,
            method: best.method,
            confidence: best.confidence,
            status,
            note: best.rationale,
            updatedAt: now,
            decidedAt: status === 'approved' ? now : null,
          },
        });
      }
    } else {
      toWrite.push({
        marketplace: listing.marketplace,
        accountId: listing.accountId,
        listingSku: listing.sku,
        listingId: listing.id,
        masterSku: best.masterSku,
        status,
        method: best.method,
        confidence: best.confidence,
        allocationMode: null,
        allocationValue: null,
        note: best.rationale,
        createdAt: now,
        updatedAt: now,
        decidedAt: status === 'approved' ? now : null,
      });
    }

    if (best.method === 'exact') result.exactCreated += 1;
    else if (best.method === 'normalized') result.normalizedCreated += 1;
    else result.fuzzyCreated += 1;
  });

  const CHUNK = 1000;
  for (let i = 0; i < toWrite.length; i += CHUNK) {
    await db.mappings.bulkPut(toWrite.slice(i, i + CHUNK));
  }
  for (const { id, patch } of toUpdate) {
    await db.mappings.update(id, patch);
  }

  onProgress?.(total, total);
  return result;
}

/**
 * Creates or replaces a mapping as an explicit, user-approved decision.
 * Reassigning a listing to a different master SKU is allowed here because the
 * caller is an explicit user action; it updates in place rather than adding a
 * second mapping for the same listing.
 */
export async function setMapping(params: {
  listing: MarketplaceListing;
  masterSku: string;
  status: SkuMapping['status'];
  method: MappingMethod;
  confidence: number;
  note?: string | null;
}): Promise<number> {
  const now = Date.now();
  const existing = await db.mappings
    .where('[marketplace+accountId+listingSku]')
    .equals([params.listing.marketplace, params.listing.accountId, params.listing.sku])
    .first();

  if (existing) {
    await db.mappings.update(existing.id as number, {
      masterSku: params.masterSku,
      status: params.status,
      method: params.method,
      confidence: params.confidence,
      note: params.note ?? existing.note,
      updatedAt: now,
      decidedAt: now,
    });
    return existing.id as number;
  }

  return (await db.mappings.add({
    marketplace: params.listing.marketplace,
    accountId: params.listing.accountId,
    listingSku: params.listing.sku,
    listingId: params.listing.id,
    masterSku: params.masterSku,
    status: params.status,
    method: params.method,
    confidence: params.confidence,
    allocationMode: null,
    allocationValue: null,
    note: params.note ?? null,
    createdAt: now,
    updatedAt: now,
    decidedAt: now,
  })) as number;
}

export async function approveMapping(id: number): Promise<void> {
  const now = Date.now();
  await db.mappings.update(id, { status: 'approved', updatedAt: now, decidedAt: now });
}

export async function rejectMapping(id: number): Promise<void> {
  const now = Date.now();
  await db.mappings.update(id, { status: 'rejected', updatedAt: now, decidedAt: now });
}

export async function removeMapping(id: number): Promise<void> {
  await db.mappings.delete(id);
}

export async function approveMappings(ids: number[]): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', db.mappings, async () => {
    for (const id of ids) {
      await db.mappings.update(id, { status: 'approved', updatedAt: now, decidedAt: now });
    }
  });
}

export async function rejectMappings(ids: number[]): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', db.mappings, async () => {
    for (const id of ids) {
      await db.mappings.update(id, { status: 'rejected', updatedAt: now, decidedAt: now });
    }
  });
}

export async function setMappingAllocation(
  id: number,
  allocationMode: SkuMapping['allocationMode'],
  allocationValue: number | null,
): Promise<void> {
  await db.mappings.update(id, {
    allocationMode,
    allocationValue,
    updatedAt: Date.now(),
  });
}

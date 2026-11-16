import { db } from '../db/database';
import {
  DISCREPANCY_TYPES,
  type AllocationMode,
  type Discrepancy,
  type DiscrepancyType,
  type MarketplaceListing,
  type ReconciliationConfig,
  type ReconciliationRun,
  type Severity,
  type SkuMapping,
  type SonicItem,
} from '../types/domain';
import { compactSku, stripListingSuffix } from '../utils/sku';
import { getReconciliationConfig } from '../db/settings';

/** Deterministic id so repeated runs update one record instead of appending. */
export function discrepancyId(
  type: DiscrepancyType,
  masterSku: string | null,
  listingId: string | null,
): string {
  return `${type}|${masterSku ?? '-'}|${listingId ?? '-'}`;
}

interface Finding {
  type: DiscrepancyType;
  severity: Severity;
  masterSku: string | null;
  listingId: string | null;
  marketplace: MarketplaceListing['marketplace'] | null;
  accountId: string | null;
  fulfillment: MarketplaceListing['fulfillment']['type'] | null;
  sonicQuantity: number | null;
  expectedQuantity: number | null;
  actualQuantity: number | null;
  difference: number | null;
  detail: string;
}

/**
 * Expected quantity for one seller-fulfilled listing.
 * Returns null when no expectation can be formed (unknown Sonic quantity).
 */
export function expectedQuantityFor(
  sonicQuantity: number | null,
  mode: AllocationMode,
  listingCount: number,
  mapping: SkuMapping,
): number | null {
  const effectiveMode = mapping.allocationMode ?? mode;

  if (effectiveMode === 'fixed') {
    return mapping.allocationValue ?? null;
  }
  if (sonicQuantity === null) return null;

  switch (effectiveMode) {
    case 'full':
      return sonicQuantity;
    case 'split_even':
      return listingCount > 0 ? Math.floor(sonicQuantity / listingCount) : sonicQuantity;
    case 'percent': {
      const pct = mapping.allocationValue;
      if (pct === null) return null;
      return Math.floor((sonicQuantity * pct) / 100);
    }
    default:
      return sonicQuantity;
  }
}

export interface ReconciliationProgress {
  phase: 'loading' | 'mapping' | 'evaluating' | 'saving' | 'done';
  done: number;
  total: number;
}

export interface ReconciliationResult {
  runId: number;
  run: ReconciliationRun;
}

/**
 * Runs a full reconciliation pass.
 *
 * Key behaviours:
 *  - Only APPROVED mappings participate in quantity comparison.
 *  - Marketplace-fulfilled listings are tracked but never compared against
 *    Sonic warehouse stock.
 *  - Listings with unknown fulfillment are flagged for review, not guessed.
 *  - Discrepancy records are upserted, preserving firstSeenAt and counting
 *    reopens; records that no longer apply are marked resolved, not deleted.
 */
export async function runReconciliation(
  onProgress?: (p: ReconciliationProgress) => void,
  configOverride?: ReconciliationConfig,
): Promise<ReconciliationResult> {
  const startedAt = Date.now();
  const config = configOverride ?? (await getReconciliationConfig());

  onProgress?.({ phase: 'loading', done: 0, total: 0 });

  // ---- Load mappings (small relative to inventory) -------------------
  const mappings = await db.mappings.toArray();
  const approvedByMaster = new Map<string, SkuMapping[]>();
  const mappingByListing = new Map<string, SkuMapping>();
  for (const m of mappings) {
    mappingByListing.set(m.listingId, m);
    if (m.status !== 'approved') continue;
    const bucket = approvedByMaster.get(m.masterSku);
    if (bucket) bucket.push(m);
    else approvedByMaster.set(m.masterSku, [m]);
  }

  // ---- Load listings -------------------------------------------------
  onProgress?.({ phase: 'mapping', done: 0, total: 0 });
  const listingsById = new Map<string, MarketplaceListing>();
  let listingsEvaluated = 0;
  let unmappedListings = 0;
  const findings: Finding[] = [];

  await db.listings.each((listing) => {
    listingsById.set(listing.id, listing);
    listingsEvaluated += 1;
  });

  const accountAllocation = (accountId: string): AllocationMode =>
    config.accountAllocation[accountId] ?? config.defaultAllocation;

  // ---- Unmapped / unknown-fulfillment listings -----------------------
  for (const listing of listingsById.values()) {
    const mapping = mappingByListing.get(listing.id);
    const approved = mapping?.status === 'approved';

    if (!approved) {
      unmappedListings += 1;
      findings.push({
        type: 'listing_unmapped',
        severity: DISCREPANCY_TYPES.listing_unmapped.defaultSeverity,
        masterSku: null,
        listingId: listing.id,
        marketplace: listing.marketplace,
        accountId: listing.accountId,
        fulfillment: listing.fulfillment.type,
        sonicQuantity: null,
        expectedQuantity: null,
        actualQuantity: listing.quantity,
        difference: null,
        detail: mapping
          ? `Mapping to "${mapping.masterSku}" is ${mapping.status} and awaiting approval.`
          : 'No Sonic master SKU is linked to this listing.',
      });
    }

    if (listing.fulfillment.type === 'unknown') {
      findings.push({
        type: 'fulfillment_unknown',
        severity: DISCREPANCY_TYPES.fulfillment_unknown.defaultSeverity,
        masterSku: mapping?.status === 'approved' ? mapping.masterSku : null,
        listingId: listing.id,
        marketplace: listing.marketplace,
        accountId: listing.accountId,
        fulfillment: 'unknown',
        sonicQuantity: null,
        expectedQuantity: null,
        actualQuantity: listing.quantity,
        difference: null,
        detail: listing.fulfillment.rawValue
          ? `Fulfillment value "${listing.fulfillment.rawValue}" was not recognized.`
          : 'The import provided no fulfillment column for this listing.',
      });
    }

    if (listing.quantity === null) {
      findings.push({
        type: 'missing_quantity_data',
        severity: DISCREPANCY_TYPES.missing_quantity_data.defaultSeverity,
        masterSku: mapping?.status === 'approved' ? mapping.masterSku : null,
        listingId: listing.id,
        marketplace: listing.marketplace,
        accountId: listing.accountId,
        fulfillment: listing.fulfillment.type,
        sonicQuantity: null,
        expectedQuantity: null,
        actualQuantity: null,
        difference: null,
        detail: 'Quantity is unknown for this listing, so it cannot be reconciled.',
      });
    }
  }

  // ---- Per-master-SKU evaluation -------------------------------------
  onProgress?.({ phase: 'evaluating', done: 0, total: approvedByMaster.size });

  let sonicItemsEvaluated = 0;
  let evaluated = 0;
  const sonicCache = new Map<string, SonicItem | undefined>();

  for (const [masterSku, allMappings] of approvedByMaster) {
    evaluated += 1;
    if (evaluated % 500 === 0) {
      onProgress?.({ phase: 'evaluating', done: evaluated, total: approvedByMaster.size });
    }

    const sonic = await db.sonicItems.get(masterSku);
    sonicCache.set(masterSku, sonic);
    if (sonic) sonicItemsEvaluated += 1;

    const mapped = allMappings
      .map((m) => ({ mapping: m, listing: listingsById.get(m.listingId) }))
      .filter((x): x is { mapping: SkuMapping; listing: MarketplaceListing } => !!x.listing);

    const sellerFulfilled = mapped.filter(
      (x) => x.listing.fulfillment.type === 'seller_fulfilled',
    );

    const sonicQty = sonic?.quantity ?? null;
    const allocation = sellerFulfilled.length
      ? accountAllocation(sellerFulfilled[0]!.listing.accountId)
      : config.defaultAllocation;

    /* -------- Priority 0: master SKU absent from latest full snapshot ----- */
    const absentFromSnapshot = !sonic || sonic.inLatestSnapshot === false;
    if (absentFromSnapshot) {
      for (const { listing } of sellerFulfilled) {
        if ((listing.quantity ?? 0) > 0) {
          findings.push({
            type: 'sonic_missing_listing_live',
            severity: 'critical',
            masterSku,
            listingId: listing.id,
            marketplace: listing.marketplace,
            accountId: listing.accountId,
            fulfillment: 'seller_fulfilled',
            sonicQuantity: sonicQty,
            expectedQuantity: 0,
            actualQuantity: listing.quantity,
            difference: listing.quantity,
            detail: sonic
              ? `"${masterSku}" was absent from the most recent completed full Sonic snapshot, but this seller-fulfilled listing still shows ${listing.quantity}. Last known Sonic quantity was ${sonic.quantity ?? 'unknown'}.`
              : `"${masterSku}" does not exist in Sonic inventory at all, but this seller-fulfilled listing still shows ${listing.quantity}.`,
          });
        }
      }
    }

    /* -------- Priority 0: Sonic zero, seller-fulfilled listing positive -- */
    if (sonic && sonicQty === 0 && sonic.inLatestSnapshot !== false) {
      for (const { listing } of sellerFulfilled) {
        if ((listing.quantity ?? 0) > 0) {
          findings.push({
            type: 'sonic_zero_listing_positive',
            severity: 'critical',
            masterSku,
            listingId: listing.id,
            marketplace: listing.marketplace,
            accountId: listing.accountId,
            fulfillment: 'seller_fulfilled',
            sonicQuantity: 0,
            expectedQuantity: 0,
            actualQuantity: listing.quantity,
            difference: listing.quantity,
            detail: `Sonic reports 0 available, but this seller-fulfilled listing still shows ${listing.quantity}. Oversell risk.`,
          });
        }
      }
    }

    /* -------- Quantity comparison for seller-fulfilled listings ---------- */
    let allocationTotal = 0;
    for (const { mapping, listing } of sellerFulfilled) {
      const expected = expectedQuantityFor(sonicQty, allocation, sellerFulfilled.length, mapping);
      if (expected !== null) allocationTotal += expected;

      if (expected === null || listing.quantity === null) continue;
      // Critical cases above already cover these.
      if (absentFromSnapshot && listing.quantity > 0) continue;
      if (sonicQty === 0 && listing.quantity > 0) continue;

      const diff = listing.quantity - expected;

      if (listing.quantity === 0 && (sonicQty ?? 0) >= config.zeroListingMinSonicQty) {
        findings.push({
          type: 'listing_zero_sonic_available',
          severity: DISCREPANCY_TYPES.listing_zero_sonic_available.defaultSeverity,
          masterSku,
          listingId: listing.id,
          marketplace: listing.marketplace,
          accountId: listing.accountId,
          fulfillment: 'seller_fulfilled',
          sonicQuantity: sonicQty,
          expectedQuantity: expected,
          actualQuantity: 0,
          difference: diff,
          detail: `Listing is at 0 while Sonic has ${sonicQty} available. Potential lost sales.`,
        });
        continue;
      }

      if (Math.abs(diff) > config.quantityTolerance) {
        // Overstated marketplace quantity is worse than understated.
        const severity: Severity = diff > 0 ? 'high' : 'medium';
        findings.push({
          type: 'quantity_mismatch',
          severity,
          masterSku,
          listingId: listing.id,
          marketplace: listing.marketplace,
          accountId: listing.accountId,
          fulfillment: 'seller_fulfilled',
          sonicQuantity: sonicQty,
          expectedQuantity: expected,
          actualQuantity: listing.quantity,
          difference: diff,
          detail:
            diff > 0
              ? `Listing shows ${listing.quantity} but only ${expected} is expected from Sonic stock of ${sonicQty}. Overstated by ${diff}.`
              : `Listing shows ${listing.quantity} but ${expected} is expected from Sonic stock of ${sonicQty}. Understated by ${Math.abs(diff)}.`,
        });
      }

    }

    // Inactive listings are evaluated independently of the quantity branches
    // above, so a listing sitting at zero is still reported as inactive.
    for (const { mapping, listing } of sellerFulfilled) {
      if (listing.active !== false) continue;
      if ((sonicQty ?? 0) <= 0) continue;
      findings.push({
        type: 'listing_inactive',
        severity: DISCREPANCY_TYPES.listing_inactive.defaultSeverity,
        masterSku,
        listingId: listing.id,
        marketplace: listing.marketplace,
        accountId: listing.accountId,
        fulfillment: listing.fulfillment.type,
        sonicQuantity: sonicQty,
        expectedQuantity: expectedQuantityFor(
          sonicQty,
          allocation,
          sellerFulfilled.length,
          mapping,
        ),
        actualQuantity: listing.quantity,
        difference: null,
        detail: `The import reports this listing as "${listing.statusRaw ?? 'inactive'}" while Sonic has ${sonicQty} available.`,
      });
    }

    /* -------- Allocation exceeds available stock -------------------------
     * Only meaningful when stock is actually divided between listings. Under
     * the 'full' policy every listing deliberately shows the whole quantity,
     * so the sum exceeding stock is expected, not a discrepancy.
     */
    const dividesStock = sellerFulfilled.some(
      (x) => (x.mapping.allocationMode ?? allocation) !== 'full',
    );
    if (
      dividesStock &&
      sonicQty !== null &&
      sellerFulfilled.length > 1 &&
      allocationTotal > sonicQty
    ) {
      findings.push({
        type: 'allocation_exceeds_stock',
        severity: DISCREPANCY_TYPES.allocation_exceeds_stock.defaultSeverity,
        masterSku,
        listingId: null,
        marketplace: sellerFulfilled[0]!.listing.marketplace,
        accountId: sellerFulfilled[0]!.listing.accountId,
        fulfillment: 'seller_fulfilled',
        sonicQuantity: sonicQty,
        expectedQuantity: allocationTotal,
        actualQuantity: null,
        difference: allocationTotal - sonicQty,
        detail: `${sellerFulfilled.length} seller-fulfilled listings expect ${allocationTotal} units in total but Sonic has only ${sonicQty}. Review the allocation policy.`,
      });
    }

    /* -------- Possible duplicate listings ------------------------------- */
    const byBase = new Map<string, string[]>();
    for (const { listing } of mapped) {
      const base = stripListingSuffix(listing.sku) ?? listing.sku;
      const key = `${listing.accountId}|${compactSku(base)}`;
      const bucket = byBase.get(key);
      if (bucket) bucket.push(listing.sku);
      else byBase.set(key, [listing.sku]);
    }
    for (const [, skus] of byBase) {
      if (skus.length > 1) {
        findings.push({
          type: 'possible_duplicate_listing',
          severity: DISCREPANCY_TYPES.possible_duplicate_listing.defaultSeverity,
          masterSku,
          listingId: null,
          marketplace: mapped[0]!.listing.marketplace,
          accountId: mapped[0]!.listing.accountId,
          fulfillment: null,
          sonicQuantity: sonicQty,
          expectedQuantity: null,
          actualQuantity: null,
          difference: null,
          detail: `${skus.length} listings in the same account share the base SKU: ${skus.slice(0, 6).join(', ')}${skus.length > 6 ? '…' : ''}. This may be intentional.`,
        });
        break;
      }
    }
  }

  /* -------- Sonic SKUs with no mapped listing (opt-in, noisy) ---------- */
  if (config.reportSonicWithoutListing) {
    await db.sonicItems.each((item) => {
      if (approvedByMaster.has(item.sku)) return;
      if ((item.quantity ?? 0) <= 0) return;
      findings.push({
        type: 'sonic_no_listing',
        severity: DISCREPANCY_TYPES.sonic_no_listing.defaultSeverity,
        masterSku: item.sku,
        listingId: null,
        marketplace: null,
        accountId: null,
        fulfillment: null,
        sonicQuantity: item.quantity,
        expectedQuantity: null,
        actualQuantity: null,
        difference: null,
        detail: `Sonic has ${item.quantity} available but no approved marketplace listing is linked.`,
      });
    });
  }

  /* ---- Persist findings, preserving history --------------------------- */
  onProgress?.({ phase: 'saving', done: 0, total: findings.length });

  const ranAt = Date.now();
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  // Reserve the run id first so discrepancies can reference it.
  const runId = (await db.reconciliationRuns.add({
    ranAt,
    durationMs: 0,
    sonicItemsEvaluated,
    listingsEvaluated,
    mappedListings: listingsEvaluated - unmappedListings,
    unmappedListings,
    counts,
    openTotal: 0,
    resolvedThisRun: 0,
    newThisRun: 0,
    reopenedThisRun: 0,
  } as ReconciliationRun)) as number;

  let newThisRun = 0;
  let reopenedThisRun = 0;
  const seenIds = new Set<string>();

  const CHUNK = 500;
  for (let i = 0; i < findings.length; i += CHUNK) {
    const chunk = findings.slice(i, i + CHUNK);
    await db.transaction('rw', db.discrepancies, async () => {
      const ids = chunk.map((f) => discrepancyId(f.type, f.masterSku, f.listingId));
      const existingRows = await db.discrepancies.bulkGet(ids);
      const puts: Discrepancy[] = [];

      chunk.forEach((finding, idx) => {
        const id = ids[idx] as string;
        if (seenIds.has(id)) return;
        seenIds.add(id);
        counts[finding.severity] += 1;

        const existing = existingRows[idx];
        if (!existing) {
          newThisRun += 1;
          puts.push({
            id,
            ...finding,
            state: 'open',
            firstSeenAt: ranAt,
            lastSeenAt: ranAt,
            resolvedAt: null,
            reopenCount: 0,
            lastReopenedAt: null,
            lastRunId: runId,
            acknowledgedAt: null,
            note: null,
          });
          return;
        }

        const wasResolved = existing.state === 'resolved';
        if (wasResolved) reopenedThisRun += 1;

        puts.push({
          ...existing,
          ...finding,
          state: 'open',
          // firstSeenAt is never overwritten: it is the age of the problem.
          firstSeenAt: existing.firstSeenAt,
          lastSeenAt: ranAt,
          resolvedAt: null,
          reopenCount: wasResolved ? existing.reopenCount + 1 : existing.reopenCount,
          lastReopenedAt: wasResolved ? ranAt : existing.lastReopenedAt,
          lastRunId: runId,
          acknowledgedAt: wasResolved ? null : existing.acknowledgedAt,
          note: existing.note,
        });
      });

      if (puts.length) await db.discrepancies.bulkPut(puts);
    });
    onProgress?.({ phase: 'saving', done: Math.min(i + CHUNK, findings.length), total: findings.length });
  }

  // Anything previously open that this run did not re-observe is now resolved.
  let resolvedThisRun = 0;
  const toResolve: Discrepancy[] = [];
  await db.discrepancies
    .where('state')
    .equals('open')
    .each((d) => {
      if (!seenIds.has(d.id)) toResolve.push(d);
    });
  for (let i = 0; i < toResolve.length; i += CHUNK) {
    const chunk = toResolve.slice(i, i + CHUNK);
    await db.discrepancies.bulkPut(
      chunk.map((d) => ({
        ...d,
        state: 'resolved' as const,
        resolvedAt: ranAt,
        lastRunId: runId,
      })),
    );
    resolvedThisRun += chunk.length;
  }

  const openTotal = seenIds.size;
  const durationMs = Date.now() - startedAt;

  const run: ReconciliationRun = {
    id: runId,
    ranAt,
    durationMs,
    sonicItemsEvaluated,
    listingsEvaluated,
    mappedListings: listingsEvaluated - unmappedListings,
    unmappedListings,
    counts,
    openTotal,
    resolvedThisRun,
    newThisRun,
    reopenedThisRun,
  };

  await db.reconciliationRuns.update(runId, {
    durationMs,
    counts,
    openTotal,
    resolvedThisRun,
    newThisRun,
    reopenedThisRun,
  });

  onProgress?.({ phase: 'done', done: findings.length, total: findings.length });
  return { runId, run };
}

export async function acknowledgeDiscrepancy(id: string, note: string | null): Promise<void> {
  await db.discrepancies.update(id, { acknowledgedAt: Date.now(), note });
}

export async function clearAcknowledgement(id: string): Promise<void> {
  await db.discrepancies.update(id, { acknowledgedAt: null });
}

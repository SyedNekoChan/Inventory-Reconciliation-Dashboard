import { db } from '../../db/database';
import {
  type Discrepancy,
  type FulfillmentType,
  type Marketplace,
  type MarketplaceListing,
  type Severity,
  type SkuMapping,
  type SonicItem,
  SEVERITY_ORDER,
} from '../../types/domain';
import { normalizeSku } from '../../utils/sku';
import { expectedQuantityFor } from '../../services/reconciliation';
import { getReconciliationConfig } from '../../db/settings';

export interface ReconFilters {
  search: string;
  marketplace: Marketplace | 'all';
  accountId: string | 'all';
  fulfillment: FulfillmentType | 'all';
  severity: Severity | 'all';
  state: 'open' | 'resolved' | 'all';
  type: string | 'all';
}

export interface ReconGroupListing {
  listing: MarketplaceListing;
  mapping: SkuMapping | null;
  expectedQuantity: number | null;
  difference: number | null;
  discrepancies: Discrepancy[];
}

/** One row per Sonic master SKU (plus a pseudo-group for unmapped listings). */
export interface ReconGroup {
  key: string;
  masterSku: string | null;
  sonic: SonicItem | null;
  sonicQuantity: number | null;
  inLatestSnapshot: boolean | null;
  worstSeverity: Severity | null;
  openCount: number;
  resolvedCount: number;
  listings: ReconGroupListing[];
  groupDiscrepancies: Discrepancy[];
}

export interface ReconPage {
  groups: ReconGroup[];
  total: number;
  counts: Record<Severity, number>;
  openTotal: number;
  resolvedTotal: number;
}

function matchesFilters(d: Discrepancy, f: ReconFilters): boolean {
  if (f.state !== 'all' && d.state !== f.state) return false;
  if (f.severity !== 'all' && d.severity !== f.severity) return false;
  if (f.marketplace !== 'all' && d.marketplace !== f.marketplace) return false;
  if (f.accountId !== 'all' && d.accountId !== f.accountId) return false;
  if (f.fulfillment !== 'all' && d.fulfillment !== f.fulfillment) return false;
  if (f.type !== 'all' && d.type !== f.type) return false;
  return true;
}

/**
 * Builds reconciliation rows from stored discrepancies.
 *
 * Discrepancies are the working set here (orders of magnitude smaller than the
 * full inventory), so the whole filtered set is grouped and then paged. Sonic
 * items and listings are fetched only for the groups on the current page.
 */
export async function queryReconciliation(
  filters: ReconFilters,
  offset: number,
  limit: number,
): Promise<ReconPage> {
  const term = normalizeSku(filters.search.trim());
  const config = await getReconciliationConfig();

  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  let openTotal = 0;
  let resolvedTotal = 0;

  // Group keys: master SKU when known, otherwise the listing id.
  const grouped = new Map<string, Discrepancy[]>();

  await db.discrepancies.each((d) => {
    if (d.state === 'open') {
      openTotal += 1;
      counts[d.severity] += 1;
    } else {
      resolvedTotal += 1;
    }
    if (!matchesFilters(d, filters)) return;

    const key = d.masterSku ?? `listing:${d.listingId ?? d.id}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(d);
    else grouped.set(key, [d]);
  });

  // Search filter applies to the master SKU or any listing SKU in the group.
  let keys = [...grouped.keys()];
  if (term) {
    keys = keys.filter((key) => {
      if (key.startsWith('listing:')) {
        return normalizeSku(key.slice(8)).includes(term);
      }
      if (normalizeSku(key).includes(term)) return true;
      const list = grouped.get(key) ?? [];
      return list.some((d) => (d.listingId ? normalizeSku(d.listingId).includes(term) : false));
    });
  }

  // Sort: worst severity first, then oldest.
  const severityOf = (key: string): number => {
    const list = grouped.get(key) ?? [];
    return Math.min(...list.map((d) => SEVERITY_ORDER[d.severity]));
  };
  const oldestOf = (key: string): number => {
    const list = grouped.get(key) ?? [];
    return Math.min(...list.map((d) => d.firstSeenAt));
  };
  keys.sort((a, b) => severityOf(a) - severityOf(b) || oldestOf(a) - oldestOf(b));

  const total = keys.length;
  const pageKeys = keys.slice(offset, offset + limit);

  const groups: ReconGroup[] = [];
  for (const key of pageKeys) {
    const list = grouped.get(key) ?? [];
    const isListingGroup = key.startsWith('listing:');
    const masterSku = isListingGroup ? null : key;

    const sonic = masterSku ? ((await db.sonicItems.get(masterSku)) ?? null) : null;

    // Collect listings referenced by this group's discrepancies, plus every
    // approved mapping for the master SKU so the expanded row is complete.
    const listingIds = new Set<string>(
      list.map((d) => d.listingId).filter((x): x is string => !!x),
    );
    const mappingsForMaster = masterSku
      ? await db.mappings.where('masterSku').equals(masterSku).toArray()
      : [];
    for (const m of mappingsForMaster) {
      if (m.status === 'approved') listingIds.add(m.listingId);
    }

    const mappingByListing = new Map(mappingsForMaster.map((m) => [m.listingId, m]));
    const listings: ReconGroupListing[] = [];

    for (const id of listingIds) {
      const listing = await db.listings.get(id);
      if (!listing) continue;
      let mapping = mappingByListing.get(id) ?? null;
      if (!mapping) {
        mapping = (await db.mappings.where('listingId').equals(id).first()) ?? null;
      }

      const approvedSellerFulfilled = mappingsForMaster.filter(
        (m) => m.status === 'approved',
      ).length;

      const allocation =
        config.accountAllocation[listing.accountId] ?? config.defaultAllocation;

      const expectedQuantity =
        mapping && mapping.status === 'approved' && listing.fulfillment.type === 'seller_fulfilled'
          ? expectedQuantityFor(
              sonic?.quantity ?? null,
              allocation,
              Math.max(1, approvedSellerFulfilled),
              mapping,
            )
          : null;

      const difference =
        expectedQuantity !== null && listing.quantity !== null
          ? listing.quantity - expectedQuantity
          : null;

      listings.push({
        listing,
        mapping,
        expectedQuantity,
        difference,
        discrepancies: list.filter((d) => d.listingId === id),
      });
    }

    listings.sort(
      (a, b) =>
        a.listing.marketplace.localeCompare(b.listing.marketplace) ||
        a.listing.accountId.localeCompare(b.listing.accountId) ||
        a.listing.sku.localeCompare(b.listing.sku),
    );

    const openList = list.filter((d) => d.state === 'open');
    const worstSeverity =
      openList.length > 0
        ? (openList
            .slice()
            .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])[0]
            ?.severity ?? null)
        : null;

    groups.push({
      key,
      masterSku,
      sonic,
      sonicQuantity: sonic?.quantity ?? null,
      inLatestSnapshot: sonic?.inLatestSnapshot ?? null,
      worstSeverity,
      openCount: openList.length,
      resolvedCount: list.length - openList.length,
      listings,
      groupDiscrepancies: list.filter((d) => d.listingId === null),
    });
  }

  return { groups, total, counts, openTotal, resolvedTotal };
}

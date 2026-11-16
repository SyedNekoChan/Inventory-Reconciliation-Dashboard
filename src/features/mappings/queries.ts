import { db } from '../../db/database';
import type {
  Marketplace,
  MappingStatus,
  MarketplaceListing,
  SkuMapping,
  SonicItem,
} from '../../types/domain';
import { normalizeSku } from '../../utils/sku';

export type MappingView = 'unmapped' | 'suggested' | 'approved' | 'rejected';

export interface MappingFilters {
  view: MappingView;
  search: string;
  marketplace: Marketplace | 'all';
  accountId: string | 'all';
}

export interface MappingRow {
  listing: MarketplaceListing;
  mapping: SkuMapping | null;
  master: SonicItem | null;
}

export interface MappingPageResult {
  rows: MappingRow[];
  total: number;
  counts: Record<MappingView, number>;
}

export async function queryMappings(
  filters: MappingFilters,
  offset: number,
  limit: number,
): Promise<MappingPageResult> {
  const term = normalizeSku(filters.search.trim());

  // Mapping status per listing id.
  const statusByListing = new Map<string, SkuMapping>();
  await db.mappings.each((m) => statusByListing.set(m.listingId, m));

  const counts: Record<MappingView, number> = {
    unmapped: 0,
    suggested: 0,
    approved: 0,
    rejected: 0,
  };

  const viewOf = (mapping: SkuMapping | undefined): MappingView => {
    if (!mapping) return 'unmapped';
    if (mapping.status === 'approved') return 'approved';
    if (mapping.status === 'suggested') return 'suggested';
    return 'rejected';
  };

  const collected: MarketplaceListing[] = [];

  await db.listings.each((listing) => {
    const mapping = statusByListing.get(listing.id);
    const view = viewOf(mapping);
    counts[view] += 1;

    if (view !== filters.view) return;
    if (filters.marketplace !== 'all' && listing.marketplace !== filters.marketplace) return;
    if (filters.accountId !== 'all' && listing.accountId !== filters.accountId) return;
    if (term) {
      const inListing = listing.skuNormalized.includes(term);
      const inMaster = mapping ? normalizeSku(mapping.masterSku).includes(term) : false;
      const inTitle = listing.title ? listing.title.toLowerCase().includes(term) : false;
      if (!inListing && !inMaster && !inTitle) return;
    }
    collected.push(listing);
  });

  collected.sort((a, b) => {
    const ma = statusByListing.get(a.id);
    const mb = statusByListing.get(b.id);
    // Highest-confidence suggestions first so the user reviews the safe ones.
    if (filters.view === 'suggested') {
      const diff = (mb?.confidence ?? 0) - (ma?.confidence ?? 0);
      if (diff !== 0) return diff;
    }
    return (
      a.marketplace.localeCompare(b.marketplace) ||
      a.accountId.localeCompare(b.accountId) ||
      a.sku.localeCompare(b.sku)
    );
  });

  const pageSlice = collected.slice(offset, offset + limit);
  const rows: MappingRow[] = [];
  for (const listing of pageSlice) {
    const mapping = statusByListing.get(listing.id) ?? null;
    const master = mapping ? ((await db.sonicItems.get(mapping.masterSku)) ?? null) : null;
    rows.push({ listing, mapping, master });
  }

  return { rows, total: collected.length, counts };
}

/** Master SKU lookup for the manual mapping picker. */
export async function searchMasterSkus(term: string, limit = 25): Promise<SonicItem[]> {
  const needle = normalizeSku(term.trim());
  if (!needle) return [];
  const out: SonicItem[] = [];
  await db.sonicItems
    .where('skuNormalized')
    .startsWith(needle)
    .limit(limit)
    .each((item) => out.push(item));

  if (out.length < limit) {
    // Fall back to a contains scan, bounded so it stays responsive.
    let scanned = 0;
    await db.sonicItems
      .filter((item) => {
        scanned += 1;
        return scanned < 50_000 && item.skuNormalized.includes(needle);
      })
      .limit(limit - out.length)
      .each((item) => {
        if (!out.some((x) => x.sku === item.sku)) out.push(item);
      });
  }
  return out;
}

export async function listingsForMaster(masterSku: string): Promise<MappingRow[]> {
  const mappings = await db.mappings.where('masterSku').equals(masterSku).toArray();
  const rows: MappingRow[] = [];
  const master = (await db.sonicItems.get(masterSku)) ?? null;
  for (const mapping of mappings) {
    const listing = await db.listings.get(mapping.listingId);
    if (!listing) continue;
    rows.push({ listing, mapping, master });
  }
  return rows.sort((a, b) => a.listing.sku.localeCompare(b.listing.sku));
}

export async function countMappingsByStatus(): Promise<Record<MappingStatus, number>> {
  const [approved, suggested, rejected] = await Promise.all([
    db.mappings.where('status').equals('approved').count(),
    db.mappings.where('status').equals('suggested').count(),
    db.mappings.where('status').equals('rejected').count(),
  ]);
  return { approved, suggested, rejected };
}

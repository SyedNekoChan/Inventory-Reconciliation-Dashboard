import { db } from '../../db/database';
import type { MarketplaceListing, SkuMapping, SonicItem } from '../../types/domain';
import { normalizeSku } from '../../utils/sku';

export type SonicSortKey = 'sku' | 'quantity' | 'updatedAt';
export type StockFilter = 'all' | 'in_stock' | 'zero' | 'unknown' | 'absent_from_snapshot';

export interface InventoryQuery {
  search: string;
  stock: StockFilter;
  sortKey: SonicSortKey;
  sortDir: 'asc' | 'desc';
  offset: number;
  limit: number;
}

export interface InventoryPage {
  rows: SonicItem[];
  total: number;
  /** True when the result had to be filtered (search/filter active). */
  scanned: boolean;
  /**
   * True when the result came from the indexed prefix path, so `total` counts
   * prefix matches only. Mid-string matches are not included.
   */
  prefixOnly?: boolean;
}

/**
 * Pages Sonic inventory out of IndexedDB.
 *
 * Without a search term this uses an index cursor with offset/limit so only
 * the requested page is materialized — the full 98k dataset is never loaded
 * into React state. With a search term it streams through the index and keeps
 * only matches, stopping once enough rows are collected.
 */
export async function querySonicItems(q: InventoryQuery): Promise<InventoryPage> {
  const term = normalizeSku(q.search.trim());
  const hasSearch = term.length > 0;
  const hasFilter = q.stock !== 'all';

  const matches = (item: SonicItem): boolean => {
    if (hasSearch) {
      const inSku = item.skuNormalized.includes(term);
      const inDesc = item.description
        ? item.description.toLowerCase().includes(term)
        : false;
      if (!inSku && !inDesc) return false;
    }
    switch (q.stock) {
      case 'in_stock':
        return (item.quantity ?? 0) > 0;
      case 'zero':
        return item.quantity === 0;
      case 'unknown':
        return item.quantity === null;
      case 'absent_from_snapshot':
        return item.inLatestSnapshot === false;
      default:
        return true;
    }
  };

  // Fast path: no search, no filter — index-ordered page, counted cheaply.
  if (!hasSearch && !hasFilter) {
    const total = await db.sonicItems.count();
    const index = q.sortKey === 'sku' ? 'sku' : q.sortKey;
    let collection = db.sonicItems.orderBy(index);
    if (q.sortDir === 'desc') collection = collection.reverse();
    const rows = await collection.offset(q.offset).limit(q.limit).toArray();
    return { rows, total, scanned: false };
  }

  /*
   * Indexed fast path: a bare prefix search (no stock filter, SKU ordering)
   * is served by the skuNormalized index, so only the matching key range is
   * visited instead of all ~98k rows.
   */
  if (hasSearch && !hasFilter && q.sortKey === 'sku' && q.sortDir === 'asc') {
    const prefixRange = db.sonicItems.where('skuNormalized').startsWith(term);
    const prefixTotal = await prefixRange.clone().count();
    if (prefixTotal > 0) {
      const prefixRows = await prefixRange.offset(q.offset).limit(q.limit).toArray();
      // Only trust this path when it is a genuine prefix hit. Mid-string
      // matches still need the scan below, so fall through when the prefix
      // range alone cannot explain the page the caller asked for.
      if (q.offset < prefixTotal) {
        return { rows: prefixRows, total: prefixTotal, scanned: true, prefixOnly: true };
      }
    }
  }

  // Filtered path: stream the index and collect matches. Iteration stops as
  // soon as the requested page is filled and the total is only needed for
  // pagination, so a deep page costs more than a shallow one but the whole
  // dataset is never held in memory.
  const index = q.sortKey === 'sku' ? 'sku' : q.sortKey;
  let collection = db.sonicItems.orderBy(index);
  if (q.sortDir === 'desc') collection = collection.reverse();

  const rows: SonicItem[] = [];
  let total = 0;

  await collection.each((item) => {
    if (!matches(item)) return;
    if (total >= q.offset && rows.length < q.limit) rows.push(item);
    total += 1;
  });

  return { rows, total, scanned: true };
}

export interface SonicDetail {
  item: SonicItem;
  listings: Array<{ listing: MarketplaceListing; mapping: SkuMapping }>;
  pendingSuggestions: SkuMapping[];
}

export async function loadSonicDetail(sku: string): Promise<SonicDetail | null> {
  const item = await db.sonicItems.get(sku);
  if (!item) return null;

  const mappings = await db.mappings.where('masterSku').equals(sku).toArray();
  const listings: Array<{ listing: MarketplaceListing; mapping: SkuMapping }> = [];
  const pendingSuggestions: SkuMapping[] = [];

  for (const mapping of mappings) {
    if (mapping.status === 'rejected') continue;
    const listing = await db.listings.get(mapping.listingId);
    if (!listing) continue;
    if (mapping.status === 'approved') listings.push({ listing, mapping });
    else pendingSuggestions.push(mapping);
  }

  listings.sort(
    (a, b) =>
      a.listing.marketplace.localeCompare(b.listing.marketplace) ||
      a.listing.accountId.localeCompare(b.listing.accountId) ||
      a.listing.sku.localeCompare(b.listing.sku),
  );

  return { item, listings, pendingSuggestions };
}

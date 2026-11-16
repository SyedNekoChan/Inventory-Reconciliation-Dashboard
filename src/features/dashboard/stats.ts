import { db } from '../../db/database';
import type {
  Discrepancy,
  ImportRun,
  Marketplace,
  MarketplaceAccount,
  ReconciliationRun,
  Severity,
} from '../../types/domain';

export interface DashboardStats {
  sonicSkus: number;
  sonicWithStock: number;
  listings: number;
  unmappedListings: number;
  approvedMappings: number;
  pendingSuggestions: number;
  critical: number;
  high: number;
  openTotal: number;
  resolvedTotal: number;
  lastImport: ImportRun | null;
  lastRun: ReconciliationRun | null;
  hasAnyData: boolean;
}

export async function loadDashboardStats(): Promise<DashboardStats> {
  const [
    sonicSkus,
    listings,
    approvedMappings,
    pendingSuggestions,
    critical,
    high,
    openTotal,
    resolvedTotal,
    unmappedListings,
  ] = await Promise.all([
    db.sonicItems.count(),
    db.listings.count(),
    db.mappings.where('status').equals('approved').count(),
    db.mappings.where('status').equals('suggested').count(),
    db.discrepancies.where('[state+severity]').equals(['open', 'critical']).count(),
    db.discrepancies.where('[state+severity]').equals(['open', 'high']).count(),
    db.discrepancies.where('state').equals('open').count(),
    db.discrepancies.where('state').equals('resolved').count(),
    db.discrepancies.where('[state+type]').equals(['open', 'listing_unmapped']).count(),
  ]);

  const sonicWithStock = await db.sonicItems.where('quantity').above(0).count();

  const lastImport =
    (await db.importRuns.orderBy('startedAt').reverse().filter((r) => r.status === 'committed').first()) ??
    null;
  const lastRun = (await db.reconciliationRuns.orderBy('ranAt').reverse().first()) ?? null;

  return {
    sonicSkus,
    sonicWithStock,
    listings,
    unmappedListings,
    approvedMappings,
    pendingSuggestions,
    critical,
    high,
    openTotal,
    resolvedTotal,
    lastImport,
    lastRun,
    hasAnyData: sonicSkus > 0 || listings > 0,
  };
}

export interface TrendPoint {
  runId: number;
  ranAt: number;
  label: string;
  critical: number;
  high: number;
  other: number;
  resolved: number;
}

/**
 * Discrepancy trend from stored reconciliation runs.
 * Only real runs are returned — no synthetic history is ever generated.
 */
export async function loadTrend(limit = 30): Promise<TrendPoint[]> {
  const runs = await db.reconciliationRuns.orderBy('ranAt').reverse().limit(limit).toArray();
  const ordered = runs.reverse();

  // When several runs land on one day, the date alone cannot tell them apart,
  // so fall back to a time-of-day label.
  const days = new Set(ordered.map((r) => new Date(r.ranAt).toDateString()));
  const sameDay = days.size <= 1 && ordered.length > 1;

  return ordered.map((run) => {
    const counts = run.counts ?? ({} as Record<Severity, number>);
    const other = (counts.medium ?? 0) + (counts.low ?? 0) + (counts.info ?? 0);
    const when = new Date(run.ranAt);
    return {
      runId: run.id as number,
      ranAt: run.ranAt,
      label: sameDay
        ? when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        : when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      critical: counts.critical ?? 0,
      high: counts.high ?? 0,
      other,
      resolved: run.resolvedThisRun ?? 0,
    };
  });
}

export interface AccountHealth {
  account: MarketplaceAccount;
  listings: number;
  mapped: number;
  unmapped: number;
  discrepancies: number;
  critical: number;
  lastImportAt: number | null;
  lastImportFile: string | null;
}

export async function loadAccountHealth(): Promise<AccountHealth[]> {
  const accounts = await db.accounts.toArray();
  const out: AccountHealth[] = [];

  for (const account of accounts) {
    const key: [Marketplace, string] = [account.marketplace, account.id];
    const listings = await db.listings.where('[marketplace+accountId]').equals(key).count();

    const mapped = await db.mappings
      .where('[accountId+status]')
      .equals([account.id, 'approved'])
      .count();

    const discrepancies = await db.discrepancies
      .where('accountId')
      .equals(account.id)
      .filter((d) => d.state === 'open')
      .count();

    const critical = await db.discrepancies
      .where('accountId')
      .equals(account.id)
      .filter((d) => d.state === 'open' && d.severity === 'critical')
      .count();

    const lastImport = await db.importRuns
      .where('accountId')
      .equals(account.id)
      .filter((r) => r.status === 'committed')
      .last();

    out.push({
      account,
      listings,
      mapped,
      unmapped: Math.max(0, listings - mapped),
      discrepancies,
      critical,
      lastImportAt: lastImport?.startedAt ?? null,
      lastImportFile: lastImport?.fileName ?? null,
    });
  }

  return out.sort(
    (a, b) =>
      b.critical - a.critical ||
      a.account.marketplace.localeCompare(b.account.marketplace) ||
      a.account.label.localeCompare(b.account.label),
  );
}

/** Top unresolved discrepancies by severity, then by age. */
export async function loadPriorityDiscrepancies(limit = 8): Promise<Discrepancy[]> {
  const out: Discrepancy[] = [];
  const order: Severity[] = ['critical', 'high', 'medium'];
  for (const severity of order) {
    if (out.length >= limit) break;
    const rows = await db.discrepancies
      .where('[state+severity]')
      .equals(['open', severity])
      .limit(limit - out.length)
      .toArray();
    rows.sort((a, b) => a.firstSeenAt - b.firstSeenAt);
    out.push(...rows);
  }
  return out.slice(0, limit);
}

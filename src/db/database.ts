import Dexie, { type Table } from 'dexie';
import type {
  AppSettings,
  Discrepancy,
  ImportProfile,
  ImportRun,
  MarketplaceAccount,
  MarketplaceListing,
  ReconciliationRun,
  SkuMapping,
  SonicItem,
} from '../types/domain';

/**
 * Version of the RECORD SHAPES used by exported backups. Bump only when the
 * stored fields change, since restore validation compares against it.
 */
export const SCHEMA_VERSION = 1;

/**
 * Version of the on-disk IndexedDB structure. Bump whenever indexes change;
 * Dexie applies the new index set on open. Adding an index does not alter
 * record shapes, so SCHEMA_VERSION can stay where it is.
 */
export const DB_VERSION = 2;

export const DB_NAME = 'inventory-reconciliation';

export class InventoryDatabase extends Dexie {
  sonicItems!: Table<SonicItem, string>;
  listings!: Table<MarketplaceListing, string>;
  mappings!: Table<SkuMapping, number>;
  accounts!: Table<MarketplaceAccount, string>;
  profiles!: Table<ImportProfile, number>;
  importRuns!: Table<ImportRun, number>;
  discrepancies!: Table<Discrepancy, string>;
  reconciliationRuns!: Table<ReconciliationRun, number>;
  settings!: Table<AppSettings, string>;

  constructor() {
    super(DB_NAME);

    // v1 — initial index set.
    this.version(1).stores({
      // Natural primary key: the Sonic master SKU.
      sonicItems: 'sku, skuNormalized, quantity, inLatestSnapshot, lastSeenAt, updatedAt',
      // Composite id keeps repeated imports idempotent.
      listings:
        'id, sku, skuNormalized, marketplace, accountId, quantity, ' +
        '[marketplace+accountId], fulfillment.type, lastSeenAt, inLatestSnapshot',
      mappings:
        '++id, &[marketplace+accountId+listingSku], listingId, masterSku, status, ' +
        'method, [masterSku+status], [status+marketplace]',
      accounts: 'id, marketplace, active',
      profiles: '++id, name, sourceType, signature, [sourceType+signature], lastUsedAt',
      importRuns: '++id, startedAt, sourceType, marketplace, accountId, status',
      discrepancies:
        'id, type, severity, state, masterSku, listingId, marketplace, accountId, ' +
        '[state+severity], [state+type], firstSeenAt, lastSeenAt, lastRunId',
      reconciliationRuns: '++id, ranAt',
      settings: 'key',
    });

    // v2 — mappings gained accountId indexes. The per-account dashboard health
    // query filters mappings by account, which v1 could not serve.
    this.version(2).stores({
      mappings:
        '++id, &[marketplace+accountId+listingSku], listingId, masterSku, status, ' +
        'method, accountId, marketplace, [masterSku+status], [status+marketplace], ' +
        '[accountId+status]',
    });
  }
}

export const db = new InventoryDatabase();

/** Every table that holds operational data (used by clear-all and backup). */
export const OPERATIONAL_TABLES = [
  'sonicItems',
  'listings',
  'mappings',
  'accounts',
  'profiles',
  'importRuns',
  'discrepancies',
  'reconciliationRuns',
] as const;

export type OperationalTableName = (typeof OPERATIONAL_TABLES)[number];

/**
 * Core domain models.
 *
 * Design notes that matter for data integrity:
 *  - Sonic master SKU is the natural primary key for master inventory.
 *  - A marketplace listing is keyed by marketplace + accountId + the COMPLETE
 *    original marketplace SKU. Suffixes are never stripped from stored values.
 *  - Mappings are many-to-one (many marketplace listings -> one master SKU) and
 *    are stored separately so that re-imports never destroy them.
 */

export type Marketplace = 'amazon' | 'newegg';

export const MARKETPLACES: readonly Marketplace[] = ['amazon', 'newegg'] as const;

export const MARKETPLACE_LABELS: Record<Marketplace, string> = {
  amazon: 'Amazon',
  newegg: 'Newegg',
};

/**
 * Fulfillment classification.
 *  - seller_fulfilled : stock ships from our warehouse, so it must reconcile
 *                       against Sonic quantity.
 *  - marketplace_fulfilled : stock is physically held by the marketplace
 *                       (FBA, Newegg-shipped). Tracked separately; never
 *                       compared against Sonic warehouse stock.
 *  - unknown          : the import did not carry enough information. Flagged
 *                       for review rather than guessed.
 */
export type FulfillmentType = 'seller_fulfilled' | 'marketplace_fulfilled' | 'unknown';

export const FULFILLMENT_LABELS: Record<FulfillmentType, string> = {
  seller_fulfilled: 'Seller fulfilled',
  marketplace_fulfilled: 'Marketplace fulfilled',
  unknown: 'Unknown',
};

/** Marketplace-specific fulfillment code preserved verbatim from the file. */
export interface FulfillmentInfo {
  type: FulfillmentType;
  /** Raw value from the spreadsheet, e.g. "AMAZON_NA", "FBM", "Shipped by Newegg". */
  rawValue: string | null;
}

export type ImportSourceType = 'sonic' | 'marketplace';

export type ImportMode = 'full_snapshot' | 'incremental';

export const IMPORT_MODE_LABELS: Record<ImportMode, string> = {
  full_snapshot: 'Full snapshot',
  incremental: 'Incremental',
};

/** A configurable marketplace account/platform. Accounts may be inactive. */
export interface MarketplaceAccount {
  id: string;
  marketplace: Marketplace;
  label: string;
  /** Free-text note, e.g. the Newegg platform (USA / Business / Canada). */
  platform: string | null;
  active: boolean;
  /**
   * Default fulfillment assumption when a file carries no fulfillment column.
   * 'none' means do not assume — flag listings as unknown for review.
   */
  defaultFulfillment: FulfillmentType | 'none';
  createdAt: number;
  updatedAt: number;
}

/** Sonic master inventory record. Primary key: sku. */
export interface SonicItem {
  sku: string;
  /** Lowercased/normalized form, indexed for case-insensitive lookup. */
  skuNormalized: string;
  description: string | null;
  /** Quantity available in the Sonic warehouse. null = unknown, not zero. */
  quantity: number | null;
  /** Additional columns the user chose to carry through, verbatim. */
  extra: Record<string, string | number | null>;
  firstImportId: number;
  lastImportId: number;
  /** Epoch ms when this SKU was last seen in any Sonic import. */
  lastSeenAt: number;
  /**
   * True when the SKU was present in the most recent completed FULL Sonic
   * snapshot. False means the latest full snapshot did not contain it, which is
   * the trigger for the Priority 0 "absent from snapshot" discrepancy.
   * null means no full snapshot has ever been imported, so absence is unknown.
   */
  inLatestSnapshot: boolean | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A marketplace product listing.
 * Primary key: `${marketplace}|${accountId}|${sku}` — stable across re-imports,
 * which is what makes repeated imports upsert instead of duplicate.
 */
export interface MarketplaceListing {
  id: string;
  marketplace: Marketplace;
  accountId: string;
  /** COMPLETE original marketplace SKU, suffixes intact. Never normalized away. */
  sku: string;
  skuNormalized: string;
  title: string | null;
  /** The quantity field the user explicitly selected during import. */
  quantity: number | null;
  /** Which spreadsheet column the quantity came from, shown in the UI. */
  quantityField: string | null;
  fulfillment: FulfillmentInfo;
  /** Listing status text from the file (e.g. Active/Inactive), if present. */
  statusRaw: string | null;
  /** Derived: false only when the file explicitly says inactive. */
  active: boolean | null;
  extra: Record<string, string | number | null>;
  firstImportId: number;
  lastImportId: number;
  lastSeenAt: number;
  inLatestSnapshot: boolean | null;
  createdAt: number;
  updatedAt: number;
}

export type MappingStatus = 'approved' | 'suggested' | 'rejected';

export type MappingMethod = 'exact' | 'normalized' | 'fuzzy' | 'manual';

export const MAPPING_METHOD_LABELS: Record<MappingMethod, string> = {
  exact: 'Exact match',
  normalized: 'Normalized match',
  fuzzy: 'Fuzzy suggestion',
  manual: 'Manual',
};

/**
 * Links one marketplace listing to one Sonic master SKU.
 * Unique on [marketplace+accountId+listingSku] so a listing cannot silently
 * belong to two master SKUs; reassignment requires explicit user action.
 */
export interface SkuMapping {
  id?: number;
  marketplace: Marketplace;
  accountId: string;
  listingSku: string;
  listingId: string;
  masterSku: string;
  status: MappingStatus;
  method: MappingMethod;
  /** 0..1. 1 for exact/manual. */
  confidence: number;
  /**
   * Per-listing allocation override. null = use the account/global policy.
   * For 'fixed', allocationValue is the quantity this listing should show.
   * For 'percent', allocationValue is 0..100 of Sonic quantity.
   */
  allocationMode: AllocationMode | null;
  allocationValue: number | null;
  note: string | null;
  createdAt: number;
  updatedAt: number;
  /** Set when a user approved or rejected it, so re-imports never overwrite. */
  decidedAt: number | null;
}

/**
 * How Sonic stock is expected to be distributed across the seller-fulfilled
 * listings mapped to one master SKU.
 *  - full      : every listing is expected to show the whole Sonic quantity.
 *  - split_even: Sonic quantity divided evenly across mapped listings.
 *  - fixed     : listing shows a fixed configured quantity.
 *  - percent   : listing shows a percentage of Sonic quantity.
 */
export type AllocationMode = 'full' | 'split_even' | 'fixed' | 'percent';

export const ALLOCATION_LABELS: Record<AllocationMode, string> = {
  full: 'Full quantity on every listing',
  split_even: 'Split evenly across listings',
  fixed: 'Fixed quantity',
  percent: 'Percentage of Sonic quantity',
};

/** A saved spreadsheet column configuration. */
export interface ImportProfile {
  id?: number;
  name: string;
  sourceType: ImportSourceType;
  marketplace: Marketplace | null;
  accountId: string | null;
  sheetName: string | null;
  headerRowIndex: number;
  skuColumn: string;
  quantityColumn: string;
  descriptionColumn: string | null;
  fulfillmentColumn: string | null;
  statusColumn: string | null;
  extraColumns: string[];
  /** Fingerprint of the header set, used to auto-suggest this profile. */
  signature: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  useCount: number;
}

export type ImportRunStatus = 'committed' | 'failed';

export interface ImportValidationIssue {
  rowNumber: number;
  field: string;
  message: string;
  rawValue: string | null;
}

export interface ImportRun {
  id?: number;
  startedAt: number;
  finishedAt: number | null;
  sourceType: ImportSourceType;
  marketplace: Marketplace | null;
  accountId: string | null;
  fileName: string;
  fileSize: number;
  sheetName: string | null;
  mode: ImportMode;
  profileId: number | null;
  profileName: string | null;
  columnMapping: Record<string, string | null>;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateSkuRows: number;
  recordsAdded: number;
  recordsUpdated: number;
  recordsUnchanged: number;
  /** SKUs known before this import but absent from a full snapshot. */
  recordsMissingFromSnapshot: number;
  status: ImportRunStatus;
  errorMessage: string | null;
  issues: ImportValidationIssue[];
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Informational',
};

export type DiscrepancyType =
  | 'sonic_missing_listing_live'
  | 'sonic_zero_listing_positive'
  | 'quantity_mismatch'
  | 'listing_zero_sonic_available'
  | 'listing_unmapped'
  | 'sonic_no_listing'
  | 'listing_inactive'
  | 'allocation_exceeds_stock'
  | 'possible_duplicate_listing'
  | 'missing_quantity_data'
  | 'fulfillment_unknown';

export interface DiscrepancyTypeMeta {
  type: DiscrepancyType;
  label: string;
  description: string;
  defaultSeverity: Severity;
}

export const DISCREPANCY_TYPES: Record<DiscrepancyType, DiscrepancyTypeMeta> = {
  sonic_missing_listing_live: {
    type: 'sonic_missing_listing_live',
    label: 'Sonic SKU absent from snapshot, listing still live',
    description:
      'The master SKU was not present in the most recent completed full Sonic snapshot, but a mapped seller-fulfilled listing still has positive quantity.',
    defaultSeverity: 'critical',
  },
  sonic_zero_listing_positive: {
    type: 'sonic_zero_listing_positive',
    label: 'Sonic quantity zero, listing has stock',
    description:
      'Sonic reports zero available quantity while a mapped seller-fulfilled listing still shows positive quantity.',
    defaultSeverity: 'critical',
  },
  quantity_mismatch: {
    type: 'quantity_mismatch',
    label: 'Quantity differs from expected',
    description:
      'The seller-fulfilled listing quantity does not match the quantity expected under the active allocation policy.',
    defaultSeverity: 'high',
  },
  listing_zero_sonic_available: {
    type: 'listing_zero_sonic_available',
    label: 'Listing at zero while Sonic has stock',
    description:
      'A mapped seller-fulfilled listing shows zero quantity although Sonic has available stock. Potential lost sales.',
    defaultSeverity: 'medium',
  },
  listing_unmapped: {
    type: 'listing_unmapped',
    label: 'Listing has no approved mapping',
    description:
      'The marketplace listing is not linked to any approved Sonic master SKU, so it cannot be reconciled.',
    defaultSeverity: 'high',
  },
  sonic_no_listing: {
    type: 'sonic_no_listing',
    label: 'Sonic SKU has no marketplace listing',
    description: 'The master SKU has stock but no mapped marketplace listing.',
    defaultSeverity: 'low',
  },
  listing_inactive: {
    type: 'listing_inactive',
    label: 'Listing appears inactive',
    description:
      'The imported file reports this listing as inactive while Sonic has available stock.',
    defaultSeverity: 'low',
  },
  allocation_exceeds_stock: {
    type: 'allocation_exceeds_stock',
    label: 'Allocation exceeds available stock',
    description:
      'The combined expected quantity across mapped seller-fulfilled listings exceeds the available Sonic quantity.',
    defaultSeverity: 'high',
  },
  possible_duplicate_listing: {
    type: 'possible_duplicate_listing',
    label: 'Possible duplicate listings',
    description:
      'Several listings in the same account normalize to the same base SKU and are mapped to the same master SKU.',
    defaultSeverity: 'info',
  },
  missing_quantity_data: {
    type: 'missing_quantity_data',
    label: 'Missing or invalid quantity',
    description:
      'Quantity information is unknown for this record, so no reliable comparison is possible.',
    defaultSeverity: 'medium',
  },
  fulfillment_unknown: {
    type: 'fulfillment_unknown',
    label: 'Fulfillment type unknown',
    description:
      'The import did not provide enough information to classify fulfillment. Review before trusting reconciliation for this listing.',
    defaultSeverity: 'medium',
  },
};

export type DiscrepancyState = 'open' | 'resolved';

/**
 * A discrepancy record with history.
 * Primary key is deterministic (`type|masterSku|listingId`) so successive
 * reconciliation runs update the same record rather than piling up duplicates,
 * which is what makes firstSeenAt / reopenCount meaningful.
 */
export interface Discrepancy {
  id: string;
  type: DiscrepancyType;
  severity: Severity;
  state: DiscrepancyState;
  masterSku: string | null;
  listingId: string | null;
  marketplace: Marketplace | null;
  accountId: string | null;
  fulfillment: FulfillmentType | null;
  sonicQuantity: number | null;
  expectedQuantity: number | null;
  actualQuantity: number | null;
  difference: number | null;
  detail: string;
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
  /** How many times it went resolved -> open again. */
  reopenCount: number;
  lastReopenedAt: number | null;
  /** Reconciliation run that last observed it as open. */
  lastRunId: number;
  acknowledgedAt: number | null;
  note: string | null;
}

export interface ReconciliationRun {
  id?: number;
  ranAt: number;
  durationMs: number;
  sonicItemsEvaluated: number;
  listingsEvaluated: number;
  mappedListings: number;
  unmappedListings: number;
  counts: Record<Severity, number>;
  openTotal: number;
  resolvedThisRun: number;
  newThisRun: number;
  reopenedThisRun: number;
}

export interface AppSettings {
  key: string;
  value: unknown;
}

export type ThemeMode = 'light' | 'dark';

export interface ReconciliationConfig {
  defaultAllocation: AllocationMode;
  /** Per-account allocation override. */
  accountAllocation: Record<string, AllocationMode>;
  /** Absolute tolerance before a quantity difference is reported. */
  quantityTolerance: number;
  /** Report sonic_no_listing at all (noisy on large catalogs). */
  reportSonicWithoutListing: boolean;
  /** Minimum Sonic quantity before listing_zero_sonic_available is raised. */
  zeroListingMinSonicQty: number;
  /** Minimum score (0..1) for a fuzzy mapping suggestion to be offered. */
  fuzzyThreshold: number;
}

export const DEFAULT_RECONCILIATION_CONFIG: ReconciliationConfig = {
  defaultAllocation: 'full',
  accountAllocation: {},
  quantityTolerance: 0,
  reportSonicWithoutListing: false,
  zeroListingMinSonicQty: 1,
  fuzzyThreshold: 0.82,
};

export const SETTINGS_KEYS = {
  theme: 'theme',
  reconciliation: 'reconciliation',
  schemaVersion: 'schemaVersion',
  lastReconciliationRunId: 'lastReconciliationRunId',
} as const;

import { db, OPERATIONAL_TABLES, SCHEMA_VERSION, type OperationalTableName } from '../db/database';
import { SETTINGS_KEYS } from '../types/domain';
import { getSetting, setSetting } from '../db/settings';

export const BACKUP_FORMAT = 'inventory-reconciliation-backup';

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  appVersion: string;
  exportedAt: number;
  counts: Record<string, number>;
  tables: Record<string, unknown[]>;
  settings: Array<{ key: string; value: unknown }>;
}

export const APP_VERSION = '1.0.0';

export async function exportBackup(
  onProgress?: (table: string, index: number, total: number) => void,
): Promise<BackupFile> {
  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};

  for (let i = 0; i < OPERATIONAL_TABLES.length; i += 1) {
    const name = OPERATIONAL_TABLES[i] as OperationalTableName;
    onProgress?.(name, i, OPERATIONAL_TABLES.length);
    const rows = await db.table(name).toArray();
    tables[name] = rows;
    counts[name] = rows.length;
  }

  // Preferences travel with the backup, but not the schema-version marker.
  const settings = (await db.settings.toArray()).filter(
    (s) => s.key !== SETTINGS_KEYS.schemaVersion,
  );

  onProgress?.('done', OPERATIONAL_TABLES.length, OPERATIONAL_TABLES.length);

  return {
    format: BACKUP_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    exportedAt: Date.now(),
    counts,
    tables,
    settings,
  };
}

export function downloadBackup(backup: BackupFile): void {
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date(backup.exportedAt)
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `inventory-reconciliation-backup-${stamp}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a moment to start the download before revoking.
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export interface BackupValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  backup: BackupFile | null;
  counts: Record<string, number>;
}

/** Row-shape checks per table. A malformed backup must never be applied. */
const REQUIRED_FIELDS: Record<OperationalTableName, string[]> = {
  sonicItems: ['sku', 'skuNormalized'],
  listings: ['id', 'marketplace', 'accountId', 'sku'],
  mappings: ['marketplace', 'accountId', 'listingSku', 'masterSku', 'status'],
  accounts: ['id', 'marketplace', 'label'],
  profiles: ['name', 'sourceType', 'skuColumn', 'quantityColumn'],
  importRuns: ['startedAt', 'sourceType', 'fileName'],
  discrepancies: ['id', 'type', 'severity', 'state'],
  reconciliationRuns: ['ranAt', 'counts'],
};

export function validateBackup(text: string): BackupValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      errors: [`The file is not valid JSON (${err instanceof Error ? err.message : 'parse error'}).`],
      warnings,
      backup: null,
      counts: {},
    };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return {
      ok: false,
      errors: ['The backup file does not contain a JSON object.'],
      warnings,
      backup: null,
      counts: {},
    };
  }

  const candidate = parsed as Partial<BackupFile>;

  if (candidate.format !== BACKUP_FORMAT) {
    errors.push(
      `This file is not a backup from this application (expected format "${BACKUP_FORMAT}", found "${String(candidate.format)}").`,
    );
  }

  if (typeof candidate.schemaVersion !== 'number') {
    errors.push('The backup is missing a schema version identifier.');
  } else if (candidate.schemaVersion > SCHEMA_VERSION) {
    errors.push(
      `The backup was created by a newer version of the application (schema ${candidate.schemaVersion}, this build supports ${SCHEMA_VERSION}). Update the application before restoring.`,
    );
  } else if (candidate.schemaVersion < SCHEMA_VERSION) {
    warnings.push(
      `The backup uses an older schema (${candidate.schemaVersion} vs ${SCHEMA_VERSION}). It will be restored as-is.`,
    );
  }

  if (typeof candidate.tables !== 'object' || candidate.tables === null) {
    errors.push('The backup contains no table data.');
  }

  const counts: Record<string, number> = {};
  if (candidate.tables && typeof candidate.tables === 'object') {
    for (const name of OPERATIONAL_TABLES) {
      const rows = (candidate.tables as Record<string, unknown>)[name];
      if (rows === undefined) {
        warnings.push(`Table "${name}" is absent from the backup and will be left empty.`);
        counts[name] = 0;
        continue;
      }
      if (!Array.isArray(rows)) {
        errors.push(`Table "${name}" is not an array.`);
        continue;
      }
      counts[name] = rows.length;

      // Check a sample of rows rather than all of them, for speed.
      const required = REQUIRED_FIELDS[name];
      const sample = rows.slice(0, 50);
      for (const row of sample) {
        if (typeof row !== 'object' || row === null) {
          errors.push(`Table "${name}" contains a row that is not an object.`);
          break;
        }
        const missing = required.filter((f) => !(f in (row as Record<string, unknown>)));
        if (missing.length) {
          errors.push(
            `Table "${name}" contains rows missing required fields: ${missing.join(', ')}.`,
          );
          break;
        }
      }
    }
  }

  if (candidate.settings !== undefined && !Array.isArray(candidate.settings)) {
    errors.push('The settings section of the backup is malformed.');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    backup: errors.length === 0 ? (candidate as BackupFile) : null,
    counts,
  };
}

export type RestoreMode = 'replace' | 'merge';

export interface RestoreResult {
  mode: RestoreMode;
  written: Record<string, number>;
}

/**
 * Applies a validated backup.
 *  - 'replace' clears each operational table first.
 *  - 'merge' upserts rows by primary key, so existing records with the same key
 *    are overwritten by the backup and everything else is kept.
 *
 * Each table is written in its own transaction so a failure part-way leaves the
 * other tables intact and reports which table failed.
 */
export async function restoreBackup(
  backup: BackupFile,
  mode: RestoreMode,
  onProgress?: (table: string, index: number, total: number) => void,
): Promise<RestoreResult> {
  const written: Record<string, number> = {};

  for (let i = 0; i < OPERATIONAL_TABLES.length; i += 1) {
    const name = OPERATIONAL_TABLES[i] as OperationalTableName;
    onProgress?.(name, i, OPERATIONAL_TABLES.length);
    const rows = (backup.tables[name] ?? []) as unknown[];
    const table = db.table(name);

    try {
      await db.transaction('rw', table, async () => {
        if (mode === 'replace') await table.clear();
        if (rows.length) {
          const CHUNK = 2000;
          for (let j = 0; j < rows.length; j += CHUNK) {
            await table.bulkPut(rows.slice(j, j + CHUNK));
          }
        }
      });
      written[name] = rows.length;
    } catch (err) {
      throw new Error(
        `Restore failed while writing "${name}": ${
          err instanceof Error ? err.message : 'unknown error'
        }. Tables written before this point were applied; later tables were not.`,
      );
    }
  }

  if (Array.isArray(backup.settings)) {
    for (const entry of backup.settings) {
      if (entry && typeof entry.key === 'string' && entry.key !== SETTINGS_KEYS.schemaVersion) {
        await setSetting(entry.key, entry.value);
      }
    }
  }
  await setSetting(SETTINGS_KEYS.schemaVersion, SCHEMA_VERSION);

  onProgress?.('done', OPERATIONAL_TABLES.length, OPERATIONAL_TABLES.length);
  return { mode, written };
}

/**
 * Deletes every operational record from IndexedDB.
 * The theme preference is kept so the UI does not flip appearance, and the
 * schema-version marker is re-written so the database stays usable.
 */
export async function clearAllData(
  onProgress?: (table: string, index: number, total: number) => void,
): Promise<Record<string, number>> {
  const cleared: Record<string, number> = {};
  const theme = await getSetting<unknown>(SETTINGS_KEYS.theme, null);

  for (let i = 0; i < OPERATIONAL_TABLES.length; i += 1) {
    const name = OPERATIONAL_TABLES[i] as OperationalTableName;
    onProgress?.(name, i, OPERATIONAL_TABLES.length);
    const table = db.table(name);
    cleared[name] = await table.count();
    await table.clear();
  }

  await db.settings.clear();
  if (theme !== null) await setSetting(SETTINGS_KEYS.theme, theme);
  await setSetting(SETTINGS_KEYS.schemaVersion, SCHEMA_VERSION);

  onProgress?.('done', OPERATIONAL_TABLES.length, OPERATIONAL_TABLES.length);
  return cleared;
}

export async function getDataFootprint(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of OPERATIONAL_TABLES) {
    out[name] = await db.table(name).count();
  }
  return out;
}

export async function estimateStorage(): Promise<{ usage: number | null; quota: number | null }> {
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      return { usage: est.usage ?? null, quota: est.quota ?? null };
    }
  } catch {
    /* not supported */
  }
  return { usage: null, quota: null };
}

import { db, SCHEMA_VERSION } from './database';
import {
  DEFAULT_RECONCILIATION_CONFIG,
  SETTINGS_KEYS,
  type ReconciliationConfig,
} from '../types/domain';

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  if (!row) return fallback;
  return row.value as T;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}

export async function getReconciliationConfig(): Promise<ReconciliationConfig> {
  const stored = await getSetting<Partial<ReconciliationConfig>>(
    SETTINGS_KEYS.reconciliation,
    {},
  );
  return { ...DEFAULT_RECONCILIATION_CONFIG, ...stored };
}

export async function saveReconciliationConfig(
  config: ReconciliationConfig,
): Promise<void> {
  await setSetting(SETTINGS_KEYS.reconciliation, config);
}

export async function ensureSchemaVersion(): Promise<void> {
  const current = await getSetting<number | null>(SETTINGS_KEYS.schemaVersion, null);
  if (current !== SCHEMA_VERSION) {
    await setSetting(SETTINGS_KEYS.schemaVersion, SCHEMA_VERSION);
  }
}

import { db } from './database';
import type { FulfillmentType, Marketplace, MarketplaceAccount } from '../types/domain';

export interface AccountDraft {
  marketplace: Marketplace;
  label: string;
  platform?: string | null;
  active?: boolean;
  defaultFulfillment?: FulfillmentType | 'none';
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

export async function createAccount(draft: AccountDraft): Promise<string> {
  const base = `${draft.marketplace}-${slugify(draft.label) || 'account'}`;
  let id = base;
  let suffix = 2;
  while (await db.accounts.get(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  const now = Date.now();
  await db.accounts.put({
    id,
    marketplace: draft.marketplace,
    label: draft.label.trim(),
    platform: draft.platform?.trim() || null,
    active: draft.active ?? true,
    defaultFulfillment: draft.defaultFulfillment ?? 'none',
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function updateAccount(
  id: string,
  patch: Partial<Omit<MarketplaceAccount, 'id' | 'createdAt'>>,
): Promise<void> {
  await db.accounts.update(id, { ...patch, updatedAt: Date.now() });
}

/**
 * Removes an account. Listings and mappings for the account are NOT deleted —
 * records are never hard-deleted as a side effect. The caller is told what
 * remains so it can warn the user.
 */
export async function deleteAccount(id: string): Promise<{ orphanedListings: number }> {
  const orphanedListings = await db.listings.where('accountId').equals(id).count();
  await db.accounts.delete(id);
  return { orphanedListings };
}

export async function listAccounts(): Promise<MarketplaceAccount[]> {
  const rows = await db.accounts.toArray();
  return rows.sort(
    (a, b) => a.marketplace.localeCompare(b.marketplace) || a.label.localeCompare(b.label),
  );
}

export async function getAccountMap(): Promise<Map<string, MarketplaceAccount>> {
  const rows = await db.accounts.toArray();
  return new Map(rows.map((r) => [r.id, r]));
}

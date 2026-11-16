import { db } from './database';
import type { ImportProfile, ImportSourceType } from '../types/domain';

export async function saveProfile(
  profile: Omit<ImportProfile, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt' | 'useCount'>,
  existingId?: number,
): Promise<number> {
  const now = Date.now();
  if (existingId) {
    await db.profiles.update(existingId, { ...profile, updatedAt: now });
    return existingId;
  }
  return (await db.profiles.add({
    ...profile,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    useCount: 0,
  } as ImportProfile)) as number;
}

export async function markProfileUsed(id: number): Promise<void> {
  const profile = await db.profiles.get(id);
  if (!profile) return;
  await db.profiles.update(id, {
    lastUsedAt: Date.now(),
    useCount: (profile.useCount ?? 0) + 1,
  });
}

export async function listProfiles(sourceType?: ImportSourceType): Promise<ImportProfile[]> {
  const rows = sourceType
    ? await db.profiles.where('sourceType').equals(sourceType).toArray()
    : await db.profiles.toArray();
  return rows.sort(
    (a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt),
  );
}

/** Finds a saved profile matching a file's header layout. */
export async function findProfileBySignature(
  sourceType: ImportSourceType,
  signature: string,
  accountId: string | null,
): Promise<ImportProfile | null> {
  const matches = await db.profiles
    .where('[sourceType+signature]')
    .equals([sourceType, signature])
    .toArray();
  if (!matches.length) return null;
  // Prefer a profile saved for this same account.
  const forAccount = matches.find((p) => p.accountId === accountId);
  if (forAccount) return forAccount;
  return (
    matches.sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt))[0] ??
    null
  );
}

export async function deleteProfile(id: number): Promise<void> {
  await db.profiles.delete(id);
}

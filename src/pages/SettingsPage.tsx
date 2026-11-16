import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Badge,
  Card,
  InfoNote,
  LoadingBlock,
  PageHeader,
  SectionTitle,
  Toggle,
} from '../components/ui/Primitives';
import { Modal } from '../components/ui/Modal';
import {
  IconAlert,
  IconDownload,
  IconMoon,
  IconSun,
  IconTrash,
  IconUpload,
} from '../components/icons';
import { createAccount, deleteAccount, listAccounts, updateAccount } from '../db/accounts';
import { getReconciliationConfig, saveReconciliationConfig } from '../db/settings';
import {
  clearAllData,
  downloadBackup,
  estimateStorage,
  exportBackup,
  getDataFootprint,
  restoreBackup,
  validateBackup,
  type BackupValidation,
  type RestoreMode,
} from '../services/backup';
import { useTheme } from '../components/ThemeProvider';
import { useToast } from '../components/ToastProvider';
import { formatBytes, formatDateTime, formatNumber } from '../utils/format';
import { SCHEMA_VERSION } from '../db/database';
import {
  ALLOCATION_LABELS,
  FULFILLMENT_LABELS,
  MARKETPLACE_LABELS,
  MARKETPLACES,
  type AllocationMode,
  type FulfillmentType,
  type Marketplace,
  type ReconciliationConfig,
} from '../types/domain';

const TABLE_LABELS: Record<string, string> = {
  sonicItems: 'Sonic inventory records',
  listings: 'Marketplace listings',
  mappings: 'SKU mappings',
  accounts: 'Marketplace accounts',
  profiles: 'Import profiles',
  importRuns: 'Import history entries',
  discrepancies: 'Discrepancy records',
  reconciliationRuns: 'Reconciliation runs',
};

export function SettingsPage() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Settings"
        description="Marketplace accounts, reconciliation behaviour, appearance, and local data management."
      />
      <AppearanceCard />
      <AccountsCard />
      <ReconciliationCard />
      <BackupCard />
      <ClearDataCard />
      <AboutCard />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function AppearanceCard() {
  const { theme, setTheme } = useTheme();
  return (
    <Card>
      <SectionTitle>Appearance</SectionTitle>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={theme === 'light' ? 'btn-primary' : 'btn-secondary'}
          onClick={() => setTheme('light')}
        >
          <IconSun width={15} height={15} />
          Light
        </button>
        <button
          type="button"
          className={theme === 'dark' ? 'btn-primary' : 'btn-secondary'}
          onClick={() => setTheme('dark')}
        >
          <IconMoon width={15} height={15} />
          Dark
        </button>
      </div>
      <p className="mt-2 text-xs text-muted">
        The theme preference is remembered in this browser.
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function AccountsCard() {
  const toast = useToast();
  const accounts = useLiveQuery(() => listAccounts(), [], []);
  const [adding, setAdding] = useState(false);
  const [marketplace, setMarketplace] = useState<Marketplace>('amazon');
  const [label, setLabel] = useState('');
  const [platform, setPlatform] = useState('');
  const [defaultFulfillment, setDefaultFulfillment] = useState<FulfillmentType | 'none'>('none');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const onAdd = async () => {
    if (!label.trim()) {
      toast.error('A label is required');
      return;
    }
    try {
      await createAccount({
        marketplace,
        label,
        platform: platform || null,
        defaultFulfillment,
      });
      toast.success('Account added', label.trim());
      setLabel('');
      setPlatform('');
      setDefaultFulfillment('none');
      setAdding(false);
    } catch (err) {
      toast.error('Could not add account', err instanceof Error ? err.message : 'Unknown error.');
    }
  };

  const onDelete = async (id: string) => {
    try {
      const { orphanedListings } = await deleteAccount(id);
      toast.info(
        'Account removed',
        orphanedListings > 0
          ? `${formatNumber(orphanedListings)} imported listings were kept and are no longer linked to an account.`
          : undefined,
      );
      setConfirmDelete(null);
    } catch (err) {
      toast.error('Could not remove account', err instanceof Error ? err.message : 'Unknown error.');
    }
  };

  return (
    <Card>
      <SectionTitle
        action={
          <button type="button" className="btn-secondary btn-sm" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'Add account'}
          </button>
        }
      >
        Marketplace accounts
      </SectionTitle>

      <p className="-mt-2 mb-3 text-xs text-muted">
        Marketplace exports are imported per account, so one marketplace can have several
        accounts or platforms. Accounts can be marked inactive without deleting their data.
      </p>

      {adding ? (
        <div className="mb-4 grid gap-3 rounded-md border border-edge bg-elevated/40 p-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label" htmlFor="acct-mp">
              Marketplace
            </label>
            <select
              id="acct-mp"
              className="field"
              value={marketplace}
              onChange={(e) => setMarketplace(e.target.value as Marketplace)}
            >
              {MARKETPLACES.map((m) => (
                <option key={m} value={m}>
                  {MARKETPLACE_LABELS[m]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="acct-label">
              Label
            </label>
            <input
              id="acct-label"
              className="field"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Amazon US main"
            />
          </div>
          <div>
            <label className="label" htmlFor="acct-platform">
              Platform (optional)
            </label>
            <input
              id="acct-platform"
              className="field"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              placeholder="e.g. Newegg USA"
            />
          </div>
          <div>
            <label className="label" htmlFor="acct-ful">
              Default fulfillment
            </label>
            <select
              id="acct-ful"
              className="field"
              value={defaultFulfillment}
              onChange={(e) => setDefaultFulfillment(e.target.value as FulfillmentType | 'none')}
            >
              <option value="none">Do not assume — flag for review</option>
              <option value="seller_fulfilled">Seller fulfilled</option>
              <option value="marketplace_fulfilled">Marketplace fulfilled</option>
            </select>
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            <button type="button" className="btn-primary" onClick={onAdd}>
              Add account
            </button>
            <p className="mt-1 text-2xs text-faint">
              The default fulfillment is only used when an imported file has no fulfillment
              column.
            </p>
          </div>
        </div>
      ) : null}

      {accounts.length === 0 ? (
        <InfoNote tone="warn">
          No marketplace accounts configured. Add at least one before importing Amazon or Newegg
          exports.
        </InfoNote>
      ) : (
        <div className="overflow-x-auto rounded-md border border-edge">
          <table className="w-full min-w-[720px]">
            <thead className="border-b border-edge bg-elevated/50">
              <tr>
                <th className="th">Label</th>
                <th className="th">Marketplace</th>
                <th className="th">Platform</th>
                <th className="th">Default fulfillment</th>
                <th className="th">Account id</th>
                <th className="th text-center">Active</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td className="td font-medium">{a.label}</td>
                  <td className="td text-xs">{MARKETPLACE_LABELS[a.marketplace]}</td>
                  <td className="td text-xs text-muted">{a.platform ?? '—'}</td>
                  <td className="td text-xs">
                    {a.defaultFulfillment === 'none' ? (
                      <span className="text-muted">Flag for review</span>
                    ) : (
                      FULFILLMENT_LABELS[a.defaultFulfillment]
                    )}
                  </td>
                  <td className="td mono text-2xs text-faint">{a.id}</td>
                  <td className="td text-center">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-edge"
                      checked={a.active}
                      onChange={(e) => void updateAccount(a.id, { active: e.target.checked })}
                      aria-label={`${a.label} active`}
                    />
                  </td>
                  <td className="td text-right">
                    <button
                      type="button"
                      className="btn-ghost btn-sm text-red-600 dark:text-red-400"
                      onClick={() => setConfirmDelete(a.id)}
                    >
                      <IconTrash width={13} height={13} />
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="Remove marketplace account?"
        width="sm"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setConfirmDelete(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={() => confirmDelete && void onDelete(confirmDelete)}
            >
              Remove account
            </button>
          </>
        }
      >
        <p className="text-sm text-muted">
          Imported listings, mappings and history for this account are <strong>kept</strong> —
          nothing is deleted. The listings will simply no longer be linked to a configured
          account, and will appear as such in reconciliation.
        </p>
      </Modal>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function ReconciliationCard() {
  const toast = useToast();
  const [config, setConfig] = useState<ReconciliationConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const accounts = useLiveQuery(() => listAccounts(), [], []);

  useEffect(() => {
    void getReconciliationConfig().then(setConfig);
  }, []);

  const save = async (next: ReconciliationConfig) => {
    setConfig(next);
    setSaving(true);
    try {
      await saveReconciliationConfig(next);
    } catch (err) {
      toast.error('Could not save settings', err instanceof Error ? err.message : 'Unknown error.');
    } finally {
      setSaving(false);
    }
  };

  if (!config) {
    return (
      <Card>
        <LoadingBlock />
      </Card>
    );
  }

  return (
    <Card>
      <SectionTitle action={saving ? <span className="text-2xs text-faint">Saving…</span> : undefined}>
        Reconciliation behaviour
      </SectionTitle>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label className="label" htmlFor="rec-alloc">
            Default stock allocation
          </label>
          <select
            id="rec-alloc"
            className="field"
            value={config.defaultAllocation}
            onChange={(e) =>
              void save({ ...config, defaultAllocation: e.target.value as AllocationMode })
            }
          >
            {(Object.keys(ALLOCATION_LABELS) as AllocationMode[])
              .filter((m) => m === 'full' || m === 'split_even')
              .map((m) => (
                <option key={m} value={m}>
                  {ALLOCATION_LABELS[m]}
                </option>
              ))}
          </select>
          <p className="mt-1 text-2xs text-muted">
            How Sonic stock is expected to be spread across the seller-fulfilled listings mapped
            to one master SKU. Fixed and percentage policies are set per mapping on the SKU
            Mapping page.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="rec-tol">
            Quantity tolerance
          </label>
          <input
            id="rec-tol"
            type="number"
            min={0}
            className="field"
            value={config.quantityTolerance}
            onChange={(e) =>
              void save({ ...config, quantityTolerance: Math.max(0, Number(e.target.value) || 0) })
            }
          />
          <p className="mt-1 text-2xs text-muted">
            Differences within this many units are not reported as mismatches.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="rec-zero">
            Minimum Sonic quantity for zero-listing alerts
          </label>
          <input
            id="rec-zero"
            type="number"
            min={1}
            className="field"
            value={config.zeroListingMinSonicQty}
            onChange={(e) =>
              void save({
                ...config,
                zeroListingMinSonicQty: Math.max(1, Number(e.target.value) || 1),
              })
            }
          />
          <p className="mt-1 text-2xs text-muted">
            A listing at zero is only flagged when Sonic holds at least this much stock.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="rec-fuzzy">
            Fuzzy match threshold ({Math.round(config.fuzzyThreshold * 100)}%)
          </label>
          <input
            id="rec-fuzzy"
            type="range"
            min={60}
            max={99}
            className="w-full accent-[rgb(var(--c-accent))]"
            value={Math.round(config.fuzzyThreshold * 100)}
            onChange={(e) => void save({ ...config, fuzzyThreshold: Number(e.target.value) / 100 })}
          />
          <p className="mt-1 text-2xs text-muted">
            Minimum similarity before a fuzzy mapping is offered as a suggestion. Fuzzy matches
            are never approved automatically.
          </p>
        </div>

        <div className="sm:col-span-2 lg:col-span-1 flex flex-col justify-center">
          <Toggle
            checked={config.reportSonicWithoutListing}
            onChange={(v) => void save({ ...config, reportSonicWithoutListing: v })}
            label="Report Sonic SKUs with stock but no marketplace listing"
          />
          <p className="mt-1 text-2xs text-muted">
            Off by default — on a large catalog this produces a very large number of
            informational records.
          </p>
        </div>
      </div>

      {accounts.length > 0 ? (
        <div className="mt-4">
          <p className="label">Per-account allocation override</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {accounts.map((a) => (
              <div key={a.id} className="flex items-center gap-2 rounded-md border border-edge px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate text-xs">{a.label}</span>
                <select
                  className="field !w-auto !py-1 !px-1.5 text-xs"
                  value={config.accountAllocation[a.id] ?? 'default'}
                  onChange={(e) => {
                    const next = { ...config.accountAllocation };
                    if (e.target.value === 'default') delete next[a.id];
                    else next[a.id] = e.target.value as AllocationMode;
                    void save({ ...config, accountAllocation: next });
                  }}
                >
                  <option value="default">Use default</option>
                  <option value="full">Full quantity</option>
                  <option value="split_even">Split evenly</option>
                </select>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function BackupCard() {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState<BackupValidation | null>(null);
  const [mode, setMode] = useState<RestoreMode>('replace');
  const [progressLabel, setProgressLabel] = useState<string | null>(null);

  const onExport = async () => {
    setBusy(true);
    try {
      const backup = await exportBackup((table) => setProgressLabel(table));
      downloadBackup(backup);
      const totalRows = Object.values(backup.counts).reduce((a, b) => a + b, 0);
      toast.success(
        'Backup exported',
        `${formatNumber(totalRows)} records written to a JSON file on this computer.`,
      );
    } catch (err) {
      toast.error('Export failed', err instanceof Error ? err.message : 'Unknown error.');
    } finally {
      setBusy(false);
      setProgressLabel(null);
    }
  };

  const onFileChosen = async (file: File) => {
    setBusy(true);
    try {
      const text = await file.text();
      setValidation(validateBackup(text));
    } catch (err) {
      toast.error('Could not read file', err instanceof Error ? err.message : 'Unknown error.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const onRestore = async () => {
    if (!validation?.backup) return;
    setBusy(true);
    try {
      const result = await restoreBackup(validation.backup, mode, (table) =>
        setProgressLabel(table),
      );
      const totalRows = Object.values(result.written).reduce((a, b) => a + b, 0);
      toast.success(
        'Backup restored',
        `${formatNumber(totalRows)} records ${mode === 'replace' ? 'replaced the' : 'merged into the'} local dataset.`,
      );
      setValidation(null);
    } catch (err) {
      toast.error('Restore failed', err instanceof Error ? err.message : 'Unknown error.');
    } finally {
      setBusy(false);
      setProgressLabel(null);
    }
  };

  return (
    <Card>
      <SectionTitle>Local backup</SectionTitle>
      <p className="-mt-2 mb-3 text-xs text-muted">
        All data lives in this browser only. It is not synchronized between computers, and
        clearing browser site data deletes it. Export a backup regularly, and keep the file
        somewhere safe. Backups are written and read entirely on this computer.
      </p>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary" onClick={onExport} disabled={busy}>
          <IconDownload width={15} height={15} />
          Export backup
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          <IconUpload width={15} height={15} />
          Restore from backup
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onFileChosen(file);
          }}
        />
        {progressLabel ? (
          <span className="self-center text-xs text-muted">
            {progressLabel === 'done' ? 'Finishing…' : `Processing ${progressLabel}…`}
          </span>
        ) : null}
      </div>

      <Modal
        open={validation !== null}
        onClose={() => setValidation(null)}
        title="Restore backup"
        description="Review what this backup contains before applying it."
        width="lg"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setValidation(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={onRestore}
              disabled={busy || !validation?.ok}
            >
              {mode === 'replace' ? 'Replace all local data' : 'Merge into local data'}
            </button>
          </>
        }
      >
        {validation ? (
          <div className="space-y-3">
            {!validation.ok ? (
              <InfoNote tone="bad">
                <p className="flex items-start gap-2 font-medium">
                  <IconAlert width={16} height={16} className="mt-0.5 shrink-0" />
                  This backup cannot be restored.
                </p>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-6">
                  {validation.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </InfoNote>
            ) : (
              <InfoNote>The backup structure and schema version are valid.</InfoNote>
            )}

            {validation.warnings.length > 0 ? (
              <InfoNote tone="warn">
                <ul className="list-disc space-y-0.5 pl-4">
                  {validation.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </InfoNote>
            ) : null}

            {validation.backup ? (
              <>
                <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <div>
                    <dt className="label">Exported</dt>
                    <dd className="text-sm">{formatDateTime(validation.backup.exportedAt)}</dd>
                  </div>
                  <div>
                    <dt className="label">Schema version</dt>
                    <dd className="text-sm">{validation.backup.schemaVersion}</dd>
                  </div>
                  <div>
                    <dt className="label">App version</dt>
                    <dd className="text-sm">{validation.backup.appVersion ?? 'Unknown'}</dd>
                  </div>
                </dl>

                <div>
                  <p className="label">Records in this backup</p>
                  <ul className="divide-y divide-edge rounded-md border border-edge">
                    {Object.entries(validation.counts).map(([table, count]) => (
                      <li key={table} className="flex items-center justify-between px-3 py-1.5">
                        <span className="text-xs">{TABLE_LABELS[table] ?? table}</span>
                        <span className="text-xs font-medium tabular-nums">
                          {formatNumber(count)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  <p className="label">How should it be applied?</p>
                  <div className="space-y-2">
                    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-edge p-2.5">
                      <input
                        type="radio"
                        className="mt-0.5"
                        checked={mode === 'replace'}
                        onChange={() => setMode('replace')}
                      />
                      <span>
                        <span className="block text-sm font-medium">Replace all local data</span>
                        <span className="block text-xs text-muted">
                          Every current record is removed first, then the backup is written. The
                          result matches the backup exactly.
                        </span>
                      </span>
                    </label>
                    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-edge p-2.5">
                      <input
                        type="radio"
                        className="mt-0.5"
                        checked={mode === 'merge'}
                        onChange={() => setMode('merge')}
                      />
                      <span>
                        <span className="block text-sm font-medium">Merge into local data</span>
                        <span className="block text-xs text-muted">
                          Records in the backup overwrite local records with the same key.
                          Anything not in the backup is kept.
                        </span>
                      </span>
                    </label>
                  </div>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

const CONFIRM_PHRASE = 'DELETE ALL DATA';

function ClearDataCard() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);

  const footprint = useLiveQuery(() => getDataFootprint(), [], {});
  const totalRecords = Object.values(footprint).reduce((a, b) => a + b, 0);

  const close = () => {
    setOpen(false);
    setPhrase('');
    setAcknowledged(false);
  };

  const onClear = async () => {
    setBusy(true);
    try {
      const cleared = await clearAllData((table) => setProgressLabel(table));
      const total = Object.values(cleared).reduce((a, b) => a + b, 0);
      toast.success(
        'All local data cleared',
        `${formatNumber(total)} records were permanently deleted. The application is ready for new imports.`,
      );
      close();
    } catch (err) {
      toast.error('Could not clear data', err instanceof Error ? err.message : 'Unknown error.');
    } finally {
      setBusy(false);
      setProgressLabel(null);
    }
  };

  const canConfirm = phrase.trim() === CONFIRM_PHRASE && acknowledged && !busy;

  return (
    <Card className="border-red-500/40">
      <SectionTitle>Clear all data</SectionTitle>
      <p className="-mt-2 mb-3 text-xs text-muted">
        Permanently deletes every record this application has stored in this browser. Application
        settings required to run, and the source code itself, are not affected.
      </p>

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Object.entries(footprint).map(([table, count]) => (
          <div key={table} className="rounded-md border border-edge px-2.5 py-1.5">
            <p className="text-2xs text-muted truncate">{TABLE_LABELS[table] ?? table}</p>
            <p className="text-base font-semibold tabular-nums">{formatNumber(count)}</p>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="btn-danger"
        onClick={() => setOpen(true)}
        disabled={totalRecords === 0}
      >
        <IconTrash width={15} height={15} />
        Clear all data
      </button>
      {totalRecords === 0 ? (
        <p className="mt-2 text-xs text-muted">There is no stored data to clear.</p>
      ) : null}

      <Modal
        open={open}
        onClose={busy ? () => undefined : close}
        title="Permanently delete all local data?"
        width="md"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn-danger" onClick={onClear} disabled={!canConfirm}>
              {busy ? 'Deleting…' : 'Permanently delete everything'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <InfoNote tone="bad">
            <p className="flex items-start gap-2 font-medium">
              <IconAlert width={16} height={16} className="mt-0.5 shrink-0" />
              This cannot be undone. There is no recycle bin and no server-side copy.
            </p>
          </InfoNote>

          <div>
            <p className="text-sm font-medium">The following will be permanently deleted:</p>
            <ul className="mt-1.5 divide-y divide-edge rounded-md border border-edge">
              {Object.entries(footprint).map(([table, count]) => (
                <li key={table} className="flex items-center justify-between px-3 py-1.5">
                  <span className="text-xs">{TABLE_LABELS[table] ?? table}</span>
                  <span className="text-xs font-medium tabular-nums">{formatNumber(count)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-xs text-muted">
              {formatNumber(totalRecords)} records in total. If you may need this data again,
              cancel and export a backup first.
            </p>
          </div>

          <Toggle
            checked={acknowledged}
            onChange={setAcknowledged}
            label="I understand this permanently deletes all locally stored inventory data."
            disabled={busy}
          />

          <div>
            <label className="label" htmlFor="confirm-phrase">
              Type <span className="mono font-semibold">{CONFIRM_PHRASE}</span> to confirm
            </label>
            <input
              id="confirm-phrase"
              className="field"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder={CONFIRM_PHRASE}
              autoComplete="off"
              disabled={busy}
            />
          </div>

          {progressLabel ? (
            <p className="text-xs text-muted">
              {progressLabel === 'done' ? 'Finishing…' : `Clearing ${progressLabel}…`}
            </p>
          ) : null}
        </div>
      </Modal>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function AboutCard() {
  const [storage, setStorage] = useState<{ usage: number | null; quota: number | null }>({
    usage: null,
    quota: null,
  });

  useEffect(() => {
    void estimateStorage().then(setStorage);
  }, []);

  return (
    <Card>
      <SectionTitle>About this installation</SectionTitle>
      <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="label">Storage</dt>
          <dd className="text-sm">IndexedDB in this browser</dd>
        </div>
        <div>
          <dt className="label">Schema version</dt>
          <dd className="text-sm">{SCHEMA_VERSION}</dd>
        </div>
        <div>
          <dt className="label">Estimated usage</dt>
          <dd className="text-sm">
            {storage.usage === null ? (
              <span className="text-faint">Unavailable</span>
            ) : (
              <>
                {formatBytes(storage.usage)}
                {storage.quota ? (
                  <span className="text-muted"> of ~{formatBytes(storage.quota)}</span>
                ) : null}
              </>
            )}
          </dd>
        </div>
        <div>
          <dt className="label">Marketplace APIs</dt>
          <dd className="text-sm">
            <Badge>Not connected</Badge>
          </dd>
        </div>
      </dl>
      <InfoNote>
        <p>
          This is a fully local, static application. There is no backend, no account system and no
          marketplace API integration — all inventory and listing data arrives through the manual
          spreadsheet imports you perform. No operational data leaves this computer.
        </p>
        <p className="mt-1.5">
          Because storage is per-browser, each computer has its own independent dataset. Use the
          backup export and restore above to move data between computers.
        </p>
      </InfoNote>
    </Card>
  );
}

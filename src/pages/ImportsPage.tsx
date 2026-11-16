import { useCallback, useMemo, useRef, useState } from 'react';
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
import { IconAlert, IconCheck, IconUpload, IconWarning } from '../components/icons';
import {
  loadWorkbook,
  extractSheetRows,
  type CellValue,
  type LoadedWorkbook,
} from '../services/workbook';
import {
  detectColumns,
  detectHeaderRow,
  headerSignature,
  suggestSheet,
  type DetectionResult,
} from '../services/detection';
import {
  buildPreview,
  commitImport,
  parseRows,
  type ColumnSelection,
  type ImportContext,
  type ImportPreview,
} from '../services/importEngine';
import {
  deleteProfile,
  findProfileBySignature,
  listProfiles,
  markProfileUsed,
  saveProfile,
} from '../db/profiles';
import { listAccounts } from '../db/accounts';
import { useToast } from '../components/ToastProvider';
import { formatBytes, formatNumber, formatRelative } from '../utils/format';
import {
  IMPORT_MODE_LABELS,
  MARKETPLACE_LABELS,
  type ImportMode,
  type ImportProfile,
  type ImportSourceType,
  type Marketplace,
} from '../types/domain';

type Step = 'file' | 'configure' | 'preview' | 'committing';

interface WizardState {
  step: Step;
  workbook: LoadedWorkbook | null;
  sheetName: string | null;
  rows: CellValue[][];
  detection: DetectionResult | null;
  sourceType: ImportSourceType;
  marketplace: Marketplace | null;
  accountId: string | null;
  mode: ImportMode | null;
  selection: ColumnSelection | null;
  preview: ImportPreview | null;
  matchedProfile: ImportProfile | null;
  profileName: string;
  saveAsProfile: boolean;
}

const INITIAL: WizardState = {
  step: 'file',
  workbook: null,
  sheetName: null,
  rows: [],
  detection: null,
  sourceType: 'sonic',
  marketplace: null,
  accountId: null,
  mode: null,
  selection: null,
  preview: null,
  matchedProfile: null,
  profileName: '',
  saveAsProfile: false,
};

export function ImportsPage() {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [s, setS] = useState<WizardState>(INITIAL);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);

  const accounts = useLiveQuery(() => listAccounts(), [], []);
  const profiles = useLiveQuery(() => listProfiles(), [], []);

  const reset = () => {
    setS(INITIAL);
    setError(null);
    setProgress(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  /* ---------------- step 1: file ---------------- */

  const onFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      try {
        const workbook = await loadWorkbook(file);
        const sheetName = suggestSheet(workbook.sheets, workbook.sheetNames);
        if (!sheetName) throw new Error('No usable worksheet was found in the file.');

        const rows = extractSheetRows(workbook.raw, sheetName);
        const header = detectHeaderRow(rows);
        const detection = detectColumns(rows, header);

        setS((prev) => ({
          ...prev,
          step: 'configure',
          workbook,
          sheetName,
          rows,
          detection,
          selection: defaultSelection(detection),
          profileName: file.name.replace(/\.[^.]+$/, ''),
        }));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The file could not be read.');
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  /* ---------------- sheet change ---------------- */

  const onSheetChange = (name: string) => {
    if (!s.workbook) return;
    try {
      const rows = extractSheetRows(s.workbook.raw, name);
      const header = detectHeaderRow(rows);
      const detection = detectColumns(rows, header);
      setS((prev) => ({
        ...prev,
        sheetName: name,
        rows,
        detection,
        selection: defaultSelection(detection),
        preview: null,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That worksheet could not be read.');
    }
  };

  const onHeaderRowChange = (index: number) => {
    if (!s.rows.length) return;
    const row = s.rows[index] ?? [];
    const headers = row.map((c, i) => {
      const text = c === null ? '' : String(c).trim();
      return text || `Column ${i + 1}`;
    });
    const header = { headerRowIndex: index, headers, confidence: 1, notes: [] };
    const detection = detectColumns(s.rows, header);
    setS((prev) => ({
      ...prev,
      detection,
      selection: defaultSelection(detection),
      preview: null,
    }));
  };

  /* ---------------- profile lookup ---------------- */

  const checkProfile = useCallback(
    async (sourceType: ImportSourceType, accountId: string | null) => {
      if (!s.detection) return;
      const signature = headerSignature(s.detection.header.headers);
      const profile = await findProfileBySignature(sourceType, signature, accountId);
      if (!profile) {
        setS((prev) => ({ ...prev, matchedProfile: null }));
        return;
      }
      // Apply the saved profile, matching columns by header name.
      const headers = s.detection.header.headers;
      const idx = (name: string | null): number | null => {
        if (!name) return null;
        const i = headers.findIndex((h) => h === name);
        return i >= 0 ? i : null;
      };
      const skuIdx = idx(profile.skuColumn);
      const qtyIdx = idx(profile.quantityColumn);
      if (skuIdx === null || qtyIdx === null) {
        setS((prev) => ({ ...prev, matchedProfile: profile }));
        return;
      }
      setS((prev) => ({
        ...prev,
        matchedProfile: profile,
        selection: {
          skuColumn: skuIdx,
          quantityColumn: qtyIdx,
          descriptionColumn: idx(profile.descriptionColumn),
          fulfillmentColumn: idx(profile.fulfillmentColumn),
          statusColumn: idx(profile.statusColumn),
          extraColumns: profile.extraColumns
            .map((n) => idx(n))
            .filter((x): x is number => x !== null),
        },
        preview: null,
      }));
    },
    [s.detection],
  );

  /* ---------------- step 2 → 3: preview ---------------- */

  const context = useMemo<ImportContext | null>(() => {
    if (!s.detection || !s.selection || !s.mode) return null;
    if (s.sourceType === 'marketplace' && (!s.marketplace || !s.accountId)) return null;
    const account = accounts.find((a) => a.id === s.accountId);
    return {
      sourceType: s.sourceType,
      marketplace: s.sourceType === 'marketplace' ? s.marketplace : null,
      accountId: s.sourceType === 'marketplace' ? s.accountId : null,
      accountDefaultFulfillment: account?.defaultFulfillment ?? 'none',
      mode: s.mode,
      fileName: s.workbook?.fileName ?? 'unknown',
      fileSize: s.workbook?.fileSize ?? 0,
      sheetName: s.sheetName,
      headers: s.detection.header.headers,
      headerRowIndex: s.detection.header.headerRowIndex,
      selection: s.selection,
      profileId: s.matchedProfile?.id ?? null,
      profileName: s.matchedProfile?.name ?? null,
    };
  }, [s, accounts]);

  const onPreview = async () => {
    if (!context) return;
    setBusy(true);
    setError(null);
    try {
      const parse = parseRows(s.rows, context);
      if (parse.rows.length === 0) {
        setError(
          'No valid rows were found with the current column selection. Check the header row and SKU column.',
        );
        setBusy(false);
        return;
      }
      const preview = await buildPreview(parse, context);
      setS((prev) => ({ ...prev, step: 'preview', preview }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The preview could not be built.');
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- step 3 → commit ---------------- */

  const onCommit = async () => {
    if (!context || !s.preview) return;
    setBusy(true);
    setError(null);
    setS((prev) => ({ ...prev, step: 'committing' }));
    try {
      const result = await commitImport(s.preview.parse, context, (done, total) =>
        setProgress({ done, total }),
      );

      if (s.saveAsProfile && s.detection && s.selection) {
        const h = (i: number | null) =>
          i === null ? null : (s.detection!.header.headers[i] ?? null);
        await saveProfile({
          name: s.profileName.trim() || `${s.sourceType} profile`,
          sourceType: s.sourceType,
          marketplace: context.marketplace,
          accountId: context.accountId,
          sheetName: s.sheetName,
          headerRowIndex: s.detection.header.headerRowIndex,
          skuColumn: h(s.selection.skuColumn) ?? '',
          quantityColumn: h(s.selection.quantityColumn) ?? '',
          descriptionColumn: h(s.selection.descriptionColumn),
          fulfillmentColumn: h(s.selection.fulfillmentColumn),
          statusColumn: h(s.selection.statusColumn),
          extraColumns: s.selection.extraColumns
            .map((i) => h(i))
            .filter((x): x is string => x !== null),
          signature: headerSignature(s.detection.header.headers),
        });
      }
      if (s.matchedProfile?.id) await markProfileUsed(s.matchedProfile.id);

      toast.success(
        'Import committed',
        `${formatNumber(result.recordsAdded)} added · ${formatNumber(result.recordsUpdated)} updated · ${formatNumber(result.recordsUnchanged)} unchanged${
          result.recordsMissingFromSnapshot > 0
            ? ` · ${formatNumber(result.recordsMissingFromSnapshot)} marked absent from snapshot`
            : ''
        }.`,
      );
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The import failed.');
      setS((prev) => ({ ...prev, step: 'preview' }));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const marketplaceAccounts = accounts.filter(
    (a) => !s.marketplace || a.marketplace === s.marketplace,
  );

  return (
    <div>
      <PageHeader
        title="Imports"
        description="Upload Sonic master inventory and marketplace exports. Column choices are always shown before anything is written, and repeated imports update existing records rather than duplicating them."
        actions={
          s.step !== 'file' ? (
            <button type="button" className="btn-secondary" onClick={reset} disabled={busy}>
              Start over
            </button>
          ) : null
        }
      />

      {error ? (
        <div className="mb-4">
          <InfoNote tone="bad">
            <span className="flex items-start gap-2">
              <IconAlert width={16} height={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </span>
          </InfoNote>
        </div>
      ) : null}

      <ol className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        {(['file', 'configure', 'preview'] as const).map((step, i) => {
          const order = ['file', 'configure', 'preview', 'committing'];
          const current = order.indexOf(s.step);
          const done = current > i;
          const active = s.step === step || (step === 'preview' && s.step === 'committing');
          return (
            <li key={step} className="flex items-center gap-2">
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-2xs font-semibold ${
                  active
                    ? 'bg-accent text-white'
                    : done
                      ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                      : 'bg-elevated text-faint'
                }`}
              >
                {done ? <IconCheck width={11} height={11} /> : i + 1}
              </span>
              <span className={active ? 'font-medium' : 'text-muted'}>
                {step === 'file' ? 'Choose file' : step === 'configure' ? 'Configure columns' : 'Review and commit'}
              </span>
              {i < 2 ? <span className="text-faint">→</span> : null}
            </li>
          );
        })}
      </ol>

      {/* ---------------- STEP 1 ---------------- */}
      {s.step === 'file' ? (
        <Card>
          <SectionTitle>Choose a spreadsheet</SectionTitle>
          <label
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-edge px-6 py-12 text-center transition-colors hover:border-accent/60 hover:bg-elevated/40"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files?.[0];
              if (file) void onFile(file);
            }}
          >
            <IconUpload width={26} height={26} className="text-faint" />
            <span className="text-sm font-medium">
              {busy ? 'Reading file…' : 'Drop a file here, or click to browse'}
            </span>
            <span className="text-xs text-muted">
              Accepts .xlsx, .xls and .csv. Files are read in this browser and never uploaded.
            </span>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept=".xlsx,.xls,.csv,.txt,.tsv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onFile(file);
              }}
            />
          </label>

          {profiles.length > 0 ? (
            <div className="mt-5">
              <SectionTitle>Saved import profiles</SectionTitle>
              <ul className="divide-y divide-edge rounded-md border border-edge">
                {profiles.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{p.name}</p>
                      <p className="truncate text-xs text-muted">
                        {p.sourceType === 'sonic'
                          ? 'Sonic inventory'
                          : `${p.marketplace ? MARKETPLACE_LABELS[p.marketplace] : 'Marketplace'}${p.accountId ? ` · ${p.accountId}` : ''}`}
                        {' · SKU: '}
                        {p.skuColumn}
                        {' · Qty: '}
                        {p.quantityColumn}
                      </p>
                    </div>
                    <span className="text-2xs text-faint">
                      {p.useCount > 0 ? `Used ${p.useCount}× · ${formatRelative(p.lastUsedAt)}` : 'Never used'}
                    </span>
                    <button
                      type="button"
                      className="btn-ghost btn-sm text-red-600 dark:text-red-400"
                      onClick={async () => {
                        await deleteProfile(p.id as number);
                        toast.info('Profile deleted');
                      }}
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">
                A matching profile is applied automatically when a file with the same column
                layout is uploaded.
              </p>
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* ---------------- STEP 2 ---------------- */}
      {s.step === 'configure' && s.workbook && s.detection && s.selection ? (
        <div className="space-y-4">
          <Card>
            <SectionTitle>
              {s.workbook.fileName}
            </SectionTitle>
            <p className="-mt-2 mb-3 text-xs text-muted">
              {formatBytes(s.workbook.fileSize)} ·{' '}
              {s.workbook.sheetNames.length === 1
                ? '1 worksheet'
                : `${s.workbook.sheetNames.length} worksheets`}
            </p>

            {s.matchedProfile ? (
              <div className="mb-3">
                <InfoNote>
                  Saved profile <strong>{s.matchedProfile.name}</strong> matches this file layout
                  and has been applied. Review the selections below — you can change anything.
                </InfoNote>
              </div>
            ) : null}

            {s.detection.header.notes.map((note) => (
              <div key={note} className="mb-2">
                <InfoNote tone="warn">
                  <span className="flex items-start gap-2">
                    <IconWarning width={15} height={15} className="mt-0.5 shrink-0" />
                    <span>{note}</span>
                  </span>
                </InfoNote>
              </div>
            ))}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="label" htmlFor="imp-source">
                  What is this file?
                </label>
                <select
                  id="imp-source"
                  className="field"
                  value={s.sourceType}
                  onChange={(e) => {
                    const sourceType = e.target.value as ImportSourceType;
                    setS((prev) => ({
                      ...prev,
                      sourceType,
                      marketplace: sourceType === 'sonic' ? null : prev.marketplace,
                      accountId: sourceType === 'sonic' ? null : prev.accountId,
                      preview: null,
                    }));
                    void checkProfile(sourceType, sourceType === 'sonic' ? null : s.accountId);
                  }}
                >
                  <option value="sonic">Sonic master inventory</option>
                  <option value="marketplace">Marketplace export</option>
                </select>
              </div>

              {s.sourceType === 'marketplace' ? (
                <>
                  <div>
                    <label className="label" htmlFor="imp-mp">
                      Marketplace
                    </label>
                    <select
                      id="imp-mp"
                      className="field"
                      value={s.marketplace ?? ''}
                      onChange={(e) => {
                        const marketplace = (e.target.value || null) as Marketplace | null;
                        setS((prev) => ({ ...prev, marketplace, accountId: null, preview: null }));
                      }}
                    >
                      <option value="">Select…</option>
                      <option value="amazon">Amazon</option>
                      <option value="newegg">Newegg</option>
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="imp-acct">
                      Account
                    </label>
                    <select
                      id="imp-acct"
                      className="field"
                      value={s.accountId ?? ''}
                      onChange={(e) => {
                        const accountId = e.target.value || null;
                        setS((prev) => ({ ...prev, accountId, preview: null }));
                        void checkProfile('marketplace', accountId);
                      }}
                      disabled={!s.marketplace}
                    >
                      <option value="">Select…</option>
                      {marketplaceAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                          {a.active ? '' : ' (inactive)'}
                        </option>
                      ))}
                    </select>
                    {s.marketplace && marketplaceAccounts.length === 0 ? (
                      <p className="mt-1 text-2xs text-amber-600 dark:text-amber-400">
                        No {MARKETPLACE_LABELS[s.marketplace]} account configured. Add one in
                        Settings first.
                      </p>
                    ) : null}
                  </div>
                </>
              ) : null}

              <div>
                <label className="label" htmlFor="imp-mode">
                  Import type
                </label>
                <select
                  id="imp-mode"
                  className="field"
                  value={s.mode ?? ''}
                  onChange={(e) =>
                    setS((prev) => ({
                      ...prev,
                      mode: (e.target.value || null) as ImportMode | null,
                      preview: null,
                    }))
                  }
                >
                  <option value="">Select…</option>
                  <option value="full_snapshot">Full snapshot — complete dataset</option>
                  <option value="incremental">Incremental — changed records only</option>
                </select>
              </div>
            </div>

            {s.mode === null ? (
              <div className="mt-3">
                <InfoNote tone="warn">
                  Choose the import type. A <strong>full snapshot</strong> means this file contains
                  every current record; SKUs absent from it will be flagged as absent (never
                  deleted). An <strong>incremental</strong> import only updates the records it
                  contains and leaves everything else untouched.
                </InfoNote>
              </div>
            ) : (
              <div className="mt-3">
                <InfoNote>
                  <strong>{IMPORT_MODE_LABELS[s.mode]}:</strong>{' '}
                  {s.mode === 'full_snapshot'
                    ? 'records not present in this file will be marked as absent from the latest snapshot. Their last known quantities are preserved and nothing is deleted.'
                    : 'only the records in this file will be updated. Records missing from the file are left exactly as they are.'}
                </InfoNote>
              </div>
            )}
          </Card>

          <Card>
            <SectionTitle>Worksheet and header row</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="imp-sheet">
                  Worksheet
                </label>
                <select
                  id="imp-sheet"
                  className="field"
                  value={s.sheetName ?? ''}
                  onChange={(e) => onSheetChange(e.target.value)}
                >
                  {s.workbook.sheetNames.map((name) => {
                    const sheet = s.workbook!.sheets[name];
                    return (
                      <option key={name} value={name}>
                        {name} ({formatNumber(sheet?.totalRows ?? 0)} rows)
                      </option>
                    );
                  })}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="imp-header">
                  Header row
                </label>
                <select
                  id="imp-header"
                  className="field"
                  value={s.detection.header.headerRowIndex}
                  onChange={(e) => onHeaderRowChange(Number(e.target.value))}
                >
                  {s.rows.slice(0, 25).map((row, i) => {
                    const preview = row
                      .slice(0, 5)
                      .map((c) => (c === null ? '' : String(c)))
                      .filter(Boolean)
                      .join(' | ');
                    return (
                      <option key={i} value={i}>
                        Row {i + 1}
                        {preview ? ` — ${preview.slice(0, 60)}` : ' — (empty)'}
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>
          </Card>

          <ColumnPicker
            detection={s.detection}
            selection={s.selection}
            sourceType={s.sourceType}
            onChange={(selection) => setS((prev) => ({ ...prev, selection, preview: null }))}
          />

          <SheetPreviewTable
            rows={s.rows}
            headerRowIndex={s.detection.header.headerRowIndex}
            headers={s.detection.header.headers}
            selection={s.selection}
          />

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={reset}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={onPreview}
              disabled={busy || context === null}
            >
              {busy ? 'Validating…' : 'Preview import'}
            </button>
          </div>
          {context === null ? (
            <p className="mt-2 text-right text-xs text-muted">
              Select the import type
              {s.sourceType === 'marketplace' ? ', marketplace and account' : ''} to continue.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ---------------- STEP 3 ---------------- */}
      {(s.step === 'preview' || s.step === 'committing') && s.preview && context ? (
        <PreviewPanel
          preview={s.preview}
          context={context}
          busy={busy}
          progress={progress}
          committing={s.step === 'committing'}
          saveAsProfile={s.saveAsProfile}
          profileName={s.profileName}
          onSaveProfileChange={(saveAsProfile) => setS((prev) => ({ ...prev, saveAsProfile }))}
          onProfileNameChange={(profileName) => setS((prev) => ({ ...prev, profileName }))}
          onBack={() => setS((prev) => ({ ...prev, step: 'configure' }))}
          onCommit={onCommit}
          onShowIssues={() => setIssuesOpen(true)}
        />
      ) : null}

      <Modal
        open={issuesOpen}
        onClose={() => setIssuesOpen(false)}
        title="Validation issues"
        description={
          s.preview
            ? `${formatNumber(s.preview.parse.issues.length)} issue${s.preview.parse.issues.length === 1 ? '' : 's'} recorded for this file. Nothing is discarded silently.`
            : undefined
        }
        width="xl"
        footer={
          <button type="button" className="btn-secondary" onClick={() => setIssuesOpen(false)}>
            Close
          </button>
        }
      >
        {s.preview ? (
          <div className="max-h-[60vh] overflow-y-auto rounded-md border border-edge">
            <table className="w-full">
              <thead className="sticky top-0 border-b border-edge bg-elevated">
                <tr>
                  <th className="th">Row</th>
                  <th className="th">Column</th>
                  <th className="th">Value</th>
                  <th className="th">Issue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {s.preview.parse.issues.map((issue, i) => (
                  <tr key={`${issue.rowNumber}-${issue.field}-${i}`}>
                    <td className="td tabular-nums">{issue.rowNumber}</td>
                    <td className="td text-xs">{issue.field}</td>
                    <td className="td mono text-xs max-w-[200px] truncate">
                      {issue.rawValue ?? <span className="text-faint">empty</span>}
                    </td>
                    <td className="td text-xs text-muted">{issue.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function defaultSelection(detection: DetectionResult): ColumnSelection {
  const sku = detection.skuCandidates[0];
  const qty = detection.quantityCandidates[0];
  const desc = detection.descriptionCandidates[0];
  const ful = detection.fulfillmentCandidates[0];
  const status = detection.statusCandidates[0];
  return {
    skuColumn: sku?.index ?? 0,
    quantityColumn: qty?.index ?? Math.min(1, detection.header.headers.length - 1),
    // Only auto-select optional columns when the signal is strong.
    descriptionColumn: desc && desc.score >= 0.8 ? desc.index : null,
    fulfillmentColumn: ful && ful.score >= 0.8 ? ful.index : null,
    statusColumn: status && status.score >= 0.8 ? status.index : null,
    extraColumns: [],
  };
}

function ColumnPicker({
  detection,
  selection,
  sourceType,
  onChange,
}: {
  detection: DetectionResult;
  selection: ColumnSelection;
  sourceType: ImportSourceType;
  onChange: (next: ColumnSelection) => void;
}) {
  const headers = detection.header.headers;

  const options = (allowNone: boolean) => (
    <>
      {allowNone ? <option value="">Not in this file</option> : null}
      {headers.map((h, i) => (
        <option key={`${h}-${i}`} value={i}>
          {h}
        </option>
      ))}
    </>
  );

  const candidateHint = (
    candidates: DetectionResult['skuCandidates'],
    chosen: number | null,
  ) => {
    if (chosen === null) return null;
    const match = candidates.find((c) => c.index === chosen);
    if (!match) {
      return (
        <p className="mt-1 text-2xs text-amber-600 dark:text-amber-400">
          This column was not auto-detected. Confirm it holds the right data.
        </p>
      );
    }
    const tone =
      match.score >= 0.85
        ? 'text-emerald-600 dark:text-emerald-400'
        : match.score >= 0.5
          ? 'text-muted'
          : 'text-amber-600 dark:text-amber-400';
    return (
      <p className={`mt-1 text-2xs ${tone}`}>
        {match.reason} ({Math.round(match.score * 100)}% confidence)
      </p>
    );
  };

  const quantityAlternatives = detection.quantityCandidates.filter(
    (c) => c.index !== selection.quantityColumn,
  );

  return (
    <Card>
      <SectionTitle>Column mapping</SectionTitle>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label className="label" htmlFor="col-sku">
            {sourceType === 'sonic' ? 'Sonic master SKU' : 'Marketplace SKU'} <span className="text-red-500">*</span>
          </label>
          <select
            id="col-sku"
            className="field"
            value={selection.skuColumn}
            onChange={(e) => onChange({ ...selection, skuColumn: Number(e.target.value) })}
          >
            {options(false)}
          </select>
          {candidateHint(detection.skuCandidates, selection.skuColumn)}
          {sourceType === 'marketplace' ? (
            <p className="mt-1 text-2xs text-faint">
              The complete SKU including any suffix is stored exactly as it appears.
            </p>
          ) : null}
        </div>

        <div>
          <label className="label" htmlFor="col-qty">
            Quantity <span className="text-red-500">*</span>
          </label>
          <select
            id="col-qty"
            className="field"
            value={selection.quantityColumn}
            onChange={(e) => onChange({ ...selection, quantityColumn: Number(e.target.value) })}
          >
            {options(false)}
          </select>
          {candidateHint(detection.quantityCandidates, selection.quantityColumn)}
          <p className="mt-1 text-2xs font-medium">
            Reconciling against:{' '}
            <span className="mono">{headers[selection.quantityColumn] ?? '—'}</span>
          </p>
          {quantityAlternatives.length > 0 ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-2xs text-muted hover:text-ink">
                {quantityAlternatives.length} other quantity-like{' '}
                {quantityAlternatives.length === 1 ? 'column' : 'columns'} in this file
              </summary>
              <ul className="mt-1 space-y-0.5">
                {quantityAlternatives.map((c) => (
                  <li key={c.index} className="text-2xs text-faint">
                    <button
                      type="button"
                      className="mono underline hover:text-accent"
                      onClick={() => onChange({ ...selection, quantityColumn: c.index })}
                    >
                      {c.name}
                    </button>{' '}
                    — {c.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>

        <div>
          <label className="label" htmlFor="col-desc">
            Description / title
          </label>
          <select
            id="col-desc"
            className="field"
            value={selection.descriptionColumn ?? ''}
            onChange={(e) =>
              onChange({
                ...selection,
                descriptionColumn: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          >
            {options(true)}
          </select>
          {candidateHint(detection.descriptionCandidates, selection.descriptionColumn)}
        </div>

        {sourceType === 'marketplace' ? (
          <>
            <div>
              <label className="label" htmlFor="col-ful">
                Fulfillment
              </label>
              <select
                id="col-ful"
                className="field"
                value={selection.fulfillmentColumn ?? ''}
                onChange={(e) =>
                  onChange({
                    ...selection,
                    fulfillmentColumn: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              >
                {options(true)}
              </select>
              {candidateHint(detection.fulfillmentCandidates, selection.fulfillmentColumn)}
              {selection.fulfillmentColumn === null ? (
                <p className="mt-1 text-2xs text-amber-600 dark:text-amber-400">
                  Without this column, fulfillment falls back to the account default, or is
                  flagged as unknown for review.
                </p>
              ) : null}
            </div>

            <div>
              <label className="label" htmlFor="col-status">
                Listing status
              </label>
              <select
                id="col-status"
                className="field"
                value={selection.statusColumn ?? ''}
                onChange={(e) =>
                  onChange({
                    ...selection,
                    statusColumn: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              >
                {options(true)}
              </select>
              {candidateHint(detection.statusCandidates, selection.statusColumn)}
            </div>
          </>
        ) : null}
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer text-xs font-medium text-muted hover:text-ink">
          Carry through additional columns ({selection.extraColumns.length} selected)
        </summary>
        <div className="mt-2 grid max-h-48 gap-1 overflow-y-auto rounded-md border border-edge p-2 sm:grid-cols-2 lg:grid-cols-3">
          {headers.map((h, i) => {
            const isCore =
              i === selection.skuColumn ||
              i === selection.quantityColumn ||
              i === selection.descriptionColumn ||
              i === selection.fulfillmentColumn ||
              i === selection.statusColumn;
            return (
              <label
                key={`${h}-extra-${i}`}
                className={`flex items-center gap-1.5 text-xs ${isCore ? 'opacity-40' : 'cursor-pointer'}`}
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-edge"
                  disabled={isCore}
                  checked={selection.extraColumns.includes(i)}
                  onChange={(e) =>
                    onChange({
                      ...selection,
                      extraColumns: e.target.checked
                        ? [...selection.extraColumns, i]
                        : selection.extraColumns.filter((x) => x !== i),
                    })
                  }
                />
                <span className="truncate" title={h}>
                  {h}
                </span>
              </label>
            );
          })}
        </div>
        <p className="mt-1 text-2xs text-faint">
          Everything not selected here is ignored. Extra columns are stored verbatim and shown in
          record details.
        </p>
      </details>
    </Card>
  );
}

function SheetPreviewTable({
  rows,
  headerRowIndex,
  headers,
  selection,
}: {
  rows: CellValue[][];
  headerRowIndex: number;
  headers: string[];
  selection: ColumnSelection;
}) {
  const sample = rows.slice(headerRowIndex + 1, headerRowIndex + 9);
  const highlight = (i: number): string => {
    if (i === selection.skuColumn) return 'bg-accent-soft/60';
    if (i === selection.quantityColumn) return 'bg-emerald-500/10';
    if (
      i === selection.descriptionColumn ||
      i === selection.fulfillmentColumn ||
      i === selection.statusColumn
    ) {
      return 'bg-amber-500/10';
    }
    if (selection.extraColumns.includes(i)) return 'bg-slate-500/10';
    return 'opacity-50';
  };

  return (
    <Card padded={false}>
      <div className="px-4 pt-4">
        <SectionTitle>File preview</SectionTitle>
        <p className="-mt-2 mb-3 flex flex-wrap gap-3 text-2xs text-muted">
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-accent-soft" /> SKU
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500/40" /> Quantity
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-amber-500/40" /> Optional field
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-slate-500/40" /> Carried through
          </span>
          <span className="text-faint">Faded columns are ignored.</span>
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-y border-edge bg-elevated/50">
            <tr>
              <th className="th w-10 text-right">#</th>
              {headers.map((h, i) => (
                <th key={`${h}-${i}`} className={`th ${highlight(i)}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {sample.map((row, r) => (
              <tr key={r}>
                <td className="td text-right text-2xs text-faint tabular-nums">
                  {headerRowIndex + r + 2}
                </td>
                {headers.map((_h, i) => (
                  <td key={i} className={`td text-xs max-w-[200px] truncate ${highlight(i)}`}>
                    {row[i] === null || row[i] === undefined ? (
                      <span className="text-faint">—</span>
                    ) : (
                      String(row[i])
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function PreviewPanel({
  preview,
  context,
  busy,
  progress,
  committing,
  saveAsProfile,
  profileName,
  onSaveProfileChange,
  onProfileNameChange,
  onBack,
  onCommit,
  onShowIssues,
}: {
  preview: ImportPreview;
  context: ImportContext;
  busy: boolean;
  progress: { done: number; total: number } | null;
  committing: boolean;
  saveAsProfile: boolean;
  profileName: string;
  onSaveProfileChange: (next: boolean) => void;
  onProfileNameChange: (next: string) => void;
  onBack: () => void;
  onCommit: () => void;
  onShowIssues: () => void;
}) {
  const p = preview.parse;

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>Import summary</SectionTitle>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          <Stat label="Rows detected" value={p.totalRows} />
          <Stat label="Valid rows" value={p.rows.length} tone="good" />
          <Stat label="Invalid rows" value={p.missingSkuRows} tone={p.missingSkuRows > 0 ? 'bad' : 'neutral'} />
          <Stat
            label="Duplicate SKUs"
            value={p.duplicateSkus.length}
            tone={p.duplicateSkus.length > 0 ? 'warn' : 'neutral'}
          />
          <Stat
            label="Missing quantity"
            value={p.missingQuantityRows}
            tone={p.missingQuantityRows > 0 ? 'warn' : 'neutral'}
          />
          {context.sourceType === 'marketplace' ? (
            <Stat
              label="Unknown fulfillment"
              value={p.unknownFulfillmentRows}
              tone={p.unknownFulfillmentRows > 0 ? 'warn' : 'neutral'}
            />
          ) : null}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Will be added" value={preview.toAdd} tone="good" />
          <Stat label="Will be updated" value={preview.toUpdate} tone="warn" />
          <Stat label="Unchanged" value={preview.unchanged} />
          <Stat
            label={context.mode === 'full_snapshot' ? 'Marked absent' : 'Not in this file'}
            value={context.mode === 'full_snapshot' ? preview.willMarkAbsent : preview.knownNotInFile}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge tone="accent">
            {context.sourceType === 'sonic'
              ? 'Sonic master inventory'
              : `${context.marketplace ? MARKETPLACE_LABELS[context.marketplace] : ''} · ${context.accountId}`}
          </Badge>
          <Badge>{IMPORT_MODE_LABELS[context.mode]}</Badge>
          <Badge>Quantity: {context.headers[context.selection.quantityColumn] ?? '—'}</Badge>
          {p.issues.length > 0 ? (
            <button type="button" className="btn-secondary btn-sm" onClick={onShowIssues}>
              Inspect {formatNumber(p.issues.length)} validation{' '}
              {p.issues.length === 1 ? 'issue' : 'issues'}
            </button>
          ) : (
            <Badge tone="good">No validation issues</Badge>
          )}
        </div>
      </Card>

      {context.mode === 'full_snapshot' && preview.willMarkAbsent > 0 ? (
        <InfoNote tone="warn">
          <strong>{formatNumber(preview.willMarkAbsent)}</strong> existing{' '}
          {preview.willMarkAbsent === 1 ? 'record is' : 'records are'} not present in this file.
          Because this is a full snapshot, they will be flagged as absent from the latest snapshot
          and their linked listings may raise critical discrepancies. Nothing is deleted and last
          known quantities are preserved.
        </InfoNote>
      ) : null}

      {context.mode === 'incremental' && preview.knownNotInFile > 0 ? (
        <InfoNote>
          <strong>{formatNumber(preview.knownNotInFile)}</strong> existing{' '}
          {preview.knownNotInFile === 1 ? 'record is' : 'records are'} not in this file. As an
          incremental import, they will be left completely untouched.
        </InfoNote>
      ) : null}

      {preview.suspicious.length > 0 ? (
        <Card padded={false}>
          <div className="px-4 pt-4">
            <SectionTitle>
              Suspicious changes ({formatNumber(preview.suspicious.length)})
            </SectionTitle>
            <p className="-mt-2 mb-3 text-xs text-muted">
              Large quantity drops worth confirming before committing.
            </p>
          </div>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 border-y border-edge bg-elevated">
                <tr>
                  <th className="th">SKU</th>
                  <th className="th text-right">Current</th>
                  <th className="th text-right">New</th>
                  <th className="th">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {preview.suspicious.map((c) => (
                  <tr key={c.sku}>
                    <td className="td mono max-w-[240px] truncate">{c.sku}</td>
                    <td className="td text-right tabular-nums">{formatNumber(c.previous)}</td>
                    <td className="td text-right tabular-nums text-red-600 dark:text-red-400">
                      {c.next === null ? 'Unknown' : formatNumber(c.next)}
                    </td>
                    <td className="td text-xs text-muted">{c.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {p.duplicateSkus.length > 0 ? (
        <Card padded={false}>
          <div className="px-4 pt-4">
            <SectionTitle>Duplicate SKUs in this file</SectionTitle>
            <p className="-mt-2 mb-3 text-xs text-muted">
              The last occurrence of each SKU will be used. No duplicate records are created.
            </p>
          </div>
          <div className="max-h-56 overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 border-y border-edge bg-elevated">
                <tr>
                  <th className="th">SKU</th>
                  <th className="th text-right">Occurrences</th>
                  <th className="th">Rows</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {p.duplicateSkus.slice(0, 100).map((d) => (
                  <tr key={d.sku}>
                    <td className="td mono max-w-[260px] truncate">{d.sku}</td>
                    <td className="td text-right tabular-nums">{d.count}</td>
                    <td className="td text-xs text-muted">
                      {d.rowNumbers.slice(0, 12).join(', ')}
                      {d.rowNumbers.length > 12 ? '…' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {preview.sampleAdds.length > 0 ? (
          <SampleTable
            title={`Records to add (${formatNumber(preview.toAdd)})`}
            rows={preview.sampleAdds.map((r) => ({
              sku: r.sku,
              left: null,
              right: r.quantity,
            }))}
            leftLabel="—"
            rightLabel="Quantity"
          />
        ) : null}
        {preview.sampleUpdates.length > 0 ? (
          <SampleTable
            title={`Records to update (${formatNumber(preview.toUpdate)})`}
            rows={preview.sampleUpdates.map((u) => ({
              sku: u.row.sku,
              left: u.previousQuantity,
              right: u.row.quantity,
            }))}
            leftLabel="Current"
            rightLabel="New"
          />
        ) : null}
      </div>

      <Card>
        <Toggle
          checked={saveAsProfile}
          onChange={onSaveProfileChange}
          label="Save this column configuration as a reusable import profile"
        />
        {saveAsProfile ? (
          <div className="mt-2 max-w-sm">
            <label className="label" htmlFor="profile-name">
              Profile name
            </label>
            <input
              id="profile-name"
              className="field"
              value={profileName}
              onChange={(e) => onProfileNameChange(e.target.value)}
              placeholder="e.g. Newegg USA monthly export"
            />
          </div>
        ) : null}
      </Card>

      {committing ? (
        <Card>
          <p className="text-sm font-medium">Committing import…</p>
          {progress ? (
            <>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-elevated">
                <div
                  className="h-full bg-accent transition-all"
                  style={{
                    width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%`,
                  }}
                />
              </div>
              <p className="mt-1 text-xs text-muted tabular-nums">
                {formatNumber(progress.done)} / {formatNumber(progress.total)} records written
              </p>
            </>
          ) : (
            <LoadingBlock label="Preparing…" />
          )}
        </Card>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onBack} disabled={busy}>
            Back to column mapping
          </button>
          <button type="button" className="btn-primary" onClick={onCommit} disabled={busy}>
            <IconCheck width={15} height={15} />
            Commit {formatNumber(p.rows.length)} {p.rows.length === 1 ? 'record' : 'records'}
          </button>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  const tones = {
    neutral: 'text-ink',
    good: 'text-emerald-600 dark:text-emerald-400',
    warn: 'text-amber-600 dark:text-amber-400',
    bad: 'text-red-600 dark:text-red-400',
  } as const;
  return (
    <div className="rounded-md border border-edge px-3 py-2">
      <p className="text-2xs font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className={`mt-0.5 text-xl font-semibold tabular-nums ${tones[tone]}`}>
        {formatNumber(value)}
      </p>
    </div>
  );
}

function SampleTable({
  title,
  rows,
  leftLabel,
  rightLabel,
}: {
  title: string;
  rows: Array<{ sku: string; left: number | null; right: number | null }>;
  leftLabel: string;
  rightLabel: string;
}) {
  return (
    <Card padded={false}>
      <div className="px-4 pt-4">
        <SectionTitle>{title}</SectionTitle>
        <p className="-mt-2 mb-3 text-xs text-muted">
          Showing the first {rows.length} for review.
        </p>
      </div>
      <div className="max-h-72 overflow-y-auto">
        <table className="w-full">
          <thead className="sticky top-0 border-y border-edge bg-elevated">
            <tr>
              <th className="th">SKU</th>
              <th className="th text-right">{leftLabel}</th>
              <th className="th text-right">{rightLabel}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {rows.map((r) => (
              <tr key={r.sku}>
                <td className="td mono max-w-[260px] truncate">{r.sku}</td>
                <td className="td text-right tabular-nums text-muted">
                  {r.left === null ? '—' : formatNumber(r.left)}
                </td>
                <td className="td text-right tabular-nums font-medium">
                  {r.right === null ? (
                    <span className="text-faint">Unknown</span>
                  ) : (
                    formatNumber(r.right)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

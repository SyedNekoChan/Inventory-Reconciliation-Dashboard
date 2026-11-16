import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Badge,
  Card,
  EmptyState,
  InfoNote,
  LoadingBlock,
  PageHeader,
} from '../components/ui/Primitives';
import { Modal } from '../components/ui/Modal';
import { Pagination } from '../components/ui/Pagination';
import { IconHistory } from '../components/icons';
import { db } from '../db/database';
import { usePersistentState } from '../utils/hooks';
import { formatBytes, formatDateTime, formatDuration, formatNumber } from '../utils/format';
import { IMPORT_MODE_LABELS, MARKETPLACE_LABELS, type ImportRun } from '../types/domain';

export function ImportHistoryPage() {
  const [pageSize, setPageSize] = usePersistentState('irt.history.pageSize', 25);
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<ImportRun | null>(null);

  const total = useLiveQuery(() => db.importRuns.count(), [], 0);
  const runs = useLiveQuery(
    () =>
      db.importRuns
        .orderBy('startedAt')
        .reverse()
        .offset(page * pageSize)
        .limit(pageSize)
        .toArray(),
    [page, pageSize],
  );

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <PageHeader
        title="Import History"
        description="Every committed and failed import, with the column mapping used and the validation issues recorded at the time."
        actions={
          <span className="text-xs text-muted tabular-nums">
            {formatNumber(total)} {total === 1 ? 'import' : 'imports'}
          </span>
        }
      />

      <Card padded={false}>
        {!runs ? (
          <LoadingBlock />
        ) : runs.length === 0 ? (
          <EmptyState
            icon={<IconHistory width={28} height={28} />}
            title="No imports recorded"
            description="Import history appears here once you commit your first spreadsheet."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px]">
                <thead className="border-b border-edge bg-elevated/50">
                  <tr>
                    <th className="th">Date</th>
                    <th className="th">Source</th>
                    <th className="th">Account</th>
                    <th className="th">Filename</th>
                    <th className="th">Type</th>
                    <th className="th text-right">Added</th>
                    <th className="th text-right">Updated</th>
                    <th className="th text-right">Invalid</th>
                    <th className="th">Status</th>
                    <th className="th" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge">
                  {runs.map((run) => (
                    <tr key={run.id} className="row-hover">
                      <td className="td whitespace-nowrap text-xs">
                        {formatDateTime(run.startedAt)}
                      </td>
                      <td className="td text-xs">
                        {run.sourceType === 'sonic'
                          ? 'Sonic'
                          : run.marketplace
                            ? MARKETPLACE_LABELS[run.marketplace]
                            : 'Marketplace'}
                      </td>
                      <td className="td text-xs text-muted max-w-[150px] truncate">
                        {run.accountId ?? '—'}
                      </td>
                      <td className="td text-xs max-w-[220px] truncate" title={run.fileName}>
                        {run.fileName}
                        {run.sheetName ? (
                          <span className="block text-2xs text-faint truncate">
                            Sheet: {run.sheetName}
                          </span>
                        ) : null}
                      </td>
                      <td className="td text-xs">
                        <Badge tone={run.mode === 'full_snapshot' ? 'accent' : 'neutral'}>
                          {run.mode === 'full_snapshot' ? 'Snapshot' : 'Incremental'}
                        </Badge>
                      </td>
                      <td className="td text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatNumber(run.recordsAdded)}
                      </td>
                      <td className="td text-right tabular-nums">
                        {formatNumber(run.recordsUpdated)}
                      </td>
                      <td
                        className={`td text-right tabular-nums ${run.invalidRows > 0 ? 'text-red-600 dark:text-red-400' : 'text-faint'}`}
                      >
                        {formatNumber(run.invalidRows)}
                      </td>
                      <td className="td">
                        {run.status === 'committed' ? (
                          <Badge tone="good">Committed</Badge>
                        ) : (
                          <Badge tone="bad">Failed</Badge>
                        )}
                      </td>
                      <td className="td text-right">
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          onClick={() => setDetail(run)}
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              pageCount={pageCount}
              total={total}
              pageSize={pageSize}
              onPage={setPage}
              onPageSize={(n) => {
                setPageSize(n);
                setPage(0);
              }}
            />
          </>
        )}
      </Card>

      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail?.fileName ?? ''}
        description={detail ? formatDateTime(detail.startedAt) : undefined}
        width="xl"
        footer={
          <button type="button" className="btn-secondary" onClick={() => setDetail(null)}>
            Close
          </button>
        }
      >
        {detail ? (
          <div className="space-y-4">
            {detail.status === 'failed' ? (
              <InfoNote tone="bad">
                This import failed: {detail.errorMessage ?? 'no error message was recorded.'}
              </InfoNote>
            ) : null}

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
              <Field label="Source">
                {detail.sourceType === 'sonic'
                  ? 'Sonic master inventory'
                  : detail.marketplace
                    ? MARKETPLACE_LABELS[detail.marketplace]
                    : 'Marketplace'}
              </Field>
              <Field label="Account">{detail.accountId ?? '—'}</Field>
              <Field label="Import type">{IMPORT_MODE_LABELS[detail.mode]}</Field>
              <Field label="Worksheet">{detail.sheetName ?? '—'}</Field>
              <Field label="File size">{formatBytes(detail.fileSize)}</Field>
              <Field label="Duration">
                {detail.finishedAt ? formatDuration(detail.finishedAt - detail.startedAt) : '—'}
              </Field>
              <Field label="Profile used">{detail.profileName ?? 'None'}</Field>
              <Field label="Header row">{formatNumber(detail.totalRows)} data rows</Field>
            </dl>

            <div>
              <p className="label">Record counts</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <Count label="Total rows" value={detail.totalRows} />
                <Count label="Valid" value={detail.validRows} />
                <Count label="Invalid" value={detail.invalidRows} />
                <Count label="Duplicates" value={detail.duplicateSkuRows} />
                <Count label="Added" value={detail.recordsAdded} />
                <Count label="Updated" value={detail.recordsUpdated} />
                <Count label="Unchanged" value={detail.recordsUnchanged} />
                {detail.mode === 'full_snapshot' ? (
                  <Count label="Marked absent" value={detail.recordsMissingFromSnapshot} />
                ) : null}
              </div>
            </div>

            <div>
              <p className="label">Column mapping used</p>
              <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {Object.entries(detail.columnMapping).map(([key, value]) => (
                  <div key={key} className="flex justify-between gap-2 border-b border-edge py-1">
                    <dt className="text-xs capitalize text-muted">{key}</dt>
                    <dd className="mono text-xs truncate">
                      {value ?? <span className="font-sans text-faint">Not used</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            {detail.issues.length > 0 ? (
              <div>
                <p className="label">
                  Validation issues ({formatNumber(detail.issues.length)}
                  {detail.issues.length >= 500 ? ', first 500 stored' : ''})
                </p>
                <div className="max-h-64 overflow-y-auto rounded-md border border-edge">
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
                      {detail.issues.map((issue, i) => (
                        <tr key={`${issue.rowNumber}-${i}`}>
                          <td className="td tabular-nums text-xs">{issue.rowNumber}</td>
                          <td className="td text-xs">{issue.field}</td>
                          <td className="td mono text-xs max-w-[180px] truncate">
                            {issue.rawValue ?? <span className="font-sans text-faint">empty</span>}
                          </td>
                          <td className="td text-xs text-muted">{issue.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <InfoNote>No validation issues were recorded for this import.</InfoNote>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="text-sm truncate">{children}</dd>
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-edge px-2.5 py-1.5">
      <p className="text-2xs font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className="text-base font-semibold tabular-nums">{formatNumber(value)}</p>
    </div>
  );
}

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Badge,
  Card,
  EmptyState,
  InfoNote,
  LoadingBlock,
  PageHeader,
  SeverityBadge,
  Unknown,
} from '../components/ui/Primitives';
import { Pagination } from '../components/ui/Pagination';
import { SearchInput } from '../components/ui/SearchInput';
import { IconCheck, IconChevronRight, IconRecon, IconRefresh } from '../components/icons';
import {
  queryReconciliation,
  type ReconFilters,
  type ReconGroup,
} from '../features/reconciliation/queries';
import { acknowledgeDiscrepancy, clearAcknowledgement, runReconciliation } from '../services/reconciliation';
import { listAccounts } from '../db/accounts';
import { useToast } from '../components/ToastProvider';
import { useDebounced, usePersistentState } from '../utils/hooks';
import { formatNumber, formatRelative, formatSigned } from '../utils/format';
import {
  DISCREPANCY_TYPES,
  MARKETPLACE_LABELS,
  MARKETPLACES,
  SEVERITY_LABELS,
  type Discrepancy,
  type FulfillmentType,
  type Marketplace,
  type Severity,
} from '../types/domain';

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function ReconciliationPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const [search, setSearch] = useState(params.get('sku') ?? '');
  const debouncedSearch = useDebounced(search, 300);
  const [marketplace, setMarketplace] = useState<Marketplace | 'all'>('all');
  const [accountId, setAccountId] = useState<string | 'all'>('all');
  const [fulfillment, setFulfillment] = useState<FulfillmentType | 'all'>('all');
  const [severity, setSeverity] = useState<Severity | 'all'>(
    (params.get('severity') as Severity | null) ?? 'all',
  );
  const [state, setState] = useState<'open' | 'resolved' | 'all'>('open');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [pageSize, setPageSize] = usePersistentState('irt.recon.pageSize', 25);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);

  const accounts = useLiveQuery(() => listAccounts(), [], []);

  // A deep link from the dashboard pre-fills the search and expands the row.
  useEffect(() => {
    const sku = params.get('sku');
    if (sku) {
      setExpanded(new Set([sku]));
      setState('all');
    }
  }, [params]);

  const filters = useMemo<ReconFilters>(
    () => ({
      search: debouncedSearch,
      marketplace,
      accountId,
      fulfillment,
      severity,
      state,
      type: typeFilter,
    }),
    [debouncedSearch, marketplace, accountId, fulfillment, severity, state, typeFilter],
  );

  const result = useLiveQuery(
    () => queryReconciliation(filters, page * pageSize, pageSize),
    [filters, page, pageSize],
  );

  const pageCount = result ? Math.max(1, Math.ceil(result.total / pageSize)) : 1;

  const onRun = async () => {
    setRunning(true);
    try {
      const { run } = await runReconciliation();
      toast.success(
        'Reconciliation complete',
        `${formatNumber(run.openTotal)} open · ${formatNumber(run.newThisRun)} new · ${formatNumber(run.reopenedThisRun)} reopened · ${formatNumber(run.resolvedThisRun)} resolved.`,
      );
    } catch (err) {
      toast.error('Reconciliation failed', err instanceof Error ? err.message : 'Unknown error.');
    } finally {
      setRunning(false);
    }
  };

  const resetFilters = () => {
    setSearch('');
    setMarketplace('all');
    setAccountId('all');
    setFulfillment('all');
    setSeverity('all');
    setState('open');
    setTypeFilter('all');
    setPage(0);
    setParams(new URLSearchParams());
  };

  const visibleAccounts = accounts.filter(
    (a) => marketplace === 'all' || a.marketplace === marketplace,
  );

  return (
    <div>
      <PageHeader
        title="Reconciliation"
        description="Sonic inventory compared against marketplace listing quantities. Seller-fulfilled stock is reconciled against Sonic; marketplace-fulfilled stock is tracked separately."
        actions={
          <button type="button" className="btn-primary" onClick={onRun} disabled={running}>
            <IconRefresh width={15} height={15} />
            {running ? 'Reconciling…' : 'Run reconciliation'}
          </button>
        }
      />

      {result ? (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {SEVERITIES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setSeverity(severity === s ? 'all' : s);
                setState('open');
                setPage(0);
              }}
              className={`card px-3 py-2 text-left transition-colors ${
                severity === s ? 'border-accent' : 'hover:bg-elevated/60'
              }`}
            >
              <p className="text-2xs font-semibold uppercase tracking-wider text-muted">
                {SEVERITY_LABELS[s]}
              </p>
              <p className="mt-0.5 text-xl font-semibold tabular-nums">
                {formatNumber(result.counts[s])}
              </p>
            </button>
          ))}
          <div className="card px-3 py-2">
            <p className="text-2xs font-semibold uppercase tracking-wider text-muted">Resolved</p>
            <p className="mt-0.5 text-xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
              {formatNumber(result.resolvedTotal)}
            </p>
          </div>
        </div>
      ) : null}

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-edge p-3">
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(0);
            }}
            placeholder="Search master or marketplace SKU…"
            className="w-full sm:w-64"
          />
          <select
            className="field !w-auto"
            value={marketplace}
            onChange={(e) => {
              setMarketplace(e.target.value as Marketplace | 'all');
              setAccountId('all');
              setPage(0);
            }}
          >
            <option value="all">All marketplaces</option>
            {MARKETPLACES.map((m) => (
              <option key={m} value={m}>
                {MARKETPLACE_LABELS[m]}
              </option>
            ))}
          </select>
          <select
            className="field !w-auto"
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              setPage(0);
            }}
          >
            <option value="all">All accounts</option>
            {visibleAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
          <select
            className="field !w-auto"
            value={fulfillment}
            onChange={(e) => {
              setFulfillment(e.target.value as FulfillmentType | 'all');
              setPage(0);
            }}
          >
            <option value="all">All fulfillment</option>
            <option value="seller_fulfilled">Seller fulfilled</option>
            <option value="marketplace_fulfilled">Marketplace fulfilled</option>
            <option value="unknown">Unknown fulfillment</option>
          </select>
          <select
            className="field !w-auto"
            value={typeFilter}
            onChange={(e) => {
              setTypeFilter(e.target.value);
              setPage(0);
            }}
          >
            <option value="all">All discrepancy types</option>
            {Object.values(DISCREPANCY_TYPES).map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
          <select
            className="field !w-auto"
            value={state}
            onChange={(e) => {
              setState(e.target.value as 'open' | 'resolved' | 'all');
              setPage(0);
            }}
          >
            <option value="open">Unresolved</option>
            <option value="resolved">Resolved</option>
            <option value="all">All states</option>
          </select>
          <button type="button" className="btn-ghost btn-sm" onClick={resetFilters}>
            Reset
          </button>
        </div>

        {!result ? (
          <LoadingBlock />
        ) : result.groups.length === 0 ? (
          <EmptyState
            icon={<IconRecon width={28} height={28} />}
            title={
              result.openTotal === 0 && result.resolvedTotal === 0
                ? 'No reconciliation results yet'
                : 'No records match these filters'
            }
            description={
              result.openTotal === 0 && result.resolvedTotal === 0
                ? 'Import Sonic and marketplace data, approve SKU mappings, then run reconciliation.'
                : 'Adjust or reset the filters above.'
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px]">
                <thead className="border-b border-edge bg-elevated/50">
                  <tr>
                    <th className="th w-8" />
                    <th className="th">Master SKU</th>
                    <th className="th text-right">Sonic qty</th>
                    <th className="th text-center">Snapshot</th>
                    <th className="th text-center">Listings</th>
                    <th className="th">Worst severity</th>
                    <th className="th text-right">Open</th>
                    <th className="th">Oldest</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge">
                  {result.groups.map((group) => (
                    <ReconRow
                      key={group.key}
                      group={group}
                      expanded={expanded.has(group.key)}
                      onToggle={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(group.key)) next.delete(group.key);
                          else next.add(group.key);
                          return next;
                        })
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              pageCount={pageCount}
              total={result.total}
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
    </div>
  );
}

function ReconRow({
  group,
  expanded,
  onToggle,
}: {
  group: ReconGroup;
  expanded: boolean;
  onToggle: () => void;
}) {
  const oldest = Math.min(
    ...[...group.listings.flatMap((l) => l.discrepancies), ...group.groupDiscrepancies].map(
      (d) => d.firstSeenAt,
    ),
  );

  return (
    <>
      <tr className="row-hover cursor-pointer" onClick={onToggle}>
        <td className="td pl-3 pr-0">
          <IconChevronRight
            width={14}
            height={14}
            className={`text-faint transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </td>
        <td className="td mono max-w-[280px] truncate font-medium" title={group.masterSku ?? ''}>
          {group.masterSku ?? (
            <span className="font-sans text-muted italic">Unmapped listing</span>
          )}
        </td>
        <td className="td text-right tabular-nums font-medium">
          {group.masterSku === null ? (
            <span className="text-faint">—</span>
          ) : group.sonic === null ? (
            <Badge tone="bad">Not in Sonic</Badge>
          ) : group.sonicQuantity === null ? (
            <Unknown />
          ) : group.sonicQuantity === 0 ? (
            <span className="text-red-600 dark:text-red-400">0</span>
          ) : (
            formatNumber(group.sonicQuantity)
          )}
        </td>
        <td className="td text-center">
          {group.inLatestSnapshot === false ? (
            <Badge tone="bad">Absent</Badge>
          ) : group.inLatestSnapshot === true ? (
            <Badge tone="good">Present</Badge>
          ) : (
            <span className="text-2xs text-faint">—</span>
          )}
        </td>
        <td className="td text-center tabular-nums">{group.listings.length}</td>
        <td className="td">
          {group.worstSeverity ? (
            <SeverityBadge severity={group.worstSeverity} />
          ) : (
            <Badge tone="good">Resolved</Badge>
          )}
        </td>
        <td className="td text-right tabular-nums">
          {group.openCount > 0 ? (
            <span className="font-medium">{group.openCount}</span>
          ) : (
            <span className="text-faint">0</span>
          )}
        </td>
        <td className="td whitespace-nowrap text-xs text-muted">
          {Number.isFinite(oldest) ? formatRelative(oldest) : '—'}
        </td>
      </tr>

      {expanded ? (
        <tr>
          <td colSpan={8} className="bg-elevated/40 px-3 py-3">
            {group.groupDiscrepancies.length > 0 ? (
              <ul className="mb-3 space-y-1.5">
                {group.groupDiscrepancies.map((d) => (
                  <DiscrepancyLine key={d.id} discrepancy={d} />
                ))}
              </ul>
            ) : null}

            {group.listings.length === 0 ? (
              <InfoNote>No marketplace listings are linked to this record.</InfoNote>
            ) : (
              <div className="overflow-x-auto rounded-md border border-edge bg-surface">
                <table className="w-full min-w-[900px]">
                  <thead className="border-b border-edge bg-elevated/60">
                    <tr>
                      <th className="th">Marketplace SKU</th>
                      <th className="th">Marketplace</th>
                      <th className="th">Account</th>
                      <th className="th">Fulfillment</th>
                      <th className="th text-right">Actual</th>
                      <th className="th text-right">Expected</th>
                      <th className="th text-right">Difference</th>
                      <th className="th">Mapping</th>
                      <th className="th">Last imported</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-edge">
                    {group.listings.map(({ listing, mapping, expectedQuantity, difference, discrepancies }) => (
                      <Fragment key={listing.id}>
                        <tr>
                          <td className="td mono max-w-[240px] truncate" title={listing.sku}>
                            {listing.sku}
                          </td>
                          <td className="td text-xs">{MARKETPLACE_LABELS[listing.marketplace]}</td>
                          <td className="td text-xs text-muted max-w-[140px] truncate">
                            {listing.accountId}
                          </td>
                          <td className="td text-xs">
                            {listing.fulfillment.type === 'unknown' ? (
                              <Badge tone="warn">Unknown</Badge>
                            ) : listing.fulfillment.type === 'marketplace_fulfilled' ? (
                              <Badge tone="accent">Marketplace</Badge>
                            ) : (
                              <Badge>Seller</Badge>
                            )}
                            {listing.fulfillment.rawValue ? (
                              <span className="ml-1 text-2xs text-faint">
                                {listing.fulfillment.rawValue}
                              </span>
                            ) : null}
                          </td>
                          <td className="td text-right tabular-nums font-medium">
                            {listing.quantity === null ? <Unknown /> : formatNumber(listing.quantity)}
                          </td>
                          <td className="td text-right tabular-nums">
                            {expectedQuantity === null ? (
                              <span
                                className="text-faint"
                                title={
                                  listing.fulfillment.type === 'marketplace_fulfilled'
                                    ? 'Marketplace-fulfilled stock is not compared against Sonic warehouse quantity'
                                    : 'No expectation can be formed'
                                }
                              >
                                n/a
                              </span>
                            ) : (
                              formatNumber(expectedQuantity)
                            )}
                          </td>
                          <td
                            className={`td text-right tabular-nums font-medium ${
                              difference === null
                                ? ''
                                : difference > 0
                                  ? 'text-red-600 dark:text-red-400'
                                  : difference < 0
                                    ? 'text-amber-600 dark:text-amber-400'
                                    : 'text-emerald-600 dark:text-emerald-400'
                            }`}
                          >
                            {difference === null ? (
                              <span className="text-faint">—</span>
                            ) : (
                              formatSigned(difference)
                            )}
                          </td>
                          <td className="td text-xs">
                            {!mapping ? (
                              <Badge tone="bad">None</Badge>
                            ) : mapping.status === 'approved' ? (
                              <Badge tone="good">Approved</Badge>
                            ) : mapping.status === 'suggested' ? (
                              <Badge tone="warn">Suggested</Badge>
                            ) : (
                              <Badge>Rejected</Badge>
                            )}
                          </td>
                          <td className="td whitespace-nowrap text-xs text-muted">
                            {formatRelative(listing.lastSeenAt)}
                          </td>
                        </tr>
                        {discrepancies.length > 0 ? (
                          <tr>
                            <td colSpan={9} className="px-3 pb-2.5 pt-0">
                              <ul className="space-y-1.5">
                                {discrepancies.map((d) => (
                                  <DiscrepancyLine key={d.id} discrepancy={d} />
                                ))}
                              </ul>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function DiscrepancyLine({ discrepancy }: { discrepancy: Discrepancy }) {
  const toast = useToast();
  const meta = DISCREPANCY_TYPES[discrepancy.type];

  const onAck = async () => {
    try {
      if (discrepancy.acknowledgedAt) {
        await clearAcknowledgement(discrepancy.id);
        toast.info('Acknowledgement cleared');
      } else {
        await acknowledgeDiscrepancy(discrepancy.id, null);
        toast.success('Discrepancy acknowledged');
      }
    } catch (err) {
      toast.error('Could not update', err instanceof Error ? err.message : 'Unknown error.');
    }
  };

  return (
    <li className="flex flex-wrap items-start gap-2 rounded border border-edge bg-surface px-2.5 py-2">
      <SeverityBadge severity={discrepancy.severity} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">
          {meta.label}
          {discrepancy.state === 'resolved' ? (
            <span className="ml-2">
              <Badge tone="good">Resolved {formatRelative(discrepancy.resolvedAt)}</Badge>
            </span>
          ) : null}
          {discrepancy.acknowledgedAt ? (
            <span className="ml-2">
              <Badge tone="accent">Acknowledged</Badge>
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 text-xs text-muted">{discrepancy.detail}</p>
        <p className="mt-1 flex flex-wrap gap-x-3 text-2xs text-faint">
          <span>First seen {formatRelative(discrepancy.firstSeenAt)}</span>
          <span>Last seen {formatRelative(discrepancy.lastSeenAt)}</span>
          {discrepancy.reopenCount > 0 ? (
            <span className="text-amber-600 dark:text-amber-400">
              Reopened {discrepancy.reopenCount}× (last {formatRelative(discrepancy.lastReopenedAt)})
            </span>
          ) : null}
        </p>
      </div>
      {discrepancy.state === 'open' ? (
        <button type="button" className="btn-ghost btn-sm shrink-0" onClick={onAck}>
          <IconCheck width={13} height={13} />
          {discrepancy.acknowledgedAt ? 'Unacknowledge' : 'Acknowledge'}
        </button>
      ) : null}
    </li>
  );
}

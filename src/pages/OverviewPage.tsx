import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Badge,
  Card,
  EmptyState,
  InfoNote,
  LoadingBlock,
  PageHeader,
  SectionTitle,
  SeverityBadge,
  StatTile,
} from '../components/ui/Primitives';
import { IconImport, IconRefresh } from '../components/icons';
import {
  loadAccountHealth,
  loadDashboardStats,
  loadPriorityDiscrepancies,
  loadTrend,
} from '../features/dashboard/stats';
import { runReconciliation } from '../services/reconciliation';
import { useToast } from '../components/ToastProvider';
import { useTheme } from '../components/ThemeProvider';
import {
  DISCREPANCY_TYPES,
  MARKETPLACE_LABELS,
  type Discrepancy,
} from '../types/domain';
import { formatDateTime, formatNumber, formatRelative } from '../utils/format';

export function OverviewPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { theme } = useTheme();
  const [running, setRunning] = useState(false);

  const stats = useLiveQuery(() => loadDashboardStats(), []);
  const trend = useLiveQuery(() => loadTrend(30), [], []);
  const accounts = useLiveQuery(() => loadAccountHealth(), [], []);
  const priority = useLiveQuery(() => loadPriorityDiscrepancies(8), [], []);

  const onRun = useCallback(async () => {
    setRunning(true);
    try {
      const { run } = await runReconciliation();
      toast.success(
        'Reconciliation complete',
        `${formatNumber(run.openTotal)} open, ${formatNumber(run.newThisRun)} new, ${formatNumber(run.resolvedThisRun)} resolved.`,
      );
    } catch (err) {
      toast.error(
        'Reconciliation failed',
        err instanceof Error ? err.message : 'Unknown error.',
      );
    } finally {
      setRunning(false);
    }
  }, [toast]);

  if (!stats) return <LoadingBlock />;

  const axisColor = theme === 'dark' ? '#6c7684' : '#8b94a3';
  const gridColor = theme === 'dark' ? '#2f3742' : '#e0e3e9';

  return (
    <div>
      <PageHeader
        title="Overview"
        description="Inventory health across Sonic and the configured marketplace accounts. All figures come from imported data stored in this browser."
        actions={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => navigate('/imports')}
            >
              <IconImport width={15} height={15} />
              Import data
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={onRun}
              disabled={running || !stats.hasAnyData}
            >
              <IconRefresh width={15} height={15} />
              {running ? 'Reconciling…' : 'Run reconciliation'}
            </button>
          </>
        }
      />

      {!stats.hasAnyData ? (
        <Card padded={false}>
          <EmptyState
            title="No inventory data yet"
            description="Import a Sonic master inventory file, then import your Amazon and Newegg exports. Everything stays in this browser."
            action={
              <button type="button" className="btn-primary" onClick={() => navigate('/imports')}>
                <IconImport width={15} height={15} />
                Go to Imports
              </button>
            }
          />
        </Card>
      ) : null}

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
        <StatTile
          label="Sonic SKUs"
          value={formatNumber(stats.sonicSkus)}
          hint={`${formatNumber(stats.sonicWithStock)} with stock`}
          onClick={() => navigate('/inventory')}
        />
        <StatTile
          label="Listings"
          value={formatNumber(stats.listings)}
          hint={`${formatNumber(stats.approvedMappings)} mapped`}
          onClick={() => navigate('/mapping')}
        />
        <StatTile
          label="Unmapped"
          value={formatNumber(stats.unmappedListings)}
          hint={
            stats.pendingSuggestions > 0
              ? `${formatNumber(stats.pendingSuggestions)} suggestions pending`
              : 'No pending suggestions'
          }
          tone={stats.unmappedListings > 0 ? 'warn' : 'good'}
          onClick={() => navigate('/mapping')}
        />
        <StatTile
          label="Critical"
          value={formatNumber(stats.critical)}
          hint="Oversell risk"
          tone={stats.critical > 0 ? 'bad' : 'good'}
          onClick={() => navigate('/reconciliation?severity=critical')}
        />
        <StatTile
          label="High priority"
          value={formatNumber(stats.high)}
          tone={stats.high > 0 ? 'warn' : 'good'}
          onClick={() => navigate('/reconciliation?severity=high')}
        />
        <StatTile
          label="Unresolved"
          value={formatNumber(stats.openTotal)}
          hint={`${formatNumber(stats.resolvedTotal)} resolved historically`}
          onClick={() => navigate('/reconciliation')}
        />
        <StatTile
          label="Last import"
          value={
            stats.lastImport ? (
              <span className="text-base font-semibold">
                {formatRelative(stats.lastImport.startedAt)}
              </span>
            ) : (
              <span className="text-base font-semibold text-faint">Never</span>
            )
          }
          hint={stats.lastImport?.fileName ?? 'No imports yet'}
          onClick={() => navigate('/import-history')}
        />
      </div>

      {stats.lastRun === null && stats.hasAnyData ? (
        <div className="mt-3">
          <InfoNote tone="warn">
            Data has been imported but reconciliation has not been run yet. Run it to
            calculate discrepancies.
          </InfoNote>
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* Priority discrepancies */}
        <Card className="min-w-0 xl:col-span-2" padded={false}>
          <div className="px-4 pt-4">
            <SectionTitle
              action={
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => navigate('/reconciliation')}
                >
                  View all
                </button>
              }
            >
              Priority discrepancies
            </SectionTitle>
          </div>
          {priority.length === 0 ? (
            <EmptyState
              title={stats.lastRun ? 'No unresolved discrepancies' : 'Nothing calculated yet'}
              description={
                stats.lastRun
                  ? `Last reconciliation ran ${formatRelative(stats.lastRun.ranAt)} and found nothing outstanding.`
                  : 'Run reconciliation to compare Sonic inventory against marketplace listings.'
              }
            />
          ) : (
            <ul className="divide-y divide-edge">
              {priority.map((d) => (
                <PriorityRow key={d.id} discrepancy={d} />
              ))}
            </ul>
          )}
        </Card>

        {/* Marketplace health */}
        <Card padded={false}>
          <div className="px-4 pt-4">
            <SectionTitle
              action={
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => navigate('/settings')}
                >
                  Accounts
                </button>
              }
            >
              Marketplace health
            </SectionTitle>
          </div>
          {accounts.length === 0 ? (
            <EmptyState
              title="No marketplace accounts"
              description="Add an Amazon or Newegg account in Settings before importing marketplace files."
              action={
                <button type="button" className="btn-secondary" onClick={() => navigate('/settings')}>
                  Add an account
                </button>
              }
            />
          ) : (
            <ul className="divide-y divide-edge">
              {accounts.map((h) => (
                <li key={h.account.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {h.account.label}
                        {!h.account.active ? (
                          <span className="ml-2 align-middle">
                            <Badge>Inactive</Badge>
                          </span>
                        ) : null}
                      </p>
                      <p className="truncate text-xs text-muted">
                        {MARKETPLACE_LABELS[h.account.marketplace]}
                        {h.account.platform ? ` · ${h.account.platform}` : ''}
                      </p>
                    </div>
                    {h.critical > 0 ? (
                      <Badge tone="bad">{formatNumber(h.critical)} critical</Badge>
                    ) : h.discrepancies > 0 ? (
                      <Badge tone="warn">{formatNumber(h.discrepancies)} open</Badge>
                    ) : (
                      <Badge tone="good">Clear</Badge>
                    )}
                  </div>
                  <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <dt className="text-faint">Listings</dt>
                      <dd className="tabular-nums font-medium">{formatNumber(h.listings)}</dd>
                    </div>
                    <div>
                      <dt className="text-faint">Mapped</dt>
                      <dd className="tabular-nums font-medium">{formatNumber(h.mapped)}</dd>
                    </div>
                    <div>
                      <dt className="text-faint">Unmapped</dt>
                      <dd
                        className={`tabular-nums font-medium ${h.unmapped > 0 ? 'text-amber-600 dark:text-amber-400' : ''}`}
                      >
                        {formatNumber(h.unmapped)}
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-2 truncate text-2xs text-faint">
                    {h.lastImportAt
                      ? `Last import ${formatRelative(h.lastImportAt)} · ${h.lastImportFile}`
                      : 'No import recorded'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Trend */}
      <Card className="mt-4">
        <SectionTitle
          action={
            trend.length > 0 ? (
              <span className="text-xs text-faint">
                {trend.length === 1
                  ? '1 reconciliation run recorded'
                  : `Last ${trend.length} reconciliation runs`}
              </span>
            ) : undefined
          }
        >
          Discrepancy trend
        </SectionTitle>
        {trend.length < 2 ? (
          <EmptyState
            title="Not enough history yet"
            description={
              trend.length === 0
                ? 'The trend graph is built from stored reconciliation runs. Run reconciliation to start recording history.'
                : 'One run has been recorded. The trend appears once at least two reconciliation runs exist.'
            }
          />
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: axisColor }}
                  stroke={gridColor}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: axisColor }}
                  stroke={gridColor}
                />
                <Tooltip
                  contentStyle={{
                    background: theme === 'dark' ? '#1d232c' : '#ffffff',
                    border: `1px solid ${gridColor}`,
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelFormatter={(_l, payload) => {
                    const point = payload?.[0]?.payload as { ranAt?: number } | undefined;
                    return point?.ranAt ? formatDateTime(point.ranAt) : '';
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line
                  type="linear"
                  dataKey="critical"
                  name="Critical"
                  stroke="#ef4444"
                  strokeWidth={2}
                  dot={{ r: 2.5 }}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
                <Line
                  type="linear"
                  dataKey="high"
                  name="High"
                  stroke="#f97316"
                  strokeWidth={2}
                  dot={{ r: 2.5 }}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
                <Line
                  type="linear"
                  dataKey="other"
                  name="Other unresolved"
                  stroke="#64748b"
                  strokeWidth={1.75}
                  dot={{ r: 2.5 }}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
                <Line
                  type="linear"
                  dataKey="resolved"
                  name="Resolved in run"
                  stroke="#10b981"
                  strokeWidth={1.75}
                  strokeDasharray="4 3"
                  dot={{ r: 2.5 }}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
    </div>
  );
}

function PriorityRow({ discrepancy }: { discrepancy: Discrepancy }) {
  const navigate = useNavigate();
  const meta = DISCREPANCY_TYPES[discrepancy.type];
  const target = discrepancy.masterSku
    ? `/reconciliation?sku=${encodeURIComponent(discrepancy.masterSku)}`
    : `/reconciliation?discrepancy=${encodeURIComponent(discrepancy.id)}`;

  return (
    <li>
      <button
        type="button"
        className="row-hover flex w-full min-w-0 items-start gap-3 px-4 py-2.5 text-left"
        onClick={() => navigate(target)}
      >
        <span className="mt-0.5 shrink-0">
          <SeverityBadge severity={discrepancy.severity} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            {/* min-w-0 lets the nowrap SKU shrink instead of widening the page. */}
            <span className="mono min-w-0 max-w-full truncate font-medium">
              {discrepancy.masterSku ?? discrepancy.listingId?.split('|').slice(2).join('|') ?? '—'}
            </span>
            <span className="text-xs text-muted">{meta.label}</span>
          </span>
          <span className="mt-0.5 block min-w-0 max-w-full truncate text-xs text-muted">
            {discrepancy.detail}
          </span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-2xs text-faint">
            {discrepancy.marketplace ? (
              <span>{MARKETPLACE_LABELS[discrepancy.marketplace]}</span>
            ) : null}
            <span>First seen {formatRelative(discrepancy.firstSeenAt)}</span>
            {discrepancy.reopenCount > 0 ? (
              <span className="text-amber-600 dark:text-amber-400">
                Reopened {discrepancy.reopenCount}×
              </span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}

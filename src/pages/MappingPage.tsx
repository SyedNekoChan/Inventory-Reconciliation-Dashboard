import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Badge,
  Card,
  EmptyState,
  InfoNote,
  LoadingBlock,
  PageHeader,
  Unknown,
} from '../components/ui/Primitives';
import { Modal } from '../components/ui/Modal';
import { Pagination } from '../components/ui/Pagination';
import { SearchInput } from '../components/ui/SearchInput';
import { IconCheck, IconClose, IconLink, IconMapping, IconRefresh, IconTrash } from '../components/icons';
import {
  queryMappings,
  searchMasterSkus,
  type MappingFilters,
  type MappingRow,
  type MappingView,
} from '../features/mappings/queries';
import {
  approveMapping,
  approveMappings,
  buildSonicIndex,
  findCandidates,
  generateSuggestions,
  rejectMapping,
  rejectMappings,
  removeMapping,
  setMapping,
  setMappingAllocation,
} from '../services/mappingEngine';
import { getReconciliationConfig } from '../db/settings';
import { listAccounts } from '../db/accounts';
import { useToast } from '../components/ToastProvider';
import { useDebounced, usePersistentState } from '../utils/hooks';
import { formatNumber, formatRelative } from '../utils/format';
import {
  ALLOCATION_LABELS,
  MAPPING_METHOD_LABELS,
  MARKETPLACE_LABELS,
  MARKETPLACES,
  type AllocationMode,
  type Marketplace,
  type MarketplaceListing,
} from '../types/domain';

const VIEWS: Array<{ value: MappingView; label: string }> = [
  { value: 'unmapped', label: 'Unmapped' },
  { value: 'suggested', label: 'Suggested' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

export function MappingPage() {
  const toast = useToast();
  const [view, setView] = useState<MappingView>('suggested');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 300);
  const [marketplace, setMarketplace] = useState<Marketplace | 'all'>('all');
  const [accountId, setAccountId] = useState<string | 'all'>('all');
  const [pageSize, setPageSize] = usePersistentState('irt.mapping.pageSize', 50);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [working, setWorking] = useState(false);
  const [manualFor, setManualFor] = useState<MarketplaceListing | null>(null);

  const accounts = useLiveQuery(() => listAccounts(), [], []);

  const filters = useMemo<MappingFilters>(
    () => ({ view, search: debouncedSearch, marketplace, accountId }),
    [view, debouncedSearch, marketplace, accountId],
  );

  const result = useLiveQuery(
    () => queryMappings(filters, page * pageSize, pageSize),
    [filters, page, pageSize],
  );

  const pageCount = result ? Math.max(1, Math.ceil(result.total / pageSize)) : 1;

  const onGenerate = async () => {
    setWorking(true);
    try {
      const config = await getReconciliationConfig();
      const res = await generateSuggestions({
        fuzzyThreshold: config.fuzzyThreshold,
        autoApproveExact: true,
        ...(marketplace !== 'all' ? { marketplace } : {}),
        ...(accountId !== 'all' ? { accountId } : {}),
      });
      if (res.listingsScanned === 0) {
        toast.info('Nothing to match', 'No marketplace listings have been imported yet.');
      } else {
        toast.success(
          'Matching complete',
          `${formatNumber(res.exactCreated)} exact (auto-approved) · ${formatNumber(res.normalizedCreated)} normalized · ${formatNumber(res.fuzzyCreated)} fuzzy suggestions · ${formatNumber(res.skippedAlreadyMapped)} already decided · ${formatNumber(res.noCandidate)} with no candidate.`,
        );
        setView('suggested');
      }
    } catch (err) {
      toast.error('Matching failed', err instanceof Error ? err.message : 'Unknown error.');
    } finally {
      setWorking(false);
    }
  };

  const bulkApprove = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setWorking(true);
    try {
      await approveMappings(ids);
      toast.success(`${ids.length} ${ids.length === 1 ? 'mapping' : 'mappings'} approved`);
      setSelected(new Set());
    } catch (err) {
      toast.error('Approval failed', err instanceof Error ? err.message : 'Unknown error.');
    } finally {
      setWorking(false);
    }
  };

  const bulkReject = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setWorking(true);
    try {
      await rejectMappings(ids);
      toast.info(`${ids.length} ${ids.length === 1 ? 'suggestion' : 'suggestions'} rejected`);
      setSelected(new Set());
    } catch (err) {
      toast.error('Rejection failed', err instanceof Error ? err.message : 'Unknown error.');
    } finally {
      setWorking(false);
    }
  };

  const visibleAccounts = accounts.filter(
    (a) => marketplace === 'all' || a.marketplace === marketplace,
  );

  const selectableIds = (result?.rows ?? [])
    .map((r) => r.mapping?.id)
    .filter((x): x is number => typeof x === 'number');

  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  return (
    <div>
      <PageHeader
        title="SKU Mapping"
        description="Links marketplace listings to Sonic master SKUs. One master SKU can carry many listings; marketplace SKU suffixes are always preserved. Only exact matches are approved automatically."
        actions={
          <button type="button" className="btn-primary" onClick={onGenerate} disabled={working}>
            <IconRefresh width={15} height={15} />
            {working ? 'Working…' : 'Find matches'}
          </button>
        }
      />

      {result ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {VIEWS.map((v) => (
            <button
              key={v.value}
              type="button"
              onClick={() => {
                setView(v.value);
                setPage(0);
                setSelected(new Set());
              }}
              className={`card px-3.5 py-2 text-left transition-colors ${
                view === v.value ? 'border-accent' : 'hover:bg-elevated/60'
              }`}
            >
              <p className="text-2xs font-semibold uppercase tracking-wider text-muted">{v.label}</p>
              <p className="mt-0.5 text-xl font-semibold tabular-nums">
                {formatNumber(result.counts[v.value])}
              </p>
            </button>
          ))}
        </div>
      ) : null}

      {view === 'suggested' && result && result.counts.suggested > 0 ? (
        <div className="mb-3">
          <InfoNote tone="warn">
            Suggested mappings are not used by reconciliation until approved. Review each
            suggestion — normalized and fuzzy matches can be wrong.
          </InfoNote>
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
            placeholder="Search marketplace or master SKU…"
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

          {selected.size > 0 ? (
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted">{selected.size} selected</span>
              <button type="button" className="btn-primary btn-sm" onClick={bulkApprove} disabled={working}>
                <IconCheck width={13} height={13} />
                Approve
              </button>
              <button type="button" className="btn-secondary btn-sm" onClick={bulkReject} disabled={working}>
                <IconClose width={13} height={13} />
                Reject
              </button>
            </div>
          ) : null}
        </div>

        {!result ? (
          <LoadingBlock />
        ) : result.rows.length === 0 ? (
          <EmptyState
            icon={<IconMapping width={28} height={28} />}
            title={
              result.counts.unmapped +
                result.counts.suggested +
                result.counts.approved +
                result.counts.rejected ===
              0
                ? 'No marketplace listings imported'
                : `No ${view} listings match`
            }
            description={
              result.counts.unmapped +
                result.counts.suggested +
                result.counts.approved +
                result.counts.rejected ===
              0
                ? 'Import an Amazon or Newegg export first, then use "Find matches".'
                : 'Adjust the filters, or run "Find matches" to generate suggestions.'
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[920px]">
                <thead className="border-b border-edge bg-elevated/50">
                  <tr>
                    {selectableIds.length > 0 ? (
                      <th className="th w-8 pl-3">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded border-edge"
                          checked={allSelected}
                          onChange={(e) =>
                            setSelected(e.target.checked ? new Set(selectableIds) : new Set())
                          }
                          aria-label="Select all on this page"
                        />
                      </th>
                    ) : null}
                    <th className="th">Marketplace SKU</th>
                    <th className="th">Marketplace / account</th>
                    <th className="th text-right">Listing qty</th>
                    <th className="th">Master SKU</th>
                    <th className="th text-right">Sonic qty</th>
                    <th className="th">Match</th>
                    <th className="th">Allocation</th>
                    <th className="th text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge">
                  {result.rows.map((row) => (
                    <MappingTableRow
                      key={row.listing.id}
                      row={row}
                      selectable={selectableIds.length > 0}
                      selected={row.mapping?.id ? selected.has(row.mapping.id) : false}
                      onSelect={(checked) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          const id = row.mapping?.id;
                          if (typeof id !== 'number') return next;
                          if (checked) next.add(id);
                          else next.delete(id);
                          return next;
                        })
                      }
                      onManual={() => setManualFor(row.listing)}
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

      <ManualMappingModal listing={manualFor} onClose={() => setManualFor(null)} />
    </div>
  );
}

function MappingTableRow({
  row,
  selectable,
  selected,
  onSelect,
  onManual,
}: {
  row: MappingRow;
  selectable: boolean;
  selected: boolean;
  onSelect: (checked: boolean) => void;
  onManual: () => void;
}) {
  const toast = useToast();
  const { listing, mapping, master } = row;
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<void>, message: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(message);
    } catch (err) {
      toast.error('Action failed', err instanceof Error ? err.message : 'Unknown error.');
    } finally {
      setBusy(false);
    }
  };

  const onAllocationChange = async (mode: string) => {
    if (!mapping?.id) return;
    const next = mode === 'policy' ? null : (mode as AllocationMode);
    const value =
      next === 'fixed' || next === 'percent' ? (mapping.allocationValue ?? 0) : null;
    await act(
      () => setMappingAllocation(mapping.id as number, next, value),
      'Allocation updated',
    );
  };

  return (
    <tr className="row-hover">
      {selectable ? (
        <td className="td pl-3">
          {mapping?.id ? (
            <input
              type="checkbox"
              className="h-3.5 w-3.5 rounded border-edge"
              checked={selected}
              onChange={(e) => onSelect(e.target.checked)}
              aria-label={`Select ${listing.sku}`}
            />
          ) : null}
        </td>
      ) : null}
      <td className="td mono max-w-[240px] truncate font-medium" title={listing.sku}>
        {listing.sku}
      </td>
      <td className="td text-xs">
        {MARKETPLACE_LABELS[listing.marketplace]}
        <span className="block text-2xs text-faint truncate max-w-[140px]">{listing.accountId}</span>
      </td>
      <td className="td text-right tabular-nums">
        {listing.quantity === null ? <Unknown /> : formatNumber(listing.quantity)}
      </td>
      <td className="td mono max-w-[240px] truncate" title={mapping?.masterSku ?? ''}>
        {mapping ? (
          mapping.masterSku
        ) : (
          <span className="font-sans text-faint italic">Not linked</span>
        )}
      </td>
      <td className="td text-right tabular-nums">
        {!mapping ? (
          <span className="text-faint">—</span>
        ) : !master ? (
          <Badge tone="bad">Not in Sonic</Badge>
        ) : master.quantity === null ? (
          <Unknown />
        ) : (
          formatNumber(master.quantity)
        )}
      </td>
      <td className="td text-xs">
        {mapping ? (
          <>
            <span className="block">{MAPPING_METHOD_LABELS[mapping.method]}</span>
            <span className="block text-2xs text-faint">
              {Math.round(mapping.confidence * 100)}% · {formatRelative(mapping.updatedAt)}
            </span>
          </>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      <td className="td text-xs">
        {mapping?.status === 'approved' ? (
          <select
            className="field !w-auto !py-1 !px-1.5 text-xs"
            value={mapping.allocationMode ?? 'policy'}
            onChange={(e) => onAllocationChange(e.target.value)}
            disabled={busy}
          >
            <option value="policy">Use policy</option>
            {(Object.keys(ALLOCATION_LABELS) as AllocationMode[]).map((m) => (
              <option key={m} value={m}>
                {ALLOCATION_LABELS[m]}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      <td className="td text-right">
        <div className="flex items-center justify-end gap-1">
          {mapping && mapping.status !== 'approved' ? (
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={busy}
              onClick={() =>
                act(
                  () => approveMapping(mapping.id as number),
                  'Mapping approved',
                )
              }
            >
              <IconCheck width={13} height={13} />
              Approve
            </button>
          ) : null}
          {mapping && mapping.status === 'suggested' ? (
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={busy}
              onClick={() =>
                act(
                  () => rejectMapping(mapping.id as number),
                  'Suggestion rejected',
                )
              }
            >
              <IconClose width={13} height={13} />
            </button>
          ) : null}
          <button type="button" className="btn-secondary btn-sm" onClick={onManual} disabled={busy}>
            <IconLink width={13} height={13} />
            {mapping ? 'Change' : 'Link'}
          </button>
          {mapping ? (
            <button
              type="button"
              className="btn-ghost btn-sm text-red-600 dark:text-red-400"
              disabled={busy}
              title="Remove this mapping"
              onClick={() => act(() => removeMapping(mapping.id as number), 'Mapping removed')}
            >
              <IconTrash width={13} height={13} />
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function ManualMappingModal({
  listing,
  onClose,
}: {
  listing: MarketplaceListing | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const [term, setTerm] = useState('');
  const debounced = useDebounced(term, 300);
  const [busy, setBusy] = useState(false);

  const suggestions = useLiveQuery(async () => {
    if (!listing) return [];
    const index = await buildSonicIndex();
    return findCandidates(listing.sku, index, 6);
  }, [listing?.id]);

  const searchResults = useLiveQuery(
    () => (debounced.trim() ? searchMasterSkus(debounced, 20) : Promise.resolve([])),
    [debounced],
    [],
  );

  const link = async (masterSku: string, method: 'manual', confidence: number) => {
    if (!listing) return;
    setBusy(true);
    try {
      await setMapping({
        listing,
        masterSku,
        status: 'approved',
        method,
        confidence,
        note: 'Created manually by the user.',
      });
      toast.success('Mapping approved', `${listing.sku} → ${masterSku}`);
      onClose();
      setTerm('');
    } catch (err) {
      toast.error('Could not save mapping', err instanceof Error ? err.message : 'Unknown error.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={listing !== null}
      onClose={onClose}
      title="Link marketplace listing to a Sonic master SKU"
      description={
        listing ? (
          <span className="mono">
            {listing.sku}
            <span className="font-sans text-faint">
              {' '}
              · {MARKETPLACE_LABELS[listing.marketplace]} · {listing.accountId}
            </span>
          </span>
        ) : undefined
      }
      width="lg"
      footer={
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
      }
    >
      {!listing ? null : (
        <div className="space-y-4">
          <div>
            <p className="label">Suggested master SKUs</p>
            {suggestions === undefined ? (
              <LoadingBlock label="Scanning Sonic inventory…" />
            ) : suggestions.length === 0 ? (
              <InfoNote>
                No Sonic SKU resembles this marketplace SKU. Search manually below.
              </InfoNote>
            ) : (
              <ul className="divide-y divide-edge rounded-md border border-edge">
                {suggestions.map((s) => (
                  <li key={s.masterSku} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="mono truncate text-sm font-medium">{s.masterSku}</p>
                      <p className="text-xs text-muted">{s.rationale}</p>
                    </div>
                    <Badge tone={s.confidence >= 0.95 ? 'good' : 'warn'}>
                      {Math.round(s.confidence * 100)}%
                    </Badge>
                    <button
                      type="button"
                      className="btn-primary btn-sm shrink-0"
                      disabled={busy}
                      onClick={() => link(s.masterSku, 'manual', 1)}
                    >
                      Link
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <p className="label">Search all Sonic master SKUs</p>
            <SearchInput value={term} onChange={setTerm} placeholder="Type a master SKU…" />
            {debounced.trim() ? (
              searchResults.length === 0 ? (
                <p className="mt-2 text-xs text-muted">No Sonic SKU matches “{debounced}”.</p>
              ) : (
                <ul className="mt-2 max-h-64 divide-y divide-edge overflow-y-auto rounded-md border border-edge">
                  {searchResults.map((item) => (
                    <li key={item.sku} className="flex items-center gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="mono truncate text-sm">{item.sku}</p>
                        <p className="truncate text-xs text-muted">
                          {item.description ?? 'No description'}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-muted">
                        {item.quantity === null ? 'Unknown' : `${formatNumber(item.quantity)} in Sonic`}
                      </span>
                      <button
                        type="button"
                        className="btn-secondary btn-sm shrink-0"
                        disabled={busy}
                        onClick={() => link(item.sku, 'manual', 1)}
                      >
                        Link
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </div>
        </div>
      )}
    </Modal>
  );
}

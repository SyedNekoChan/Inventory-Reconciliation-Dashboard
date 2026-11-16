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
import { db } from '../db/database';
import { Pagination } from '../components/ui/Pagination';
import { SearchInput } from '../components/ui/SearchInput';
import { IconChevronDown, IconInventory } from '../components/icons';
import {
  loadSonicDetail,
  querySonicItems,
  type SonicSortKey,
  type StockFilter,
} from '../features/inventory/queries';
import { useDebounced, usePersistentState } from '../utils/hooks';
import { formatNumber, formatRelative } from '../utils/format';
import {
  FULFILLMENT_LABELS,
  MARKETPLACE_LABELS,
  MAPPING_METHOD_LABELS,
} from '../types/domain';

const STOCK_FILTERS: Array<{ value: StockFilter; label: string }> = [
  { value: 'all', label: 'All SKUs' },
  { value: 'in_stock', label: 'In stock' },
  { value: 'zero', label: 'Zero quantity' },
  { value: 'unknown', label: 'Unknown quantity' },
  { value: 'absent_from_snapshot', label: 'Absent from latest snapshot' },
];

export function InventoryPage() {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 300);
  const [stock, setStock] = useState<StockFilter>('all');
  const [sortKey, setSortKey] = useState<SonicSortKey>('sku');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [pageSize, setPageSize] = usePersistentState('irt.inventory.pageSize', 50);
  const [page, setPage] = useState(0);
  const [detailSku, setDetailSku] = useState<string | null>(null);

  const query = useMemo(
    () => ({
      search: debouncedSearch,
      stock,
      sortKey,
      sortDir,
      offset: page * pageSize,
      limit: pageSize,
    }),
    [debouncedSearch, stock, sortKey, sortDir, page, pageSize],
  );

  const result = useLiveQuery(() => querySonicItems(query), [query]);
  const totalAll = useLiveQuery(() => db.sonicItems.count(), [], 0);

  const pageCount = result ? Math.max(1, Math.ceil(result.total / pageSize)) : 1;

  const toggleSort = (key: SonicSortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'sku' ? 'asc' : 'desc');
    }
    setPage(0);
  };

  const sortIndicator = (key: SonicSortKey) =>
    sortKey === key ? (
      <IconChevronDown
        width={12}
        height={12}
        className={`inline-block transition-transform ${sortDir === 'asc' ? 'rotate-180' : ''}`}
      />
    ) : null;

  return (
    <div>
      <PageHeader
        title="Inventory"
        description="Sonic master inventory with the marketplace listings linked to each master SKU."
        actions={
          <span className="text-xs text-muted tabular-nums">
            {formatNumber(totalAll)} master {totalAll === 1 ? 'SKU' : 'SKUs'}
          </span>
        }
      />

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-edge p-3">
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(0);
            }}
            placeholder="Search SKU or description…"
            className="w-full sm:w-72"
          />
          <select
            className="field !w-auto"
            value={stock}
            onChange={(e) => {
              setStock(e.target.value as StockFilter);
              setPage(0);
            }}
          >
            {STOCK_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          {result?.scanned && result.total > 0 ? (
            <span
              className="text-xs text-faint"
              title={
                result.prefixOnly
                  ? 'Matched on the start of the SKU using an index, which keeps search fast on large catalogs.'
                  : 'Matched anywhere in the SKU or description.'
              }
            >
              {formatNumber(result.total)} matching
              {result.prefixOnly ? ' (SKU starts with)' : ''}
            </span>
          ) : null}
        </div>

        {!result ? (
          <LoadingBlock />
        ) : result.rows.length === 0 ? (
          <EmptyState
            icon={<IconInventory width={28} height={28} />}
            title={totalAll === 0 ? 'No Sonic inventory imported' : 'No matching SKUs'}
            description={
              totalAll === 0
                ? 'Import a Sonic master inventory file to populate this table.'
                : 'Adjust the search term or filter.'
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px]">
                <thead className="border-b border-edge bg-elevated/50">
                  <tr>
                    <th className="th">
                      <button type="button" className="inline-flex items-center gap-1 hover:text-ink" onClick={() => toggleSort('sku')}>
                        Master SKU {sortIndicator('sku')}
                      </button>
                    </th>
                    <th className="th">Description</th>
                    <th className="th text-right">
                      <button type="button" className="inline-flex items-center gap-1 hover:text-ink" onClick={() => toggleSort('quantity')}>
                        Sonic qty {sortIndicator('quantity')}
                      </button>
                    </th>
                    <th className="th text-center">Snapshot</th>
                    <th className="th">
                      <button type="button" className="inline-flex items-center gap-1 hover:text-ink" onClick={() => toggleSort('updatedAt')}>
                        Updated {sortIndicator('updatedAt')}
                      </button>
                    </th>
                    <th className="th" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge">
                  {result.rows.map((item) => (
                    <tr key={item.sku} className="row-hover">
                      <td className="td mono font-medium max-w-[280px] truncate" title={item.sku}>
                        {item.sku}
                      </td>
                      <td className="td max-w-[320px] truncate text-muted" title={item.description ?? ''}>
                        {item.description ?? <Unknown hint="No description column was imported" />}
                      </td>
                      <td className="td text-right tabular-nums font-medium">
                        {item.quantity === null ? (
                          <Unknown hint="Quantity was empty or unreadable in the import" />
                        ) : item.quantity === 0 ? (
                          <span className="text-red-600 dark:text-red-400">0</span>
                        ) : (
                          formatNumber(item.quantity)
                        )}
                      </td>
                      <td className="td text-center">
                        {item.inLatestSnapshot === false ? (
                          <Badge tone="bad">Absent</Badge>
                        ) : item.inLatestSnapshot === true ? (
                          <Badge tone="good">Present</Badge>
                        ) : (
                          <span className="text-2xs text-faint">No snapshot</span>
                        )}
                      </td>
                      <td className="td text-xs text-muted whitespace-nowrap">
                        {formatRelative(item.updatedAt)}
                      </td>
                      <td className="td text-right">
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          onClick={() => setDetailSku(item.sku)}
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

      <SonicDetailModal sku={detailSku} onClose={() => setDetailSku(null)} />
    </div>
  );
}

function SonicDetailModal({ sku, onClose }: { sku: string | null; onClose: () => void }) {
  const detail = useLiveQuery(() => (sku ? loadSonicDetail(sku) : Promise.resolve(null)), [sku]);

  return (
    <Modal
      open={sku !== null}
      onClose={onClose}
      title={sku ?? ''}
      description="Sonic master SKU detail and linked marketplace listings"
      width="xl"
      footer={
        <button type="button" className="btn-secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      {!detail ? (
        <LoadingBlock />
      ) : (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <dt className="label">Sonic quantity</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {detail.item.quantity === null ? <Unknown /> : formatNumber(detail.item.quantity)}
              </dd>
            </div>
            <div>
              <dt className="label">In latest snapshot</dt>
              <dd className="text-sm">
                {detail.item.inLatestSnapshot === false ? (
                  <Badge tone="bad">Absent</Badge>
                ) : detail.item.inLatestSnapshot === true ? (
                  <Badge tone="good">Present</Badge>
                ) : (
                  <span className="text-faint text-xs">No full snapshot imported</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="label">Approved listings</dt>
              <dd className="text-lg font-semibold tabular-nums">{detail.listings.length}</dd>
            </div>
            <div>
              <dt className="label">Last seen in import</dt>
              <dd className="text-sm">{formatRelative(detail.item.lastSeenAt)}</dd>
            </div>
          </dl>

          {detail.item.description ? (
            <div>
              <p className="label">Description</p>
              <p className="text-sm text-muted">{detail.item.description}</p>
            </div>
          ) : null}

          {detail.pendingSuggestions.length > 0 ? (
            <InfoNote tone="warn">
              {detail.pendingSuggestions.length} suggested{' '}
              {detail.pendingSuggestions.length === 1 ? 'mapping' : 'mappings'} awaiting approval
              on the SKU Mapping page.
            </InfoNote>
          ) : null}

          <div>
            <p className="label">Linked marketplace listings</p>
            {detail.listings.length === 0 ? (
              <InfoNote>
                No approved marketplace listings are linked to this master SKU.
              </InfoNote>
            ) : (
              <div className="overflow-x-auto rounded-md border border-edge">
                <table className="w-full min-w-[640px]">
                  <thead className="border-b border-edge bg-elevated/50">
                    <tr>
                      <th className="th">Marketplace SKU</th>
                      <th className="th">Marketplace</th>
                      <th className="th">Fulfillment</th>
                      <th className="th text-right">Qty</th>
                      <th className="th">Quantity field</th>
                      <th className="th">Mapping</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-edge">
                    {detail.listings.map(({ listing, mapping }) => (
                      <tr key={listing.id}>
                        <td className="td mono max-w-[240px] truncate" title={listing.sku}>
                          {listing.sku}
                        </td>
                        <td className="td text-xs">
                          {MARKETPLACE_LABELS[listing.marketplace]}
                          <span className="block text-2xs text-faint">{listing.accountId}</span>
                        </td>
                        <td className="td text-xs">
                          {listing.fulfillment.type === 'unknown' ? (
                            <Badge tone="warn">Unknown</Badge>
                          ) : (
                            <span>{FULFILLMENT_LABELS[listing.fulfillment.type]}</span>
                          )}
                        </td>
                        <td className="td text-right tabular-nums">
                          {listing.quantity === null ? <Unknown /> : formatNumber(listing.quantity)}
                        </td>
                        <td className="td text-2xs text-faint max-w-[140px] truncate">
                          {listing.quantityField ?? '—'}
                        </td>
                        <td className="td text-2xs text-faint">
                          {MAPPING_METHOD_LABELS[mapping.method]}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {Object.keys(detail.item.extra).length > 0 ? (
            <div>
              <p className="label">Additional imported columns</p>
              <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {Object.entries(detail.item.extra).map(([key, value]) => (
                  <div key={key} className="flex justify-between gap-2 border-b border-edge py-1">
                    <dt className="text-xs text-muted truncate">{key}</dt>
                    <dd className="text-xs font-medium truncate">{value === null ? '—' : String(value)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

import { IconChevronLeft, IconChevronRight } from '../icons';
import { formatNumber } from '../../utils/format';

export function Pagination({
  page,
  pageCount,
  total,
  pageSize,
  onPage,
  onPageSize,
  pageSizeOptions = [25, 50, 100, 250],
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onPage: (next: number) => void;
  onPageSize?: (next: number) => void;
  pageSizeOptions?: number[];
}) {
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-edge px-3 py-2">
      <p className="text-xs text-muted tabular-nums">
        {formatNumber(from)}–{formatNumber(to)} of {formatNumber(total)}
      </p>
      <div className="flex items-center gap-2">
        {onPageSize ? (
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Rows
            <select
              className="field !w-auto !py-1 !px-1.5 text-xs"
              value={pageSize}
              onChange={(e) => onPageSize(Number(e.target.value))}
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => onPage(page - 1)}
            disabled={page <= 0}
            aria-label="Previous page"
          >
            <IconChevronLeft width={14} height={14} />
          </button>
          <span className="px-1.5 text-xs text-muted tabular-nums whitespace-nowrap">
            {page + 1} / {pageCount}
          </span>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => onPage(page + 1)}
            disabled={page >= pageCount - 1}
            aria-label="Next page"
          >
            <IconChevronRight width={14} height={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

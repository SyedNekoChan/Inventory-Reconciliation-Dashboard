import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/database';
import { useTheme } from '../ThemeProvider';
import { ErrorBoundary } from '../ErrorBoundary';
import {
  IconDatabase,
  IconHistory,
  IconImport,
  IconInventory,
  IconMapping,
  IconMenu,
  IconMoon,
  IconOverview,
  IconRecon,
  IconSettings,
  IconSun,
  IconClose,
} from '../icons';
import { formatNumber } from '../../utils/format';

interface NavItem {
  to: string;
  label: string;
  icon: typeof IconOverview;
  /** Live badge count source. */
  badge?: 'critical' | 'unmapped';
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: IconOverview },
  { to: '/inventory', label: 'Inventory', icon: IconInventory },
  { to: '/reconciliation', label: 'Reconciliation', icon: IconRecon, badge: 'critical' },
  { to: '/mapping', label: 'SKU Mapping', icon: IconMapping, badge: 'unmapped' },
  { to: '/imports', label: 'Imports', icon: IconImport },
  { to: '/import-history', label: 'Import History', icon: IconHistory },
  { to: '/settings', label: 'Settings', icon: IconSettings },
];

export function AppLayout() {
  const { theme, toggle } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const badges = useLiveQuery(async () => {
    const [critical, unmapped] = await Promise.all([
      db.discrepancies.where('[state+severity]').equals(['open', 'critical']).count(),
      db.discrepancies.where('[state+type]').equals(['open', 'listing_unmapped']).count(),
    ]);
    return { critical, unmapped };
  }, [], { critical: 0, unmapped: 0 });

  const nav = (
    <nav className="flex flex-col gap-0.5 px-2">
      {NAV.map((item) => {
        const Icon = item.icon;
        const count =
          item.badge === 'critical'
            ? badges.critical
            : item.badge === 'unmapped'
              ? badges.unmapped
              : 0;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-accent-soft text-accent'
                  : 'text-muted hover:bg-elevated hover:text-ink'
              }`
            }
          >
            <Icon width={17} height={17} className="shrink-0" />
            <span className="flex-1 truncate">{item.label}</span>
            {count > 0 ? (
              <span
                className={`chip tabular-nums ${
                  item.badge === 'critical'
                    ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                    : 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                }`}
              >
                {count > 999 ? '999+' : formatNumber(count)}
              </span>
            ) : null}
          </NavLink>
        );
      })}
    </nav>
  );

  const brand = (
    <div className="flex items-center gap-2.5 px-4 py-4">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-white">
        <IconDatabase width={17} height={17} />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold leading-tight">Sonic Reconciliation</p>
        <p className="truncate text-2xs text-faint">Local inventory control</p>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-edge bg-surface lg:flex">
        {brand}
        <div className="flex-1 overflow-y-auto pb-4">{nav}</div>
        <div className="border-t border-edge p-2">
          <button type="button" className="btn-ghost w-full justify-start" onClick={toggle}>
            {theme === 'dark' ? (
              <IconSun width={16} height={16} />
            ) : (
              <IconMoon width={16} height={16} />
            )}
            <span>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
          </button>
        </div>
      </aside>

      {/* Mobile drawer */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative flex h-full w-64 flex-col border-r border-edge bg-surface">
            <div className="flex items-center justify-between">
              {brand}
              <button
                type="button"
                className="btn-ghost btn-sm mr-2"
                onClick={() => setMobileOpen(false)}
                aria-label="Close navigation"
              >
                <IconClose width={16} height={16} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto pb-4">{nav}</div>
            <div className="border-t border-edge p-2">
              <button type="button" className="btn-ghost w-full justify-start" onClick={toggle}>
                {theme === 'dark' ? (
                  <IconSun width={16} height={16} />
                ) : (
                  <IconMoon width={16} height={16} />
                )}
                <span>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
              </button>
            </div>
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="flex items-center gap-2 border-b border-edge bg-surface px-3 py-2 lg:hidden">
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
          >
            <IconMenu width={18} height={18} />
          </button>
          <span className="text-sm font-semibold">Sonic Reconciliation</span>
          <button type="button" className="btn-ghost btn-sm ml-auto" onClick={toggle} aria-label="Toggle theme">
            {theme === 'dark' ? <IconSun width={16} height={16} /> : <IconMoon width={16} height={16} />}
          </button>
        </header>

        <main className="min-w-0 flex-1 p-4 sm:p-6">
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

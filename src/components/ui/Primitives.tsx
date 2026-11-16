import type { ReactNode } from 'react';
import { SEVERITY_LABELS, type Severity } from '../../types/domain';
import { IconSpinner } from '../icons';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1 text-sm text-muted max-w-3xl">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2 shrink-0">{actions}</div> : null}
    </div>
  );
}

export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div className={`card ${padded ? 'p-4' : ''} ${className}`}>{children}</div>
  );
}

export function SectionTitle({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3">
      <h2 className="text-sm font-semibold text-ink">{children}</h2>
      {action}
    </div>
  );
}

const SEVERITY_CLASSES: Record<Severity, string> = {
  critical: 'bg-red-500/15 text-red-600 dark:text-red-400',
  high: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  medium: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  low: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  info: 'bg-slate-500/15 text-slate-600 dark:text-slate-300',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`chip ${SEVERITY_CLASSES[severity]}`}>{SEVERITY_LABELS[severity]}</span>;
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'accent';
}) {
  const tones = {
    neutral: 'bg-elevated text-muted',
    good: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    warn: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    bad: 'bg-red-500/15 text-red-600 dark:text-red-400',
    accent: 'bg-accent-soft text-accent',
  } as const;
  return <span className={`chip ${tones[tone]}`}>{children}</span>;
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 px-6">
      {icon ? <div className="mb-3 text-faint">{icon}</div> : null}
      <p className="text-sm font-medium text-ink">{title}</p>
      {description ? (
        <p className="mt-1 text-sm text-muted max-w-md">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted">
      <IconSpinner />
      {label ? <span>{label}</span> : null}
    </div>
  );
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-12">
      <Spinner label={label} />
    </div>
  );
}

/** Explicit unknown-data marker. Never render 0 for missing values. */
export function Unknown({ hint }: { hint?: string }) {
  return (
    <span className="text-faint" title={hint ?? 'No data imported for this field'}>
      Unknown
    </span>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
  onClick,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'neutral' | 'bad' | 'warn' | 'good';
  onClick?: () => void;
}) {
  const valueTone = {
    neutral: 'text-ink',
    bad: 'text-red-600 dark:text-red-400',
    warn: 'text-amber-600 dark:text-amber-400',
    good: 'text-emerald-600 dark:text-emerald-400',
  }[tone];

  const interactive = onClick
    ? 'text-left w-full hover:border-accent/60 hover:bg-elevated/60 transition-colors cursor-pointer'
    : '';

  const Tag = onClick ? 'button' : 'div';

  return (
    <Tag className={`card px-3.5 py-3 ${interactive}`} onClick={onClick} type={onClick ? 'button' : undefined}>
      <p className="text-2xs font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums leading-tight ${valueTone}`}>
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-faint truncate">{hint}</p> : null}
    </Tag>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-center gap-2 text-sm ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-edge accent-[rgb(var(--c-accent))]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function InfoNote({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warn' | 'bad' }) {
  const tones = {
    neutral: 'border-edge bg-elevated text-muted',
    warn: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
    bad: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300',
  } as const;
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${tones[tone]}`}>{children}</div>
  );
}

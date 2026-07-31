import * as React from 'react';
import { Badge, Card, CardContent, Skeleton } from '@/components/ui/primitives';
import { cn, formatNumber } from '@/lib/utils';

/** Categorical palette used by every chart, readable in both themes. */
export const CHART_COLORS = [
  '#7c85f5',
  '#4ac2a2',
  '#f0a541',
  '#e0688a',
  '#59b3e6',
  '#b58ae0',
  '#8bc34a',
  '#e8785a',
];

export const CHART_GRID = 'hsl(var(--border))';
export const CHART_AXIS = 'hsl(var(--muted-foreground))';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}): JSX.Element {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description ? (
          <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'default',
  loading = false,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: React.ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'destructive';
  loading?: boolean;
}): JSX.Element {
  const toneClass = {
    default: 'text-foreground',
    success: 'text-success',
    warning: 'text-warning',
    destructive: 'text-destructive',
  }[tone];

  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4">
        {icon ? (
          <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground [&_svg]:size-4">
            {icon}
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          {loading ? (
            <Skeleton className="mt-1.5 h-6 w-20" />
          ) : (
            <p className={cn('tabular mt-0.5 text-xl font-semibold', toneClass)}>{value}</p>
          )}
          {hint ? <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}

const JOB_STATUS_TONE: Record<string, 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'destructive'> = {
  new: 'outline',
  scored: 'default',
  queued: 'default',
  applying: 'warning',
  applied: 'success',
  skipped: 'secondary',
  failed: 'destructive',
  manual_review: 'warning',
  pending: 'outline',
  in_progress: 'warning',
  submitted: 'success',
  abandoned: 'secondary',
  needs_human: 'warning',
  interview: 'success',
  rejected: 'destructive',
  offer: 'success',
  active: 'warning',
  completed: 'success',
  delayed: 'outline',
  cancelled: 'secondary',
  running: 'warning',
  succeeded: 'success',
};

export function StatusBadge({ status }: { status: string | null | undefined }): JSX.Element {
  if (!status) return <Badge variant="outline">—</Badge>;
  return (
    <Badge variant={JOB_STATUS_TONE[status] ?? 'secondary'}>{status.replace(/_/g, ' ')}</Badge>
  );
}

export function ScoreBadge({ score }: { score: number | null | undefined }): JSX.Element {
  if (score === null || score === undefined) return <span className="text-muted-foreground">—</span>;
  const tone = score >= 75 ? 'success' : score >= 50 ? 'warning' : 'destructive';
  return (
    <Badge variant={tone} className="tabular">
      {Math.round(score)}
    </Badge>
  );
}

export function KeyValue({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{children}</dd>
    </div>
  );
}

export function ChartTooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number | string; color?: string }[];
  label?: string | number;
}): JSX.Element | null {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-2.5 py-2 text-xs shadow-md">
      {label !== undefined ? <p className="mb-1 font-medium">{String(label)}</p> : null}
      {payload.map((entry, index) => (
        <p key={index} className="tabular flex items-center gap-1.5 text-muted-foreground">
          <span
            className="size-2 rounded-full"
            style={{ backgroundColor: entry.color ?? CHART_COLORS[0] }}
          />
          {entry.name}: <span className="text-foreground">{formatNumber(Number(entry.value))}</span>
        </p>
      ))}
    </div>
  );
}

export function LoadingRows({ rows = 5, cols = 4 }: { rows?: number; cols?: number }): JSX.Element {
  return (
    <div className="space-y-2 p-3">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex gap-3">
          {Array.from({ length: cols }).map((__, colIndex) => (
            <Skeleton key={colIndex} className="h-6 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function ErrorState({ error }: { error: unknown }): JSX.Element {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
      {message}
    </div>
  );
}

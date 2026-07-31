import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, RefreshCw, ScrollText, Search } from 'lucide-react';
import { LOG_LEVELS, type LogLevel } from '@deedy/shared';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { ErrorState, LoadingRows, PageHeader } from '@/components/common';
import { Badge, Button, EmptyState, Input, Select } from '@/components/ui/primitives';
import { Switch } from '@/components/ui/overlays';
import { Pagination, TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';

const PAGE_SIZE = 50;

const LEVEL_TONE: Record<LogLevel, 'default' | 'outline' | 'warning' | 'destructive'> = {
  trace: 'outline',
  debug: 'outline',
  info: 'default',
  warn: 'warning',
  error: 'destructive',
  fatal: 'destructive',
};

const SINCE_WINDOWS = [
  { value: '', label: 'All time', minutes: 0 },
  { value: '15m', label: 'Last 15 minutes', minutes: 15 },
  { value: '1h', label: 'Last hour', minutes: 60 },
  { value: '24h', label: 'Last 24 hours', minutes: 60 * 24 },
  { value: '7d', label: 'Last 7 days', minutes: 60 * 24 * 7 },
] as const;

type SinceValue = (typeof SINCE_WINDOWS)[number]['value'];

function formatContext(context: unknown): string {
  try {
    return JSON.stringify(context, null, 2) ?? String(context);
  } catch {
    // Circular or non-serialisable payloads still deserve a readable fallback.
    return String(context);
  }
}

function hasContext(context: unknown): boolean {
  if (context === null || context === undefined) return false;
  if (typeof context === 'object') return Object.keys(context as Record<string, unknown>).length > 0;
  return true;
}

export default function LogsPage(): JSX.Element {
  const queryClient = useQueryClient();

  const [search, setSearch] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [level, setLevel] = React.useState('');
  const [scope, setScope] = React.useState('');
  const [since, setSince] = React.useState<SinceValue>('1h');
  const [liveTail, setLiveTail] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [expanded, setExpanded] = React.useState<number | null>(null);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const scopes = useQuery({ queryKey: ['logs', 'scopes'], queryFn: api.observability.logScopes });

  // Pinned to the selection rather than to "now" so the query key stays stable and
  // live tail refetches the same window instead of thrashing the cache every render.
  const sinceIso = React.useMemo(() => {
    const window = SINCE_WINDOWS.find((entry) => entry.value === since);
    if (!window || window.minutes === 0) return undefined;
    return new Date(Date.now() - window.minutes * 60_000).toISOString();
  }, [since]);

  const effectivePage = liveTail ? 1 : page;

  const query = {
    page: effectivePage,
    pageSize: PAGE_SIZE,
    q: debounced || undefined,
    level: level ? (level as LogLevel) : undefined,
    scope: scope || undefined,
    since: sinceIso,
  };

  const logs = useQuery({
    queryKey: ['logs', query],
    queryFn: () => api.observability.logs(query),
    refetchInterval: liveTail ? 3000 : false,
  });

  return (
    <div>
      <PageHeader
        title="Logs"
        description="Structured application logs written to the local database. Nothing is shipped off this machine."
        actions={
          <>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={liveTail}
                onCheckedChange={(checked) => {
                  setLiveTail(checked);
                  if (checked) setPage(1);
                }}
              />
              Live tail
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['logs'] })}
            >
              <RefreshCw />
              Refresh
            </Button>
          </>
        }
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        <div className="relative sm:col-span-2">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search message…"
            className="pl-8"
          />
        </div>
        <Select
          value={level}
          onChange={(event) => {
            setLevel(event.target.value);
            setPage(1);
          }}
        >
          <option value="">All levels</option>
          {LOG_LEVELS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
        <Select
          value={scope}
          onChange={(event) => {
            setScope(event.target.value);
            setPage(1);
          }}
        >
          <option value="">All scopes</option>
          {(scopes.data?.scopes ?? []).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
        <Select
          value={since}
          onChange={(event) => {
            setSince(event.target.value as SinceValue);
            setPage(1);
          }}
        >
          {SINCE_WINDOWS.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </Select>
      </div>

      {logs.isError ? <ErrorState error={logs.error} /> : null}

      <TableWrapper>
        {logs.isLoading ? (
          <LoadingRows rows={12} cols={4} />
        ) : logs.data && logs.data.items.length === 0 ? (
          <EmptyState
            icon={<ScrollText />}
            title="No log entries match these filters"
            description="Widen the time window or clear the level and scope filters."
          />
        ) : (
          <Table className="font-mono text-xs">
            <THead>
              <TR>
                <TH className="w-6" />
                <TH className="w-44">Time</TH>
                <TH className="w-20">Level</TH>
                <TH className="hidden w-40 sm:table-cell">Scope</TH>
                <TH>Message</TH>
              </TR>
            </THead>
            <TBody>
              {logs.data?.items.map((entry) => {
                const expandable = hasContext(entry.context);
                const isOpen = expanded === entry.id;
                return (
                  <React.Fragment key={entry.id}>
                    <TR
                      className={expandable ? 'cursor-pointer' : undefined}
                      onClick={() => {
                        if (expandable) setExpanded(isOpen ? null : entry.id);
                      }}
                    >
                      <TD className="py-1.5 pr-0 text-muted-foreground">
                        {expandable ? (
                          isOpen ? (
                            <ChevronDown className="size-3.5" />
                          ) : (
                            <ChevronRight className="size-3.5" />
                          )
                        ) : null}
                      </TD>
                      <TD className="tabular whitespace-nowrap py-1.5 text-muted-foreground">
                        {formatDate(entry.createdAt)}
                      </TD>
                      <TD className="py-1.5">
                        <Badge variant={LEVEL_TONE[entry.level]}>{entry.level}</Badge>
                      </TD>
                      <TD className="hidden max-w-[10rem] truncate py-1.5 text-muted-foreground sm:table-cell">
                        {entry.scope}
                      </TD>
                      <TD className="max-w-0 truncate py-1.5">{entry.message}</TD>
                    </TR>
                    {isOpen ? (
                      <TR className="hover:bg-transparent">
                        <TD colSpan={5} className="bg-secondary/30 px-3 py-2">
                          <pre className="scrollbar-thin max-h-80 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground">
                            {formatContext(entry.context)}
                          </pre>
                        </TD>
                      </TR>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </TBody>
          </Table>
        )}
      </TableWrapper>

      {logs.data ? (
        <Pagination
          page={logs.data.page}
          totalPages={logs.data.totalPages}
          total={logs.data.total}
          pageSize={logs.data.pageSize}
          onPageChange={(next) => {
            setLiveTail(false);
            setPage(next);
          }}
        />
      ) : null}
    </div>
  );
}

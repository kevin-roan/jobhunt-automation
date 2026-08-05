import * as React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  CircleSlash,
  KeyRound,
  Layers,
  MonitorPlay,
  Play,
  RefreshCw,
  Square,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import type { CredentialStatus, SourceStatusDto } from '@deedy/shared';
import { api } from '@/lib/api';
import { cn, formatDate, formatNumber, relativeTime } from '@/lib/utils';
import { ErrorState, LoadingRows, PageHeader, StatCard, StatusBadge } from '@/components/common';
import { SourceBadge, SourceTile, sourceLabel } from '@/components/sources';
import { VpnControls } from '@/components/VpnControls';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Separator,
} from '@/components/ui/primitives';
import { Switch, Tooltip } from '@/components/ui/overlays';
import { useToast } from '@/components/ui/toast';

/** Keeps `running` and the last-run counters honest without a manual refresh. */
const REFETCH_MS = 5000;

const CREDENTIAL_VARIANTS: Record<CredentialStatus, 'success' | 'warning' | 'destructive' | 'outline'> =
  {
    valid: 'success',
    expired: 'destructive',
    invalid: 'destructive',
    unknown: 'warning',
  };

const CREDENTIAL_LABELS: Record<CredentialStatus, string> = {
  valid: 'session valid',
  expired: 'session expired',
  invalid: 'session invalid',
  unknown: 'session unverified',
};

/**
 * Sources that need attention come first: a source that is switched on but
 * cannot run is the failure this page exists to surface. Disabled ones sink.
 */
function sortForAttention(sources: SourceStatusDto[]): SourceStatusDto[] {
  const rank = (source: SourceStatusDto): number => {
    if (!source.enabled) return 2;
    return source.blockedReason ? 0 : 1;
  };
  return [...sources].sort(
    (left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name),
  );
}

function SourceStat({ label, value }: { label: string; value: React.ReactNode }): JSX.Element {
  return (
    <div className="min-w-0">
      <p className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="tabular mt-0.5 text-sm font-semibold">{value}</p>
    </div>
  );
}

export default function SourcesPage(): JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();

  const sources = useQuery({
    queryKey: ['sources'],
    queryFn: api.sources.list,
    refetchInterval: REFETCH_MS,
  });

  const invalidateSources = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['sources'] });
  };

  const runSource = useMutation({
    mutationFn: ({ id, immediate }: { id: string; immediate: boolean }) =>
      api.sources.run(id, immediate),
    onSuccess: (result, variables) => {
      const label = sourceLabel(variables.id);
      if (variables.immediate) {
        toast.success(`${label} collected now`, 'The run finished in the foreground.');
      } else {
        toast.success(
          `${label} queued`,
          result.queueJobId === null
            ? 'The worker will pick it up on its next pass.'
            : `Queue job #${result.queueJobId}.`,
        );
      }
      invalidateSources();
      void queryClient.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: (error: unknown) =>
      toast.error('Could not start the run', error instanceof Error ? error.message : undefined),
  });

  const stopSource = useMutation({
    mutationFn: (id: string) => api.sources.stop(id),
    onSuccess: (result, id) => {
      toast.success(
        `${sourceLabel(id)} stopped`,
        `${result.cancelled} queued run${result.cancelled === 1 ? '' : 's'} cancelled.`,
      );
      invalidateSources();
      void queryClient.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: (error: unknown) =>
      toast.error('Could not stop the run', error instanceof Error ? error.message : undefined),
  });

  const setEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.sources.setEnabled(id, enabled),
    onSuccess: (_result, variables) => {
      toast.success(
        `${sourceLabel(variables.id)} ${variables.enabled ? 'enabled' : 'disabled'}`,
        variables.enabled
          ? 'It will be included in the next collection pass.'
          : 'It will be skipped until you switch it back on.',
      );
      invalidateSources();
    },
    onError: (error: unknown) =>
      toast.error('Could not change the source', error instanceof Error ? error.message : undefined),
  });

  const list = sources.data?.sources ?? [];
  const ordered = sortForAttention(list);
  const enabledCount = list.filter((source) => source.enabled).length;
  const blockedCount = list.filter((source) => source.enabled && source.blockedReason).length;
  const runningCount = list.filter((source) => source.running).length;
  const jobsToday = list.reduce((total, source) => total + source.jobsToday, 0);

  const renderSource = (source: SourceStatusDto): JSX.Element => {
    const blocked = Boolean(source.blockedReason);
    const running = source.running;
    const queuePending = runSource.isPending && runSource.variables?.id === source.id;
    const stopPending = stopSource.isPending && stopSource.variables === source.id;
    const togglePending = setEnabled.isPending && setEnabled.variables?.id === source.id;
    const toggleId = `source-enabled-${source.id}`;

    return (
      <Card
        key={source.id}
        className={cn(
          source.enabled && blocked && 'border-warning/50',
          !source.enabled && 'opacity-75',
        )}
      >
        <CardHeader>
          <div className="flex items-start gap-3">
            <SourceTile source={source.source} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="truncate">{source.name}</CardTitle>
                <SourceBadge source={source.source} />
                <Badge variant={source.builtIn ? 'secondary' : 'outline'}>
                  {source.builtIn ? 'built-in' : 'plugin'}
                </Badge>
                {running ? (
                  <Badge variant="warning" className="gap-1">
                    <span className="size-1.5 rounded-full bg-warning" />
                    running
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{source.description}</p>
            </div>
            <Switch
              id={toggleId}
              checked={source.enabled}
              disabled={togglePending}
              aria-label={`${source.enabled ? 'Disable' : 'Enable'} ${source.name}`}
              onCheckedChange={(next) => setEnabled.mutate({ id: source.id, enabled: next })}
            />
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {source.blockedReason ? (
            <div className="flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <p className="text-muted-foreground">
                <span className="font-medium text-warning">This source cannot run.</span>{' '}
                {source.blockedReason}
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {source.requiresAuth ? (
              source.credential ? (
                <Badge variant={CREDENTIAL_VARIANTS[source.credential.status]} className="gap-1">
                  <KeyRound className="size-3" />
                  {CREDENTIAL_LABELS[source.credential.status]}
                  {source.credential.cookieCount === null
                    ? ''
                    : ` · ${source.credential.cookieCount} cookie${
                        source.credential.cookieCount === 1 ? '' : 's'
                      }`}
                  {source.credential.expiresAt
                    ? ` · expires ${relativeTime(source.credential.expiresAt)}`
                    : ' · no expiry'}
                </Badge>
              ) : (
                <Badge variant="destructive" className="gap-1">
                  <KeyRound className="size-3" />
                  no session saved
                </Badge>
              )
            ) : (
              <Badge variant="outline">no sign-in needed</Badge>
            )}
            {source.browserOpen ? (
              <Badge variant="warning" className="gap-1">
                <MonitorPlay className="size-3" />
                profile open
              </Badge>
            ) : null}
            {source.requiresBoards ? (
              <Badge variant="outline">
                {source.boards.length} board{source.boards.length === 1 ? '' : 's'}
              </Badge>
            ) : null}
            {source.credential?.lastCheckedAt ? (
              <span className="text-[11px] text-muted-foreground">
                checked {relativeTime(source.credential.lastCheckedAt)}
              </span>
            ) : null}
          </div>

          <Separator />

          <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            <SourceStat label="Jobs" value={formatNumber(source.totalJobs)} />
            <SourceStat label="Today" value={formatNumber(source.jobsToday)} />
            <SourceStat label="Scored" value={formatNumber(source.scoredJobs)} />
            <SourceStat
              label="Avg score"
              value={source.averageScore === null ? '—' : Math.round(source.averageScore)}
            />
            <SourceStat label="Applied" value={formatNumber(source.applications)} />
            <SourceStat label="Keywords" value={formatNumber(source.activeKeywords)} />
          </div>

          <Separator />

          {source.lastRun ? (
            <div className="space-y-1.5 text-xs text-muted-foreground">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={source.lastRun.status} />
                <span className="tabular">
                  {formatNumber(source.lastRun.found)} found ·{' '}
                  {formatNumber(source.lastRun.inserted)} new ·{' '}
                  {formatNumber(source.lastRun.duplicates)} duplicate
                  {source.lastRun.duplicates === 1 ? '' : 's'}
                </span>
                {source.lastRun.errors > 0 ? (
                  <span className="tabular font-medium text-destructive">
                    {formatNumber(source.lastRun.errors)} error
                    {source.lastRun.errors === 1 ? '' : 's'}
                  </span>
                ) : null}
                <Tooltip content={formatDate(source.lastRun.finishedAt ?? source.lastRun.startedAt)}>
                  <span className="ml-auto">
                    {relativeTime(source.lastRun.finishedAt ?? source.lastRun.startedAt)}
                  </span>
                </Tooltip>
              </div>
              {source.lastRun.message ? (
                <p className="break-words rounded-md border border-border bg-secondary/40 p-2">
                  {source.lastRun.message}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              This source has not run yet, so there is nothing to report.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={queuePending || !source.enabled}
              onClick={() => runSource.mutate({ id: source.id, immediate: false })}
            >
              <Play />
              {queuePending && runSource.variables?.immediate === false ? 'Queueing…' : 'Run now'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={queuePending || !source.enabled}
              title={`Collect from ${source.name} in the foreground, skipping the queue`}
              onClick={() => runSource.mutate({ id: source.id, immediate: true })}
            >
              <Zap />
              {queuePending && runSource.variables?.immediate === true
                ? 'Running…'
                : 'Run immediately'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!running || stopPending}
              title={running ? `Stop the ${source.name} run` : 'Nothing is running for this source'}
              onClick={() => stopSource.mutate(source.id)}
            >
              <Square />
              {stopPending ? 'Stopping…' : 'Stop'}
            </Button>
            {source.requiresAuth ? (
              <Button variant="ghost" size="sm" asChild>
                <Link to="/browser">
                  <KeyRound />
                  Manage session
                </Link>
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div>
      <PageHeader
        title="Sources"
        description="The platforms jobs are collected from. Each one runs independently with its own session, keywords and schedule, so you can see exactly which of them is producing and which has quietly stopped."
        actions={
          <Button variant="outline" size="sm" onClick={invalidateSources}>
            <RefreshCw />
            Refresh
          </Button>
        }
      />

      {sources.isError ? <ErrorState error={sources.error} /> : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Enabled"
          value={`${enabledCount} / ${list.length}`}
          icon={<Layers />}
          loading={sources.isLoading}
        />
        <StatCard
          label="Blocked"
          value={blockedCount}
          tone={blockedCount > 0 ? 'warning' : 'default'}
          hint={blockedCount > 0 ? 'Enabled but unable to run' : 'Every enabled source can run'}
          icon={blockedCount > 0 ? <TriangleAlert /> : <CircleSlash />}
          loading={sources.isLoading}
        />
        <StatCard
          label="Jobs today"
          value={formatNumber(jobsToday)}
          hint="Across every source"
          icon={<Activity />}
          loading={sources.isLoading}
        />
        <StatCard
          label="Running"
          value={runningCount}
          tone={runningCount > 0 ? 'warning' : 'default'}
          icon={<Play />}
          loading={sources.isLoading}
        />
      </div>

      {/* Sits above the platforms because the exit country decides which regional
          index every one of them searches. */}
      <VpnControls className="mb-4" />

      {sources.isLoading ? (
        <LoadingRows rows={4} cols={3} />
      ) : ordered.length === 0 ? (
        <EmptyState
          icon={<Layers />}
          title="No sources configured"
          description="Built-in collectors register themselves on first start. If this list is empty the API has not finished seeding them yet."
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">{ordered.map(renderSource)}</div>
      )}
    </div>
  );
}

import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Activity,
  Briefcase,
  CheckCircle2,
  Play,
  Send,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useLiveEventLog } from '@/lib/events';
import { formatDay, formatNumber, relativeTime, truncate } from '@/lib/utils';
import {
  CHART_AXIS,
  CHART_COLORS,
  CHART_GRID,
  ChartTooltipContent,
  ErrorState,
  PageHeader,
  ScoreBadge,
  StatCard,
  StatusBadge,
} from '@/components/common';
import { PipelineControls } from '@/components/PipelineControls';
import { SourceBadge, SourceIcon, sourceAccent, sourceLabel } from '@/components/sources';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
} from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';

export default function OverviewPage(): JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();
  // Reads the root subscription's buffer; opening a second EventSource here would
  // double every invalidation and burn one of the ~6 connections per origin.
  const events = useLiveEventLog(20);

  const analytics = useQuery({
    queryKey: ['analytics', 30],
    queryFn: () => api.analytics.full(30),
  });
  const recentJobs = useQuery({
    queryKey: ['jobs', 'recent'],
    queryFn: () => api.jobs.list({ page: 1, pageSize: 8, sort: 'collectedAt', order: 'desc' }),
  });
  const recentApplications = useQuery({
    queryKey: ['applications', 'recent'],
    queryFn: () => api.applications.list({ page: 1, pageSize: 8 }),
  });
  const collectors = useQuery({ queryKey: ['collectors'], queryFn: api.collectors.list });
  const sources = useQuery({ queryKey: ['sources'], queryFn: api.sources.list });

  const runCollectors = useMutation({
    mutationFn: async () => {
      const planned = collectors.data?.planned ?? [];
      if (planned.length === 0) throw new Error('No collectors are configured to run');
      await Promise.all(planned.map((id) => api.collectors.run(id, false)));
      return planned.length;
    },
    onSuccess: (count) => {
      toast.success(`Queued ${count} collector run(s)`);
      void queryClient.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: (error: unknown) =>
      toast.error('Could not start collection', error instanceof Error ? error.message : undefined),
  });

  const overview = analytics.data?.overview;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Overview"
        description="Live state of the collection, scoring and application pipeline."
        actions={
          <Button
            onClick={() => runCollectors.mutate()}
            disabled={runCollectors.isPending}
            size="sm"
          >
            <Play />
            {runCollectors.isPending ? 'Queueing…' : 'Collect jobs now'}
          </Button>
        }
      />

      <PipelineControls />

      {analytics.isError ? <ErrorState error={analytics.error} /> : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Jobs collected"
          value={formatNumber(overview?.totalJobs)}
          hint={`${formatNumber(overview?.jobsToday)} today`}
          icon={<Briefcase />}
          loading={analytics.isLoading}
        />
        <StatCard
          label="Average score"
          value={overview ? overview.averageScore.toFixed(1) : '—'}
          hint={`${formatNumber(overview?.scoredJobs)} scored`}
          icon={<Sparkles />}
          loading={analytics.isLoading}
        />
        <StatCard
          label="Applications"
          value={formatNumber(overview?.totalApplications)}
          hint={`${formatNumber(overview?.applicationsToday)} today`}
          icon={<Send />}
          loading={analytics.isLoading}
        />
        <StatCard
          label="Submitted"
          value={formatNumber(overview?.submittedApplications)}
          hint={`${overview?.successRate ?? 0}% success rate`}
          tone="success"
          icon={<CheckCircle2 />}
          loading={analytics.isLoading}
        />
        <StatCard
          label="Needs you"
          value={formatNumber(overview?.needsHuman)}
          hint={`${formatNumber(overview?.failedApplications)} failed`}
          tone={overview && overview.needsHuman > 0 ? 'warning' : 'default'}
          icon={<TriangleAlert />}
          loading={analytics.isLoading}
        />
        <StatCard
          label="Queue"
          value={formatNumber(overview?.queuePending)}
          hint={`${formatNumber(overview?.queueActive)} active · ${formatNumber(overview?.queueFailed)} failed`}
          icon={<Activity />}
          loading={analytics.isLoading}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Pipeline volume · last 30 days</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={mergeSeries(analytics.data)}>
                <defs>
                  <linearGradient id="jobsFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_COLORS[0]} stopOpacity={0.45} />
                    <stop offset="100%" stopColor={CHART_COLORS[0]} stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="appsFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_COLORS[1]} stopOpacity={0.45} />
                    <stop offset="100%" stopColor={CHART_COLORS[1]} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDay}
                  stroke={CHART_AXIS}
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke={CHART_AXIS}
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  width={32}
                />
                <Tooltip content={<ChartTooltipContent />} />
                <Area
                  type="monotone"
                  dataKey="jobs"
                  name="Jobs collected"
                  stroke={CHART_COLORS[0]}
                  fill="url(#jobsFill)"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="applications"
                  name="Applications"
                  stroke={CHART_COLORS[1]}
                  fill="url(#appsFill)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Application funnel</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analytics.data?.funnel ?? []} layout="vertical" margin={{ left: 12 }}>
                <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" horizontal={false} />
                <XAxis
                  type="number"
                  stroke={CHART_AXIS}
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  stroke={CHART_AXIS}
                  fontSize={11}
                  width={86}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  content={<ChartTooltipContent />}
                  cursor={{ fill: 'hsl(var(--secondary))' }}
                />
                <Bar dataKey="count" name="Count" radius={[0, 4, 4, 0]}>
                  {(analytics.data?.funnel ?? []).map((_, index) => (
                    <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>Recent jobs</CardTitle>
            <Button variant="link" size="sm" asChild>
              <Link to="/jobs">View all</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-1">
            {recentJobs.data?.items.length === 0 ? (
              <EmptyState
                title="No jobs collected yet"
                description="Configure boards and keywords in Settings, then run a collector."
              />
            ) : (
              recentJobs.data?.items.map((job) => (
                <Link
                  key={job.id}
                  to={`/jobs/${job.id}`}
                  className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-secondary"
                >
                  <ScoreBadge score={job.score} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{job.title}</p>
                    <div className="flex min-w-0 items-center gap-1.5">
                      <p className="truncate text-xs text-muted-foreground">
                        {job.company} · {job.location ?? 'Location unspecified'}
                      </p>
                      <SourceBadge source={job.source} className="shrink-0" />
                    </div>
                  </div>
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                    {relativeTime(job.collectedAt)}
                  </span>
                  <StatusBadge status={job.status} />
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Jobs by source</CardTitle>
            </CardHeader>
            <CardContent>
              {(analytics.data?.sourceDistribution.length ?? 0) === 0 ? (
                <p className="py-16 text-center text-xs text-muted-foreground">No data yet</p>
              ) : (
                <>
                  <div className="h-44">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={analytics.data?.sourceDistribution ?? []}
                          dataKey="count"
                          nameKey="label"
                          innerRadius={40}
                          outerRadius={68}
                          paddingAngle={2}
                          stroke="hsl(var(--card))"
                        >
                          {(analytics.data?.sourceDistribution ?? []).map((entry) => (
                            <Cell key={entry.label} fill={sourceChartColor(entry.label)} />
                          ))}
                        </Pie>
                        <Tooltip content={<ChartTooltipContent />} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    {(analytics.data?.sourceDistribution ?? []).map((entry) => (
                      <li key={entry.label} className="flex items-center gap-1.5">
                        <SourceBadge source={entry.label} />
                        <span className="tabular text-xs text-muted-foreground">
                          {formatNumber(entry.count)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Sources</CardTitle>
              <Button variant="link" size="sm" asChild>
                <Link to="/sources">View all</Link>
              </Button>
            </CardHeader>
            <CardContent className="space-y-1">
              {sources.data?.sources.length === 0 ? (
                <EmptyState
                  title="No sources configured"
                  description="Enable a job board in Settings to start collecting."
                />
              ) : (
                sources.data?.sources.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm"
                  >
                    <SourceIcon source={entry.source} className={sourceAccent(entry.source).text} />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {entry.name || sourceLabel(entry.source)}
                    </span>
                    {/* Never colour alone: the state is spelled out for screen readers
                        and the reason rides along as the accessible name. */}
                    {entry.blockedReason ? (
                      <Badge
                        variant="destructive"
                        className="shrink-0"
                        // `role="img"` because Badge renders a plain <span>, on which an
                        // aria-label is not reliably exposed without a role.
                        role="img"
                        title={entry.blockedReason}
                        aria-label={`Blocked: ${entry.blockedReason}`}
                      >
                        blocked
                      </Badge>
                    ) : null}
                    <span className="tabular shrink-0 text-xs text-muted-foreground">
                      {formatNumber(entry.jobsToday)} today
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>Recent applications</CardTitle>
            <Button variant="link" size="sm" asChild>
              <Link to="/applications">View all</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-1">
            {recentApplications.data?.items.length === 0 ? (
              <EmptyState
                title="No applications yet"
                description="Score some jobs, then apply from a job page or enable auto-apply in Settings."
              />
            ) : (
              recentApplications.data?.items.map((application) => (
                <Link
                  key={application.id}
                  to={`/applications/${application.id}`}
                  className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-secondary"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{application.jobTitle ?? '—'}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {application.company ?? '—'} · attempt {application.attempts}/
                      {application.maxAttempts}
                      {application.dryRun ? ' · dry run' : ''}
                    </p>
                  </div>
                  <StatusBadge status={application.status} />
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Live activity</CardTitle>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                Waiting for pipeline events…
              </p>
            ) : (
              <ul className="scrollbar-thin max-h-64 space-y-1.5 overflow-y-auto pr-1">
                {events.map((event, index) => (
                  <li key={index} className="flex items-start gap-2 text-xs">
                    <span className="mt-1 size-1.5 shrink-0 rounded-full bg-primary" />
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {new Date(event.receivedAt).toLocaleTimeString()}
                    </span>
                    <span className="font-medium">{event.event}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {truncate(JSON.stringify(event.payload), 90)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * The accent carries its own resolved hex for exactly this, so pie slice and badge
 * are driven by one palette and every accent — including `slate` — has a real colour.
 */
function sourceChartColor(source: string): string {
  return sourceAccent(source).chart;
}

/** Aligns the jobs-per-day and applications-per-day series on a shared date axis. */
function mergeSeries(
  analytics:
    | {
        jobsPerDay: { date: string; value: number }[];
        applicationsPerDay: { date: string; value: number }[];
      }
    | undefined,
): { date: string; jobs: number; applications: number }[] {
  if (!analytics) return [];
  const byDate = new Map<string, { date: string; jobs: number; applications: number }>();
  for (const point of analytics.jobsPerDay) {
    byDate.set(point.date, { date: point.date, jobs: point.value, applications: 0 });
  }
  for (const point of analytics.applicationsPerDay) {
    const existing = byDate.get(point.date);
    if (existing) existing.applications = point.value;
    else byDate.set(point.date, { date: point.date, jobs: 0, applications: point.value });
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

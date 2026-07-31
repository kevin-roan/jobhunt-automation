import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Activity,
  Ban,
  CheckCircle2,
  CircleSlash,
  Clock,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react';
import { QUEUE_STATUSES, QUEUE_TASKS } from '@deedy/shared';
import type { QueueStats } from '@/lib/api';
import { api } from '@/lib/api';
import { formatDate, relativeTime, truncate } from '@/lib/utils';
import {
  CHART_AXIS,
  CHART_COLORS,
  CHART_GRID,
  ChartTooltipContent,
  ErrorState,
  LoadingRows,
  PageHeader,
  StatCard,
  StatusBadge,
} from '@/components/common';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Select,
} from '@/components/ui/primitives';
import { Tooltip } from '@/components/ui/overlays';
import { Pagination, TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';

/** Statuses whose rows can still be pulled back or pushed forward by hand. */
const CANCELLABLE = new Set<string>(['pending', 'active', 'delayed']);

const REFETCH_MS = 5000;

export default function QueuePage(): JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [status, setStatus] = React.useState('');
  const [task, setTask] = React.useState('');
  const [page, setPage] = React.useState(1);

  const stats = useQuery({
    queryKey: ['queue', 'stats'],
    queryFn: api.queue.stats,
    refetchInterval: REFETCH_MS,
  });

  const query = {
    page,
    pageSize: 25,
    status: status || undefined,
    task: task || undefined,
  };

  const jobs = useQuery({
    queryKey: ['queue', 'list', query],
    queryFn: () => api.queue.list(query),
    refetchInterval: REFETCH_MS,
  });

  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings.get });
  const paused = settings.data?.queue.paused ?? false;

  const invalidateQueue = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['queue'] });
  };

  const togglePause = useMutation({
    mutationFn: (next: boolean) => api.settings.pauseQueue(next),
    onSuccess: (_result, next) => {
      toast.success(next ? 'Queue paused' : 'Queue resumed');
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      invalidateQueue();
    },
    onError: (error: unknown) =>
      toast.error('Could not change queue state', error instanceof Error ? error.message : undefined),
  });

  const retryJob = useMutation({
    mutationFn: (id: number) => api.queue.retry(id),
    onSuccess: () => {
      toast.success('Job re-queued');
      invalidateQueue();
    },
    onError: (error: unknown) =>
      toast.error('Retry failed', error instanceof Error ? error.message : undefined),
  });

  const cancelJob = useMutation({
    mutationFn: (id: number) => api.queue.cancel(id),
    onSuccess: () => {
      toast.success('Job cancelled');
      invalidateQueue();
    },
    onError: (error: unknown) =>
      toast.error('Cancel failed', error instanceof Error ? error.message : undefined),
  });

  const retryAllFailed = useMutation({
    mutationFn: () => api.queue.retryFailed(),
    onSuccess: (result) => {
      toast.success(`Re-queued ${result.retried} failed job${result.retried === 1 ? '' : 's'}`);
      invalidateQueue();
    },
    onError: (error: unknown) =>
      toast.error('Could not retry failed jobs', error instanceof Error ? error.message : undefined),
  });

  const byStatus = stats.data?.byStatus ?? {};
  const worker = stats.data?.worker;
  const chartData = pivotTaskCountsByStatus(stats.data);
  const chartStatuses = QUEUE_STATUSES.filter((value) =>
    chartData.some((row) => Number(row[value] ?? 0) > 0),
  );

  return (
    <div>
      <PageHeader
        title="Automation queue"
        description="Every unit of background work the local worker runs: collection, scoring, tailoring and applying."
        actions={
          <>
            <Button
              variant={paused ? 'default' : 'outline'}
              size="sm"
              onClick={() => togglePause.mutate(!paused)}
              disabled={togglePause.isPending || settings.isLoading}
            >
              {paused ? <Play /> : <Pause />}
              {paused ? 'Resume queue' : 'Pause queue'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => retryAllFailed.mutate()}
              disabled={retryAllFailed.isPending || (byStatus.failed ?? 0) === 0}
            >
              <RotateCcw />
              Retry all failed
            </Button>
            <Button variant="outline" size="sm" onClick={invalidateQueue}>
              <RefreshCw />
              Refresh
            </Button>
          </>
        }
      />

      {stats.isError ? <ErrorState error={stats.error} /> : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <StatCard
          label="Pending"
          value={byStatus.pending ?? 0}
          icon={<Clock />}
          loading={stats.isLoading}
        />
        <StatCard
          label="Active"
          value={byStatus.active ?? 0}
          tone="warning"
          icon={<Play />}
          loading={stats.isLoading}
        />
        <StatCard
          label="Completed"
          value={byStatus.completed ?? 0}
          tone="success"
          icon={<CheckCircle2 />}
          loading={stats.isLoading}
        />
        <StatCard
          label="Failed"
          value={byStatus.failed ?? 0}
          tone="destructive"
          icon={<TriangleAlert />}
          loading={stats.isLoading}
        />
        <StatCard
          label="Cancelled"
          value={byStatus.cancelled ?? 0}
          icon={<CircleSlash />}
          loading={stats.isLoading}
        />
        <StatCard
          label="Worker"
          value={paused ? 'Paused' : worker?.running ? 'Running' : 'Stopped'}
          tone={paused ? 'warning' : worker?.running ? 'success' : 'destructive'}
          hint={worker ? `${worker.inFlight} in flight · ${worker.workerId}` : undefined}
          icon={paused ? <Pause /> : <Activity />}
          loading={stats.isLoading}
        />
      </div>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Work by task</CardTitle>
        </CardHeader>
        <CardContent className="h-72">
          {chartData.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing has been queued yet. Run a collector to give the worker something to do.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ left: 4, right: 8, bottom: 4 }}>
                <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="task"
                  stroke={CHART_AXIS}
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  interval={0}
                  angle={-20}
                  textAnchor="end"
                  height={56}
                />
                <YAxis
                  stroke={CHART_AXIS}
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  width={32}
                  allowDecimals={false}
                />
                <RechartsTooltip
                  content={<ChartTooltipContent />}
                  cursor={{ fill: 'hsl(var(--secondary))' }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {chartStatuses.map((value, index) => (
                  <Bar
                    key={value}
                    dataKey={value}
                    name={value}
                    stackId="queue"
                    fill={CHART_COLORS[index % CHART_COLORS.length]}
                    radius={index === chartStatuses.length - 1 ? [4, 4, 0, 0] : undefined}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {QUEUE_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
        <Select
          value={task}
          onChange={(event) => {
            setTask(event.target.value);
            setPage(1);
          }}
        >
          <option value="">All tasks</option>
          {QUEUE_TASKS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
      </div>

      {jobs.isError ? <ErrorState error={jobs.error} /> : null}

      <TableWrapper>
        {jobs.isLoading ? (
          <LoadingRows rows={8} cols={6} />
        ) : jobs.data && jobs.data.items.length === 0 ? (
          <EmptyState
            title="No queued work matches these filters"
            description="The worker drains the queue continuously, so completed runs may already have been cleaned up."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH className="w-16">ID</TH>
                <TH>Task</TH>
                <TH>Status</TH>
                <TH className="hidden w-20 sm:table-cell">Priority</TH>
                <TH className="hidden w-24 md:table-cell">Attempts</TH>
                <TH className="hidden lg:table-cell">Run at</TH>
                <TH className="hidden xl:table-cell">Last error</TH>
                <TH className="w-24 text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {jobs.data?.items.map((job) => (
                <TR key={job.id}>
                  <TD className="tabular text-xs text-muted-foreground">{job.id}</TD>
                  <TD className="font-medium">{job.task}</TD>
                  <TD>
                    <StatusBadge status={job.status} />
                  </TD>
                  <TD className="tabular hidden text-xs text-muted-foreground sm:table-cell">
                    {job.priority}
                  </TD>
                  <TD className="tabular hidden text-xs text-muted-foreground md:table-cell">
                    {job.attempts}/{job.maxAttempts}
                  </TD>
                  <TD className="hidden whitespace-nowrap text-xs text-muted-foreground lg:table-cell">
                    <Tooltip content={formatDate(job.runAt)}>
                      <span>{relativeTime(job.runAt)}</span>
                    </Tooltip>
                  </TD>
                  <TD className="hidden max-w-[18rem] xl:table-cell">
                    {job.lastError ? (
                      <Tooltip
                        content={
                          <span className="block whitespace-pre-wrap break-words">
                            {job.lastError}
                          </span>
                        }
                      >
                        <span className="block truncate text-xs text-destructive">
                          {truncate(job.lastError, 80)}
                        </span>
                      </Tooltip>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TD>
                  <TD>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Retry this job now"
                        onClick={() => retryJob.mutate(job.id)}
                        disabled={retryJob.isPending}
                      >
                        <RotateCcw />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Cancel this job"
                        onClick={() => cancelJob.mutate(job.id)}
                        disabled={cancelJob.isPending || !CANCELLABLE.has(job.status)}
                      >
                        <Ban />
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </TableWrapper>

      {jobs.data ? (
        <Pagination
          page={jobs.data.page}
          totalPages={jobs.data.totalPages}
          total={jobs.data.total}
          pageSize={jobs.data.pageSize}
          onPageChange={setPage}
        />
      ) : null}
    </div>
  );
}

interface TaskStatusRow {
  task: string;
  [status: string]: string | number;
}

/**
 * Recharts stacks need one row per category with a key per series, but the API
 * returns a flat (task, status, value) triple list, so pivot it here.
 */
function pivotTaskCountsByStatus(stats: QueueStats | undefined): TaskStatusRow[] {
  if (!stats) return [];
  const rows = new Map<string, TaskStatusRow>();
  for (const entry of stats.byTask) {
    let row = rows.get(entry.task);
    if (!row) {
      row = { task: entry.task };
      for (const value of QUEUE_STATUSES) row[value] = 0;
      rows.set(entry.task, row);
    }
    row[entry.status] = Number(row[entry.status] ?? 0) + entry.value;
  }
  return [...rows.values()];
}

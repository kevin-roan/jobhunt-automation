import * as React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarCheck,
  CheckCircle2,
  FlaskConical,
  RefreshCw,
  RotateCw,
  Send,
  Trophy,
  UserCheck,
  XCircle,
} from 'lucide-react';
import { APPLICATION_STATUSES, type ApplicationDto, type ApplicationStatus } from '@deedy/shared';
import { api } from '@/lib/api';
import { cn, relativeTime } from '@/lib/utils';
import { ErrorState, LoadingRows, PageHeader, StatCard, StatusBadge } from '@/components/common';
import { Badge, Button, EmptyState, Select } from '@/components/ui/primitives';
import { Pagination, TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';

const PAGE_SIZE = 25;

/** Statuses a human records manually after hearing back from the employer. */
const OUTCOME_STATUSES: ApplicationStatus[] = [
  'submitted',
  'interview',
  'rejected',
  'offer',
  'abandoned',
];

const RETRYABLE = new Set<ApplicationStatus>(['failed', 'needs_human']);

export default function ApplicationsPage(): JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [status, setStatus] = React.useState('');
  const [page, setPage] = React.useState(1);

  const query = { page, pageSize: PAGE_SIZE, status: status || undefined };

  const applications = useQuery({
    queryKey: ['applications', query],
    queryFn: () => api.applications.list(query),
  });

  const overview = useQuery({
    queryKey: ['analytics', 'overview'],
    queryFn: api.analytics.overview,
  });

  const refreshLists = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['applications'] });
    void queryClient.invalidateQueries({ queryKey: ['analytics'] });
  };

  const retry = useMutation({
    mutationFn: (id: number) => api.applications.retry(id),
    onSuccess: () => {
      toast.success('Retry queued');
      void queryClient.invalidateQueries({ queryKey: ['queue'] });
      refreshLists();
    },
    onError: (error: unknown) =>
      toast.error('Could not retry application', error instanceof Error ? error.message : undefined),
  });

  const setStatusMutation = useMutation({
    mutationFn: ({ id, value }: { id: number; value: string }) =>
      api.applications.setStatus(id, value),
    onSuccess: (updated: ApplicationDto) => {
      toast.success(`Marked as ${updated.status.replace(/_/g, ' ')}`);
      refreshLists();
    },
    onError: (error: unknown) =>
      toast.error('Could not update status', error instanceof Error ? error.message : undefined),
  });

  const stats = overview.data;
  const statsLoading = overview.isLoading;

  return (
    <div>
      <PageHeader
        title="Applications"
        description="Every application the agent has attempted, with its outcome. Record real-world replies here so the analytics stay honest."
        actions={
          <Button variant="outline" size="sm" onClick={refreshLists}>
            <RefreshCw />
            Refresh
          </Button>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <StatCard
          label="Total"
          value={stats?.totalApplications ?? 0}
          icon={<Send />}
          loading={statsLoading}
        />
        <StatCard
          label="Submitted"
          value={stats?.submittedApplications ?? 0}
          tone="success"
          icon={<CheckCircle2 />}
          loading={statsLoading}
        />
        <StatCard
          label="Needs human"
          value={stats?.needsHuman ?? 0}
          tone="warning"
          icon={<UserCheck />}
          loading={statsLoading}
        />
        <StatCard
          label="Failed"
          value={stats?.failedApplications ?? 0}
          tone="destructive"
          icon={<XCircle />}
          loading={statsLoading}
        />
        <StatCard
          label="Interviews"
          value={stats?.interviews ?? 0}
          tone="success"
          icon={<CalendarCheck />}
          loading={statsLoading}
        />
        <StatCard
          label="Offers"
          value={stats?.offers ?? 0}
          tone="success"
          icon={<Trophy />}
          loading={statsLoading}
        />
      </div>

      <div className="mb-4 grid gap-2 sm:max-w-xs">
        <Select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {APPLICATION_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value.replace(/_/g, ' ')}
            </option>
          ))}
        </Select>
      </div>

      {applications.isError ? <ErrorState error={applications.error} /> : null}
      {overview.isError ? <ErrorState error={overview.error} /> : null}

      <TableWrapper>
        {applications.isLoading ? (
          <LoadingRows rows={8} cols={6} />
        ) : applications.data && applications.data.items.length === 0 ? (
          <EmptyState
            title="No applications yet"
            description="Score some jobs and apply from a job page, or let the autopilot scheduler queue them for you."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Role</TH>
                <TH className="hidden sm:table-cell">Source</TH>
                <TH>Status</TH>
                <TH className="hidden md:table-cell">Attempts</TH>
                <TH className="hidden lg:table-cell">Mode</TH>
                <TH className="hidden xl:table-cell">Submitted</TH>
                <TH className="w-56 text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {applications.data?.items.map((application) => (
                <TR
                  key={application.id}
                  className={cn(
                    application.status === 'needs_human' &&
                      'border-l-2 border-l-warning bg-warning/5',
                  )}
                >
                  <TD className="max-w-[22rem]">
                    <Link
                      to={`/applications/${application.id}`}
                      className="block truncate font-medium hover:underline"
                    >
                      {application.jobTitle ?? `Application #${application.id}`}
                    </Link>
                    <span className="block truncate text-xs text-muted-foreground">
                      {application.company ?? '—'}
                    </span>
                  </TD>
                  <TD className="hidden text-xs text-muted-foreground sm:table-cell">
                    {application.source ?? '—'}
                  </TD>
                  <TD>
                    <StatusBadge status={application.status} />
                  </TD>
                  <TD className="tabular hidden text-xs text-muted-foreground md:table-cell">
                    {application.attempts}/{application.maxAttempts}
                  </TD>
                  <TD className="hidden lg:table-cell">
                    {application.dryRun ? (
                      <Badge variant="outline" className="gap-1">
                        <FlaskConical className="size-3" />
                        dry run
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">live</span>
                    )}
                  </TD>
                  <TD className="hidden whitespace-nowrap text-xs text-muted-foreground xl:table-cell">
                    {application.submittedAt ? relativeTime(application.submittedAt) : '—'}
                  </TD>
                  <TD>
                    <div className="flex items-center justify-end gap-1.5">
                      {RETRYABLE.has(application.status) ? (
                        <Button
                          variant="outline"
                          size="sm"
                          title="Queue another attempt"
                          onClick={() => retry.mutate(application.id)}
                          disabled={retry.isPending}
                        >
                          <RotateCw />
                          Retry
                        </Button>
                      ) : null}
                      <Select
                        aria-label="Record outcome"
                        className="h-8 w-32 text-xs"
                        value=""
                        disabled={setStatusMutation.isPending}
                        onChange={(event) => {
                          const value = event.target.value;
                          if (!value) return;
                          setStatusMutation.mutate({ id: application.id, value });
                        }}
                      >
                        <option value="">Set status…</option>
                        {OUTCOME_STATUSES.map((value) => (
                          <option key={value} value={value}>
                            {value.replace(/_/g, ' ')}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </TableWrapper>

      {applications.data ? (
        <Pagination
          page={applications.data.page}
          totalPages={applications.data.totalPages}
          total={applications.data.total}
          pageSize={applications.data.pageSize}
          onPageChange={setPage}
        />
      ) : null}
    </div>
  );
}

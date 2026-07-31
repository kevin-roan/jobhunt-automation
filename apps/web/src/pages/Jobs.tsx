import * as React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ExternalLink, RefreshCw, Search, Sparkles } from 'lucide-react';
import { JOB_STATUSES, type JobStatus } from '@deedy/shared';
import { api } from '@/lib/api';
import { formatSalary, relativeTime } from '@/lib/utils';
import {
  ErrorState,
  LoadingRows,
  PageHeader,
  ScoreBadge,
  StatusBadge,
} from '@/components/common';
import { Button, EmptyState, Input, Select } from '@/components/ui/primitives';
import { Pagination, TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';

export default function JobsPage(): JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [status, setStatus] = React.useState<JobStatus | ''>('');
  const [source, setSource] = React.useState('');
  const [minScore, setMinScore] = React.useState('');
  const [sort, setSort] = React.useState<'collectedAt' | 'score' | 'postedAt' | 'company'>(
    'collectedAt',
  );
  const [archived, setArchived] = React.useState(false);
  const [page, setPage] = React.useState(1);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const sources = useQuery({ queryKey: ['jobs', 'sources'], queryFn: api.jobs.sources });

  const query = {
    page,
    pageSize: 25,
    q: debounced || undefined,
    status: status || undefined,
    source: source || undefined,
    minScore: minScore ? Number(minScore) : undefined,
    sort,
    order: 'desc' as const,
    archived,
  };

  const jobs = useQuery({ queryKey: ['jobs', query], queryFn: () => api.jobs.list(query) });

  const scoreJob = useMutation({
    mutationFn: (id: number) => api.jobs.score(id, {}),
    onSuccess: () => {
      toast.success('Scoring queued');
      void queryClient.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: (error: unknown) =>
      toast.error('Could not queue scoring', error instanceof Error ? error.message : undefined),
  });

  const archiveJob = useMutation({
    mutationFn: ({ id, value }: { id: number; value: boolean }) =>
      api.jobs.update(id, { archived: value }),
    onSuccess: () => {
      toast.success('Job updated');
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error: unknown) =>
      toast.error('Could not update job', error instanceof Error ? error.message : undefined),
  });

  return (
    <div>
      <PageHeader
        title="Jobs"
        description="Every posting collected from your configured sources, de-duplicated and scored locally."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ['jobs'] })}
          >
            <RefreshCw />
            Refresh
          </Button>
        }
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
        <div className="relative sm:col-span-2">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search title, company, description…"
            className="pl-8"
          />
        </div>
        <Select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as JobStatus | '');
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {JOB_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value.replace(/_/g, ' ')}
            </option>
          ))}
        </Select>
        <Select
          value={source}
          onChange={(event) => {
            setSource(event.target.value);
            setPage(1);
          }}
        >
          <option value="">All sources</option>
          {(sources.data?.sources ?? []).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
        <Input
          type="number"
          min={0}
          max={100}
          value={minScore}
          onChange={(event) => {
            setMinScore(event.target.value);
            setPage(1);
          }}
          placeholder="Min score"
        />
        <Select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
          <option value="collectedAt">Newest collected</option>
          <option value="postedAt">Newest posted</option>
          <option value="score">Highest score</option>
          <option value="company">Company</option>
        </Select>
      </div>

      <div className="mb-3 flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => {
            setArchived(!archived);
            setPage(1);
          }}
          className="rounded-md border border-border px-2.5 py-1 transition-colors hover:bg-secondary"
        >
          {archived ? 'Showing archived' : 'Showing active'}
        </button>
      </div>

      {jobs.isError ? <ErrorState error={jobs.error} /> : null}

      <TableWrapper>
        {jobs.isLoading ? (
          <LoadingRows rows={8} cols={6} />
        ) : jobs.data && jobs.data.items.length === 0 ? (
          <EmptyState
            title="No jobs match these filters"
            description="Adjust the filters, or configure boards and keywords in Settings and run a collector."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH className="w-14">Score</TH>
                <TH>Role</TH>
                <TH className="hidden md:table-cell">Location</TH>
                <TH className="hidden lg:table-cell">Salary</TH>
                <TH className="hidden sm:table-cell">Source</TH>
                <TH>Status</TH>
                <TH className="hidden xl:table-cell">Collected</TH>
                <TH className="w-28 text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {jobs.data?.items.map((job) => (
                <TR key={job.id}>
                  <TD>
                    <ScoreBadge score={job.score} />
                  </TD>
                  <TD className="max-w-[22rem]">
                    <Link to={`/jobs/${job.id}`} className="block truncate font-medium hover:underline">
                      {job.title}
                    </Link>
                    <span className="block truncate text-xs text-muted-foreground">
                      {job.company}
                    </span>
                  </TD>
                  <TD className="hidden max-w-[12rem] truncate text-xs text-muted-foreground md:table-cell">
                    {job.location ?? '—'}
                  </TD>
                  <TD className="tabular hidden text-xs text-muted-foreground lg:table-cell">
                    {formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency, job.salaryPeriod)}
                  </TD>
                  <TD className="hidden text-xs text-muted-foreground sm:table-cell">{job.source}</TD>
                  <TD>
                    <StatusBadge status={job.status} />
                  </TD>
                  <TD className="hidden whitespace-nowrap text-xs text-muted-foreground xl:table-cell">
                    {relativeTime(job.collectedAt)}
                  </TD>
                  <TD>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Score with the local LLM"
                        onClick={() => scoreJob.mutate(job.id)}
                        disabled={scoreJob.isPending}
                      >
                        <Sparkles />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title={job.archived ? 'Unarchive' : 'Archive'}
                        onClick={() => archiveJob.mutate({ id: job.id, value: !job.archived })}
                      >
                        <Archive />
                      </Button>
                      <Button variant="ghost" size="icon" title="Open posting" asChild>
                        <a href={job.applicationUrl} target="_blank" rel="noreferrer">
                          <ExternalLink />
                        </a>
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

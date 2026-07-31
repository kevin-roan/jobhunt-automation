import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Briefcase,
  FileCode2,
  Image as ImageIcon,
  ListChecks,
  RefreshCw,
} from 'lucide-react';
import {
  APPLICATION_STATUSES,
  type ApplicationEventDto,
  type ArtifactDto,
  type StepStatus,
} from '@deedy/shared';
import { api } from '@/lib/api';
import { formatBytes, formatDate, relativeTime } from '@/lib/utils';
import { ErrorState, KeyValue, PageHeader, StatusBadge } from '@/components/common';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Label,
  Select,
  Separator,
  Skeleton,
} from '@/components/ui/primitives';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/overlays';
import { useToast } from '@/components/ui/toast';

const DOT_TONE: Record<StepStatus, string> = {
  succeeded: 'bg-success',
  failed: 'bg-destructive',
  running: 'bg-warning',
  skipped: 'bg-muted-foreground/40',
  pending: 'bg-muted-foreground/40',
};

function humanize(value: string): string {
  return value.replace(/_/g, ' ');
}

function formatDuration(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Events arrive newest-first from the API; the timeline reads better oldest-first per attempt. */
function groupByAttempt(events: ApplicationEventDto[]): { attempt: number; events: ApplicationEventDto[] }[] {
  const groups = new Map<number, ApplicationEventDto[]>();
  for (const event of events) {
    const bucket = groups.get(event.attempt);
    if (bucket) bucket.push(event);
    else groups.set(event.attempt, [event]);
  }
  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([attempt, list]) => ({
      attempt,
      events: [...list].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id - b.id,
      ),
    }));
}

function TimelineEntry({ event }: { event: ApplicationEventDto }): JSX.Element {
  const duration = formatDuration(event.durationMs);
  return (
    <li className="relative pl-6">
      <span
        className={`absolute left-0 top-1.5 size-2.5 rounded-full ring-4 ring-card ${DOT_TONE[event.status]}`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{humanize(event.step)}</span>
        <StatusBadge status={event.status} />
        {duration ? <span className="tabular text-xs text-muted-foreground">{duration}</span> : null}
        <span className="ml-auto text-xs text-muted-foreground">{relativeTime(event.createdAt)}</span>
      </div>
      {event.message ? (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{event.message}</p>
      ) : null}
      {event.error ? (
        <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-destructive">
          {event.error}
        </p>
      ) : null}
    </li>
  );
}

export default function ApplicationDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const applicationId = Number(params.id);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [preview, setPreview] = React.useState<ArtifactDto | null>(null);

  const application = useQuery({
    queryKey: ['applications', applicationId],
    queryFn: () => api.applications.get(applicationId),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['applications'] });
    void queryClient.invalidateQueries({ queryKey: ['queue'] });
  };

  const retry = useMutation({
    mutationFn: () => api.applications.retry(applicationId),
    onSuccess: () => {
      toast.success('Retry queued');
      invalidate();
    },
    onError: (error: unknown) =>
      toast.error('Could not queue retry', error instanceof Error ? error.message : undefined),
  });

  const setStatus = useMutation({
    mutationFn: (status: string) => api.applications.setStatus(applicationId, status),
    onSuccess: () => {
      toast.success('Status updated');
      invalidate();
    },
    onError: (error: unknown) =>
      toast.error('Could not update status', error instanceof Error ? error.message : undefined),
  });

  if (application.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (application.isError || !application.data) {
    return <ErrorState error={application.error ?? 'Application not found'} />;
  }

  const data = application.data;
  const attempts = groupByAttempt(data.events);
  const screenshots = data.artifacts.filter((artifact) => artifact.kind === 'screenshot');
  const documents = data.artifacts.filter((artifact) => artifact.kind !== 'screenshot');

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link to="/applications">
          <ArrowLeft />
          Back to applications
        </Link>
      </Button>

      <PageHeader
        title={data.jobTitle ?? `Application #${data.id}`}
        description={`${data.company ?? 'Unknown company'}${data.source ? ` · via ${data.source}` : ''}${
          data.currentStep ? ` · step: ${humanize(data.currentStep)}` : ''
        }`}
        actions={
          <>
            <StatusBadge status={data.status} />
            {data.dryRun ? <Badge variant="outline">dry run</Badge> : null}
            <Button variant="outline" size="sm" asChild>
              <Link to={`/jobs/${data.jobId}`}>
                <Briefcase />
                View job
              </Link>
            </Button>
          </>
        }
      />

      {data.status === 'needs_human' ? (
        <Card className="border-warning/40 bg-warning/5">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
            <AlertTriangle className="size-5 shrink-0 text-warning" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium text-warning">This application needs you</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {data.error ??
                  'The automation stopped and could not finish on its own. Open the posting and complete the remaining steps manually.'}
              </p>
            </div>
            <Button variant="outline" size="sm" asChild>
              <Link to={`/jobs/${data.jobId}`}>Open job</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardContent className="pt-5">
              <Tabs defaultValue="timeline">
                <TabsList>
                  <TabsTrigger value="timeline">Timeline</TabsTrigger>
                  <TabsTrigger value="answers">Answers ({data.answers.length})</TabsTrigger>
                  <TabsTrigger value="artifacts">Artifacts ({data.artifacts.length})</TabsTrigger>
                </TabsList>

                <TabsContent value="timeline" className="space-y-5">
                  {attempts.length === 0 ? (
                    <EmptyState
                      icon={<ListChecks />}
                      title="No events recorded"
                      description="Nothing has run for this application yet."
                    />
                  ) : (
                    attempts.map((group) => (
                      <div key={group.attempt} className="space-y-3">
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary">attempt {group.attempt}</Badge>
                          <span className="text-[11px] text-muted-foreground">
                            {group.events.length} event{group.events.length === 1 ? '' : 's'}
                          </span>
                          <Separator className="ml-1 flex-1" />
                        </div>
                        <ol className="ml-1 space-y-4 border-l border-border pl-3">
                          {group.events.map((event) => (
                            <TimelineEntry key={event.id} event={event} />
                          ))}
                        </ol>
                      </div>
                    ))
                  )}
                </TabsContent>

                <TabsContent value="answers" className="space-y-3">
                  {data.answers.length === 0 ? (
                    <EmptyState
                      icon={<ListChecks />}
                      title="No questions answered"
                      description="Answers generated for application form fields show up here."
                    />
                  ) : (
                    data.answers.map((answer) => (
                      <div key={answer.id} className="rounded-md border border-border p-3">
                        <div className="mb-1.5 flex flex-wrap items-center gap-2">
                          <Badge variant="outline">{humanize(answer.fieldType)}</Badge>
                          <Badge variant="secondary">{humanize(answer.source)}</Badge>
                          {answer.confidence !== null ? (
                            <span className="tabular text-xs text-muted-foreground">
                              confidence {(answer.confidence * 100).toFixed(0)}%
                            </span>
                          ) : null}
                          <span className="ml-auto text-xs text-muted-foreground">
                            {formatDate(answer.createdAt)}
                          </span>
                        </div>
                        <p className="text-sm font-medium leading-relaxed">{answer.question}</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                          {answer.answer}
                        </p>
                      </div>
                    ))
                  )}
                </TabsContent>

                <TabsContent value="artifacts" className="space-y-4">
                  {data.artifacts.length === 0 ? (
                    <EmptyState
                      icon={<ImageIcon />}
                      title="No artifacts captured"
                      description="Screenshots and saved pages appear here once the browser runs."
                    />
                  ) : (
                    <>
                      {screenshots.length > 0 ? (
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                          {screenshots.map((artifact) => (
                            <button
                              key={artifact.id}
                              type="button"
                              onClick={() => setPreview(artifact)}
                              className="group overflow-hidden rounded-md border border-border text-left transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <img
                                src={api.observability.artifactUrl(artifact.id)}
                                alt={artifact.step ?? `Screenshot ${artifact.id}`}
                                loading="lazy"
                                className="aspect-[4/3] w-full bg-muted object-cover object-top"
                              />
                              <span className="flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
                                <span className="truncate">
                                  {artifact.step ? humanize(artifact.step) : 'screenshot'}
                                </span>
                                <span className="shrink-0">{relativeTime(artifact.createdAt)}</span>
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : null}

                      {documents.length > 0 ? (
                        <div className="space-y-2">
                          {documents.map((artifact) => (
                            <a
                              key={artifact.id}
                              href={api.observability.artifactUrl(artifact.id)}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center gap-2 rounded-md border border-border p-2.5 text-sm transition-colors hover:border-primary"
                            >
                              <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
                              <span className="min-w-0 flex-1 truncate">
                                {artifact.step ? humanize(artifact.step) : artifact.path}
                              </span>
                              <Badge variant="outline">{artifact.kind}</Badge>
                              <span className="tabular shrink-0 text-xs text-muted-foreground">
                                {formatBytes(artifact.bytes)}
                              </span>
                            </a>
                          ))}
                        </div>
                      ) : null}
                    </>
                  )}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-4">
                <KeyValue label="Job">
                  <Link to={`/jobs/${data.jobId}`} className="text-primary hover:underline">
                    {data.jobTitle ?? `Job #${data.jobId}`}
                  </Link>
                </KeyValue>
                <KeyValue label="Provider">{data.source ?? '—'}</KeyValue>
                <KeyValue label="Resume">
                  {data.resumeId === null ? '—' : `#${data.resumeId}`}
                </KeyValue>
                <KeyValue label="Cover letter">
                  {data.coverLetterId === null ? '—' : `#${data.coverLetterId}`}
                </KeyValue>
                <KeyValue label="Attempts">
                  <span className="tabular">
                    {data.attempts} / {data.maxAttempts}
                  </span>
                </KeyValue>
                <KeyValue label="Mode">{data.dryRun ? 'Dry run' : 'Live submit'}</KeyValue>
                <KeyValue label="Started">{formatDate(data.startedAt)}</KeyValue>
                <KeyValue label="Submitted">{formatDate(data.submittedAt)}</KeyValue>
              </dl>

              {data.confirmationText ? (
                <>
                  <Separator className="my-4" />
                  <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                    Confirmation
                  </p>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-success">
                    {data.confirmationText}
                  </p>
                </>
              ) : null}

              {data.error ? (
                <>
                  <Separator className="my-4" />
                  <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                    Last error
                  </p>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-destructive">
                    {data.error}
                  </p>
                </>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                variant="outline"
                className="w-full"
                onClick={() => retry.mutate()}
                disabled={retry.isPending}
              >
                <RefreshCw />
                {retry.isPending ? 'Queueing…' : 'Retry application'}
              </Button>

              <div className="space-y-1.5">
                <Label htmlFor="application-status">Status</Label>
                <Select
                  id="application-status"
                  value={data.status}
                  disabled={setStatus.isPending}
                  onChange={(event) => setStatus.mutate(event.target.value)}
                >
                  {APPLICATION_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {humanize(status)}
                    </option>
                  ))}
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  Set this by hand to track interviews, rejections and offers.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={preview !== null} onOpenChange={(open) => setPreview(open ? preview : null)}>
        <DialogContent className="w-[min(72rem,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">
              {preview?.step ? humanize(preview.step) : 'Screenshot'}
              {preview ? (
                <span className="ml-2 font-normal text-muted-foreground">
                  {formatDate(preview.createdAt)}
                </span>
              ) : null}
            </DialogTitle>
          </DialogHeader>
          {preview ? (
            <img
              src={api.observability.artifactUrl(preview.id)}
              alt={preview.step ?? `Screenshot ${preview.id}`}
              className="scrollbar-thin max-h-[75vh] w-full overflow-auto rounded-md border border-border object-contain"
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

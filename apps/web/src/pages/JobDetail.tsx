import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, FileText, Mail, Send, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { formatDate, formatSalary } from '@/lib/utils';
import { ErrorState, KeyValue, PageHeader, ScoreBadge, StatusBadge } from '@/components/common';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Label,
  Select,
  Separator,
  Skeleton,
} from '@/components/ui/primitives';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { useToast } from '@/components/ui/toast';

export default function JobDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const jobId = Number(params.id);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [resumeId, setResumeId] = React.useState<string>('');
  const [dryRun, setDryRun] = React.useState(true);

  const job = useQuery({ queryKey: ['jobs', jobId], queryFn: () => api.jobs.get(jobId) });
  const resumes = useQuery({ queryKey: ['resumes'], queryFn: () => api.resumes.list(false) });
  const coverLetters = useQuery({
    queryKey: ['cover-letters', jobId],
    queryFn: () => api.coverLetters.list(jobId),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['jobs', jobId] });
    void queryClient.invalidateQueries({ queryKey: ['queue'] });
  };

  const score = useMutation({
    mutationFn: () =>
      api.jobs.score(jobId, { resumeId: resumeId ? Number(resumeId) : null, immediate: true }),
    onSuccess: () => {
      toast.success('Job scored');
      invalidate();
    },
    onError: (error: unknown) =>
      toast.error('Scoring failed', error instanceof Error ? error.message : undefined),
  });

  const enrich = useMutation({
    mutationFn: () => api.jobs.enrich(jobId),
    onSuccess: () => {
      toast.success('Enrichment queued');
      invalidate();
    },
    onError: (error: unknown) =>
      toast.error('Could not queue enrichment', error instanceof Error ? error.message : undefined),
  });

  const tailor = useMutation({
    mutationFn: () => {
      const base = resumeId ? Number(resumeId) : (resumes.data?.resumes[0]?.id ?? 0);
      if (!base) throw new Error('Create a base resume first');
      return api.resumes.tailor(base, { jobId, immediate: true, force: true });
    },
    onSuccess: () => {
      toast.success('Tailored resume generated');
      void queryClient.invalidateQueries({ queryKey: ['resumes'] });
    },
    onError: (error: unknown) =>
      toast.error('Tailoring failed', error instanceof Error ? error.message : undefined),
  });

  const generateLetter = useMutation({
    mutationFn: () =>
      api.coverLetters.generate({
        jobId,
        resumeId: resumeId ? Number(resumeId) : null,
        regenerate: true,
      }),
    onSuccess: () => {
      toast.success('Cover letter generated');
      void queryClient.invalidateQueries({ queryKey: ['cover-letters', jobId] });
    },
    onError: (error: unknown) =>
      toast.error('Generation failed', error instanceof Error ? error.message : undefined),
  });

  const apply = useMutation({
    mutationFn: () =>
      api.applications.apply({
        jobId,
        resumeId: resumeId ? Number(resumeId) : null,
        dryRun,
        immediate: false,
      }),
    onSuccess: () => {
      toast.success(dryRun ? 'Dry-run application queued' : 'Application queued');
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ['applications'] });
    },
    onError: (error: unknown) =>
      toast.error('Could not queue application', error instanceof Error ? error.message : undefined),
  });

  if (job.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (job.isError || !job.data) return <ErrorState error={job.error ?? 'Job not found'} />;

  const data = job.data;
  const latestScore = data.scores[0];

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link to="/jobs">
          <ArrowLeft />
          Back to jobs
        </Link>
      </Button>

      <PageHeader
        title={data.title}
        description={`${data.company}${data.location ? ` · ${data.location}` : ''} · via ${data.source}`}
        actions={
          <>
            <StatusBadge status={data.status} />
            <ScoreBadge score={data.score} />
            <Button variant="outline" size="sm" asChild>
              <a href={data.applicationUrl} target="_blank" rel="noreferrer">
                <ExternalLink />
                Open posting
              </a>
            </Button>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <KeyValue label="Employment">{data.employmentType.replace(/_/g, ' ')}</KeyValue>
                <KeyValue label="Experience">{data.experienceLevel}</KeyValue>
                <KeyValue label="Workplace">{data.remoteType}</KeyValue>
                <KeyValue label="Salary">
                  {formatSalary(
                    data.salaryMin,
                    data.salaryMax,
                    data.salaryCurrency,
                    data.salaryPeriod,
                  )}
                </KeyValue>
                <KeyValue label="Posted">{formatDate(data.postedAt)}</KeyValue>
                <KeyValue label="Collected">{formatDate(data.collectedAt)}</KeyValue>
              </dl>

              {data.skills.length > 0 ? (
                <>
                  <Separator className="my-4" />
                  <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                    Extracted skills
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {data.skills.map((skill) => (
                      <Badge key={skill} variant="secondary">
                        {skill}
                      </Badge>
                    ))}
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5">
              <Tabs defaultValue={data.summary ? 'summary' : 'description'}>
                <TabsList>
                  <TabsTrigger value="summary">AI summary</TabsTrigger>
                  <TabsTrigger value="description">Full description</TabsTrigger>
                  <TabsTrigger value="scores">Scoring history</TabsTrigger>
                </TabsList>

                <TabsContent value="summary">
                  {data.summary ? (
                    <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
                      {data.summary}
                    </pre>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No summary yet. Run enrichment to generate one locally.
                    </p>
                  )}
                </TabsContent>

                <TabsContent value="description">
                  <pre className="scrollbar-thin max-h-[32rem] overflow-y-auto whitespace-pre-wrap font-sans text-sm leading-relaxed text-muted-foreground">
                    {data.description ?? 'No description was published for this posting.'}
                  </pre>
                </TabsContent>

                <TabsContent value="scores" className="space-y-3">
                  {data.scores.length === 0 ? (
                    <p className="text-sm text-muted-foreground">This job has not been scored yet.</p>
                  ) : (
                    data.scores.map((entry) => (
                      <div key={entry.id} className="rounded-md border border-border p-3">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <ScoreBadge score={entry.score} />
                          <Badge variant="outline">{entry.recommendation.replace(/_/g, ' ')}</Badge>
                          <span className="text-xs text-muted-foreground">
                            confidence {(entry.confidence * 100).toFixed(0)}%
                          </span>
                          {entry.interviewProbability !== null ? (
                            <span className="text-xs text-muted-foreground">
                              interview odds {(entry.interviewProbability * 100).toFixed(0)}%
                            </span>
                          ) : null}
                          <span className="ml-auto text-xs text-muted-foreground">
                            {entry.model} · {formatDate(entry.createdAt)}
                          </span>
                        </div>
                        <p className="text-sm leading-relaxed">{entry.reasoning}</p>
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          <div>
                            <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                              Matched
                            </p>
                            <div className="flex flex-wrap gap-1">
                              {entry.matchedSkills.map((skill) => (
                                <Badge key={skill} variant="success">
                                  {skill}
                                </Badge>
                              ))}
                            </div>
                          </div>
                          <div>
                            <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                              Missing
                            </p>
                            <div className="flex flex-wrap gap-1">
                              {entry.missingSkills.map((skill) => (
                                <Badge key={skill} variant="warning">
                                  {skill}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        </div>
                        {entry.redFlags.length > 0 ? (
                          <div className="mt-3">
                            <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                              Red flags
                            </p>
                            <ul className="list-inside list-disc text-sm text-destructive">
                              {entry.redFlags.map((flag) => (
                                <li key={flag}>{flag}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                    ))
                  )}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="resume">Resume</Label>
                <Select
                  id="resume"
                  value={resumeId}
                  onChange={(event) => setResumeId(event.target.value)}
                >
                  <option value="">Use the default resume</option>
                  {(resumes.data?.resumes ?? []).map((resume) => (
                    <option key={resume.id} value={resume.id}>
                      {resume.name} (v{resume.version})
                    </option>
                  ))}
                </Select>
              </div>

              <Button
                variant="outline"
                className="w-full"
                onClick={() => score.mutate()}
                disabled={score.isPending}
              >
                <Sparkles />
                {score.isPending ? 'Scoring…' : 'Score now'}
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => enrich.mutate()}
                disabled={enrich.isPending}
              >
                <Sparkles />
                Extract skills & summarize
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => tailor.mutate()}
                disabled={tailor.isPending}
              >
                <FileText />
                {tailor.isPending ? 'Tailoring…' : 'Tailor resume'}
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => generateLetter.mutate()}
                disabled={generateLetter.isPending}
              >
                <Mail />
                {generateLetter.isPending ? 'Writing…' : 'Generate cover letter'}
              </Button>

              <Separator />

              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={dryRun}
                  onChange={(event) => setDryRun(event.target.checked)}
                  className="size-3.5 accent-[hsl(var(--primary))]"
                />
                Dry run — prepare everything but never click submit
              </label>

              <Button
                className="w-full"
                onClick={() => apply.mutate()}
                disabled={apply.isPending}
              >
                <Send />
                {apply.isPending ? 'Queueing…' : dryRun ? 'Queue dry run' : 'Apply now'}
              </Button>

              {data.applicationId ? (
                <Button variant="link" className="w-full" asChild>
                  <Link to={`/applications/${data.applicationId}`}>View application</Link>
                </Button>
              ) : null}
            </CardContent>
          </Card>

          {latestScore ? (
            <Card>
              <CardHeader>
                <CardTitle>Latest verdict</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <ScoreBadge score={latestScore.score} />
                  <Badge variant="outline">{latestScore.recommendation.replace(/_/g, ' ')}</Badge>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {latestScore.reasoning}
                </p>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Cover letters</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {(coverLetters.data?.coverLetters ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">None generated yet.</p>
              ) : (
                coverLetters.data?.coverLetters.map((letter) => (
                  <div key={letter.id} className="rounded-md border border-border p-2.5">
                    <p className="text-xs font-medium">
                      v{letter.version} · {letter.subject}
                    </p>
                    <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{letter.body}</p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

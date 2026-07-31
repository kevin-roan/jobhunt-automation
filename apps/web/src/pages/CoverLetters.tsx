import * as React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Mail, RefreshCw, Search, Sparkles, Trash2 } from 'lucide-react';
import type { CoverLetterDto } from '@deedy/shared';
import { api } from '@/lib/api';
import { cn, formatDate, relativeTime, truncate } from '@/lib/utils';
import { ErrorState, PageHeader } from '@/components/common';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  Select,
  Separator,
  Skeleton,
} from '@/components/ui/primitives';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/overlays';
import { useToast } from '@/components/ui/toast';

export default function CoverLettersPage(): JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [generateOpen, setGenerateOpen] = React.useState(false);
  const [jobSearch, setJobSearch] = React.useState('');
  const [debouncedJobSearch, setDebouncedJobSearch] = React.useState('');
  const [pickedJobId, setPickedJobId] = React.useState<number | null>(null);
  const [resumeId, setResumeId] = React.useState('');

  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedJobSearch(jobSearch), 300);
    return () => clearTimeout(timer);
  }, [jobSearch]);

  const letters = useQuery({
    queryKey: ['cover-letters'],
    queryFn: () => api.coverLetters.list(),
  });

  const resumes = useQuery({
    queryKey: ['resumes', 'base'],
    queryFn: () => api.resumes.list(false),
  });

  const jobPickerQuery = { page: 1, pageSize: 50, q: debouncedJobSearch || undefined };
  const pickerJobs = useQuery({
    queryKey: ['jobs', jobPickerQuery],
    queryFn: () => api.jobs.list(jobPickerQuery),
    enabled: generateOpen,
  });

  const items = React.useMemo<CoverLetterDto[]>(
    () => letters.data?.coverLetters ?? [],
    [letters.data],
  );

  // Keep a valid selection as the list refetches after generate/delete.
  React.useEffect(() => {
    if (items.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    const first = items[0];
    if (first && (selectedId === null || !items.some((letter) => letter.id === selectedId))) {
      setSelectedId(first.id);
    }
  }, [items, selectedId]);

  const selected = items.find((letter) => letter.id === selectedId) ?? null;

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['cover-letters'] });
  };

  const regenerate = useMutation({
    mutationFn: (jobId: number) =>
      api.coverLetters.generate({
        jobId,
        resumeId: selected?.resumeId ?? null,
        regenerate: true,
      }),
    onSuccess: (letter) => {
      toast.success('Cover letter regenerated', `Version ${letter.version}`);
      setSelectedId(letter.id);
      invalidate();
    },
    onError: (error: unknown) =>
      toast.error('Regeneration failed', error instanceof Error ? error.message : undefined),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.coverLetters.remove(id),
    onSuccess: () => {
      toast.success('Cover letter deleted');
      setDeleteOpen(false);
      setSelectedId(null);
      invalidate();
    },
    onError: (error: unknown) =>
      toast.error('Could not delete letter', error instanceof Error ? error.message : undefined),
  });

  const generate = useMutation({
    mutationFn: ({ jobId }: { jobId: number }) =>
      api.coverLetters.generate({
        jobId,
        resumeId: resumeId ? Number(resumeId) : null,
        regenerate: false,
      }),
    onSuccess: (letter) => {
      toast.success('Cover letter generated', `Version ${letter.version}`);
      setGenerateOpen(false);
      setPickedJobId(null);
      setJobSearch('');
      setSelectedId(letter.id);
      invalidate();
    },
    onError: (error: unknown) =>
      toast.error('Generation failed', error instanceof Error ? error.message : undefined),
  });

  const copyBody = async (letter: CoverLetterDto): Promise<void> => {
    try {
      await navigator.clipboard.writeText(letter.body);
      toast.success('Copied to clipboard');
    } catch (error) {
      toast.error('Could not copy', error instanceof Error ? error.message : undefined);
    }
  };

  return (
    <div>
      <PageHeader
        title="Cover letters"
        description="Every letter written by the local model, kept versioned next to the job it targets."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['cover-letters'] })}
            >
              <RefreshCw />
              Refresh
            </Button>
            <Dialog open={generateOpen} onOpenChange={setGenerateOpen}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Sparkles />
                  Generate for a job
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Generate a cover letter</DialogTitle>
                  <DialogDescription className="text-xs text-muted-foreground">
                    Pick a job and the resume the letter should draw from. Everything runs on this
                    machine.
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-3 overflow-y-auto">
                  <div className="space-y-1.5">
                    <Label htmlFor="job-search">Job</Label>
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="job-search"
                        value={jobSearch}
                        onChange={(event) => setJobSearch(event.target.value)}
                        placeholder="Search title, company, description…"
                        className="pl-8"
                      />
                    </div>
                  </div>

                  <div className="scrollbar-thin max-h-64 overflow-y-auto rounded-md border border-border">
                    {pickerJobs.isLoading ? (
                      <div className="space-y-2 p-3">
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-8 w-full" />
                      </div>
                    ) : pickerJobs.isError ? (
                      <div className="p-3">
                        <ErrorState error={pickerJobs.error} />
                      </div>
                    ) : (pickerJobs.data?.items ?? []).length === 0 ? (
                      <p className="p-4 text-center text-xs text-muted-foreground">
                        No jobs match this search.
                      </p>
                    ) : (
                      <ul className="divide-y divide-border">
                        {pickerJobs.data?.items.map((job) => (
                          <li key={job.id}>
                            <button
                              type="button"
                              onClick={() => setPickedJobId(job.id)}
                              className={cn(
                                'flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors hover:bg-secondary',
                                pickedJobId === job.id && 'bg-secondary',
                              )}
                            >
                              <span className="truncate text-sm font-medium">{job.title}</span>
                              <span className="truncate text-xs text-muted-foreground">
                                {job.company}
                                {job.location ? ` · ${job.location}` : ''} · {job.source}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="letter-resume">Resume</Label>
                    <Select
                      id="letter-resume"
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
                </div>

                <div className="flex justify-end gap-2">
                  <DialogClose asChild>
                    <Button variant="outline" size="sm">
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button
                    size="sm"
                    disabled={pickedJobId === null || generate.isPending}
                    onClick={() => {
                      if (pickedJobId !== null) generate.mutate({ jobId: pickedJobId });
                    }}
                  >
                    <Sparkles />
                    {generate.isPending ? 'Writing…' : 'Generate'}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </>
        }
      />

      {letters.isError ? <ErrorState error={letters.error} /> : null}

      {letters.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Mail />}
          title="No cover letters yet"
          description="Generate one for any collected job and it will be written locally, versioned, and stored here."
          action={
            <Button size="sm" onClick={() => setGenerateOpen(true)}>
              <Sparkles />
              Generate for a job
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
          <Card className="overflow-hidden">
            <CardHeader className="pb-3">
              <CardTitle>
                {items.length} letter{items.length === 1 ? '' : 's'}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="scrollbar-thin max-h-[36rem] divide-y divide-border overflow-y-auto border-t border-border">
                {items.map((letter) => (
                  <li key={letter.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(letter.id)}
                      className={cn(
                        'w-full px-4 py-3 text-left transition-colors hover:bg-secondary',
                        letter.id === selectedId && 'bg-secondary',
                      )}
                    >
                      <p className="truncate text-sm font-medium">
                        {letter.subject || 'Untitled letter'}
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Badge variant="outline">v{letter.version}</Badge>
                        {letter.tone ? <span>{letter.tone}</span> : null}
                        <span className="ml-auto whitespace-nowrap">
                          {relativeTime(letter.createdAt)}
                        </span>
                      </p>
                      <p className="mt-1 truncate text-[11px] text-muted-foreground">
                        {letter.model ?? 'unknown model'}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {selected ? (
            <Card>
              <CardHeader className="gap-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate">
                      {selected.subject || 'Untitled letter'}
                    </CardTitle>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline">v{selected.version}</Badge>
                      {selected.tone ? <Badge variant="secondary">{selected.tone}</Badge> : null}
                      <span>{selected.model ?? 'unknown model'}</span>
                      <span>{formatDate(selected.createdAt)}</span>
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => void copyBody(selected)}>
                      <Copy />
                      Copy
                    </Button>
                    {selected.jobId !== null ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (selected.jobId !== null) regenerate.mutate(selected.jobId);
                        }}
                        disabled={regenerate.isPending}
                      >
                        <RefreshCw />
                        {regenerate.isPending ? 'Writing…' : 'Regenerate'}
                      </Button>
                    ) : null}
                    <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                      <DialogTrigger asChild>
                        <Button variant="outline" size="sm">
                          <Trash2 />
                          Delete
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="w-[min(28rem,calc(100vw-2rem))]">
                        <DialogHeader>
                          <DialogTitle>Delete this cover letter?</DialogTitle>
                          <DialogDescription className="text-xs text-muted-foreground">
                            {truncate(selected.subject || 'Untitled letter', 90)} (v
                            {selected.version}) will be removed from the local database. This cannot
                            be undone.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="flex justify-end gap-2">
                          <DialogClose asChild>
                            <Button variant="outline" size="sm">
                              Cancel
                            </Button>
                          </DialogClose>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => remove.mutate(selected.id)}
                            disabled={remove.isPending}
                          >
                            <Trash2 />
                            {remove.isPending ? 'Deleting…' : 'Delete'}
                          </Button>
                        </div>
                      </DialogContent>
                    </Dialog>
                  </div>
                </div>

                {selected.jobId !== null ? (
                  <>
                    <Separator />
                    <Button variant="link" size="sm" asChild className="-ml-1 self-start">
                      <Link to={`/jobs/${selected.jobId}`}>View the job this targets</Link>
                    </Button>
                  </>
                ) : null}
              </CardHeader>
              <CardContent>
                <pre className="scrollbar-thin max-h-[32rem] max-w-[68ch] overflow-y-auto whitespace-pre-wrap font-sans text-sm leading-relaxed">
                  {selected.body}
                </pre>
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}
    </div>
  );
}

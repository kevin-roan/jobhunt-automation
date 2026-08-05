import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Cpu,
  Globe,
  Loader2,
  Pause,
  Play,
  Power,
  Sparkles,
  Square,
  Undo2,
} from 'lucide-react';
import { PIPELINE_STAGES } from '@deedy/shared';
import type { PipelineStage, PipelineStageStatus, PipelineStatus } from '@deedy/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ErrorState } from '@/components/common';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Separator,
  Skeleton,
} from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';

/** Both components read the same poll, so they share one cache entry. */
const PIPELINE_KEY = ['pipeline'] as const;

const REFETCH_MS = 3000;

/**
 * What each stage actually costs the machine. The user asked to stop the
 * pipeline because it eats resources, so every row says what it is spending.
 */
const STAGE_META: Record<PipelineStage, { label: string; cost: string }> = {
  collect: {
    label: 'Collect',
    cost: 'Drives a headless browser over job boards — heavy on CPU and network, no model calls.',
  },
  enrich: {
    label: 'Enrich',
    cost: 'Calls the local model to pull structure out of each raw posting.',
  },
  score: {
    label: 'Score',
    cost: 'Calls the local model once per job to rank it against your profile.',
  },
  tailor: {
    label: 'Tailor resume',
    cost: 'Calls the local model to rewrite the resume, then compiles LaTeX.',
  },
  cover_letter: {
    label: 'Cover letter',
    cost: 'Calls the local model to draft a letter per application.',
  },
  apply: {
    label: 'Apply',
    cost: 'Drives a real browser session to fill and submit forms — no model calls.',
  },
};

/** The reassurance that makes the stop button pressable. */
const ABORT_NOTE =
  'Stopping aborts what is in flight and puts that work back on the queue as pending — nothing is lost, it resumes where it left off when you start again.';

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function stageOf(status: PipelineStatus | undefined, stage: PipelineStage): PipelineStageStatus {
  return (
    status?.stages.find((entry) => entry.stage === stage) ?? {
      stage,
      running: false,
      usesLlm: false,
      inFlight: 0,
      pending: 0,
      failed: 0,
    }
  );
}

/** Full control surface: master switch plus one row per stage. For the Overview page. */
export function PipelineControls({ className }: { className?: string }): JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: PIPELINE_KEY,
    queryFn: api.pipeline.status,
    refetchInterval: REFETCH_MS,
    placeholderData: (previous: PipelineStatus | undefined) => previous,
  });

  /** Push the status a mutation just returned into the cache so the UI moves now. */
  const applyStatus = (data: PipelineStatus): void => {
    queryClient.setQueryData(PIPELINE_KEY, data);
    void queryClient.invalidateQueries({ queryKey: ['queue'] });
  };

  const master = useMutation({
    mutationFn: (action: 'start' | 'stop') =>
      api.pipeline.control({ action, abortInFlight: action === 'stop' }),
    onSuccess: (data, action) => {
      applyStatus(data);
      if (action === 'stop') {
        toast.success('Pipeline stopped', 'In-flight work was aborted and re-queued as pending.');
      } else {
        toast.success('Pipeline started', 'The worker is claiming queued work again.');
      }
    },
    onError: (error: unknown) => toast.error('Could not change the pipeline', errorMessage(error)),
  });

  const llmStages = (status.data?.stages ?? []).filter((entry) => entry.usesLlm);
  const runningLlmStages = llmStages.filter((entry) => entry.running);
  const llmBusy = runningLlmStages.length > 0;

  const llm = useMutation({
    mutationFn: async (action: 'start' | 'stop'): Promise<PipelineStatus[]> => {
      const targets = llmStages.map((entry) => entry.stage);
      // One round trip per stage, issued together, so the machine goes quiet at once.
      return Promise.all(
        targets.map((stage) =>
          action === 'stop' ? api.pipeline.stop(stage, true) : api.pipeline.start(stage),
        ),
      );
    },
    onSuccess: (results, action) => {
      const last = results[results.length - 1];
      if (last) applyStatus(last);
      else void queryClient.invalidateQueries({ queryKey: PIPELINE_KEY });
      if (action === 'stop') {
        toast.success(
          `Stopped all AI work (${results.length} stage${results.length === 1 ? '' : 's'})`,
          'Inference is idle. Aborted calls went back on the queue.',
        );
      } else {
        toast.success(
          `Resumed all AI work (${results.length} stage${results.length === 1 ? '' : 's'})`,
          'The local model will start picking up queued work.',
        );
      }
    },
    onError: (error: unknown) => toast.error('Could not change AI stages', errorMessage(error)),
  });

  const stageControl = useMutation({
    mutationFn: ({ stage, action }: { stage: PipelineStage; action: 'start' | 'stop' }) =>
      action === 'stop' ? api.pipeline.stop(stage, true) : api.pipeline.start(stage),
    onSuccess: (data, variables) => {
      applyStatus(data);
      const label = STAGE_META[variables.stage].label;
      if (variables.action === 'stop') {
        toast.success(`${label} stopped`, 'Its in-flight work was aborted and re-queued.');
      } else {
        toast.success(`${label} started`);
      }
    },
    onError: (error: unknown) => toast.error('Could not change that stage', errorMessage(error)),
  });

  if (status.isLoading && !status.data) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>Pipeline control</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-14 w-full" />
          {PIPELINE_STAGES.map((stage) => (
            <Skeleton key={stage} className="h-12 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (status.isError) {
    return (
      <div className={className}>
        <ErrorState error={status.error} />
      </div>
    );
  }

  const data = status.data;
  const running = data?.enabled ?? false;
  const inFlight = data?.inFlight ?? 0;
  const activeCalls = data?.llm.activeCalls ?? 0;
  const model = data?.llm.model || 'no model set';

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Pipeline control</CardTitle>
        <CardDescription>
          Everything runs on this machine. Stop any stage the moment it costs more than it is worth
          — {ABORT_NOTE}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Master switch ------------------------------------------------- */}
        <div
          className={cn(
            'flex flex-wrap items-center gap-3 rounded-lg border p-4',
            running ? 'border-success/40 bg-success/5' : 'border-border bg-secondary/40',
          )}
        >
          <div
            className={cn(
              'grid size-9 shrink-0 place-items-center rounded-md [&_svg]:size-4',
              running ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground',
            )}
          >
            {running ? <Activity /> : <Power />}
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">
              {running ? 'Pipeline is running' : 'Pipeline is stopped'}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant={data?.workerRunning ? 'success' : 'destructive'}>
                Worker {data?.workerRunning ? 'up' : 'down'}
              </Badge>
              <Badge variant={data?.queuePaused ? 'warning' : 'outline'}>
                Queue {data?.queuePaused ? 'paused' : 'draining'}
              </Badge>
              <Badge variant={inFlight > 0 ? 'warning' : 'outline'} className="tabular">
                {inFlight} in flight
              </Badge>
              <Badge variant={data?.schedulerEnabled ? 'outline' : 'secondary'}>
                Scheduler {data?.schedulerEnabled ? 'on' : 'off'}
              </Badge>
            </div>
          </div>

          <Button
            variant={running ? 'destructive' : 'default'}
            onClick={() => master.mutate(running ? 'stop' : 'start')}
            disabled={master.isPending}
          >
            {master.isPending ? <Loader2 className="animate-spin" /> : running ? <Square /> : <Play />}
            {running ? 'Stop everything' : 'Start pipeline'}
          </Button>
        </div>

        {/* LLM row -------------------------------------------------------- */}
        <div
          className={cn(
            'flex flex-wrap items-center gap-3 rounded-lg border p-4',
            llmBusy ? 'border-primary/40 bg-primary/5' : 'border-border bg-secondary/40',
          )}
        >
          <div
            className={cn(
              'grid size-9 shrink-0 place-items-center rounded-md [&_svg]:size-4',
              llmBusy ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
            )}
          >
            <Cpu />
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">
              Local inference{' '}
              <span className="font-normal text-muted-foreground">— the expensive part</span>
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="max-w-[16rem] truncate" title={model}>
                {model}
              </Badge>
              <Badge variant={activeCalls > 0 ? 'warning' : 'outline'} className="tabular">
                {activeCalls} active call{activeCalls === 1 ? '' : 's'}
              </Badge>
              <Badge variant={llmBusy ? 'default' : 'outline'} className="tabular">
                {runningLlmStages.length}/{llmStages.length} AI stages running
              </Badge>
            </div>
          </div>

          <Button
            variant={llmBusy ? 'destructive' : 'outline'}
            onClick={() => llm.mutate(llmBusy ? 'stop' : 'start')}
            disabled={llm.isPending || llmStages.length === 0}
          >
            {llm.isPending ? <Loader2 className="animate-spin" /> : llmBusy ? <Square /> : <Sparkles />}
            {llmBusy ? 'Stop all AI work' : 'Resume AI work'}
          </Button>
        </div>

        <Separator />

        {/* Per-stage rows -------------------------------------------------- */}
        <div className="space-y-2">
          {PIPELINE_STAGES.map((stage) => {
            const entry = stageOf(data, stage);
            const meta = STAGE_META[stage];
            const pending =
              stageControl.isPending && stageControl.variables?.stage === stage;

            return (
              <div
                key={stage}
                className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3"
              >
                <div
                  className={cn(
                    'grid size-8 shrink-0 place-items-center rounded-md [&_svg]:size-4',
                    entry.running ? 'bg-secondary text-foreground' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {entry.usesLlm ? <Sparkles /> : <Globe />}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{meta.label}</span>
                    {entry.usesLlm ? <Badge variant="default">AI</Badge> : null}
                    <Badge variant={entry.running ? 'success' : 'secondary'}>
                      {entry.running ? 'running' : 'stopped'}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{meta.cost}</p>
                </div>

                <div className="tabular flex shrink-0 items-center gap-1.5 text-[11px]">
                  <Badge variant={entry.inFlight > 0 ? 'warning' : 'outline'}>
                    {entry.inFlight} in flight
                  </Badge>
                  <Badge variant="outline">{entry.pending} pending</Badge>
                  <Badge variant={entry.failed > 0 ? 'destructive' : 'outline'}>
                    {entry.failed} failed
                  </Badge>
                </div>

                <Button
                  variant={entry.running ? 'outline' : 'secondary'}
                  size="sm"
                  className="shrink-0"
                  onClick={() =>
                    stageControl.mutate({ stage, action: entry.running ? 'stop' : 'start' })
                  }
                  disabled={pending}
                  title={
                    entry.running
                      ? `Stop ${meta.label} only. ${ABORT_NOTE}`
                      : `Start ${meta.label} only.`
                  }
                >
                  {pending ? (
                    <Loader2 className="animate-spin" />
                  ) : entry.running ? (
                    <Pause />
                  ) : (
                    <Play />
                  )}
                  {entry.running ? 'Stop' : 'Start'}
                </Button>
              </div>
            );
          })}
        </div>

        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-3 [&_svg]:shrink-0">
          <Undo2 />
          <span>{ABORT_NOTE}</span>
        </p>
      </CardContent>
    </Card>
  );
}

/** One-line master state + stop/start, compact enough for the app header. */
export function PipelineStatusPill(): JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: PIPELINE_KEY,
    queryFn: api.pipeline.status,
    refetchInterval: REFETCH_MS,
    placeholderData: (previous: PipelineStatus | undefined) => previous,
  });

  const master = useMutation({
    mutationFn: (action: 'start' | 'stop') =>
      api.pipeline.control({ action, abortInFlight: action === 'stop' }),
    onSuccess: (data, action) => {
      queryClient.setQueryData(PIPELINE_KEY, data);
      void queryClient.invalidateQueries({ queryKey: ['queue'] });
      toast.success(
        action === 'stop' ? 'Pipeline stopped' : 'Pipeline started',
        action === 'stop' ? 'In-flight work was aborted and re-queued as pending.' : undefined,
      );
    },
    onError: (error: unknown) => toast.error('Could not change the pipeline', errorMessage(error)),
  });

  if (status.isError) {
    return <Badge variant="destructive">Pipeline unknown</Badge>;
  }

  if (!status.data) {
    return <Skeleton className="h-5 w-28" />;
  }

  const running = status.data.enabled;
  const inFlight = status.data.inFlight;
  const activeCalls = status.data.llm.activeCalls;

  return (
    <div className="flex items-center gap-1.5">
      <Badge variant={running ? 'success' : 'secondary'} className="tabular gap-1.5">
        <span className="size-1.5 rounded-full bg-current" />
        {running ? 'Running' : 'Stopped'} · {inFlight} in flight
        {activeCalls > 0 ? ` · ${activeCalls} AI` : ''}
      </Badge>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={() => master.mutate(running ? 'stop' : 'start')}
        disabled={master.isPending}
        aria-label={running ? 'Stop the whole pipeline' : 'Start the pipeline'}
        title={
          running
            ? `Stop the whole pipeline. ${ABORT_NOTE}`
            : 'Start the pipeline — the worker resumes queued work.'
        }
      >
        {master.isPending ? <Loader2 className="animate-spin" /> : running ? <Square /> : <Play />}
      </Button>
    </div>
  );
}

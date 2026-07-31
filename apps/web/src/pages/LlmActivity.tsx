import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Check, Copy, Cpu, Hash, Plus, RefreshCw, Star, Trash2 } from 'lucide-react';
import { LLM_TASKS, type LlmTask } from '@deedy/shared';
import { api } from '@/lib/api';
import { formatDate, formatDay, formatNumber, relativeTime, truncate } from '@/lib/utils';
import {
  CHART_AXIS,
  CHART_COLORS,
  CHART_GRID,
  ChartTooltipContent,
  ErrorState,
  LoadingRows,
  PageHeader,
  StatCard,
} from '@/components/common';
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
  Textarea,
} from '@/components/ui/primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/overlays';
import { Pagination, TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';

const PAGE_SIZE = 25;

function taskLabel(task: string): string {
  return task.replace(/_/g, ' ');
}

/** Clipboard copy with a short-lived confirmation, used for every prompt block. */
function CopyButton({ value, label }: { value: string; label: string }): JSX.Element {
  const toast = useToast();
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      variant="ghost"
      size="sm"
      title={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => setCopied(true))
          .catch(() => toast.error('Could not copy', 'The clipboard is unavailable in this context'));
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

function PromptBlock({ label, value }: { label: string; value: string | null }): JSX.Element {
  const text = value ?? '';
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <CopyButton value={text} label={label} />
      </div>
      <pre className="scrollbar-thin max-h-[26rem] overflow-auto rounded-md border border-border bg-secondary/40 p-3 font-mono text-xs leading-relaxed">
        {text || 'Nothing was recorded for this block.'}
      </pre>
    </div>
  );
}

function LlmCallDialog({
  callId,
  onOpenChange,
}: {
  callId: number | null;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const call = useQuery({
    queryKey: ['llm-calls', callId],
    queryFn: () => api.observability.llmCall(callId as number),
    enabled: callId !== null,
  });

  return (
    <Dialog open={callId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(64rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">
            {call.data ? taskLabel(call.data.task) : 'LLM call'}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {call.data
              ? `${call.data.provider} · ${call.data.model} · attempt ${call.data.attempt} · ${formatDate(call.data.createdAt)}`
              : 'Loading the recorded prompt and response…'}
          </DialogDescription>
        </DialogHeader>

        {call.isError ? <ErrorState error={call.error} /> : null}

        {call.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : call.data ? (
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              <Badge variant={call.data.success ? 'success' : 'destructive'}>
                {call.data.success ? 'success' : 'failed'}
              </Badge>
              <span className="tabular text-muted-foreground">
                {formatNumber(call.data.promptTokens)} prompt ·{' '}
                {formatNumber(call.data.completionTokens)} completion ·{' '}
                {formatNumber(call.data.totalTokens)} total tokens
              </span>
              <span className="tabular text-muted-foreground">
                {call.data.durationMs === null ? '—' : `${formatNumber(call.data.durationMs)} ms`}
              </span>
            </div>

            {call.data.error ? (
              <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
                {call.data.error}
              </p>
            ) : null}

            <Tabs defaultValue="system">
              <TabsList>
                <TabsTrigger value="system">System prompt</TabsTrigger>
                <TabsTrigger value="user">User prompt</TabsTrigger>
                <TabsTrigger value="response">Raw response</TabsTrigger>
              </TabsList>
              <TabsContent value="system">
                <PromptBlock label="System prompt" value={call.data.systemPrompt} />
              </TabsContent>
              <TabsContent value="user">
                <PromptBlock label="User prompt" value={call.data.userPrompt} />
              </TabsContent>
              <TabsContent value="response">
                <PromptBlock label="Raw response" value={call.data.response} />
              </TabsContent>
            </Tabs>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function NewPromptDialog({
  open,
  onOpenChange,
  initialTask,
  initialSystem,
  initialUser,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTask: LlmTask;
  initialSystem: string;
  initialUser: string;
}): JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [task, setTask] = React.useState<LlmTask>(initialTask);
  const [name, setName] = React.useState('');
  const [system, setSystem] = React.useState(initialSystem);
  const [user, setUser] = React.useState(initialUser);
  const [isActive, setIsActive] = React.useState(true);

  // The dialog is kept mounted, so seed the fields whenever it is reopened.
  React.useEffect(() => {
    if (!open) return;
    setTask(initialTask);
    setName('');
    setSystem(initialSystem);
    setUser(initialUser);
    setIsActive(true);
  }, [open, initialTask, initialSystem, initialUser]);

  const save = useMutation({
    mutationFn: () => api.observability.savePrompt({ task, name, system, user, isActive }),
    onSuccess: () => {
      toast.success('Prompt version saved');
      void queryClient.invalidateQueries({ queryKey: ['prompts'] });
      onOpenChange(false);
    },
    onError: (error: unknown) =>
      toast.error('Could not save prompt', error instanceof Error ? error.message : undefined),
  });

  const canSave = name.trim().length > 0 && system.trim().length > 0 && user.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(56rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">New prompt version</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Stored locally and used instead of the built-in default whenever it is active.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="prompt-task">Task</Label>
              <Select
                id="prompt-task"
                value={task}
                onChange={(event) => setTask(event.target.value as LlmTask)}
              >
                {LLM_TASKS.map((value) => (
                  <option key={value} value={value}>
                    {taskLabel(value)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prompt-name">Name</Label>
              <Input
                id="prompt-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. stricter scoring rubric"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="prompt-system">System prompt</Label>
            <Textarea
              id="prompt-system"
              rows={6}
              value={system}
              onChange={(event) => setSystem(event.target.value)}
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="prompt-user">User prompt</Label>
            <Textarea
              id="prompt-user"
              rows={10}
              value={user}
              onChange={(event) => setUser(event.target.value)}
              className="font-mono text-xs"
            />
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={isActive} onCheckedChange={setIsActive} />
            Activate immediately for this task
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save version'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function LlmActivityPage(): JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [task, setTask] = React.useState('');
  const [success, setSuccess] = React.useState<'' | 'true' | 'false'>('');
  const [page, setPage] = React.useState(1);
  const [openCallId, setOpenCallId] = React.useState<number | null>(null);
  const [promptDialogOpen, setPromptDialogOpen] = React.useState(false);
  const [seedTask, setSeedTask] = React.useState<LlmTask>(LLM_TASKS[0]);
  const [seedSystem, setSeedSystem] = React.useState('');
  const [seedUser, setSeedUser] = React.useState('');

  const callsQuery = {
    page,
    pageSize: PAGE_SIZE,
    task: task || undefined,
    success: success === '' ? undefined : success === 'true',
  };

  const calls = useQuery({
    queryKey: ['llm-calls', callsQuery],
    queryFn: () => api.observability.llmCalls(callsQuery),
  });
  const overview = useQuery({ queryKey: ['analytics', 'overview'], queryFn: api.analytics.overview });
  const analytics = useQuery({ queryKey: ['analytics', 30], queryFn: () => api.analytics.full(30) });
  const prompts = useQuery({ queryKey: ['prompts'], queryFn: api.observability.prompts });

  const activate = useMutation({
    mutationFn: (id: number) => api.observability.activatePrompt(id),
    onSuccess: () => {
      toast.success('Prompt activated');
      void queryClient.invalidateQueries({ queryKey: ['prompts'] });
    },
    onError: (error: unknown) =>
      toast.error('Could not activate prompt', error instanceof Error ? error.message : undefined),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.observability.deletePrompt(id),
    onSuccess: () => {
      toast.success('Prompt deleted');
      void queryClient.invalidateQueries({ queryKey: ['prompts'] });
    },
    onError: (error: unknown) =>
      toast.error('Could not delete prompt', error instanceof Error ? error.message : undefined),
  });

  const openNewPrompt = (
    fromTask: LlmTask,
    fromSystem: string,
    fromUser: string,
  ): void => {
    setSeedTask(fromTask);
    setSeedSystem(fromSystem);
    setSeedUser(fromUser);
    setPromptDialogOpen(true);
  };

  const defaults = prompts.data?.defaults ?? [];
  const templates = prompts.data?.templates ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="LLM activity"
        description="Every prompt sent to your local model, with token accounting and the prompt templates that produced them."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: ['llm-calls'] });
                void queryClient.invalidateQueries({ queryKey: ['analytics'] });
              }}
            >
              <RefreshCw />
              Refresh
            </Button>
            <Button size="sm" onClick={() => openNewPrompt(LLM_TASKS[0], '', '')}>
              <Plus />
              New prompt version
            </Button>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-1">
          <StatCard
            label="LLM calls"
            value={formatNumber(overview.data?.llmCallsTotal)}
            hint="All tasks, all time"
            icon={<Cpu />}
            loading={overview.isLoading}
          />
          <StatCard
            label="Tokens used"
            value={formatNumber(overview.data?.llmTokensTotal)}
            hint="Prompt plus completion"
            icon={<Hash />}
            loading={overview.isLoading}
          />
        </div>

        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Tokens per day · last 30 days</CardTitle>
          </CardHeader>
          <CardContent className="h-56">
            {(analytics.data?.tokensPerDay.length ?? 0) === 0 ? (
              <p className="pt-12 text-center text-xs text-muted-foreground">No token usage yet</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={analytics.data?.tokensPerDay ?? []}>
                  <defs>
                    <linearGradient id="tokensFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_COLORS[5]} stopOpacity={0.45} />
                      <stop offset="100%" stopColor={CHART_COLORS[5]} stopOpacity={0.02} />
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
                    width={44}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Area
                    type="monotone"
                    dataKey="value"
                    name="Tokens"
                    stroke={CHART_COLORS[5]}
                    fill="url(#tokensFill)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <div>
        <div className="mb-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Select
            value={task}
            onChange={(event) => {
              setTask(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All tasks</option>
            {LLM_TASKS.map((value) => (
              <option key={value} value={value}>
                {taskLabel(value)}
              </option>
            ))}
          </Select>
          <Select
            value={success}
            onChange={(event) => {
              setSuccess(event.target.value as '' | 'true' | 'false');
              setPage(1);
            }}
          >
            <option value="">All outcomes</option>
            <option value="true">Successful only</option>
            <option value="false">Failed only</option>
          </Select>
        </div>

        {calls.isError ? <ErrorState error={calls.error} /> : null}

        <TableWrapper>
          {calls.isLoading ? (
            <LoadingRows rows={8} cols={7} />
          ) : calls.data && calls.data.items.length === 0 ? (
            <EmptyState
              title="No LLM calls recorded"
              description="Score a job or generate a document and the prompts will show up here."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH className="hidden xl:table-cell">When</TH>
                  <TH>Task</TH>
                  <TH className="hidden lg:table-cell">Model</TH>
                  <TH className="tabular text-right">Prompt</TH>
                  <TH className="tabular hidden text-right sm:table-cell">Completion</TH>
                  <TH className="tabular text-right">Total</TH>
                  <TH className="tabular hidden text-right md:table-cell">Duration</TH>
                  <TH className="tabular hidden text-right sm:table-cell">Attempt</TH>
                  <TH>Result</TH>
                  <TH className="hidden xl:table-cell">Error</TH>
                </TR>
              </THead>
              <TBody>
                {calls.data?.items.map((call) => (
                  <TR
                    key={call.id}
                    onClick={() => setOpenCallId(call.id)}
                    className="cursor-pointer"
                  >
                    <TD className="hidden whitespace-nowrap text-xs text-muted-foreground xl:table-cell">
                      {relativeTime(call.createdAt)}
                    </TD>
                    <TD className="whitespace-nowrap text-sm font-medium">{taskLabel(call.task)}</TD>
                    <TD className="hidden max-w-[14rem] truncate text-xs text-muted-foreground lg:table-cell">
                      {call.model}
                    </TD>
                    <TD className="tabular text-right text-xs text-muted-foreground">
                      {formatNumber(call.promptTokens)}
                    </TD>
                    <TD className="tabular hidden text-right text-xs text-muted-foreground sm:table-cell">
                      {formatNumber(call.completionTokens)}
                    </TD>
                    <TD className="tabular text-right text-xs">{formatNumber(call.totalTokens)}</TD>
                    <TD className="tabular hidden text-right text-xs text-muted-foreground md:table-cell">
                      {call.durationMs === null ? '—' : `${formatNumber(call.durationMs)} ms`}
                    </TD>
                    <TD className="tabular hidden text-right text-xs text-muted-foreground sm:table-cell">
                      {call.attempt}
                    </TD>
                    <TD>
                      <Badge variant={call.success ? 'success' : 'destructive'}>
                        {call.success ? 'ok' : 'failed'}
                      </Badge>
                    </TD>
                    <TD className="hidden max-w-[18rem] text-xs text-destructive xl:table-cell">
                      {call.error ? truncate(call.error, 80) : ''}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </TableWrapper>

        {calls.data ? (
          <Pagination
            page={calls.data.page}
            totalPages={calls.data.totalPages}
            total={calls.data.total}
            pageSize={calls.data.pageSize}
            onPageChange={setPage}
          />
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Prompt templates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {prompts.isError ? <ErrorState error={prompts.error} /> : null}

          <div>
            <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              Stored versions
            </p>
            {prompts.isLoading ? (
              <LoadingRows rows={3} cols={3} />
            ) : templates.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No custom templates yet. The built-in defaults below are used for every task.
              </p>
            ) : (
              <ul className="space-y-2">
                {templates.map((template) => (
                  <li
                    key={template.id}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {template.name}{' '}
                        <span className="text-xs font-normal text-muted-foreground">
                          v{template.version}
                        </span>
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {taskLabel(template.task)} · updated {relativeTime(template.updatedAt)}
                      </p>
                    </div>
                    {template.isActive ? <Badge variant="success">active</Badge> : null}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        openNewPrompt(template.task, template.system, template.user)
                      }
                    >
                      <Plus />
                      New version
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Make this the active template for its task"
                      onClick={() => activate.mutate(template.id)}
                      disabled={template.isActive || activate.isPending}
                    >
                      <Star />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Delete this template"
                      onClick={() => remove.mutate(template.id)}
                      disabled={remove.isPending}
                    >
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Separator />

          <div>
            <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              Built-in defaults
            </p>
            {prompts.isLoading ? (
              <LoadingRows rows={3} cols={2} />
            ) : defaults.length === 0 ? (
              <p className="text-xs text-muted-foreground">No built-in prompts were reported.</p>
            ) : (
              <ul className="space-y-2">
                {defaults.map((entry) => (
                  <li
                    key={entry.task}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{taskLabel(entry.task)}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {truncate(entry.system, 120)}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        openNewPrompt(entry.task as LlmTask, entry.system, entry.user)
                      }
                    >
                      <Plus />
                      Customize
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <LlmCallDialog callId={openCallId} onOpenChange={(open) => setOpenCallId(open ? openCallId : null)} />

      <NewPromptDialog
        open={promptDialogOpen}
        onOpenChange={setPromptDialogOpen}
        initialTask={seedTask}
        initialSystem={seedSystem}
        initialUser={seedUser}
      />
    </div>
  );
}

import * as React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bell,
  Bot,
  Clock,
  CloudUpload,
  Database,
  Globe,
  Link2,
  ListChecks,
  Network,
  Play,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  User,
  Workflow,
  X,
} from 'lucide-react';
import {
  BROWSER_ENGINES,
  EMPLOYMENT_TYPES,
  EXPERIENCE_LEVELS,
  LLM_PROVIDERS,
  REMOTE_TYPES,
  VPN_BACKENDS,
  type EmploymentType,
  type ExperienceLevel,
  type RemoteType,
  type Settings,
  type SettingsPatch,
  type SyncStatus,
} from '@deedy/shared';
import { api } from '@/lib/api';
import { cn, formatBytes, formatDate, formatNumber, relativeTime } from '@/lib/utils';
import { ErrorState, PageHeader } from '@/components/common';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Separator,
  Skeleton,
  Textarea,
} from '@/components/ui/primitives';
import { Switch, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { useToast } from '@/components/ui/toast';

type SectionKey = keyof Settings;

const SECTION_LABELS: Record<SectionKey, string> = {
  llm: 'Local LLM',
  browser: 'Browser',
  search: 'Search',
  application: 'Applications',
  queue: 'Queue',
  scheduler: 'Scheduler',
  pipeline: 'Pipeline',
  vpn: 'VPN',
  notifications: 'Notifications',
  profile: 'Candidate profile',
  sync: 'Mobile sync',
};

const SECTION_ORDER: SectionKey[] = [
  'llm',
  'browser',
  'search',
  'application',
  'queue',
  'scheduler',
  'pipeline',
  'vpn',
  'notifications',
  'profile',
  'sync',
];

/**
 * The consent surface for the one feature that crosses the network boundary. Kept as data so the
 * panel cannot drift from the allowlist the sync service actually enforces.
 */
const SYNC_SENDS: string[] = [
  'Job title, company, location, source and salary range',
  'Job score, recommendation and status',
  'Application status, current step, attempts, error message and timestamps',
  'Queue counts and collector run counts',
  'Notification title, body, kind and level',
];

const SYNC_NEVER_SENDS: string[] = [
  'Resume markdown and resume files',
  'Cover letter text',
  'Candidate profile PII (email, phone, street address, postal code)',
  'Provider cookies and session tokens',
  'LLM prompts and responses',
  'Screenshots and HTML snapshots',
  'The encryption key and the LLM api key',
];

/** Boards are keyed by collector source; each source expects a different slug format. */
const BOARD_SOURCES: { source: string; label: string; help: string }[] = [
  {
    source: 'greenhouse',
    label: 'Greenhouse',
    help: 'Board token from job-boards.greenhouse.io/<token>, e.g. "stripe".',
  },
  {
    source: 'lever',
    label: 'Lever',
    help: 'Company handle from jobs.lever.co/<handle>, e.g. "netflix".',
  },
  {
    source: 'ashby',
    label: 'Ashby',
    help: 'Job board name from jobs.ashbyhq.com/<name>, e.g. "ramp".',
  },
  {
    source: 'smartrecruiters',
    label: 'SmartRecruiters',
    help: 'Company identifier from careers.smartrecruiters.com/<id>, e.g. "Bosch".',
  },
  {
    source: 'workday',
    label: 'Workday',
    help: 'Full careers URL, e.g. https://acme.wd1.myworkdayjobs.com/en-US/External.',
  },
];

const SCHEDULER_TASKS: { name: string; label: string; description: string }[] = [
  { name: 'collect', label: 'Collect jobs', description: 'Run every enabled collector once.' },
  { name: 'score', label: 'Score jobs', description: 'Score everything still unscored.' },
  { name: 'apply', label: 'Apply', description: 'Process the auto-apply shortlist.' },
  { name: 'cleanup', label: 'Cleanup', description: 'Drop rows past the retention window.' },
  { name: 'backup', label: 'Backup', description: 'Snapshot the SQLite database now.' },
];

/** Backend ids are wire values; these are what an operator would recognise. */
const VPN_BACKEND_LABELS: Record<Settings['vpn']['backend'], string> = {
  none: 'None',
  protonvpn: 'Proton VPN',
  nmcli: 'NetworkManager',
  wg_quick: 'wg-quick',
  command: 'Custom command',
};

const humanize = (value: string): string => value.replace(/_/g, ' ');

/** Rebuilds a Settings object section by section so every branch stays exactly typed. */
function rebuildSettings(choose: <K extends SectionKey>(key: K) => Settings[K]): Settings {
  return {
    llm: choose('llm'),
    browser: choose('browser'),
    search: choose('search'),
    application: choose('application'),
    queue: choose('queue'),
    scheduler: choose('scheduler'),
    pipeline: choose('pipeline'),
    vpn: choose('vpn'),
    notifications: choose('notifications'),
    profile: choose('profile'),
    sync: choose('sync'),
  };
}

function sameSection(draft: Settings, server: Settings, section: SectionKey): boolean {
  return JSON.stringify(draft[section]) === JSON.stringify(server[section]);
}

/**
 * Secrets come back from the API masked. Sending the mask straight back would overwrite the real
 * value, so an untouched secret field is stripped from the patch instead.
 */
function buildPatch(section: SectionKey, draft: Settings, server: Settings): SettingsPatch {
  switch (section) {
    case 'llm': {
      const llm: NonNullable<SettingsPatch['llm']> = { ...draft.llm };
      if (draft.llm.apiKey === server.llm.apiKey) delete llm.apiKey;
      return { llm };
    }
    case 'notifications': {
      const notifications: NonNullable<SettingsPatch['notifications']> = {
        ...draft.notifications,
      };
      if (draft.notifications.webhookUrl === server.notifications.webhookUrl) {
        delete notifications.webhookUrl;
      }
      return { notifications };
    }
    case 'sync': {
      const sync: NonNullable<SettingsPatch['sync']> = { ...draft.sync };
      if (draft.sync.secretKey === server.sync.secretKey) delete sync.secretKey;
      return { sync };
    }
    case 'browser':
      return { browser: draft.browser };
    case 'search':
      return { search: draft.search };
    case 'application':
      return { application: draft.application };
    case 'queue':
      return { queue: draft.queue };
    case 'scheduler':
      return { scheduler: draft.scheduler };
    case 'pipeline':
      return { pipeline: draft.pipeline };
    case 'vpn':
      return { vpn: draft.vpn };
    case 'profile':
      return { profile: draft.profile };
  }
}

export default function SettingsPage(): JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();
  const location = useLocation();

  // Deep links such as /settings#sync open on the section they name.
  const initialSection =
    SECTION_ORDER.find((section) => section === location.hash.slice(1)) ?? 'llm';

  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings.get });
  const collectors = useQuery({ queryKey: ['collectors'], queryFn: api.collectors.list });
  const resumes = useQuery({ queryKey: ['resumes'], queryFn: () => api.resumes.list(false) });
  const backups = useQuery({ queryKey: ['backups'], queryFn: api.backups.list });
  const models = useQuery({
    queryKey: ['settings', 'models'],
    queryFn: api.settings.models,
    retry: false,
  });

  const [draft, setDraft] = React.useState<Settings | null>(null);
  const [savingSection, setSavingSection] = React.useState<SectionKey | null>(null);
  const savingRef = React.useRef<SectionKey | null>(null);
  const [llmTest, setLlmTest] = React.useState<{
    reachable: boolean;
    model: string;
    error: string | null;
  } | null>(null);
  const [pairInput, setPairInput] = React.useState('');

  const server = settings.data ?? null;
  const previousServer = React.useRef<Settings | null>(null);

  // Adopt every server value the user has not touched, so a save (or an external change) never
  // silently discards edits sitting in another tab of this page.
  React.useEffect(() => {
    if (!server) return;
    const previous = previousServer.current;
    previousServer.current = server;
    setDraft((current) => {
      if (!current || !previous) return structuredClone(server);
      const fresh = structuredClone(server);
      return rebuildSettings((key) =>
        JSON.stringify(current[key]) === JSON.stringify(previous[key]) ? fresh[key] : current[key],
      );
    });
  }, [server]);

  const save = useMutation({
    mutationFn: (patch: SettingsPatch) => api.settings.update(patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(['settings'], updated);
      // The server normalizes and re-masks what it stored, so the saved section is taken verbatim.
      const saved = savingRef.current;
      if (saved) {
        setDraft((current) =>
          current
            ? rebuildSettings((key) =>
                key === saved ? structuredClone(updated[key]) : current[key],
              )
            : current,
        );
      }
      toast.success('Settings saved');
      void queryClient.invalidateQueries({ queryKey: ['health'] });
      void queryClient.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: (error: unknown) =>
      toast.error('Could not save settings', error instanceof Error ? error.message : undefined),
    onSettled: () => setSavingSection(null),
  });

  const testLlm = useMutation({
    mutationFn: api.settings.testLlm,
    onSuccess: (result) => {
      setLlmTest(result);
      if (result.reachable) toast.success('Endpoint reachable', `Model: ${result.model || 'none'}`);
      else toast.error('Endpoint unreachable', result.error ?? undefined);
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setLlmTest({ reachable: false, model: '', error: message });
      toast.error('Connection test failed', message);
    },
  });

  const runTask = useMutation({
    mutationFn: (name: string) => api.scheduler.run(name),
    onSuccess: () => {
      toast.success('Task queued');
      void queryClient.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: (error: unknown) =>
      toast.error('Could not run task', error instanceof Error ? error.message : undefined),
  });

  const createBackup = useMutation({
    mutationFn: api.backups.create,
    onSuccess: (result) => {
      toast.success('Backup written', `${formatBytes(result.bytes)} on disk`);
      void queryClient.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (error: unknown) =>
      toast.error('Backup failed', error instanceof Error ? error.message : undefined),
  });

  const syncStatus = useQuery({
    queryKey: ['sync', 'status'],
    queryFn: api.sync.status,
    retry: false,
    // Cheap local read; polling keeps the strip honest while a flush is running.
    refetchInterval: 15000,
  });

  const refreshSyncStatus = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['sync', 'status'] });
  };

  const syncFailed =
    (label: string) =>
    (error: unknown): void => {
      toast.error(label, error instanceof Error ? error.message : undefined);
    };

  const testSync = useMutation({
    mutationFn: api.sync.test,
    onSuccess: () => {
      toast.success('Connection tested', 'The status strip below shows the result.');
      refreshSyncStatus();
    },
    onError: syncFailed('Sync connection test failed'),
  });

  const flushSync = useMutation({
    mutationFn: api.sync.flush,
    onSuccess: () => {
      toast.success('Outbox flushed');
      refreshSyncStatus();
    },
    onError: syncFailed('Could not flush the outbox'),
  });

  const fullSync = useMutation({
    mutationFn: api.sync.full,
    onSuccess: () => {
      toast.success('Full resync queued', 'Every eligible row is re-uploaded.');
      refreshSyncStatus();
    },
    onError: syncFailed('Could not start a full resync'),
  });

  const pairDevice = useMutation({
    mutationFn: (userId: string) => api.sync.pair(userId),
    onSuccess: (status) => {
      // The route answers with the freshly computed status, so adopt it directly.
      queryClient.setQueryData(['sync', 'status'], status);
      toast.success('Phone paired', status.configured ? undefined : 'Finish filling in the Supabase URL and keys above.');
      setPairInput('');
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: syncFailed('Could not pair this phone'),
  });

  if (settings.isError) return <ErrorState error={settings.error} />;

  if (settings.isLoading || !draft || !server) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-9 w-full max-w-2xl" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  const dirtySections = SECTION_ORDER.filter((section) => !sameSection(draft, server, section));

  const setLlm = (values: Partial<Settings['llm']>): void =>
    setDraft((current) => (current ? { ...current, llm: { ...current.llm, ...values } } : current));
  const setBrowser = (values: Partial<Settings['browser']>): void =>
    setDraft((current) =>
      current ? { ...current, browser: { ...current.browser, ...values } } : current,
    );
  const setSearch = (values: Partial<Settings['search']>): void =>
    setDraft((current) =>
      current ? { ...current, search: { ...current.search, ...values } } : current,
    );
  const setKeywordExpansion = (
    values: Partial<Settings['search']['keywordExpansion']>,
  ): void =>
    setDraft((current) =>
      current
        ? {
            ...current,
            search: {
              ...current.search,
              keywordExpansion: { ...current.search.keywordExpansion, ...values },
            },
          }
        : current,
    );
  const setApplication = (values: Partial<Settings['application']>): void =>
    setDraft((current) =>
      current ? { ...current, application: { ...current.application, ...values } } : current,
    );
  const setQueue = (values: Partial<Settings['queue']>): void =>
    setDraft((current) =>
      current ? { ...current, queue: { ...current.queue, ...values } } : current,
    );
  const setScheduler = (values: Partial<Settings['scheduler']>): void =>
    setDraft((current) =>
      current ? { ...current, scheduler: { ...current.scheduler, ...values } } : current,
    );
  const setPipeline = (values: Partial<Settings['pipeline']>): void =>
    setDraft((current) =>
      current ? { ...current, pipeline: { ...current.pipeline, ...values } } : current,
    );
  const setVpn = (values: Partial<Settings['vpn']>): void =>
    setDraft((current) => (current ? { ...current, vpn: { ...current.vpn, ...values } } : current));
  const setNotifications = (values: Partial<Settings['notifications']>): void =>
    setDraft((current) =>
      current ? { ...current, notifications: { ...current.notifications, ...values } } : current,
    );
  const setProfile = (values: Partial<Settings['profile']>): void =>
    setDraft((current) =>
      current ? { ...current, profile: { ...current.profile, ...values } } : current,
    );
  const setSync = (values: Partial<Settings['sync']>): void =>
    setDraft((current) => (current ? { ...current, sync: { ...current.sync, ...values } } : current));

  const resetSection = (section: SectionKey): void => {
    setDraft((current) =>
      current
        ? rebuildSettings((key) =>
            key === section ? structuredClone(server[key]) : current[key],
          )
        : current,
    );
  };

  const saveSection = (section: SectionKey): void => {
    savingRef.current = section;
    setSavingSection(section);
    save.mutate(buildPatch(section, draft, server));
  };

  const sectionProps = (section: SectionKey): SectionShellHandlers => ({
    dirty: !sameSection(draft, server, section),
    saving: savingSection === section && save.isPending,
    onSave: () => saveSection(section),
    onReset: () => resetSection(section),
  });

  const modelOptions = models.data?.models ?? [];
  const collectorList = collectors.data?.collectors ?? [];
  const resumeList = resumes.data?.resumes ?? [];

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Everything the agent uses lives here and stays on this machine, with one exception you control on the Mobile sync tab. Secrets are encrypted at rest."
        actions={
          dirtySections.length > 0 ? (
            <Badge variant="warning">
              {dirtySections.length} unsaved{' '}
              {dirtySections.length === 1 ? 'section' : 'sections'}:{' '}
              {dirtySections.map((section) => SECTION_LABELS[section]).join(', ')}
            </Badge>
          ) : (
            <Badge variant="outline">All changes saved</Badge>
          )
        }
      />

      <Tabs defaultValue={initialSection}>
        <TabsList className="flex h-auto flex-wrap justify-start">
          {SECTION_ORDER.map((section) => (
            <TabsTrigger key={section} value={section} className="gap-1.5">
              {SECTION_LABELS[section]}
              {!sameSection(draft, server, section) ? (
                <span className="size-1.5 rounded-full bg-warning" aria-label="unsaved changes" />
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ------------------------------------------------------------------ */}
        {/* Local LLM                                                           */}
        {/* ------------------------------------------------------------------ */}
        <TabsContent value="llm" className="space-y-4">
          <SectionShell
            icon={<Bot />}
            title="Local LLM"
            description="Point the agent at a model server running on this host. No model name is hardcoded anywhere in the app - you must pick one below or nothing will run."
            {...sectionProps('llm')}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <FieldRow label="Provider" help="Selects the wire protocol used to talk to your server.">
                <Select
                  value={draft.llm.provider}
                  onChange={(event) =>
                    setLlm({ provider: event.target.value as Settings['llm']['provider'] })
                  }
                >
                  {LLM_PROVIDERS.map((provider) => (
                    <option key={provider} value={provider}>
                      {humanize(provider)}
                    </option>
                  ))}
                </Select>
              </FieldRow>

              <TextField
                label="Base URL"
                value={draft.llm.baseUrl}
                onChange={(value) => setLlm({ baseUrl: value })}
                placeholder="http://localhost:11434"
                help="Must resolve to a host you control. Nothing is sent anywhere else."
              />

              <TextField
                label="API key"
                type="password"
                value={draft.llm.apiKey}
                onChange={(value) => setLlm({ apiKey: value })}
                placeholder="Optional for local gateways"
                help="Stored encrypted and shown masked. Leave the mask unchanged to keep the current value."
              />

              <NumberField
                label="Temperature"
                value={draft.llm.temperature}
                onChange={(value) => setLlm({ temperature: value ?? 0 })}
                min={0}
                max={2}
                step={0.05}
                help="Lower is more deterministic. 0.2 works well for scoring."
              />
            </div>

            <Separator className="my-5" />

            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">Models</p>
                <p className="text-xs text-muted-foreground">
                  Pick from what your server reports, or type a name if it cannot list models.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void models.refetch()}
                disabled={models.isFetching}
              >
                <RefreshCw className={cn(models.isFetching && 'animate-spin')} />
                Refresh models
              </Button>
            </div>

            {models.isError ? (
              <p className="mb-3 text-xs text-warning">
                Could not list models from {draft.llm.baseUrl}. Type the model name manually below.
              </p>
            ) : null}

            {!draft.llm.model ? (
              <p className="mb-3 rounded-md border border-warning/40 bg-warning/5 p-2.5 text-xs text-warning">
                No model selected. Scoring, tailoring and cover letters will fail until you choose
                one.
              </p>
            ) : null}

            <div className="grid gap-4 md:grid-cols-2">
              <ModelPicker
                label="Model"
                value={draft.llm.model}
                onChange={(value) => setLlm({ model: value })}
                options={modelOptions}
                help="Used for scoring, tailoring, cover letters and form answers."
              />
              <ModelPicker
                label="Fast model"
                value={draft.llm.fastModel}
                onChange={(value) => setLlm({ fastModel: value })}
                options={modelOptions}
                help="Optional smaller model for cheap classification. Falls back to the main model."
              />
            </div>

            <Separator className="my-5" />

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <NumberField
                label="Max tokens"
                value={draft.llm.maxTokens}
                onChange={(value) => setLlm({ maxTokens: value ?? 4096 })}
                min={64}
                max={131072}
                step={64}
                help="Upper bound on generated tokens per call."
              />
              <NumberField
                label="Context window"
                value={draft.llm.contextWindow}
                onChange={(value) => setLlm({ contextWindow: value ?? 16384 })}
                min={512}
                max={1048576}
                step={512}
                help="Prompts are trimmed to fit this budget."
              />
              <NumberField
                label="Request timeout (ms)"
                value={draft.llm.requestTimeoutMs}
                onChange={(value) => setLlm({ requestTimeoutMs: value ?? 300000 })}
                min={1000}
                max={1800000}
                step={1000}
                help="Large local models on CPU can need several minutes."
              />
              <NumberField
                label="Max retries"
                value={draft.llm.maxRetries}
                onChange={(value) => setLlm({ maxRetries: value ?? 0 })}
                min={0}
                max={10}
              />
            </div>

            <div className="mt-4 space-y-3">
              <SwitchField
                label="Use structured outputs"
                checked={draft.llm.useStructuredOutputs}
                onChange={(value) => setLlm({ useStructuredOutputs: value })}
                help="Constrains decoding to the JSON schema when the server supports it. Turn off if your server rejects the format field."
              />
              <SwitchField
                label="Disable model thinking"
                checked={draft.llm.disableThinking}
                onChange={(value) => setLlm({ disableThinking: value })}
                help="Reasoning models such as Qwen 3 and DeepSeek-R1 emit a long chain-of-thought before answering, which can cost hundreds of tokens per call and is very slow on CPU-only inference. These tasks want structured JSON, not deliberation. Leave this on unless you are deliberately benchmarking reasoning quality."
              />
            </div>

            <Separator className="my-5" />

            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => testLlm.mutate()}
                disabled={testLlm.isPending}
              >
                <Plug />
                {testLlm.isPending ? 'Testing…' : 'Test connection'}
              </Button>
              {llmTest ? (
                <span
                  className={cn(
                    'text-xs',
                    llmTest.reachable ? 'text-success' : 'text-destructive',
                  )}
                >
                  {llmTest.reachable
                    ? `Reachable · responded with ${llmTest.model || 'no model name'}`
                    : `Unreachable · ${llmTest.error ?? 'unknown error'}`}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Save first - the test uses the stored settings, not the draft.
                </span>
              )}
            </div>
          </SectionShell>
        </TabsContent>

        {/* ------------------------------------------------------------------ */}
        {/* Browser                                                             */}
        {/* ------------------------------------------------------------------ */}
        <TabsContent value="browser" className="space-y-4">
          <SectionShell
            icon={<Globe />}
            title="Browser"
            description="Playwright drives a real browser on this machine to read postings and fill forms."
            {...sectionProps('browser')}
          >
            {!draft.browser.dryRun ? (
              <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <p>
                  Dry run is OFF. The agent will click the real submit button and send real
                  applications to real employers. Turn it back on unless that is exactly what you
                  want.
                </p>
              </div>
            ) : null}

            <div className="grid gap-4 md:grid-cols-2">
              <FieldRow label="Engine" help="Chrome uses your installed browser; chromium ships with Playwright.">
                <Select
                  value={draft.browser.engine}
                  onChange={(event) =>
                    setBrowser({ engine: event.target.value as Settings['browser']['engine'] })
                  }
                >
                  {BROWSER_ENGINES.map((engine) => (
                    <option key={engine} value={engine}>
                      {engine}
                    </option>
                  ))}
                </Select>
              </FieldRow>

              <TextField
                label="Profile root"
                value={draft.browser.profileRoot}
                onChange={(value) => setBrowser({ profileRoot: value })}
                help="Directory holding one persistent login profile per provider."
              />
            </div>

            <div className="mt-4 space-y-3">
              <SwitchField
                label="Headless"
                checked={draft.browser.headless}
                onChange={(value) => setBrowser({ headless: value })}
                help="Turn off to watch the agent work and to solve logins manually."
              />
              <SwitchField
                label="Dry run"
                tone="destructive"
                checked={draft.browser.dryRun}
                onChange={(value) => setBrowser({ dryRun: value })}
                help="On: prepare the whole application but never click submit. Off: applications are really submitted."
              />
              <SwitchField
                label="Capture screenshots"
                checked={draft.browser.captureScreenshots}
                onChange={(value) => setBrowser({ captureScreenshots: value })}
                help="Stores a PNG per step so you can audit what happened."
              />
              <SwitchField
                label="Capture HTML"
                checked={draft.browser.captureHtml}
                onChange={(value) => setBrowser({ captureHtml: value })}
                help="Stores page HTML for debugging selector failures. Uses more disk."
              />
            </div>

            <Separator className="my-5" />

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <NumberField
                label="Slow motion (ms)"
                value={draft.browser.slowMoMs}
                onChange={(value) => setBrowser({ slowMoMs: value ?? 0 })}
                min={0}
                max={5000}
                step={50}
                help="Delay between actions. Useful when watching a run."
              />
              <NumberField
                label="Navigation timeout (ms)"
                value={draft.browser.navigationTimeoutMs}
                onChange={(value) => setBrowser({ navigationTimeoutMs: value ?? 60000 })}
                min={1000}
                max={600000}
                step={1000}
              />
              <NumberField
                label="Action timeout (ms)"
                value={draft.browser.actionTimeoutMs}
                onChange={(value) => setBrowser({ actionTimeoutMs: value ?? 30000 })}
                min={500}
                max={600000}
                step={500}
              />
              <NumberField
                label="Viewport width"
                value={draft.browser.viewportWidth}
                onChange={(value) => setBrowser({ viewportWidth: value ?? 1440 })}
                min={320}
                max={3840}
              />
              <NumberField
                label="Viewport height"
                value={draft.browser.viewportHeight}
                onChange={(value) => setBrowser({ viewportHeight: value ?? 900 })}
                min={320}
                max={2160}
              />
              <TextField
                label="Locale"
                value={draft.browser.locale}
                onChange={(value) => setBrowser({ locale: value })}
                placeholder="en-US"
              />
              <TextField
                label="Timezone"
                value={draft.browser.timezone}
                onChange={(value) => setBrowser({ timezone: value })}
                placeholder="UTC"
              />
              <div className="md:col-span-2 xl:col-span-3">
                <TextField
                  label="User agent"
                  value={draft.browser.userAgent}
                  onChange={(value) => setBrowser({ userAgent: value })}
                  placeholder="Leave empty to use the engine default"
                  help="Override only if a board blocks the default agent string."
                />
              </div>
            </div>
          </SectionShell>
        </TabsContent>

        {/* ------------------------------------------------------------------ */}
        {/* Search                                                              */}
        {/* ------------------------------------------------------------------ */}
        <TabsContent value="search" className="space-y-4">
          <SectionShell
            icon={<Search />}
            title="Search"
            description="What the collectors look for and which boards they crawl."
            {...sectionProps('search')}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <ChipListField
                label="Seed keywords"
                values={draft.search.keywords}
                onChange={(values) => setSearch({ keywords: values })}
                placeholder="staff engineer"
                help="Type and press Enter. These are seeds, not the final search terms: the local model widens them into related titles, and every expansion is managed on the Keywords page."
              />
              <ChipListField
                label="Excluded keywords"
                values={draft.search.excludedKeywords}
                onChange={(values) => setSearch({ excludedKeywords: values })}
                placeholder="unpaid"
                help="Any match drops the posting before it is scored."
              />
              <ChipListField
                label="Locations"
                values={draft.search.locations}
                onChange={(values) => setSearch({ locations: values })}
                placeholder="Berlin"
              />
              <ChipListField
                label="Excluded companies"
                values={draft.search.excludedCompanies}
                onChange={(values) => setSearch({ excludedCompanies: values })}
                placeholder="Acme Corp"
                help="Matched case-insensitively against the company name."
              />
            </div>

            <Separator className="my-5" />

            <div className="mb-3">
              <p className="text-sm font-medium">Keyword expansion</p>
              <p className="text-xs text-muted-foreground">
                The local model turns each seed above into related titles so the collectors do not
                miss postings that word the same role differently.
              </p>
            </div>

            <div className="mb-4">
              <SwitchField
                label="Let the local model widen your keywords"
                checked={draft.search.keywordExpansion.enabled}
                onChange={(value) => setKeywordExpansion({ enabled: value })}
                help="Off means the collectors search your seed terms verbatim and nothing else."
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <NumberField
                label="Terms per seed"
                value={draft.search.keywordExpansion.perSeed}
                onChange={(value) => setKeywordExpansion({ perSeed: value ?? 6 })}
                min={1}
                max={25}
                help="How many related terms the model generates for each seed keyword."
              />
              <NumberField
                label="Minimum confidence"
                value={draft.search.keywordExpansion.minConfidence}
                onChange={(value) => setKeywordExpansion({ minConfidence: value ?? 0.45 })}
                min={0}
                max={1}
                step={0.05}
                help="Terms the model scores below this are still saved, but they start disabled - you can review them and switch them on yourself."
              />
              <NumberField
                label="Max active keywords"
                value={draft.search.keywordExpansion.maxActiveKeywords}
                onChange={(value) => setKeywordExpansion({ maxActiveKeywords: value ?? 30 })}
                min={1}
                max={200}
                help="Caps how many terms any one collector run will search, however many are enabled."
              />
            </div>

            <div className="mt-4">
              <SwitchField
                label="Re-expand when the seed list changes"
                checked={draft.search.keywordExpansion.autoExpandOnSeedChange}
                onChange={(value) => setKeywordExpansion({ autoExpandOnSeedChange: value })}
                help="Runs an expansion automatically after you save a new seed. Leave off to expand on demand instead."
              />
            </div>

            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              Individual keywords - seeds and expansions alike - are enabled, edited and deleted on
              the{' '}
              <Link to="/keywords" className="text-primary underline-offset-4 hover:underline">
                Keywords
              </Link>{' '}
              page.
            </p>

            <Separator className="my-5" />

            <div className="grid gap-5 md:grid-cols-3">
              <CheckboxGroup
                label="Workplace"
                options={REMOTE_TYPES}
                values={draft.search.remotePreference}
                onChange={(values: RemoteType[]) => setSearch({ remotePreference: values })}
              />
              <CheckboxGroup
                label="Employment types"
                options={EMPLOYMENT_TYPES}
                values={draft.search.employmentTypes}
                onChange={(values: EmploymentType[]) => setSearch({ employmentTypes: values })}
              />
              <CheckboxGroup
                label="Experience levels"
                options={EXPERIENCE_LEVELS}
                values={draft.search.experienceLevels}
                onChange={(values: ExperienceLevel[]) => setSearch({ experienceLevels: values })}
              />
            </div>

            <Separator className="my-5" />

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <NumberField
                label="Minimum salary"
                value={draft.search.minSalary}
                onChange={(value) => setSearch({ minSalary: value })}
                min={0}
                allowEmpty
                placeholder="Any"
                help="Leave empty to ignore salary floors."
              />
              <NumberField
                label="Maximum salary"
                value={draft.search.maxSalary}
                onChange={(value) => setSearch({ maxSalary: value })}
                min={0}
                allowEmpty
                placeholder="Any"
              />
              <TextField
                label="Currency"
                value={draft.search.currency}
                onChange={(value) => setSearch({ currency: value })}
                placeholder="USD"
              />
              <NumberField
                label="Posted within (days)"
                value={draft.search.postedWithinDays}
                onChange={(value) => setSearch({ postedWithinDays: value ?? 30 })}
                min={1}
                max={365}
              />
              <NumberField
                label="Max jobs per collector run"
                value={draft.search.maxJobsPerCollectorRun}
                onChange={(value) => setSearch({ maxJobsPerCollectorRun: value ?? 100 })}
                min={1}
                max={2000}
                help="Keeps a single run bounded so the queue stays responsive."
              />
            </div>

            <Separator className="my-5" />

            <div className="space-y-2">
              <Label>Enabled collectors</Label>
              {collectors.isLoading ? (
                <Skeleton className="h-20 w-full" />
              ) : collectorList.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No collectors are registered on the server.
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {collectorList.map((collector) => (
                    <label
                      key={collector.id}
                      className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2.5 transition-colors hover:bg-secondary"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-3.5 accent-[hsl(var(--primary))]"
                        checked={draft.search.enabledCollectors.includes(collector.id)}
                        onChange={(event) =>
                          setSearch({
                            enabledCollectors: event.target.checked
                              ? [...draft.search.enabledCollectors, collector.id]
                              : draft.search.enabledCollectors.filter((id) => id !== collector.id),
                          })
                        }
                      />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
                          {collector.name}
                          {collector.requiresAuth ? (
                            <Badge variant="warning">login required</Badge>
                          ) : null}
                          {collector.requiresBoards ? (
                            <Badge variant="outline">needs boards</Badge>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          {collector.description}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </SectionShell>

          <Card>
            <CardHeader>
              <CardTitle>Boards</CardTitle>
              <CardDescription>
                Board-based collectors only crawl the companies you list here. Each source uses its
                own slug format.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {BOARD_SOURCES.map((entry) => (
                <ChipListField
                  key={entry.source}
                  label={entry.label}
                  values={draft.search.boards[entry.source] ?? []}
                  onChange={(values) =>
                    setSearch({ boards: { ...draft.search.boards, [entry.source]: values } })
                  }
                  placeholder={entry.source === 'workday' ? 'https://…myworkdayjobs.com/…' : 'slug'}
                  help={entry.help}
                />
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ------------------------------------------------------------------ */}
        {/* Applications                                                        */}
        {/* ------------------------------------------------------------------ */}
        <TabsContent value="application" className="space-y-4">
          <SectionShell
            icon={<Send />}
            title="Applications"
            description="Thresholds and limits that decide what the agent applies to on its own."
            {...sectionProps('application')}
          >
            {draft.application.autoApply ? (
              <div className="mb-4 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs text-warning">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <p>
                  Auto-apply is ON. The scheduler will queue applications without asking you first.
                  With dry run disabled on the Browser tab, those applications are really submitted.
                </p>
              </div>
            ) : null}

            <div className="space-y-3">
              <SwitchField
                label="Auto-apply"
                tone="warning"
                checked={draft.application.autoApply}
                onChange={(value) => setApplication({ autoApply: value })}
                help="Let the scheduler apply to anything above the score threshold, inside the daily caps."
              />
              <SwitchField
                label="Generate cover letter"
                checked={draft.application.generateCoverLetter}
                onChange={(value) => setApplication({ generateCoverLetter: value })}
              />
              <SwitchField
                label="Tailor resume"
                checked={draft.application.tailorResume}
                onChange={(value) => setApplication({ tailorResume: value })}
                help="Rewrites the base resume per job before uploading it."
              />
              <SwitchField
                label="Pause on unknown question"
                checked={draft.application.pauseOnUnknownQuestion}
                onChange={(value) => setApplication({ pauseOnUnknownQuestion: value })}
                help="Escalates to the Applications page instead of guessing an answer."
              />
            </div>

            <Separator className="my-5" />

            <div className="grid gap-5 md:grid-cols-2">
              <RangeField
                label="Minimum score to apply"
                value={draft.application.minScoreToApply}
                onChange={(value) => setApplication({ minScoreToApply: value })}
                help="Jobs scoring below this are never applied to automatically."
              />
              <RangeField
                label="Minimum score to tailor"
                value={draft.application.minScoreToTailor}
                onChange={(value) => setApplication({ minScoreToTailor: value })}
                help="Tailoring is expensive locally, so it is skipped for weak matches."
              />
            </div>

            <Separator className="my-5" />

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <NumberField
                label="Max applications per day"
                value={draft.application.maxApplicationsPerDay}
                onChange={(value) => setApplication({ maxApplicationsPerDay: value ?? 0 })}
                min={0}
                max={500}
              />
              <NumberField
                label="Max per company per day"
                value={draft.application.maxApplicationsPerCompanyPerDay}
                onChange={(value) =>
                  setApplication({ maxApplicationsPerCompanyPerDay: value ?? 0 })
                }
                min={0}
                max={50}
              />
              <FieldRow
                label="Default resume"
                help="Used whenever a job does not specify one."
              >
                <Select
                  value={
                    draft.application.defaultResumeId === null
                      ? ''
                      : String(draft.application.defaultResumeId)
                  }
                  onChange={(event) =>
                    setApplication({
                      defaultResumeId: event.target.value ? Number(event.target.value) : null,
                    })
                  }
                >
                  <option value="">None selected</option>
                  {resumeList.map((resume) => (
                    <option key={resume.id} value={resume.id}>
                      {resume.name} (v{resume.version})
                    </option>
                  ))}
                </Select>
              </FieldRow>
            </div>
          </SectionShell>
        </TabsContent>

        {/* ------------------------------------------------------------------ */}
        {/* Queue                                                               */}
        {/* ------------------------------------------------------------------ */}
        <TabsContent value="queue" className="space-y-4">
          <SectionShell
            icon={<ListChecks />}
            title="Queue"
            description="Worker concurrency and retry behaviour for every background task."
            {...sectionProps('queue')}
          >
            <div className="mb-4">
              <SwitchField
                label="Paused"
                tone="warning"
                checked={draft.queue.paused}
                onChange={(value) => setQueue({ paused: value })}
                help="Stops the worker from picking up new jobs. In-flight jobs finish first."
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <NumberField
                label="Concurrency"
                value={draft.queue.concurrency}
                onChange={(value) => setQueue({ concurrency: value ?? 1 })}
                min={1}
                max={32}
                help="Total jobs processed in parallel."
              />
              <NumberField
                label="Browser concurrency"
                value={draft.queue.browserConcurrency}
                onChange={(value) => setQueue({ browserConcurrency: value ?? 1 })}
                min={1}
                max={8}
                help="Parallel browser sessions. Keep low - each one is a full browser."
              />
              <NumberField
                label="Max attempts"
                value={draft.queue.maxAttempts}
                onChange={(value) => setQueue({ maxAttempts: value ?? 1 })}
                min={1}
                max={20}
              />
              <NumberField
                label="Backoff base (ms)"
                value={draft.queue.backoffBaseMs}
                onChange={(value) => setQueue({ backoffBaseMs: value ?? 5000 })}
                min={100}
                max={600000}
                step={100}
              />
              <NumberField
                label="Backoff factor"
                value={draft.queue.backoffFactor}
                onChange={(value) => setQueue({ backoffFactor: value ?? 2 })}
                min={1}
                max={10}
                step={0.1}
                help="Delay multiplies by this on every retry."
              />
              <NumberField
                label="Stalled after (ms)"
                value={draft.queue.stalledAfterMs}
                onChange={(value) => setQueue({ stalledAfterMs: value ?? 900000 })}
                min={10000}
                max={7200000}
                step={10000}
                help="An active job untouched for this long is reclaimed."
              />
              <NumberField
                label="Poll interval (ms)"
                value={draft.queue.pollIntervalMs}
                onChange={(value) => setQueue({ pollIntervalMs: value ?? 1000 })}
                min={100}
                max={60000}
                step={100}
              />
            </div>
          </SectionShell>
        </TabsContent>

        {/* ------------------------------------------------------------------ */}
        {/* Scheduler                                                           */}
        {/* ------------------------------------------------------------------ */}
        <TabsContent value="scheduler" className="space-y-4">
          <SectionShell
            icon={<Clock />}
            title="Scheduler"
            description="Recurring work run by the API process itself. No external cron needed."
            {...sectionProps('scheduler')}
          >
            <div className="mb-4">
              <SwitchField
                label="Enabled"
                checked={draft.scheduler.enabled}
                onChange={(value) => setScheduler({ enabled: value })}
                help="Turn off to run everything manually from this page."
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <NumberField
                label="Collect interval (minutes)"
                value={draft.scheduler.collectIntervalMinutes}
                onChange={(value) => setScheduler({ collectIntervalMinutes: value ?? 180 })}
                min={5}
                max={10080}
              />
              <NumberField
                label="Score interval (minutes)"
                value={draft.scheduler.scoreIntervalMinutes}
                onChange={(value) => setScheduler({ scoreIntervalMinutes: value ?? 10 })}
                min={1}
                max={1440}
              />
              <NumberField
                label="Apply interval (minutes)"
                value={draft.scheduler.applyIntervalMinutes}
                onChange={(value) => setScheduler({ applyIntervalMinutes: value ?? 60 })}
                min={5}
                max={10080}
              />
              <NumberField
                label="Cleanup interval (minutes)"
                value={draft.scheduler.cleanupIntervalMinutes}
                onChange={(value) => setScheduler({ cleanupIntervalMinutes: value ?? 1440 })}
                min={60}
                max={20160}
              />
              <NumberField
                label="Backup interval (minutes)"
                value={draft.scheduler.backupIntervalMinutes}
                onChange={(value) => setScheduler({ backupIntervalMinutes: value ?? 1440 })}
                min={60}
                max={20160}
              />
              <NumberField
                label="Retention (days)"
                value={draft.scheduler.retentionDays}
                onChange={(value) => setScheduler({ retentionDays: value ?? 90 })}
                min={1}
                max={3650}
                help="Logs, LLM calls and artifacts older than this are deleted by cleanup."
              />
              <NumberField
                label="Backups to keep"
                value={draft.scheduler.backupsToKeep}
                onChange={(value) => setScheduler({ backupsToKeep: value ?? 14 })}
                min={1}
                max={365}
              />
            </div>
          </SectionShell>

          <Card>
            <CardHeader>
              <CardTitle>Run a task now</CardTitle>
              <CardDescription>
                Queues the same work the scheduler would run on its next tick.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {SCHEDULER_TASKS.map((task) => (
                <Button
                  key={task.name}
                  variant="outline"
                  size="sm"
                  title={task.description}
                  onClick={() => runTask.mutate(task.name)}
                  disabled={runTask.isPending}
                >
                  <Play />
                  {task.label}
                </Button>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Backups</CardTitle>
                <CardDescription>
                  SQLite snapshots written to the local data directory.
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => createBackup.mutate()}
                disabled={createBackup.isPending}
              >
                <Database />
                {createBackup.isPending ? 'Backing up…' : 'Back up now'}
              </Button>
            </CardHeader>
            <CardContent>
              {backups.isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : backups.isError ? (
                <ErrorState error={backups.error} />
              ) : (backups.data?.backups ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No backups yet. Create one before changing anything risky.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {backups.data?.backups.map((backup) => (
                    <li
                      key={backup.name}
                      className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs"
                    >
                      <span className="truncate font-medium">{backup.name}</span>
                      <span className="tabular text-muted-foreground">
                        {formatBytes(backup.bytes)} · {formatDate(backup.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ------------------------------------------------------------------ */}
        {/* Pipeline                                                            */}
        {/* ------------------------------------------------------------------ */}
        <TabsContent value="pipeline" className="space-y-4">
          <SectionShell
            icon={<Workflow />}
            title="Pipeline"
            description="Which stages of the background pipeline are allowed to run at all. Local inference takes every core it can get, so each stage that calls the model can be stopped on its own."
            {...sectionProps('pipeline')}
          >
            {!draft.pipeline.enabled ? (
              <div className="mb-4 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs text-warning">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <p>
                  The pipeline is off. Nothing is claimed from the queue - no collecting, no
                  scoring, no applying - and it stays that way across restarts until you turn it
                  back on.
                </p>
              </div>
            ) : null}

            <div className="mb-4">
              <SwitchField
                label="Pipeline enabled"
                tone="warning"
                checked={draft.pipeline.enabled}
                onChange={(value) => setPipeline({ enabled: value })}
                help="The single control that stops all background work. Off means no stage claims anything from the queue, whatever the per-stage switches below say."
              />
            </div>

            <Separator className="my-5" />

            <div className="mb-3">
              <p className="text-sm font-medium">Stages</p>
              <p className="text-xs text-muted-foreground">
                Turn off whatever you cannot afford to have running. Queued work is not lost - it
                waits until the stage is enabled again.
              </p>
            </div>

            <div className="space-y-3">
              <SwitchField
                label="Collect"
                checked={draft.pipeline.collect}
                onChange={(value) => setPipeline({ collect: value })}
                help="Drives a browser over the job boards. Heavy on CPU and network, no model calls."
              />
              <SwitchField
                label="Enrich"
                checked={draft.pipeline.enrich}
                onChange={(value) => setPipeline({ enrich: value })}
                help="Calls the local model once per raw posting to pull structure out of it."
              />
              <SwitchField
                label="Score"
                checked={draft.pipeline.score}
                onChange={(value) => setPipeline({ score: value })}
                help="Calls the local model once per job to rank it against your profile. This is the stage that saturates the machine on a large backlog."
              />
              <SwitchField
                label="Tailor"
                checked={draft.pipeline.tailor}
                onChange={(value) => setPipeline({ tailor: value })}
                help="Calls the local model to rewrite the resume per job, then compiles it."
              />
              <SwitchField
                label="Cover letter"
                checked={draft.pipeline.coverLetter}
                onChange={(value) => setPipeline({ coverLetter: value })}
                help="Calls the local model to draft a letter per application."
              />
              <SwitchField
                label="Apply"
                checked={draft.pipeline.apply}
                onChange={(value) => setPipeline({ apply: value })}
                help="Drives a real browser session to fill and submit forms. No model calls, but it is the stage that talks to employers."
              />
            </div>

            <p className="mt-5 rounded-md border border-border bg-secondary/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
              These switches are the persisted defaults - they are what the pipeline comes back to
              after a restart. For live start and stop with in-flight counts per stage, use the
              controls on the{' '}
              <Link to="/" className="text-primary underline-offset-4 hover:underline">
                Overview
              </Link>{' '}
              page.
            </p>
          </SectionShell>
        </TabsContent>

        {/* ------------------------------------------------------------------ */}
        {/* VPN                                                                 */}
        {/* ------------------------------------------------------------------ */}
        <TabsContent value="vpn" className="space-y-4">
          <SectionShell
            icon={<Network />}
            title="VPN"
            description="Which country the collectors appear to browse from. Job boards are regional, so the exit country decides which index you actually search."
            {...sectionProps('vpn')}
          >
            <div className="mb-4 flex items-start gap-2 rounded-md border border-border bg-secondary/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>
                Connecting changes the routing of the <strong>whole machine</strong>, not just this
                app. Moving the exit helps with two things: reaching a country&apos;s job index, and
                spreading per-IP rate limiting. It does not defeat bot detection, which fingerprints
                far more than the address - so rotating faster is not a substitute for collecting
                slowly.
              </p>
            </div>

            <div className="mb-4 space-y-3">
              <SwitchField
                label="VPN control enabled"
                checked={draft.vpn.enabled}
                onChange={(value) => setVpn({ enabled: value })}
                help="Off means this app never touches your tunnel, whatever else is set here."
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="vpn-backend">Backend</Label>
              <Select
                id="vpn-backend"
                value={draft.vpn.backend}
                onChange={(event) =>
                  setVpn({ backend: event.target.value as Settings['vpn']['backend'] })
                }
              >
                {VPN_BACKENDS.map((value) => (
                  <option key={value} value={value}>
                    {VPN_BACKEND_LABELS[value]}
                  </option>
                ))}
              </Select>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Proton VPN drives the installed Proton packages through a bundled helper - sign in
                once with the Proton VPN app first. The others exist so an already-managed tunnel
                does not have to be replaced.
              </p>
            </div>

            <Separator className="my-5" />

            <div className="space-y-4">
              <ChipListField
                label="Exit countries"
                values={draft.vpn.countries}
                onChange={(values) =>
                  setVpn({ countries: values.map((value) => value.trim().toUpperCase()) })
                }
                placeholder="NL"
                help="Two-letter country codes, tried in this order when rotating. Leave empty to let the backend pick its own fastest server."
              />
              <ChipListField
                label="Only for these collectors"
                values={draft.vpn.collectors}
                onChange={(values) => setVpn({ collectors: values })}
                placeholder="indeed"
                help="Empty means every collector. Naming just the ones that need it avoids tunnelling traffic that was working fine."
              />
            </div>

            <Separator className="my-5" />

            <div className="space-y-3">
              <SwitchField
                label="Rotate when a platform blocks the run"
                checked={draft.vpn.rotateOnBlock}
                onChange={(value) => setVpn({ rotateOnBlock: value })}
                help="On a confirmed block or challenge, move to the next country and retry once. Never more than once per run."
              />
              <SwitchField
                label="Connect before a collector run"
                checked={draft.vpn.connectBeforeCollect}
                onChange={(value) => setVpn({ connectBeforeCollect: value })}
                help="Brings the tunnel up before collecting, rather than leaving it to you."
              />
              <SwitchField
                label="Disconnect afterwards"
                checked={draft.vpn.disconnectAfterCollect}
                onChange={(value) => setVpn({ disconnectAfterCollect: value })}
                help="Puts the rest of the machine back on its normal route once the run finishes."
              />
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <NumberField
                label="Minimum seconds between rotations"
                value={draft.vpn.minRotationSeconds}
                onChange={(value) => setVpn({ minRotationSeconds: value ?? 300 })}
                min={30}
                max={86400}
                step={30}
                help="A floor, so a run that keeps getting blocked cannot thrash the tunnel. The dashboard buttons bypass it; automatic rotation does not."
              />
              <NumberField
                label="Connect timeout (seconds)"
                value={draft.vpn.connectTimeoutSeconds}
                onChange={(value) => setVpn({ connectTimeoutSeconds: value ?? 60 })}
                min={5}
                max={300}
                step={5}
                help="How long to wait for the tunnel to report connected before giving up."
              />
            </div>

            {draft.vpn.backend === 'nmcli' ? (
              <div className="mt-4">
                <TextField
                  label="NetworkManager connection prefix"
                  value={draft.vpn.nmcliConnectionPrefix}
                  onChange={(value) => setVpn({ nmcliConnectionPrefix: value })}
                  placeholder="ProtonVPN-"
                  help="The country code is appended, so this plus NL must match a connection you already have."
                />
              </div>
            ) : null}

            {draft.vpn.backend === 'wg_quick' ? (
              <div className="mt-4">
                <TextField
                  label="wg-quick config prefix"
                  value={draft.vpn.nmcliConnectionPrefix}
                  onChange={(value) => setVpn({ nmcliConnectionPrefix: value })}
                  placeholder="proton-"
                  help="The country code is appended to name the interface. wg-quick usually needs passwordless sudo for the service user."
                />
              </div>
            ) : null}

            {draft.vpn.backend === 'command' ? (
              <div className="mt-4 space-y-4">
                <TextField
                  label="Connect command"
                  value={draft.vpn.connectCommand}
                  onChange={(value) => setVpn({ connectCommand: value })}
                  placeholder="/usr/local/bin/vpnctl connect {{country}}"
                  help="{{country}} is substituted. Executed directly, never through a shell, so pipes, && and redirects will not work."
                />
                <TextField
                  label="Disconnect command"
                  value={draft.vpn.disconnectCommand}
                  onChange={(value) => setVpn({ disconnectCommand: value })}
                  placeholder="/usr/local/bin/vpnctl disconnect"
                />
                <TextField
                  label="Status command"
                  value={draft.vpn.statusCommand}
                  onChange={(value) => setVpn({ statusCommand: value })}
                  placeholder="/usr/local/bin/vpnctl status"
                  help="Should print the current country, or nothing when disconnected."
                />
              </div>
            ) : null}

            <Separator className="my-5" />

            <div className="space-y-3">
              <SwitchField
                label="Verify the exit IP after connecting"
                tone="warning"
                checked={draft.vpn.verifyExitIp}
                onChange={(value) => setVpn({ verifyExitIp: value })}
                help="The only setting here that makes an outbound request. Off by default, because everything else in this app stays on your machine."
              />
              {draft.vpn.verifyExitIp ? (
                <TextField
                  label="Exit IP endpoint"
                  value={draft.vpn.exitIpEndpoint}
                  onChange={(value) => setVpn({ exitIpEndpoint: value })}
                  placeholder="https://api.protonvpn.ch/vpn/location"
                  help="Contacted once per connect to read back the address you now appear from. Point it anywhere you trust."
                />
              ) : null}
            </div>

            <p className="mt-5 rounded-md border border-border bg-secondary/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
              Live connect, disconnect and rotate controls - with the current country and server -
              are on the{' '}
              <Link to="/sources" className="text-primary underline-offset-4 hover:underline">
                Sources
              </Link>{' '}
              page, beside the platforms they affect.
            </p>
          </SectionShell>
        </TabsContent>

        {/* ------------------------------------------------------------------ */}
        {/* Notifications                                                       */}
        {/* ------------------------------------------------------------------ */}
        <TabsContent value="notifications" className="space-y-4">
          <SectionShell
            icon={<Bell />}
            title="Notifications"
            description="Optional pings to a service you run yourself, such as ntfy or gotify."
            {...sectionProps('notifications')}
          >
            <div className="mb-4 space-y-3">
              <SwitchField
                label="Enabled"
                checked={draft.notifications.enabled}
                onChange={(value) => setNotifications({ enabled: value })}
              />
            </div>

            <TextField
              label="Webhook URL"
              value={draft.notifications.webhookUrl}
              onChange={(value) => setNotifications({ webhookUrl: value })}
              placeholder="http://localhost:8080/topic/jobs"
              help="Must be a local endpoint - requests to the public internet are refused. Stored encrypted and shown masked."
            />

            <Separator className="my-5" />

            <div className="space-y-3">
              <SwitchField
                label="Notify on applied"
                checked={draft.notifications.notifyOnApplied}
                onChange={(value) => setNotifications({ notifyOnApplied: value })}
              />
              <SwitchField
                label="Notify on failure"
                checked={draft.notifications.notifyOnFailure}
                onChange={(value) => setNotifications({ notifyOnFailure: value })}
              />
              <SwitchField
                label="Notify when human input is needed"
                checked={draft.notifications.notifyOnNeedsHuman}
                onChange={(value) => setNotifications({ notifyOnNeedsHuman: value })}
              />
              <SwitchField
                label="Notify on high score"
                checked={draft.notifications.notifyOnHighScore}
                onChange={(value) => setNotifications({ notifyOnHighScore: value })}
              />
            </div>

            <Separator className="my-5" />

            <div className="max-w-md">
              <RangeField
                label="High score threshold"
                value={draft.notifications.highScoreThreshold}
                onChange={(value) => setNotifications({ highScoreThreshold: value })}
                help="Only jobs at or above this score trigger the high-score notification."
              />
            </div>
          </SectionShell>
        </TabsContent>

        {/* ------------------------------------------------------------------ */}
        {/* Candidate profile                                                   */}
        {/* ------------------------------------------------------------------ */}
        <TabsContent value="profile" className="space-y-4">
          <SectionShell
            icon={<User />}
            title="Candidate profile"
            description="The form-filler answers standard application questions straight from these values, with no LLM call. Anything missing here becomes a question the agent has to guess or escalate."
            {...sectionProps('profile')}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <TextField
                label="Full name"
                value={draft.profile.fullName}
                onChange={(value) => setProfile({ fullName: value })}
              />
              <TextField
                label="Email"
                type="email"
                value={draft.profile.email}
                onChange={(value) => setProfile({ email: value })}
              />
              <TextField
                label="First name"
                value={draft.profile.firstName}
                onChange={(value) => setProfile({ firstName: value })}
              />
              <TextField
                label="Last name"
                value={draft.profile.lastName}
                onChange={(value) => setProfile({ lastName: value })}
              />
              <TextField
                label="Phone"
                value={draft.profile.phone}
                onChange={(value) => setProfile({ phone: value })}
                placeholder="+1 555 0100"
              />
              <TextField
                label="City"
                value={draft.profile.city}
                onChange={(value) => setProfile({ city: value })}
              />
              <TextField
                label="State / region"
                value={draft.profile.state}
                onChange={(value) => setProfile({ state: value })}
              />
              <TextField
                label="Country"
                value={draft.profile.country}
                onChange={(value) => setProfile({ country: value })}
              />
              <TextField
                label="Postal code"
                value={draft.profile.postalCode}
                onChange={(value) => setProfile({ postalCode: value })}
              />
              <TextField
                label="LinkedIn URL"
                value={draft.profile.linkedinUrl}
                onChange={(value) => setProfile({ linkedinUrl: value })}
                placeholder="https://www.linkedin.com/in/…"
              />
              <TextField
                label="GitHub URL"
                value={draft.profile.githubUrl}
                onChange={(value) => setProfile({ githubUrl: value })}
                placeholder="https://github.com/…"
              />
              <TextField
                label="Portfolio URL"
                value={draft.profile.portfolioUrl}
                onChange={(value) => setProfile({ portfolioUrl: value })}
              />
              <NumberField
                label="Years of experience"
                value={draft.profile.yearsOfExperience}
                onChange={(value) => setProfile({ yearsOfExperience: value ?? 0 })}
                min={0}
                max={60}
                step={0.5}
              />
              <NumberField
                label="Notice period (days)"
                value={draft.profile.noticePeriodDays}
                onChange={(value) => setProfile({ noticePeriodDays: value ?? 0 })}
                min={0}
                max={365}
              />
              <NumberField
                label="Desired salary"
                value={draft.profile.desiredSalary}
                onChange={(value) => setProfile({ desiredSalary: value })}
                min={0}
                allowEmpty
                placeholder="Prefer not to say"
                help="Left empty, the agent answers salary questions with 'negotiable' where the field allows free text."
              />
            </div>

            <Separator className="my-5" />

            <div className="grid gap-3 md:grid-cols-2">
              <SwitchField
                label="Authorized to work"
                checked={draft.profile.authorizedToWork}
                onChange={(value) => setProfile({ authorizedToWork: value })}
                help="Answers the standard work-authorization question."
              />
              <SwitchField
                label="Requires sponsorship"
                checked={draft.profile.requiresSponsorship}
                onChange={(value) => setProfile({ requiresSponsorship: value })}
              />
              <SwitchField
                label="Willing to relocate"
                checked={draft.profile.willingToRelocate}
                onChange={(value) => setProfile({ willingToRelocate: value })}
              />
            </div>

            <Separator className="my-5" />

            <FieldRow
              label="Summary"
              help="Reused verbatim for 'tell us about yourself' style free-text fields, and as context when tailoring."
            >
              <Textarea
                rows={6}
                value={draft.profile.summary}
                onChange={(event) => setProfile({ summary: event.target.value })}
                placeholder="Two or three sentences describing your background and what you are looking for."
              />
            </FieldRow>
          </SectionShell>
        </TabsContent>

        {/* ------------------------------------------------------------------ */}
        {/* Mobile sync                                                         */}
        {/* ------------------------------------------------------------------ */}
        <TabsContent value="sync" className="space-y-4">
          <SectionShell
            icon={<Smartphone />}
            title="Mobile sync"
            description="The only feature in this app that talks to a machine you do not own. It mirrors a deliberately narrow slice of operational metadata to your own Supabase project so a phone can watch progress and issue commands."
            {...sectionProps('sync')}
          >
            <PrivacyDisclosure enabled={draft.sync.enabled} />

            <div className="mb-4">
              <SwitchField
                label="Enable mobile sync"
                tone="warning"
                checked={draft.sync.enabled}
                onChange={(value) => setSync({ enabled: value })}
                help="Off means nothing at all is uploaded. Turning this on is your consent to send the metadata listed above."
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <TextField
                label="Supabase URL"
                value={draft.sync.url}
                onChange={(value) => setSync({ url: value })}
                placeholder="https://your-project.supabase.co"
                help="Your own project. Point this at a self-hosted Supabase to keep everything on your network."
              />
              <TextField
                label="User id"
                value={draft.sync.userId}
                onChange={(value) => setSync({ userId: value })}
                placeholder="00000000-0000-0000-0000-000000000000"
                help="The Supabase auth user id shown on the mobile app's pairing screen. Every synced row is scoped to it by row level security."
              />
              <TextField
                label="Publishable key"
                value={draft.sync.publishableKey}
                onChange={(value) => setSync({ publishableKey: value })}
                placeholder="sb_publishable_…"
                help="Safe to share with the phone. It can only reach rows row level security allows."
              />
              <TextField
                label="Secret key"
                type="password"
                value={draft.sync.secretKey}
                onChange={(value) => setSync({ secretKey: value })}
                placeholder="sb_secret_…"
                help="Stored encrypted and shown masked. Leave the mask unchanged to keep the current value. This key never leaves this machine and is never sent to the phone."
              />
            </div>

            <Separator className="my-5" />

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <NumberField
                label="Sync interval (seconds)"
                value={draft.sync.intervalSeconds}
                onChange={(value) => setSync({ intervalSeconds: value ?? 60 })}
                min={15}
                max={3600}
                step={5}
                help="How often the outbox is drained to Supabase."
              />
              <NumberField
                label="Command poll (seconds)"
                value={draft.sync.commandPollSeconds}
                onChange={(value) => setSync({ commandPollSeconds: value ?? 20 })}
                min={5}
                max={600}
                step={5}
                help="How often this host asks whether the phone has queued a command."
              />
              <div className="md:col-span-2 xl:col-span-1">
                <RangeField
                  label="Minimum score to sync"
                  value={draft.sync.minScoreToSync}
                  onChange={(value) => setSync({ minScoreToSync: value })}
                  help="Jobs scoring below this are never uploaded. Raise it to keep the mirror small."
                />
              </div>
            </div>

            <Separator className="my-5" />

            <div className="space-y-3">
              <SwitchField
                label="Push notifications to the phone"
                checked={draft.sync.pushEnabled}
                onChange={(value) => setSync({ pushEnabled: value })}
                help="Sends the notification title, body, kind and level only. The underlying job or application documents stay here."
              />
              <SwitchField
                label="Sync jobs"
                checked={draft.sync.syncJobs}
                onChange={(value) => setSync({ syncJobs: value })}
                help="Title, company, location, source, salary range, score, recommendation and status."
              />
              <SwitchField
                label="Sync applications"
                checked={draft.sync.syncApplications}
                onChange={(value) => setSync({ syncApplications: value })}
                help="Status, current step, attempts, error message and timestamps. Never the resume, cover letter or answers."
              />
              <SwitchField
                label="Sync notifications"
                checked={draft.sync.syncNotifications}
                onChange={(value) => setSync({ syncNotifications: value })}
              />
            </div>
          </SectionShell>

          <Card>
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
              <div className="min-w-0">
                <CardTitle>Connection</CardTitle>
                <CardDescription>
                  Live state of the link. Reflects saved settings, not unsaved edits above.
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => testSync.mutate()}
                  disabled={testSync.isPending}
                >
                  <Plug />
                  {testSync.isPending ? 'Testing…' : 'Test connection'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => flushSync.mutate()}
                  disabled={flushSync.isPending}
                >
                  <CloudUpload />
                  {flushSync.isPending ? 'Syncing…' : 'Sync now'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  title="Re-queues every eligible row, not just what changed since the last sync."
                  onClick={() => fullSync.mutate()}
                  disabled={fullSync.isPending}
                >
                  <RefreshCw className={cn(fullSync.isPending && 'animate-spin')} />
                  {fullSync.isPending ? 'Resyncing…' : 'Full resync'}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {syncStatus.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : syncStatus.isError ? (
                <ErrorState error={syncStatus.error} />
              ) : syncStatus.data ? (
                <SyncStatusStrip status={syncStatus.data} />
              ) : null}

              <Separator />

              <FieldRow
                label="Pair with phone"
                help="Open the mobile app, copy the user id from its pairing screen and paste it here. Pairing stores that id locally and scopes every uploaded row to it."
              >
                <div className="flex gap-2">
                  <Input
                    value={pairInput}
                    placeholder="User id from the mobile app"
                    onChange={(event) => setPairInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      if (pairInput.trim()) pairDevice.mutate(pairInput.trim());
                    }}
                  />
                  <Button
                    size="sm"
                    onClick={() => pairDevice.mutate(pairInput.trim())}
                    disabled={pairDevice.isPending || pairInput.trim() === ''}
                  >
                    <Link2 />
                    {pairDevice.isPending ? 'Pairing…' : 'Pair'}
                  </Button>
                </div>
              </FieldRow>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Local building blocks                                                       */
/* -------------------------------------------------------------------------- */

interface SectionShellHandlers {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
}

function SectionShell({
  icon,
  title,
  description,
  dirty,
  saving,
  onSave,
  onReset,
  children,
}: SectionShellHandlers & {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="flex min-w-0 gap-3">
          <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground [&_svg]:size-4">
            {icon}
          </div>
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              {title}
              {dirty ? <Badge variant="warning">Unsaved</Badge> : null}
            </CardTitle>
            <CardDescription className="mt-1 max-w-2xl">{description}</CardDescription>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={onReset} disabled={!dirty || saving}>
            <RotateCcw />
            Reset
          </Button>
          <Button size="sm" onClick={onSave} disabled={!dirty || saving}>
            <Save />
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-2">{children}</CardContent>
    </Card>
  );
}

function FieldRow({
  label,
  help,
  htmlFor,
  children,
}: {
  label: string;
  help?: string;
  htmlFor?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {help ? <p className="text-[11px] leading-relaxed text-muted-foreground">{help}</p> : null}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  help,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  help?: string;
  placeholder?: string;
  type?: 'text' | 'password' | 'email';
}): JSX.Element {
  return (
    <FieldRow label={label} help={help}>
      <Input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </FieldRow>
  );
}

/**
 * Keeps the typed text local so an intermediate empty or partial value ("1.", "") does not get
 * coerced and written back into the draft mid-keystroke.
 */
function NumberField({
  label,
  value,
  onChange,
  help,
  placeholder,
  min,
  max,
  step,
  allowEmpty = false,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  help?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  allowEmpty?: boolean;
}): JSX.Element {
  const format = (input: number | null): string => (input === null ? '' : String(input));
  const [text, setText] = React.useState<string>(() => format(value));
  const propagated = React.useRef<number | null>(value);

  React.useEffect(() => {
    if (value !== propagated.current) {
      propagated.current = value;
      setText(format(value));
    }
  }, [value]);

  const handle = (raw: string): void => {
    setText(raw);
    if (raw.trim() === '') {
      if (allowEmpty) {
        propagated.current = null;
        onChange(null);
      }
      return;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    propagated.current = parsed;
    onChange(parsed);
  };

  return (
    <FieldRow label={label} help={help}>
      <Input
        type="number"
        inputMode="decimal"
        value={text}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(event) => handle(event.target.value)}
      />
    </FieldRow>
  );
}

function SwitchField({
  label,
  checked,
  onChange,
  help,
  tone = 'default',
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  help?: string;
  tone?: 'default' | 'warning' | 'destructive';
}): JSX.Element {
  const active =
    tone === 'destructive' ? !checked : tone === 'warning' ? checked : false;
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 rounded-md border p-3',
        active ? 'border-warning/50 bg-warning/5' : 'border-border',
      )}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {help ? (
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{help}</p>
        ) : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

function RangeField({
  label,
  value,
  onChange,
  help,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  help?: string;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <span className="tabular text-xs font-medium">{Math.round(value)}</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-[hsl(var(--primary))]"
        aria-label={label}
      />
      {help ? <p className="text-[11px] leading-relaxed text-muted-foreground">{help}</p> : null}
    </div>
  );
}

function ChipListField({
  label,
  values,
  onChange,
  placeholder,
  help,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  help?: string;
}): JSX.Element {
  const [entry, setEntry] = React.useState('');

  const add = (): void => {
    const next = entry.trim();
    if (!next || values.includes(next)) {
      setEntry('');
      return;
    }
    onChange([...values, next]);
    setEntry('');
  };

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input
          value={entry}
          placeholder={placeholder}
          onChange={(event) => setEntry(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
            if (event.key === 'Backspace' && entry === '' && values.length > 0) {
              onChange(values.slice(0, -1));
            }
          }}
        />
        <Button variant="outline" size="icon" onClick={add} title={`Add to ${label}`}>
          <Plus />
        </Button>
      </div>
      {values.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {values.map((value) => (
            <span
              key={value}
              className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground"
            >
              <span className="max-w-[16rem] truncate">{value}</span>
              <button
                type="button"
                onClick={() => onChange(values.filter((item) => item !== value))}
                className="text-muted-foreground transition-colors hover:text-destructive"
                aria-label={`Remove ${value}`}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {help ? <p className="text-[11px] leading-relaxed text-muted-foreground">{help}</p> : null}
    </div>
  );
}

function CheckboxGroup<T extends string>({
  label,
  options,
  values,
  onChange,
}: {
  label: string;
  options: readonly T[];
  values: T[];
  onChange: (values: T[]) => void;
}): JSX.Element {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="space-y-1.5">
        {options.map((option) => (
          <label
            key={option}
            className="flex cursor-pointer items-center gap-2 text-xs capitalize text-muted-foreground"
          >
            <input
              type="checkbox"
              className="size-3.5 accent-[hsl(var(--primary))]"
              checked={values.includes(option)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...values, option]
                    : values.filter((value) => value !== option),
                )
              }
            />
            {humanize(option)}
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * Informed consent, not fine print. Sync is the only outbound path in the product, so the exact
 * allowlist is shown before the switches rather than hidden behind a link.
 */
function PrivacyDisclosure({ enabled }: { enabled: boolean }): JSX.Element {
  return (
    <div
      className={cn(
        'mb-5 rounded-lg border-2 p-4',
        enabled ? 'border-warning/60 bg-warning/5' : 'border-border bg-secondary/40',
      )}
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlert className={cn('mt-0.5 size-5 shrink-0', enabled ? 'text-warning' : 'text-muted-foreground')} />
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            This is the only feature that sends data off this machine
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Supabase is cloud hosted. While sync is on, the rows below are uploaded to the project
            you configure. Everything else stays local, always. Read both lists before enabling it.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="rounded-md border border-warning/40 bg-background/60 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-warning">
            <CloudUpload className="size-3.5" />
            Leaves this machine
          </p>
          <ul className="mt-2 space-y-1">
            {SYNC_SENDS.map((item) => (
              <li key={item} className="flex gap-1.5 text-[11px] leading-relaxed">
                <span aria-hidden className="text-warning">
                  +
                </span>
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-md border border-success/40 bg-background/60 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-success">
            <ShieldCheck className="size-3.5" />
            Never leaves this machine
          </p>
          <ul className="mt-2 space-y-1">
            {SYNC_NEVER_SENDS.map((item) => (
              <li key={item} className="flex gap-1.5 text-[11px] leading-relaxed">
                <span aria-hidden className="text-success">
                  -
                </span>
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function SyncStatusStrip({ status }: { status: SyncStatus }): JSX.Element {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={status.enabled ? 'success' : 'outline'}>
          {status.enabled ? 'Sync on' : 'Sync off'}
        </Badge>
        <Badge variant={status.configured ? 'success' : 'warning'}>
          {status.configured ? 'Configured' : 'Not configured'}
        </Badge>
        <Badge variant={status.reachable ? 'success' : 'destructive'}>
          {status.reachable ? 'Reachable' : 'Unreachable'}
        </Badge>
        <Badge variant={status.paired ? 'success' : 'warning'}>
          {status.paired ? 'Paired' : 'Not paired'}
        </Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <SyncStat label="Last sync" value={relativeTime(status.lastSyncAt)} title={formatDate(status.lastSyncAt)} />
        <SyncStat
          label="Last command poll"
          value={relativeTime(status.lastCommandPollAt)}
          title={formatDate(status.lastCommandPollAt)}
        />
        <SyncStat label="Pending commands" value={formatNumber(status.pendingCommands)} />
        <SyncStat label="Synced jobs" value={formatNumber(status.syncedJobs)} />
        <SyncStat label="Synced applications" value={formatNumber(status.syncedApplications)} />
        <SyncStat label="Devices" value={formatNumber(status.devices)} />
      </div>

      {status.lastSyncError ? (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{status.lastSyncError}</span>
        </p>
      ) : null}
    </div>
  );
}

function SyncStat({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}): JSX.Element {
  return (
    <div className="rounded-md border border-border p-2.5" title={title}>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="tabular mt-0.5 truncate text-sm font-medium">{value}</p>
    </div>
  );
}

function ModelPicker({
  label,
  value,
  onChange,
  options,
  help,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { id: string; name: string; sizeBytes?: number | null }[];
  help?: string;
}): JSX.Element {
  const known = options.some((option) => option.id === value);
  return (
    <FieldRow label={label} help={help}>
      <Select value={known ? value : ''} onChange={(event) => onChange(event.target.value)}>
        <option value="">
          {options.length === 0 ? 'No models reported by the server' : 'Choose a model…'}
        </option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
            {option.sizeBytes ? ` · ${formatBytes(option.sizeBytes)}` : ''}
          </option>
        ))}
      </Select>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Or type the exact model name"
      />
    </FieldRow>
  );
}

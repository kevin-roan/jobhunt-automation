import * as React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardPaste,
  ExternalLink,
  Eye,
  KeyRound,
  Lock,
  LogIn,
  MonitorPlay,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  ScanEye,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import {
  CREDENTIAL_KINDS,
  type BrowserSessionDto,
  type CredentialKind,
  type CredentialStatus,
  type EffectiveSessionStrategy,
  type ProviderCredentialDto,
  type ProviderSessionDto,
} from '@deedy/shared';
import { api } from '@/lib/api';
import { cn, formatDate, relativeTime, truncate } from '@/lib/utils';
import { ErrorState, KeyValue, LoadingRows, PageHeader } from '@/components/common';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  Select,
  Separator,
  Textarea,
} from '@/components/ui/primitives';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Tooltip,
} from '@/components/ui/overlays';
import { useToast } from '@/components/ui/toast';

interface OpenResult {
  provider: string;
  url: string;
  loggedIn: boolean;
}

/** Sites that actively block scripted login are the reason the paste flow exists. */
const PROVIDER_PRESETS = [
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'indeed', label: 'Indeed' },
] as const;

const OTHER_PROVIDER = '__other__';

const KIND_LABELS: Record<CredentialKind, string> = {
  cookies: 'Cookies (recommended)',
  storage_state: 'Playwright storage state JSON',
  bearer_token: 'Bearer token',
  header: 'Raw request header',
};

const KIND_PLACEHOLDERS: Record<CredentialKind, string> = {
  cookies: 'li_at=AQEDAT...\n\nor paste the JSON array exported by a cookie extension',
  storage_state: '{ "cookies": [ … ], "origins": [ … ] }',
  bearer_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…',
  header: 'Cookie: li_at=AQEDAT…; JSESSIONID="ajax:123…"',
};

const STATUS_VARIANTS: Record<CredentialStatus, 'success' | 'warning' | 'destructive' | 'outline'> =
  {
    valid: 'success',
    expired: 'warning',
    invalid: 'destructive',
    unknown: 'outline',
  };

const STATUS_LABELS: Record<CredentialStatus, string> = {
  valid: 'valid',
  expired: 'expired',
  invalid: 'invalid',
  unknown: 'not verified',
};

/**
 * What the resolved strategy means for a run. Phrased as the consequence, not
 * the setting name, because the setting name is only meaningful in Settings.
 */
const STRATEGY_BADGES: Record<EffectiveSessionStrategy, string> = {
  attended: 'collectors use this window',
  stored: 'collectors use pasted sessions',
};

function isStale(credential: ProviderCredentialDto): boolean {
  if (credential.status === 'expired' || credential.status === 'invalid') return true;
  if (!credential.expiresAt) return false;
  return new Date(credential.expiresAt).getTime() <= Date.now();
}

function PathValue({ value }: { value: string | null }): JSX.Element {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <Tooltip content={<span className="break-all font-mono">{value}</span>}>
      <span className="block max-w-full truncate font-mono text-xs text-muted-foreground">
        {truncate(value, 64)}
      </span>
    </Tooltip>
  );
}

function KindInstructions({ kind }: { kind: CredentialKind }): JSX.Element {
  if (kind === 'storage_state') {
    return (
      <ol className="list-decimal space-y-1 pl-4">
        <li>
          This is the format Playwright writes with{' '}
          <code className="font-mono text-foreground">context.storageState()</code> - a JSON object
          with <code className="font-mono text-foreground">cookies</code> and{' '}
          <code className="font-mono text-foreground">origins</code> keys.
        </li>
        <li>
          Use it when a simple cookie is not enough because the site also keeps a token in local
          storage. Paste the whole JSON object below.
        </li>
      </ol>
    );
  }

  if (kind === 'bearer_token') {
    return (
      <ol className="list-decimal space-y-1 pl-4">
        <li>Open the site while logged in and press F12 to open DevTools.</li>
        <li>
          Go to the <span className="font-medium text-foreground">Network</span> tab, click any
          request the page makes, and look at its request headers.
        </li>
        <li>
          Copy the value after <code className="font-mono text-foreground">Authorization: Bearer</code>{' '}
          and paste just the token below - no quotes, no prefix.
        </li>
      </ol>
    );
  }

  if (kind === 'header') {
    return (
      <ol className="list-decimal space-y-1 pl-4">
        <li>Open the site while logged in and press F12 to open DevTools.</li>
        <li>
          Go to the <span className="font-medium text-foreground">Network</span> tab, right-click a
          request to the site and choose{' '}
          <span className="font-medium text-foreground">Copy &rsaquo; Copy request headers</span>.
        </li>
        <li>
          Paste the single header line you need below, for example the whole{' '}
          <code className="font-mono text-foreground">Cookie: …</code> line. The header name prefix
          is stripped for you, so pasting it verbatim is fine.
        </li>
      </ol>
    );
  }

  return (
    <ol className="list-decimal space-y-1 pl-4">
      <li>
        Open the site in your normal browser and make sure you are{' '}
        <span className="font-medium text-foreground">logged in</span>.
      </li>
      <li>
        Press <span className="font-medium text-foreground">F12</span> to open DevTools, then go to{' '}
        <span className="font-medium text-foreground">Application &rsaquo; Cookies</span> (in Firefox
        it is <span className="font-medium text-foreground">Storage &rsaquo; Cookies</span>) and
        click the site&rsquo;s domain in the left sidebar.
      </li>
      <li>
        Copy the cookie value and paste it below as{' '}
        <code className="font-mono text-foreground">name=value</code>. For LinkedIn the single{' '}
        <code className="font-mono text-foreground">li_at</code> cookie is usually enough, so{' '}
        <code className="font-mono text-foreground">li_at=AQEDAT…</code> on its own works.
      </li>
      <li>
        Easier alternative: install a cookie-export extension such as{' '}
        <span className="font-medium text-foreground">Cookie-Editor</span>, press{' '}
        <span className="font-medium text-foreground">Export &rsaquo; JSON</span> on the site, and
        paste the whole JSON array here.
      </li>
      <li>
        Pasting a raw{' '}
        <code className="font-mono text-foreground">Cookie: a=1; b=2</code> header string straight
        from the Network tab also works - it is parsed for you.
      </li>
    </ol>
  );
}

/**
 * Live view of the screen the attended browser is drawn on.
 *
 * On a desktop install the window is on the user's own monitor and there is
 * nothing to embed — the API returns a null URL and this never renders. In
 * Docker the window lives on a virtual screen inside the container, which is
 * served over noVNC, so it is embedded here: the user drives the real browser,
 * types their password into it, and completes any 2FA challenge, without
 * leaving the dashboard. The connection is host-local either way.
 */
function RemoteScreen({ url, running }: { url: string; running: boolean }): JSX.Element {
  // Remounting the iframe is the only reliable way to make noVNC re-handshake;
  // reaching into its document is cross-origin (different port).
  const [reloadKey, setReloadKey] = React.useState(0);
  const [expanded, setExpanded] = React.useState(false);

  // `scale` keeps the whole 1920x1080 desktop visible inside the panel rather
  // than cropping it, which matters because login dialogs centre themselves.
  const viewerUrl = React.useMemo(() => {
    const target = new URL(url, window.location.origin);
    target.searchParams.set('autoconnect', '1');
    target.searchParams.set('resize', 'scale');
    target.searchParams.set('reconnect', '1');
    return target.toString();
  }, [url]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-xs font-medium">Live screen</p>
        <Button size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Shrink' : 'Expand'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setReloadKey((value) => value + 1)}>
          <RefreshCw />
          Reconnect
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <a href={viewerUrl} target="_blank" rel="noreferrer">
            <ExternalLink />
            Open in a tab
          </a>
        </Button>
      </div>

      {running ? (
        <iframe
          key={reloadKey}
          src={viewerUrl}
          title="Attended browser screen"
          className={cn(
            'w-full rounded-md border border-border bg-black',
            expanded ? 'h-[75vh]' : 'h-[420px]',
          )}
          // The viewer needs scripts to run and a same-origin document to hold
          // its WebSocket; it is served from this host and nothing else.
          sandbox="allow-scripts allow-same-origin allow-forms"
          allow="clipboard-read; clipboard-write"
        />
      ) : (
        <div className="flex h-[180px] items-center justify-center rounded-md border border-dashed border-border text-center text-xs text-muted-foreground">
          <p className="max-w-sm px-4">
            The screen is empty until the browser is running. Press{' '}
            <span className="font-medium text-foreground">Open browser</span> above, then the window
            appears here and you can click and type in it directly.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The attended browser: one visible Chromium window on this desktop that every
 * collector reuses. Sign in by hand once and there is nothing left to paste.
 */
function AttendedBrowserPanel(): JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();

  const session = useQuery({
    queryKey: ['browser', 'session'],
    queryFn: api.browser.status,
    // Only worth polling while the window is actually up.
    refetchInterval: (query) => (query.state.data?.running ? 5000 : false),
  });

  const status = session.data;

  const applyStatus = (next: typeof status): void => {
    if (!next) return;
    queryClient.setQueryData(['browser', 'session'], next);
    void queryClient.invalidateQueries({ queryKey: ['sources'] });
    void queryClient.invalidateQueries({ queryKey: ['browser-sessions'] });
  };

  const failed = (title: string) => (error: unknown) =>
    toast.error(title, error instanceof Error ? error.message : undefined);

  const openWindow = useMutation({
    mutationFn: api.browser.open,
    onSuccess: (next) => {
      applyStatus(next);
      toast.success(
        'Browser window opened',
        'It stays open between runs - sign in to each site once and every collector reuses it.',
      );
    },
    onError: failed('Could not open the browser window'),
  });

  const closeWindow = useMutation({
    mutationFn: api.browser.close,
    onSuccess: (next) => {
      applyStatus(next);
      toast.success('Browser window closed', 'The signed-in session stays in the local profile.');
    },
    onError: failed('Could not close the browser window'),
  });

  const signIn = useMutation({
    mutationFn: (provider: string) => api.browser.signIn(provider),
    onSuccess: (next, provider) => {
      applyStatus(next);
      const entry = next.providers.find((item) => item.provider === provider);
      if (entry?.signedIn) {
        toast.success(`${entry.name} is signed in`);
      } else {
        toast.toast({
          title: 'Login tab opened',
          description: next.remoteViewUrl
            ? 'Finish the login in the Live screen below — click into it and type as you would in any browser — then press Re-check. Nothing you type is seen by this application.'
            : 'Finish the login in the window that just appeared, then press Re-check here. Nothing you type is seen by this application.',
          tone: 'info',
        });
      }
    },
    onError: failed('Could not open the login tab'),
  });

  const recheck = useMutation({
    mutationFn: (provider: string | undefined) => api.browser.check(provider),
    onSuccess: (next, provider) => {
      applyStatus(next);
      const entry = next.providers.find((item) => item.provider === provider);
      if (!entry) {
        toast.success('Session re-checked');
      } else if (entry.signedIn) {
        toast.success(`${entry.name} is signed in`, entry.note ?? undefined);
      } else {
        toast.error(
          `${entry.name} is signed out`,
          entry.note ?? 'Press Sign in and complete the login in the browser window.',
        );
      }
    },
    onError: failed('Could not check the session'),
  });

  if (session.isLoading) {
    return (
      <Card className="mb-4">
        <CardContent className="pt-5">
          <LoadingRows rows={4} cols={3} />
        </CardContent>
      </Card>
    );
  }

  if (session.isError || !status) {
    return (
      <Card className="mb-4">
        <CardContent className="pt-5">
          <ErrorState error={session.error} />
        </CardContent>
      </Card>
    );
  }

  const blocked = !status.attended || !status.displayAvailable;
  const busy = openWindow.isPending || closeWindow.isPending;
  // Resolved by the API from the strategy plus the attended switch; never
  // re-derived here, so the page cannot disagree with what a run actually does.
  const usesThisWindow = status.effectiveSessionStrategy === 'attended';

  const renderProvider = (provider: ProviderSessionDto): JSX.Element => {
    const signingIn = signIn.isPending && signIn.variables === provider.provider;
    const checking = recheck.isPending && recheck.variables === provider.provider;

    return (
      <li
        key={provider.provider}
        className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2.5"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{provider.name}</span>
            <Badge variant={provider.signedIn ? 'success' : 'outline'}>
              {provider.signedIn ? 'signed in' : 'signed out'}
            </Badge>
            {provider.requiresAuth ? null : <Badge variant="secondary">login optional</Badge>}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {provider.checkedAt ? `checked ${relativeTime(provider.checkedAt)}` : 'never checked'}
            {provider.note ? ` - ${provider.note}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant={provider.signedIn ? 'outline' : 'default'}
            disabled={blocked || signingIn}
            title={`Opens ${provider.name} in a tab of the browser window on this computer's screen so you can log in by hand. Your password is typed into that window, never into this dashboard.`}
            onClick={() => signIn.mutate(provider.provider)}
          >
            <LogIn />
            {signingIn ? 'Opening…' : 'Sign in'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={checking}
            title="Probe the site with the shared session and update the signed-in state."
            onClick={() => recheck.mutate(provider.provider)}
          >
            <ScanEye />
            {checking ? 'Checking…' : 'Re-check'}
          </Button>
        </div>
      </li>
    );
  };

  return (
    <Card className="mb-4 border-primary/40">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="mr-auto flex items-center gap-2">
            <MonitorPlay className="size-4 text-primary" />
            Attended browser
          </CardTitle>
          <Badge variant={status.running ? 'success' : 'outline'} className="gap-1">
            <span
              className={cn(
                'size-1.5 rounded-full',
                status.running ? 'bg-success' : 'bg-muted-foreground',
              )}
            />
            {status.running ? 'window open' : 'window closed'}
          </Badge>
          <Badge variant={usesThisWindow ? 'success' : 'warning'}>
            {STRATEGY_BADGES[status.effectiveSessionStrategy]}
          </Badge>
          <Badge variant="secondary">{status.engine}</Badge>
          <Badge variant="outline">
            {status.openPages === 1 ? '1 tab' : `${status.openPages} tabs`}
          </Badge>
        </div>
        <CardDescription>
          {usesThisWindow ? (
            <>
              One real Chromium window on this computer, shared by every collector. Press{' '}
              <span className="font-medium text-foreground">Open browser</span>, sign in to each
              site once in the window that appears, and every run from then on reuses that session.
              The window stays open between runs, so signing in once is all that is needed - no
              cookies to export, no tokens to paste.
            </>
          ) : (
            <>
              One real Chromium window on this computer, useful for signing in by hand or watching a
              run. Session source is set to{' '}
              <span className="font-medium text-foreground">Pasted session</span>, so collectors
              read the encrypted vault below rather than this window - signing in here does not
              change what a run sees.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!status.displayAvailable ? (
          <div className="flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <p className="text-muted-foreground">
              <span className="font-medium text-warning">
                No desktop display is available on this host.
              </span>{' '}
              {status.unavailableReason ??
                'A visible browser window cannot be opened here.'}{' '}
              Opening a window and signing in interactively are disabled - use the pasted-session
              fallback further down instead.
            </p>
          </div>
        ) : null}

        {!status.attended ? (
          <div className="flex items-start gap-2.5 rounded-md border border-border bg-secondary/40 p-3 text-xs">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-muted-foreground">
              Attended mode is switched off, so no shared window is used and these actions do
              nothing.{' '}
              {usesThisWindow
                ? 'Session source is pinned to the signed-in window, which cannot work until this is on.'
                : ''}{' '}
              Turn on{' '}
              <span className="font-medium text-foreground">Attended browser</span> in{' '}
              <Link
                to="/settings"
                className="text-primary underline-offset-4 hover:underline"
              >
                Settings &rsaquo; Browser
              </Link>{' '}
              to switch it on.
            </p>
          </div>
        ) : null}

        {usesThisWindow ? (
          <div className="flex items-start gap-2.5 rounded-md border border-primary/40 bg-primary/5 p-3 text-xs">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">
                Collectors reuse this window&apos;s session.
              </span>{' '}
              Sign in to each site here once and there is nothing to paste - the encrypted vault
              further down is not read at all, so a stale cookie in it can never replace a login you
              made by hand.
            </p>
          </div>
        ) : (
          <div className="flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <p className="text-muted-foreground">
              <span className="font-medium text-warning">
                Collectors do not use this window.
              </span>{' '}
              Runs read the pasted sessions in the vault further down, so signing in here has no
              effect on what they see. Set{' '}
              <span className="font-medium text-foreground">Session source</span> to the signed-in
              browser window in{' '}
              <Link to="/settings" className="text-primary underline-offset-4 hover:underline">
                Settings &rsaquo; Browser
              </Link>{' '}
              to make this window the session runs actually use.
            </p>
          </div>
        )}

        <dl className="grid gap-3 sm:grid-cols-2">
          <KeyValue label="Used by collectors">
            <span className="text-xs text-muted-foreground">
              {usesThisWindow ? 'this signed-in window' : 'pasted sessions from the vault'}
              {status.sessionStrategy === 'auto' ? ' (automatic)' : ''}
            </span>
          </KeyValue>
          <KeyValue label="Window">
            <span className="text-xs text-muted-foreground">
              {status.running
                ? `open with ${status.openPages === 1 ? '1 tab' : `${status.openPages} tabs`}`
                : 'closed'}
            </span>
          </KeyValue>
          <KeyValue label="Engine">
            <span className="text-xs text-muted-foreground">{status.engine}</span>
          </KeyValue>
          <div className="sm:col-span-2">
            <KeyValue label="Profile directory">
              <PathValue value={status.profilePath} />
            </KeyValue>
          </div>
        </dl>

        {status.pageUrls.length > 0 ? (
          <div className="rounded-md border border-border bg-secondary/40 p-3 text-xs">
            <p className="mb-1 font-medium">Open tabs</p>
            <ul className="space-y-0.5">
              {status.pageUrls.map((url, index) => (
                <li
                  key={`${url}-${index}`}
                  className="truncate font-mono text-[11px] text-muted-foreground"
                >
                  {truncate(url, 110)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {status.running ? (
            <Button
              variant="outline"
              disabled={busy}
              title="Closes the shared window. The signed-in session stays in the local profile directory."
              onClick={() => closeWindow.mutate()}
            >
              <PowerOff />
              {closeWindow.isPending ? 'Closing…' : 'Close browser'}
            </Button>
          ) : (
            <Button
              disabled={blocked || busy}
              title="Opens a real Chromium window on this computer's screen and keeps it open between runs."
              onClick={() => openWindow.mutate()}
            >
              <Power />
              {openWindow.isPending ? 'Opening…' : 'Open browser'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={recheck.isPending}
            onClick={() => recheck.mutate(undefined)}
            title="Re-probe every provider with the shared session."
          >
            <RefreshCw />
            Re-check all
          </Button>
        </div>

        {status.remoteViewUrl ? (
          <>
            <Separator />
            <RemoteScreen url={status.remoteViewUrl} running={status.running} />
          </>
        ) : null}

        <Separator />

        {status.providers.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No provider needs a signed-in session yet. Enable a source that requires a login and it
            will show up here.
          </p>
        ) : (
          <ul className="grid gap-2">{status.providers.map(renderProvider)}</ul>
        )}

        <div className="flex items-start gap-2.5 rounded-md border border-success/40 bg-success/10 p-3 text-xs">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
          <p className="text-muted-foreground">
            <span className="font-medium text-success">Your password never reaches this app.</span>{' '}
            You type it into the browser window yourself; this application never sees, enters or
            stores it. Only the resulting session lives on, in the local profile directory shown
            above, and it never leaves this machine.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function BrowserSessionsPage(): JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [urlByProvider, setUrlByProvider] = React.useState<Record<string, string>>({});
  const [newProvider, setNewProvider] = React.useState('');
  const [newUrl, setNewUrl] = React.useState('');
  const [lastResult, setLastResult] = React.useState<OpenResult | null>(null);

  const [providerChoice, setProviderChoice] = React.useState<string>(PROVIDER_PRESETS[0].id);
  const [customProvider, setCustomProvider] = React.useState('');
  const [pasteKind, setPasteKind] = React.useState<CredentialKind>('cookies');
  const [pasteValue, setPasteValue] = React.useState('');
  const [pasteNote, setPasteNote] = React.useState('');

  const sessions = useQuery({ queryKey: ['browser-sessions'], queryFn: api.browserSessions.list });
  const collectors = useQuery({ queryKey: ['collectors'], queryFn: api.collectors.list });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings.get });
  const credentials = useQuery({ queryKey: ['credentials'], queryFn: api.credentials.list });

  // Shares the panel's cache entry, so both halves of the page quote the same
  // resolved strategy instead of each working it out from the settings.
  const browserStatus = useQuery({ queryKey: ['browser', 'session'], queryFn: api.browser.status });
  const usesAttendedSession = browserStatus.data?.effectiveSessionStrategy === 'attended';

  const headless = settings.data?.browser.headless ?? true;
  const credentialList = credentials.data?.credentials ?? [];
  const staleCredentials = credentialList.filter(isStale);

  const pasteProvider = providerChoice === OTHER_PROVIDER ? customProvider.trim() : providerChoice;

  const openSession = useMutation({
    mutationFn: ({ provider, url }: { provider: string; url?: string }) =>
      api.browserSessions.open(provider, url),
    onSuccess: (result) => {
      setLastResult(result);
      if (result.loggedIn) {
        toast.success(`${result.provider}: signed in`, result.url);
      } else {
        toast.toast({
          title: `${result.provider}: not signed in yet`,
          description: `Ended on ${result.url}. Complete the login in the browser window, then open it again to re-check.`,
          tone: 'info',
        });
      }
      void queryClient.invalidateQueries({ queryKey: ['browser-sessions'] });
    },
    onError: (error: unknown) =>
      toast.error('Could not open the session', error instanceof Error ? error.message : undefined),
  });

  const forgetSession = useMutation({
    mutationFn: (provider: string) => api.browserSessions.remove(provider),
    onSuccess: () => {
      toast.success('Session forgotten');
      void queryClient.invalidateQueries({ queryKey: ['browser-sessions'] });
    },
    onError: (error: unknown) =>
      toast.error('Could not forget the session', error instanceof Error ? error.message : undefined),
  });

  const saveCredential = useMutation({
    mutationFn: () =>
      api.credentials.save({
        provider: pasteProvider,
        kind: pasteKind,
        value: pasteValue,
        note: pasteNote.trim() || undefined,
      }),
    onSuccess: (credential) => {
      // The secret is write-only, so clear it from the DOM as soon as it is stored.
      setPasteValue('');
      setPasteNote('');
      toast.success(
        `${credential.provider} session saved`,
        `${credential.summary} - encrypted on this machine.${
          credential.cookiesApplied > 0
            ? ` ${credential.cookiesApplied} cookies applied to the open browser context.`
            : ''
        }`,
      );
      void queryClient.invalidateQueries({ queryKey: ['credentials'] });
      void queryClient.invalidateQueries({ queryKey: ['browser-sessions'] });
    },
    onError: (error: unknown) =>
      toast.error('Could not save the session', error instanceof Error ? error.message : undefined),
  });

  const verifyCredential = useMutation({
    mutationFn: (provider: string) => api.credentials.verify(provider),
    onSuccess: (result) => {
      if (result.valid) {
        toast.success(`${result.provider} session is still valid`, result.message ?? undefined);
      } else if (result.strategy === 'attended') {
        // The check only ever judges the vault. Under the attended strategy the
        // vault is not what runs read, so a false here is "not applicable", and
        // calling it invalid would send the user off to paste a cookie nothing
        // would ever load.
        toast.toast({
          title: `${result.provider} is not vault-backed`,
          description:
            result.message ??
            'Collectors use the signed-in browser window, so this pasted session is not what runs read. Use Re-check in the Attended browser panel to test the real session.',
          tone: 'info',
        });
      } else {
        toast.error(
          `${result.provider} session is no longer valid`,
          result.message ?? 'Paste a fresh session to restore access.',
        );
      }
      void queryClient.invalidateQueries({ queryKey: ['credentials'] });
    },
    onError: (error: unknown) =>
      toast.error('Could not verify the session', error instanceof Error ? error.message : undefined),
  });

  const deleteCredential = useMutation({
    mutationFn: (provider: string) => api.credentials.remove(provider),
    onSuccess: () => {
      toast.success('Session deleted from this machine');
      void queryClient.invalidateQueries({ queryKey: ['credentials'] });
    },
    onError: (error: unknown) =>
      toast.error('Could not delete the session', error instanceof Error ? error.message : undefined),
  });

  const openList = sessions.data?.open ?? [];
  const authCollectors = (collectors.data?.collectors ?? []).filter(
    (collector) => collector.requiresAuth,
  );

  const submitNewProfile = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const provider = newProvider.trim();
    if (!provider) {
      toast.error('Enter a provider name first');
      return;
    }
    openSession.mutate(
      { provider, url: newUrl.trim() || undefined },
      {
        onSuccess: () => {
          setNewProvider('');
          setNewUrl('');
        },
      },
    );
  };

  const submitCredential = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!pasteProvider) {
      toast.error('Pick a provider first');
      return;
    }
    if (!pasteValue.trim()) {
      toast.error('Paste the session value first');
      return;
    }
    saveCredential.mutate();
  };

  const startRefresh = (provider: string): void => {
    const preset = PROVIDER_PRESETS.some((item) => item.id === provider);
    setProviderChoice(preset ? provider : OTHER_PROVIDER);
    if (!preset) setCustomProvider(provider);
    setPasteValue('');
    document.getElementById('paste-session-value')?.focus();
  };

  const renderCredentialRow = (credential: ProviderCredentialDto): JSX.Element => {
    const stale = isStale(credential);
    const verifying =
      verifyCredential.isPending && verifyCredential.variables === credential.provider;

    return (
      <TR
        key={credential.id}
        className={cn(stale && 'bg-warning/10 hover:bg-warning/15')}
      >
        <TD className="font-medium">
          <div className="flex items-center gap-1.5">
            {stale ? <AlertTriangle className="size-3.5 shrink-0 text-warning" /> : null}
            <span className="truncate">{credential.provider}</span>
          </div>
          {stale ? (
            <button
              type="button"
              onClick={() => startRefresh(credential.provider)}
              className="mt-0.5 text-[11px] text-warning underline-offset-4 hover:underline"
            >
              Paste a fresh session
            </button>
          ) : null}
        </TD>
        <TD className="text-xs text-muted-foreground">{KIND_LABELS[credential.kind]}</TD>
        <TD>
          <Badge variant={STATUS_VARIANTS[credential.status]}>
            {STATUS_LABELS[credential.status]}
          </Badge>
        </TD>
        <TD className="tabular text-xs text-muted-foreground">
          {credential.cookieCount ?? '—'}
        </TD>
        <TD className="text-xs text-muted-foreground">
          {credential.domains.length === 0 ? (
            '—'
          ) : (
            <Tooltip content={<span className="break-all">{credential.domains.join(', ')}</span>}>
              <span className="block max-w-[14rem] truncate font-mono">
                {credential.domains.join(', ')}
              </span>
            </Tooltip>
          )}
        </TD>
        <TD className={cn('text-xs', stale ? 'font-medium text-warning' : 'text-muted-foreground')}>
          {credential.expiresAt ? (
            <Tooltip content={<span>{formatDate(credential.expiresAt)}</span>}>
              <span>{relativeTime(credential.expiresAt)}</span>
            </Tooltip>
          ) : (
            'no expiry'
          )}
        </TD>
        <TD className="text-xs text-muted-foreground">
          {credential.lastUsedAt ? relativeTime(credential.lastUsedAt) : 'never'}
        </TD>
        <TD>
          <div className="flex items-center justify-end gap-1.5">
            <Button
              variant="outline"
              size="sm"
              disabled={verifying}
              onClick={() => verifyCredential.mutate(credential.provider)}
            >
              <ShieldCheck />
              {verifying ? 'Checking…' : 'Verify'}
            </Button>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="ghost" size="sm" aria-label={`Delete ${credential.provider} session`}>
                  <Trash2 />
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle className="text-base font-semibold">
                    Delete the saved {credential.provider} session?
                  </DialogTitle>
                  <DialogDescription className="text-xs text-muted-foreground">
                    The encrypted value is erased from this machine immediately. Collectors and
                    applications that rely on it will stop working until you paste a new one.
                  </DialogDescription>
                </DialogHeader>
                <div className="flex justify-end gap-2">
                  <DialogClose asChild>
                    <Button variant="ghost" size="sm">
                      Cancel
                    </Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => deleteCredential.mutate(credential.provider)}
                    >
                      Delete session
                    </Button>
                  </DialogClose>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </TD>
      </TR>
    );
  };

  const renderSession = (session: BrowserSessionDto): JSX.Element => {
    const isOpen = openList.includes(session.provider);
    const url = urlByProvider[session.provider] ?? '';
    const pending = openSession.isPending && openSession.variables?.provider === session.provider;

    return (
      <Card key={session.id}>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="mr-auto truncate">{session.provider}</CardTitle>
            {isOpen ? (
              <Badge variant="warning" className="gap-1">
                <span className="size-1.5 rounded-full bg-warning" />
                context open
              </Badge>
            ) : null}
            <Badge variant={session.loggedIn ? 'success' : 'outline'}>
              {session.loggedIn ? 'signed in' : 'signed out'}
            </Badge>
            <Badge variant="secondary">{session.engine}</Badge>
          </div>
          {session.note ? <CardDescription>{session.note}</CardDescription> : null}
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-3 sm:grid-cols-2">
            <KeyValue label="Profile path">
              <PathValue value={session.profilePath} />
            </KeyValue>
            <KeyValue label="Storage state">
              <PathValue value={session.storageStatePath} />
            </KeyValue>
            <KeyValue label="Last used">
              <span className="text-xs text-muted-foreground">
                {session.lastUsedAt ? relativeTime(session.lastUsedAt) : 'never'}
              </span>
            </KeyValue>
            <KeyValue label="Last checked">
              <span className="text-xs text-muted-foreground">
                {session.lastCheckAt ? relativeTime(session.lastCheckAt) : 'never'}
              </span>
            </KeyValue>
          </dl>

          <Separator />

          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={url}
              onChange={(event) =>
                setUrlByProvider((current) => ({
                  ...current,
                  [session.provider]: event.target.value,
                }))
              }
              placeholder="Optional URL to land on, e.g. https://…/login"
              className="min-w-[14rem] flex-1"
            />
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                openSession.mutate({ provider: session.provider, url: url.trim() || undefined })
              }
            >
              <LogIn />
              {pending ? 'Opening…' : 'Open and sign in'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => startRefresh(session.provider)}>
              <ClipboardPaste />
              Paste session
            </Button>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <Trash2 />
                  Forget
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle className="text-base font-semibold">
                    Forget the {session.provider} session?
                  </DialogTitle>
                  <DialogDescription className="text-xs text-muted-foreground">
                    This deletes the stored profile record and its saved storage state, so the next
                    run starts signed out and you will have to log in again interactively.
                  </DialogDescription>
                </DialogHeader>
                <div className="flex justify-end gap-2">
                  <DialogClose asChild>
                    <Button variant="ghost" size="sm">
                      Cancel
                    </Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => forgetSession.mutate(session.provider)}
                    >
                      Forget session
                    </Button>
                  </DialogClose>
                </div>
              </DialogContent>
            </Dialog>
          </div>

          {lastResult && lastResult.provider === session.provider ? (
            <div className="rounded-md border border-border bg-secondary/40 p-3 text-xs">
              <p className="flex items-center gap-1.5 font-medium">
                {lastResult.loggedIn ? (
                  <CheckCircle2 className="size-3.5 text-success" />
                ) : (
                  <Eye className="size-3.5 text-warning" />
                )}
                {lastResult.loggedIn ? 'Detected as signed in' : 'Still signed out'}
              </p>
              <p className="mt-1 break-all font-mono text-muted-foreground">{lastResult.url}</p>
            </div>
          ) : null}
        </CardContent>
      </Card>
    );
  };

  return (
    <div>
      <PageHeader
        title="Browser sessions"
        description="Open one real Chromium window, sign in yourself, and every collector reuses it. Everything stays on this machine."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ['browser', 'session'] });
              void queryClient.invalidateQueries({ queryKey: ['browser-sessions'] });
              void queryClient.invalidateQueries({ queryKey: ['credentials'] });
            }}
          >
            <RefreshCw />
            Refresh
          </Button>
        }
      />

      <AttendedBrowserPanel />

      {staleCredentials.length > 0 ? (
        <div
          className={cn(
            'mb-4 flex items-start gap-2.5 rounded-lg border p-3 text-xs',
            usesAttendedSession ? 'border-border bg-secondary/40' : 'border-warning/40 bg-warning/10',
          )}
        >
          <AlertTriangle
            className={cn(
              'mt-0.5 size-4 shrink-0',
              usesAttendedSession ? 'text-muted-foreground' : 'text-warning',
            )}
          />
          <p className="text-muted-foreground">
            <span
              className={cn('font-medium', usesAttendedSession ? 'text-foreground' : 'text-warning')}
            >
              {staleCredentials.length === 1
                ? '1 saved session is no longer usable'
                : `${staleCredentials.length} saved sessions are no longer usable`}
            </span>{' '}
            ({staleCredentials.map((item) => item.provider).join(', ')}).{' '}
            {usesAttendedSession
              ? 'Nothing breaks while collectors use the signed-in browser window - these pasted sessions are not read. They matter again only if you switch the session source back.'
              : 'Collectors and applications for those providers will fail until you paste a fresh session below.'}
          </p>
        </div>
      ) : null}

      <Card className="mb-4">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="mr-auto flex items-center gap-2">
              <ClipboardPaste className="size-4 text-muted-foreground" />
              Paste a session
            </CardTitle>
            <Badge variant="outline">{usesAttendedSession ? 'not in use' : 'in use'}</Badge>
          </div>
          <CardDescription>
            {usesAttendedSession ? (
              <>
                Collectors currently use the signed-in browser window above, so nothing saved here
                is read - you can leave this alone. It is the path for a host with no screen: a
                headless server, a container, or a remote install you reach over SSH. Anything
                pasted now only takes effect if{' '}
                <span className="font-medium text-foreground">Session source</span> is switched back
                to Pasted session in{' '}
                <Link to="/settings" className="text-primary underline-offset-4 hover:underline">
                  Settings &rsaquo; Browser
                </Link>
                . Nothing here ever asks for your password.
              </>
            ) : (
              <>
                This is what collectors read right now. It is the path for a host where no window
                can be opened - a headless server, a container, or a remote install you reach over
                SSH: hand over the session your own browser already holds. To stop pasting
                altogether, sign in to the window above and set{' '}
                <span className="font-medium text-foreground">Session source</span> to the signed-in
                browser window in{' '}
                <Link to="/settings" className="text-primary underline-offset-4 hover:underline">
                  Settings &rsaquo; Browser
                </Link>
                . Nothing here ever asks for your password.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
            <p className="mb-2 font-medium text-foreground">How to get it</p>
            <KindInstructions kind={pasteKind} />
          </div>

          <form onSubmit={submitCredential} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="paste-provider">Provider</Label>
                <Select
                  id="paste-provider"
                  value={providerChoice}
                  onChange={(event) => setProviderChoice(event.target.value)}
                >
                  {PROVIDER_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                  <option value={OTHER_PROVIDER}>Other…</option>
                </Select>
                {providerChoice === OTHER_PROVIDER ? (
                  <Input
                    value={customProvider}
                    onChange={(event) => setCustomProvider(event.target.value)}
                    placeholder="Collector source id, e.g. wellfound"
                    aria-label="Custom provider name"
                  />
                ) : null}
              </div>
              <div className="space-y-1">
                <Label htmlFor="paste-kind">What are you pasting?</Label>
                <Select
                  id="paste-kind"
                  value={pasteKind}
                  onChange={(event) => setPasteKind(event.target.value as CredentialKind)}
                >
                  {CREDENTIAL_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_LABELS[kind]}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="paste-session-value">Session value</Label>
              <Textarea
                id="paste-session-value"
                value={pasteValue}
                onChange={(event) => setPasteValue(event.target.value)}
                placeholder={KIND_PLACEHOLDERS[pasteKind]}
                spellCheck={false}
                autoComplete="off"
                className="min-h-[11rem] font-mono text-xs"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="paste-note">Note (optional)</Label>
              <Input
                id="paste-note"
                value={pasteNote}
                onChange={(event) => setPasteNote(event.target.value)}
                placeholder="e.g. exported from Firefox on 12 May"
                maxLength={500}
              />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={saveCredential.isPending}>
                <Lock />
                {saveCredential.isPending ? 'Encrypting…' : 'Encrypt and save'}
              </Button>
              <p className="text-xs text-muted-foreground">
                Saving replaces any session already stored for this provider.
              </p>
            </div>
          </form>

          <div className="flex items-start gap-2.5 rounded-md border border-success/40 bg-success/10 p-3 text-xs">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
            <p className="text-muted-foreground">
              <span className="font-medium text-success">This stays on your machine.</span> The
              pasted value is encrypted with{' '}
              <span className="font-medium text-foreground">AES-256-GCM</span> using the local key
              file before it touches disk, is stored only in the SQLite database on this computer,
              is <span className="font-medium text-foreground">never sent to Supabase</span> or any
              other cloud service, and is never shown again after saving - only its provider, kind,
              cookie count and expiry are ever displayed. To change it, paste a new one.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="mr-auto flex items-center gap-2">
              <KeyRound className="size-4 text-muted-foreground" />
              Saved sessions
            </CardTitle>
            {usesAttendedSession ? <Badge variant="outline">not in use</Badge> : null}
          </div>
          <CardDescription>
            Metadata only. Use Verify to replay a session against the provider and confirm it still
            works.{' '}
            {usesAttendedSession
              ? 'These statuses describe the vault alone. Collectors use the signed-in window, so a stale row here is not a broken run - to test what runs actually use, press Re-check in the Attended browser panel.'
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {credentials.isLoading ? (
            <LoadingRows rows={3} cols={5} />
          ) : credentials.isError ? (
            <ErrorState error={credentials.error} />
          ) : credentialList.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No pasted sessions yet. Providers that allow interactive login work fine without one.
            </p>
          ) : (
            <TableWrapper>
              <Table>
                <THead>
                  <TR>
                    <TH>Provider</TH>
                    <TH>Kind</TH>
                    <TH>Status</TH>
                    <TH>Cookies</TH>
                    <TH>Domains</TH>
                    <TH>Expires</TH>
                    <TH>Last used</TH>
                    <TH className="text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>{credentialList.map(renderCredentialRow)}</TBody>
              </Table>
            </TableWrapper>
          )}
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="mr-auto flex items-center gap-2">
              <ShieldCheck className="size-4 text-primary" />
              Per-provider profiles (older path)
            </CardTitle>
            {usesAttendedSession ? <Badge variant="outline">not in use</Badge> : null}
          </div>
          <CardDescription>
            {usesAttendedSession
              ? 'Inactive: collectors use the one signed-in window at the top of this page, not these per-provider profiles. Kept for installs that switch the session source back. Each provider would get its own browser profile directory on disk, holding its own cookies and local storage - no credentials are ever stored in the database and nothing is sent off this machine.'
              : 'The older per-provider path, kept for installs that do not use the attended browser. Each provider gets its own browser profile directory that lives on disk. You sign in once, the cookies and local storage stay in that profile, and every later collector or application run reuses it - no credentials are ever stored in the database and nothing is sent off this machine.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p>
            To sign in interactively you need a visible browser window, so turn{' '}
            <span className="font-medium text-foreground">headless mode off</span> in{' '}
            <Link to="/settings" className="text-primary underline-offset-4 hover:underline">
              Settings
            </Link>{' '}
            before pressing &ldquo;Open and sign in&rdquo;. Finish the login in the window that
            appears, close it, then open the session again to confirm the signed-in state.
          </p>
          {settings.data ? (
            <p
              className={
                headless
                  ? 'flex items-center gap-1.5 text-warning'
                  : 'flex items-center gap-1.5 text-success'
              }
            >
              <MonitorPlay className="size-3.5" />
              {headless
                ? 'Headless mode is currently ON - sign-in windows will not be visible.'
                : 'Headless mode is currently OFF - sign-in windows will be visible.'}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
            Collectors that need a signed-in session
          </CardTitle>
          <CardDescription>
            These sources will not return results until their provider profile is authenticated.{' '}
            {usesAttendedSession
              ? 'They are signed in from the browser window at the top of this page; pasted sessions are ignored.'
              : 'They are signed in from the pasted session saved for each provider.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {collectors.isLoading ? (
            <LoadingRows rows={2} cols={3} />
          ) : collectors.isError ? (
            <ErrorState error={collectors.error} />
          ) : authCollectors.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              None of your configured collectors require authentication.
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {authCollectors.map((collector) => {
                const session = sessions.data?.sessions.find(
                  (item) => item.provider === collector.source,
                );
                const credential = credentialList.find(
                  (item) => item.provider === collector.source,
                );
                const pasted = credential !== undefined && !isStale(credential);
                return (
                  <li
                    key={collector.id}
                    className="flex items-start gap-2 rounded-md border border-border p-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{collector.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {collector.description}
                      </p>
                    </div>
                    {credential && !usesAttendedSession ? (
                      <Badge variant={STATUS_VARIANTS[credential.status]}>
                        {pasted ? 'session pasted' : `session ${STATUS_LABELS[credential.status]}`}
                      </Badge>
                    ) : null}
                    <Badge
                      variant={
                        session?.loggedIn ? 'success' : session ? 'warning' : 'outline'
                      }
                    >
                      {session?.loggedIn ? 'signed in' : session ? 'signed out' : 'no profile'}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plus className="size-4 text-muted-foreground" />
            Open a new provider profile
          </CardTitle>
          <CardDescription>
            Use the collector source id as the provider name so runs pick the profile up
            automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submitNewProfile} className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]">
            <div className="space-y-1">
              <Label htmlFor="new-provider">Provider</Label>
              <Input
                id="new-provider"
                value={newProvider}
                onChange={(event) => setNewProvider(event.target.value)}
                placeholder="linkedin"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-url">Start URL (optional)</Label>
              <Input
                id="new-url"
                value={newUrl}
                onChange={(event) => setNewUrl(event.target.value)}
                placeholder="https://www.linkedin.com/login"
              />
            </div>
            <div className="flex items-end">
              <Button type="submit" disabled={openSession.isPending} className="w-full sm:w-auto">
                <LogIn />
                Open browser
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {sessions.isError ? <ErrorState error={sessions.error} /> : null}

      {sessions.isLoading ? (
        <LoadingRows rows={4} cols={3} />
      ) : sessions.data && sessions.data.sessions.length === 0 ? (
        <EmptyState
          icon={<KeyRound />}
          title="No browser profiles yet"
          description="Open a provider profile above to create one. The profile directory is created on first launch and reused from then on."
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {sessions.data?.sessions.map(renderSession)}
        </div>
      )}
    </div>
  );
}

import * as React from 'react';
import { api, ApiError, getApiToken, onUnauthorized, setApiToken } from '@/lib/api';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@/components/ui/primitives';

/**
 * `checking` is the state that matters: the app must not render its pages
 * before the token is known good, because every one of them fires queries on
 * mount and would flood the server with 401s and the user with error toasts.
 */
type GateState = 'checking' | 'locked' | 'open';

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 401 ? 'That token was rejected.' : error.message;
  }
  return error instanceof Error ? error.message : 'Could not reach the server.';
}

/**
 * Stands in front of the dashboard until a valid API token is stored.
 *
 * Deliberately not a login: there is no account, no password and no session —
 * one self-hosted instance, one secret, printed in the server's startup log and
 * written to DATA_DIR. This screen exists only to move that secret from the
 * user's terminal into their browser's `localStorage`.
 */
export function AuthGate({ children }: { children: React.ReactNode }): JSX.Element {
  const [state, setState] = React.useState<GateState>('checking');
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const verifyStored = React.useCallback(async (): Promise<void> => {
    try {
      const status = await api.auth.status();
      if (!status.authRequired) {
        setState('open');
        return;
      }
      if (getApiToken() === null) {
        setState('locked');
        return;
      }
      // A stored token can be stale — the user may have regenerated it by
      // deleting the file, or moved to a different instance on the same port.
      await api.auth.check();
      setState('open');
    } catch (cause) {
      setError(messageOf(cause));
      setState('locked');
    }
  }, []);

  React.useEffect(() => {
    void verifyStored();
  }, [verifyStored]);

  // Any request anywhere in the app that comes back 401 drops the stored token;
  // this is how the gate learns about it and takes the screen back.
  React.useEffect(
    () =>
      onUnauthorized(() => {
        setError('Your token is no longer valid.');
        setState('locked');
      }),
    [],
  );

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const candidate = value.trim();
    if (candidate.length === 0) return;

    setSubmitting(true);
    setError(null);
    // Store first, then verify: `api.auth.check` is gated, so a 200 from it is
    // the proof. A 401 clears the token again on its way through `request`.
    setApiToken(candidate);
    try {
      await api.auth.check();
      setValue('');
      setState('open');
    } catch (cause) {
      setApiToken(null);
      setError(messageOf(cause));
    } finally {
      setSubmitting(false);
    }
  };

  if (state === 'open') return <>{children}</>;

  if (state === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Checking access…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-base">Unlock this instance</CardTitle>
          <CardDescription>
            This dashboard holds your resume, contact details and application history. It needs the
            API token before it will show any of it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={(event) => void submit(event)}>
            <div className="space-y-1.5">
              <Label htmlFor="api-token">API token</Label>
              <Input
                id="api-token"
                type="password"
                autoFocus
                autoComplete="current-password"
                spellCheck={false}
                placeholder="Paste the token from the server log"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </div>

            {error !== null && <p className="text-xs text-destructive">{error}</p>}

            <Button type="submit" className="w-full" disabled={submitting || value.trim() === ''}>
              {submitting ? 'Verifying…' : 'Unlock'}
            </Button>

            <div className="space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
              <p>Where to find it:</p>
              <p>
                In the startup log, on the line beginning <code>API token:</code> — with Docker,{' '}
                <code>docker compose logs app | grep &quot;API token&quot;</code>.
              </p>
              <p>
                Or read the file it is stored in: <code>$DATA_DIR/.api-token</code> (
                <code>/data/.api-token</code> inside the container).
              </p>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

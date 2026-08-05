import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Network, Power, RefreshCw, TriangleAlert } from 'lucide-react';
import type { VpnStatusDto } from '@deedy/shared';
import { api } from '@/lib/api';
import { cn, relativeTime } from '@/lib/utils';
import { ErrorState } from '@/components/common';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  Skeleton,
} from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';

const VPN_KEY = ['vpn'] as const;

/** `NL` -> `Netherlands (NL)`, falling back to the bare code for a backend that returns none. */
function countryLabel(status: VpnStatusDto | undefined, code: string | null): string {
  if (!code) return 'unknown';
  const match = status?.countries.find((entry) => entry.code === code);
  return match ? `${match.name} (${match.code})` : code;
}

/**
 * Live exit-location control, mounted beside the sources it affects.
 *
 * Deliberately blunt about what this does and does not buy: it changes which
 * regional job index the collectors reach and which address the platform's rate
 * limiter sees. It does not make a blocked scraper welcome, and the cooldown on
 * automatic rotation is there on purpose.
 */
export function VpnControls({ className }: { className?: string }): JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [country, setCountry] = React.useState('');

  const status = useQuery({
    queryKey: VPN_KEY,
    queryFn: api.vpn.status,
    refetchInterval: 10000,
    placeholderData: (previous) => previous,
  });

  /** Every mutation returns the fresh status, so the cache is written rather than refetched. */
  const applied = (next: VpnStatusDto): void => {
    queryClient.setQueryData(VPN_KEY, next);
    // A different exit can change what a source is able to reach at all.
    void queryClient.invalidateQueries({ queryKey: ['sources'] });
  };

  const connect = useMutation({
    mutationFn: () => api.vpn.connect(country || undefined),
    onSuccess: (next) => {
      applied(next);
      toast.success(
        next.connected ? `Connected via ${countryLabel(next, next.country)}` : 'Tunnel did not come up',
        next.lastError ?? undefined,
      );
    },
    onError: (error: unknown) =>
      toast.error('Could not connect', error instanceof Error ? error.message : undefined),
  });

  const disconnect = useMutation({
    mutationFn: () => api.vpn.disconnect(),
    onSuccess: (next) => {
      applied(next);
      toast.success('Disconnected', 'The machine is back on its normal route.');
    },
    onError: (error: unknown) =>
      toast.error('Could not disconnect', error instanceof Error ? error.message : undefined),
  });

  const rotate = useMutation({
    mutationFn: () => api.vpn.rotate(),
    onSuccess: (next) => {
      applied(next);
      toast.success(`Rotated to ${countryLabel(next, next.country)}`);
    },
    onError: (error: unknown) =>
      toast.error('Could not rotate', error instanceof Error ? error.message : undefined),
  });

  const data = status.data;
  const busy = connect.isPending || disconnect.isPending || rotate.isPending;
  const usable = Boolean(data?.enabled && data.available);

  if (status.isLoading && !data) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>Exit location</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-9 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="flex items-center gap-2">
            <Network className="size-4" />
            Exit location
          </CardTitle>
          {data ? (
            <Badge variant={data.connected ? 'success' : 'outline'} className="gap-1.5">
              <span className="size-1.5 rounded-full bg-current" />
              {data.connected ? 'connected' : 'direct'}
            </Badge>
          ) : null}
          {data?.connected ? (
            <Badge variant="outline" className="gap-1">
              <Globe className="size-3" />
              {countryLabel(data, data.country)}
            </Badge>
          ) : null}
        </div>
        <CardDescription>
          Which country the collectors appear to browse from. Job boards are regional, so this
          decides which index they search.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {status.isError ? <ErrorState error={status.error} /> : null}

        {data && !data.available ? (
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <p>{data.unavailableReason ?? 'The configured VPN backend is not usable on this host.'}</p>
          </div>
        ) : null}

        {data?.lastError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            {data.lastError}
          </div>
        ) : null}

        {data?.connected ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Server</dt>
            <dd className="truncate text-right">{data.serverName ?? '—'}</dd>
            {data.exitIp ? (
              <>
                <dt className="text-muted-foreground">Exit IP</dt>
                <dd className="tabular truncate text-right">{data.exitIp}</dd>
              </>
            ) : null}
            {data.lastRotatedAt ? (
              <>
                <dt className="text-muted-foreground">Last change</dt>
                <dd className="truncate text-right">{relativeTime(data.lastRotatedAt)}</dd>
              </>
            ) : null}
          </dl>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={country}
            disabled={!usable || busy}
            onChange={(event) => setCountry(event.target.value)}
            className="w-auto min-w-[13rem] flex-1"
            aria-label="Exit country"
          >
            <option value="">Backend&apos;s choice</option>
            {(data?.countries ?? []).map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.name} ({entry.code}){entry.servers > 0 ? ` · ${entry.servers} servers` : ''}
              </option>
            ))}
          </Select>

          <Button size="sm" disabled={!usable || busy} onClick={() => connect.mutate()}>
            <Power />
            {connect.isPending ? 'Bringing up…' : 'Connect'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!usable || busy || !data?.connected}
            onClick={() => disconnect.mutate()}
          >
            {disconnect.isPending ? 'Dropping…' : 'Disconnect'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!usable || busy || (data?.rotation.length ?? 0) === 0}
            title={
              data && data.rotation.length > 0
                ? `Rotation order: ${data.rotation.join(' → ')}`
                : 'Add exit countries under Settings → VPN to rotate'
            }
            onClick={() => rotate.mutate()}
          >
            <RefreshCw className={cn(rotate.isPending && 'animate-spin')} />
            {rotate.isPending ? 'Rotating…' : 'Rotate'}
          </Button>
        </div>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Connecting reroutes the whole machine, not just this app. Moving the exit reaches a
          country&apos;s job index and spreads per-IP rate limiting — it does not defeat bot
          detection, so a blocked source usually needs a saved session rather than another country.
        </p>
      </CardContent>
    </Card>
  );
}

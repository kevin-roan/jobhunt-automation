/**
 * The outbound control channel.
 *
 * The phone cannot reach the host: there is no inbound port, tunnel or public
 * hostname, by design. So an action is not an API call, it is a row inserted
 * into `commands`. The host polls that table, claims the row, runs the work and
 * writes the result back. Two consequences the UI must respect:
 *   1. Success here means "queued", not "done". Surface that wording.
 *   2. If the machine is asleep the row stays `pending` indefinitely. That is
 *      the expected state, not an error.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { supabase } from './supabase';
import { queryKeys, SupabaseQueryError } from './queries';
import type { ApplicationStatus, CommandRow, CommandStatus, RemoteCommand } from './types';

/** What the caller hands to the mutation. `user_id` and defaults are added here. */
export interface SendCommandInput {
  kind: RemoteCommand;
  payload: Record<string, unknown>;
}

const TERMINAL_STATUSES: readonly CommandStatus[] = ['succeeded', 'failed'];

export function isTerminalCommand(status: CommandStatus | undefined): boolean {
  return status !== undefined && TERMINAL_STATUSES.includes(status);
}

/** Copy for the pending states, so a queued command never reads as a hang. */
export function describeCommandStatus(status: CommandStatus | undefined): string {
  switch (status) {
    case 'pending':
      return 'Queued - your machine will pick this up';
    case 'claimed':
      return 'Running on your machine';
    case 'succeeded':
      return 'Done';
    case 'failed':
      return 'Failed on your machine';
    default:
      return 'Sending';
  }
}

/* -------------------------------------------------------------------------- */
/* Typed builders                                                             */
/* -------------------------------------------------------------------------- */
// Payload keys are camelCase and are the contract with the host's command
// handler. Nothing here carries a document, a credential or any PII: an id, an
// enum value or a boolean is always enough for the host to look the rest up in
// its own local database.

export function retryApplication(applicationId: number): SendCommandInput {
  return { kind: 'application.retry', payload: { applicationId } };
}

export function setApplicationStatus(
  applicationId: number,
  status: ApplicationStatus,
): SendCommandInput {
  return { kind: 'application.set_status', payload: { applicationId, status } };
}

export function scoreJob(jobId: number): SendCommandInput {
  return { kind: 'job.score', payload: { jobId } };
}

export function archiveJob(jobId: number): SendCommandInput {
  return { kind: 'job.archive', payload: { jobId } };
}

export function runCollector(collectorId: string): SendCommandInput {
  return { kind: 'collector.run', payload: { collectorId } };
}

export function retryFailedQueue(): SendCommandInput {
  return { kind: 'queue.retry_failed', payload: {} };
}

export function pauseQueue(paused: boolean): SendCommandInput {
  return { kind: 'queue.pause', payload: { paused } };
}

export function requestFullSync(): SendCommandInput {
  return { kind: 'sync.full', payload: {} };
}

/* -------------------------------------------------------------------------- */
/* Sending                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The insert policy is `with check (user_id = auth.uid())` and the column has
 * no default, so the row has to carry the id explicitly - the session is the
 * only place to get it.
 */
async function currentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw new Error(error.message);
  const id = data.user?.id;
  if (!id) throw new Error('Not signed in');
  return id;
}

export function useSendCommand(): UseMutationResult<CommandRow, Error, SendCommandInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SendCommandInput): Promise<CommandRow> => {
      const userId = await currentUserId();
      const { data, error } = await supabase
        .from('commands')
        .insert({ user_id: userId, kind: input.kind, payload: input.payload })
        .select('*')
        .single();
      if (error) throw new SupabaseQueryError(error.message, error.code, error.details);
      return data as CommandRow;
    },
    onSuccess: (row: CommandRow) => {
      // Seed the cache so useCommandStatus renders "queued" on the first frame
      // instead of a spinner while its first poll is in flight.
      queryClient.setQueryData(queryKeys.commands.detail(row.id), row);
    },
  });
}

/**
 * Polled rather than realtime: `commands` is deliberately outside the realtime
 * publication (the phone writes it, the host consumes it), and a command is
 * short lived enough that a 2s poll is cheaper than a subscription.
 */
export function useCommandStatus(id: string | null): UseQueryResult<CommandRow | null, Error> {
  return useQuery({
    queryKey: queryKeys.commands.detail(id ?? ''),
    queryFn: async (): Promise<CommandRow | null> => {
      if (id === null) return null;
      const { data, error } = await supabase
        .from('commands')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new SupabaseQueryError(error.message, error.code, error.details);
      return (data ?? null) as CommandRow | null;
    },
    enabled: id !== null,
    refetchInterval: (query) => (isTerminalCommand(query.state.data?.status) ? false : 2_000),
    // No point burning battery polling a command while the app is backgrounded;
    // the result is refetched on focus anyway.
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}

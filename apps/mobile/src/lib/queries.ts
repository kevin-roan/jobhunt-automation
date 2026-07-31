/**
 * React Query hooks over the Supabase mirror.
 *
 * Every read here goes straight to Supabase; the app never reaches the local
 * server, which is what lets the host stay behind a firewall with no inbound
 * port. Row filtering by user is done by RLS (user_id = auth.uid()), so no
 * query below repeats a `.eq('user_id', ...)` - it would be dead weight and a
 * second place to get wrong.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { PostgrestError } from '@supabase/supabase-js';

import { supabase } from './supabase';
import type {
  ApplicationRow,
  ApplicationStatus,
  JobRow,
  JobStatus,
  NotificationRow,
  QueueStatsRow,
} from './types';

/** Rows per page for every infinite list. Small enough to feel instant on cellular. */
export const PAGE_SIZE = 25;

export class SupabaseQueryError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: string | null,
  ) {
    super(message);
    this.name = 'SupabaseQueryError';
  }
}

/* -------------------------------------------------------------------------- */
/* Result unwrapping                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Accepts the raw PostgREST envelope as `unknown` data on purpose: it makes the
 * helpers work whether or not the shared client is created with a generated
 * `Database` generic, and keeps the cast to a row type in exactly one place.
 */
interface RowsResult {
  data: unknown;
  error: PostgrestError | null;
}

interface CountResult {
  count: number | null;
  error: PostgrestError | null;
}

function fail(error: PostgrestError): never {
  throw new SupabaseQueryError(error.message, error.code, error.details);
}

function unwrapRows<T>(result: RowsResult): T[] {
  if (result.error) fail(result.error);
  return (result.data ?? []) as T[];
}

function unwrapMaybe<T>(result: RowsResult): T | null {
  if (result.error) fail(result.error);
  return (result.data ?? null) as T | null;
}

function unwrapCount(result: CountResult): number {
  if (result.error) fail(result.error);
  return result.count ?? 0;
}

/** PostgREST `range` is inclusive on both ends. */
function pageRange(page: number): [number, number] {
  const from = page * PAGE_SIZE;
  return [from, from + PAGE_SIZE - 1];
}

function nextPageParam<T>(lastPage: T[], allPages: T[][]): number | undefined {
  return lastPage.length < PAGE_SIZE ? undefined : allPages.length;
}

/**
 * PostgREST parses `or=(...)` as a comma separated list, so a comma, paren or
 * backslash in user input would change the meaning of the filter rather than
 * being matched. Wildcards are ours to add, not the user's.
 */
function sanitizeSearch(search: string): string {
  return search.replace(/[,()\\%*"']/g, ' ').trim();
}

/** Flattens an infinite query into a single array for a FlatList. */
export function flattenPages<T>(data: InfiniteData<T[], number> | undefined): T[] {
  return data ? data.pages.flat() : [];
}

/* -------------------------------------------------------------------------- */
/* Query keys                                                                 */
/* -------------------------------------------------------------------------- */

export interface JobFilters {
  search?: string;
  status?: JobStatus | 'all';
  minScore?: number;
}

export interface ApplicationFilters {
  status?: ApplicationStatus | 'all';
}

export interface NotificationFilters {
  unreadOnly?: boolean;
}

/**
 * Hierarchical so that realtime.ts can invalidate a whole table with the `all`
 * prefix without knowing which filters any screen currently has mounted.
 */
export const queryKeys = {
  overview: () => ['overview'] as const,
  jobs: {
    all: ['jobs'] as const,
    list: (filters: JobFilters) => ['jobs', 'list', filters] as const,
    detail: (id: number) => ['jobs', 'detail', id] as const,
  },
  applications: {
    all: ['applications'] as const,
    list: (filters: ApplicationFilters) => ['applications', 'list', filters] as const,
    detail: (id: number) => ['applications', 'detail', id] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    list: (filters: NotificationFilters) => ['notifications', 'list', filters] as const,
    unreadCount: ['notifications', 'unread-count'] as const,
  },
  commands: {
    all: ['commands'] as const,
    detail: (id: string) => ['commands', 'detail', id] as const,
  },
} as const;

/* -------------------------------------------------------------------------- */
/* Overview                                                                   */
/* -------------------------------------------------------------------------- */

export interface OverviewCounts {
  /** Null until the host has pushed its first queue snapshot. */
  queue: QueueStatsRow | null;
  jobs: {
    total: number;
    recommended: number;
    applied: number;
  };
  applications: {
    total: number;
    inFlight: number;
    submitted: number;
    failed: number;
    needsHuman: number;
  };
  unreadNotifications: number;
}

async function fetchOverview(): Promise<OverviewCounts> {
  // head:true asks PostgREST for the count header and no rows, so these are
  // cheap enough to run as a fan-out on a phone connection.
  const [
    queue,
    jobsTotal,
    jobsRecommended,
    jobsApplied,
    applicationsTotal,
    applicationsInFlight,
    applicationsSubmitted,
    applicationsFailed,
    applicationsNeedsHuman,
    unread,
  ] = await Promise.all([
    supabase.from('queue_stats').select('*').maybeSingle(),
    supabase.from('jobs').select('id', { count: 'exact', head: true }),
    supabase
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('recommendation', 'apply')
      .in('status', ['new', 'scored', 'queued']),
    supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('status', 'applied'),
    supabase.from('applications').select('id', { count: 'exact', head: true }),
    supabase
      .from('applications')
      .select('id', { count: 'exact', head: true })
      .in('status', ['pending', 'in_progress']),
    supabase
      .from('applications')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'submitted'),
    supabase
      .from('applications')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'failed'),
    supabase
      .from('applications')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'needs_human'),
    supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('read', false),
  ]);

  return {
    queue: unwrapMaybe<QueueStatsRow>(queue),
    jobs: {
      total: unwrapCount(jobsTotal),
      recommended: unwrapCount(jobsRecommended),
      applied: unwrapCount(jobsApplied),
    },
    applications: {
      total: unwrapCount(applicationsTotal),
      inFlight: unwrapCount(applicationsInFlight),
      submitted: unwrapCount(applicationsSubmitted),
      failed: unwrapCount(applicationsFailed),
      needsHuman: unwrapCount(applicationsNeedsHuman),
    },
    unreadNotifications: unwrapCount(unread),
  };
}

export function useOverview(): UseQueryResult<OverviewCounts, Error> {
  return useQuery({
    queryKey: queryKeys.overview(),
    queryFn: fetchOverview,
    staleTime: 15_000,
    // Realtime drives most updates; this is the floor for a phone that missed
    // a websocket event while backgrounded.
    refetchInterval: 60_000,
  });
}

/* -------------------------------------------------------------------------- */
/* Jobs                                                                       */
/* -------------------------------------------------------------------------- */

async function fetchJobs(filters: JobFilters, page: number): Promise<JobRow[]> {
  const [from, to] = pageRange(page);
  // Filters are applied before the transforms because only the filter builder
  // exposes eq/or/gte; ordering and range come last and close the chain.
  let query = supabase.from('jobs').select('*');

  const term = sanitizeSearch(filters.search ?? '');
  if (term.length > 0) {
    query = query.or(`title.ilike.%${term}%,company.ilike.%${term}%`);
  }
  if (filters.status && filters.status !== 'all') {
    query = query.eq('status', filters.status);
  }
  if (typeof filters.minScore === 'number') {
    query = query.gte('score', filters.minScore);
  }

  return unwrapRows<JobRow>(
    await query
      // id is the tiebreaker: without a total order, range pagination can repeat
      // or skip rows when several jobs share an updated_at.
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to),
  );
}

export function useJobs(
  filters: JobFilters = {},
): UseInfiniteQueryResult<InfiniteData<JobRow[], number>, Error> {
  return useInfiniteQuery({
    queryKey: queryKeys.jobs.list(filters),
    queryFn: ({ pageParam }) => fetchJobs(filters, pageParam),
    initialPageParam: 0,
    getNextPageParam: nextPageParam<JobRow>,
    staleTime: 15_000,
  });
}

export function useJob(id: number | null): UseQueryResult<JobRow | null, Error> {
  return useQuery({
    queryKey: queryKeys.jobs.detail(id ?? 0),
    queryFn: async () => {
      if (id === null) return null;
      return unwrapMaybe<JobRow>(
        await supabase.from('jobs').select('*').eq('id', id).maybeSingle(),
      );
    },
    enabled: id !== null,
    staleTime: 15_000,
  });
}

/* -------------------------------------------------------------------------- */
/* Applications                                                               */
/* -------------------------------------------------------------------------- */

async function fetchApplications(
  filters: ApplicationFilters,
  page: number,
): Promise<ApplicationRow[]> {
  const [from, to] = pageRange(page);
  let query = supabase.from('applications').select('*');

  if (filters.status && filters.status !== 'all') {
    query = query.eq('status', filters.status);
  }

  return unwrapRows<ApplicationRow>(
    await query
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to),
  );
}

export function useApplications(
  filters: ApplicationFilters = {},
): UseInfiniteQueryResult<InfiniteData<ApplicationRow[], number>, Error> {
  return useInfiniteQuery({
    queryKey: queryKeys.applications.list(filters),
    queryFn: ({ pageParam }) => fetchApplications(filters, pageParam),
    initialPageParam: 0,
    getNextPageParam: nextPageParam<ApplicationRow>,
    staleTime: 10_000,
  });
}

export function useApplication(id: number | null): UseQueryResult<ApplicationRow | null, Error> {
  return useQuery({
    queryKey: queryKeys.applications.detail(id ?? 0),
    queryFn: async () => {
      if (id === null) return null;
      return unwrapMaybe<ApplicationRow>(
        await supabase.from('applications').select('*').eq('id', id).maybeSingle(),
      );
    },
    enabled: id !== null,
    staleTime: 10_000,
  });
}

/* -------------------------------------------------------------------------- */
/* Notifications                                                              */
/* -------------------------------------------------------------------------- */

async function fetchNotifications(
  filters: NotificationFilters,
  page: number,
): Promise<NotificationRow[]> {
  const [from, to] = pageRange(page);
  let query = supabase.from('notifications').select('*');

  if (filters.unreadOnly) {
    query = query.eq('read', false);
  }

  return unwrapRows<NotificationRow>(
    await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to),
  );
}

export function useNotifications(
  filters: NotificationFilters = {},
): UseInfiniteQueryResult<InfiniteData<NotificationRow[], number>, Error> {
  return useInfiniteQuery({
    queryKey: queryKeys.notifications.list(filters),
    queryFn: ({ pageParam }) => fetchNotifications(filters, pageParam),
    initialPageParam: 0,
    getNextPageParam: nextPageParam<NotificationRow>,
    staleTime: 10_000,
  });
}

export function useUnreadCount(): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: queryKeys.notifications.unreadCount,
    queryFn: async () =>
      unwrapCount(
        await supabase
          .from('notifications')
          .select('id', { count: 'exact', head: true })
          .eq('read', false),
      ),
    staleTime: 10_000,
  });
}

/**
 * Marking read is a direct update rather than a command: it is the one piece of
 * state the phone owns, it changes nothing on the host's side of the pipeline,
 * and a tab badge that waits for a round trip through the machine feels broken.
 */
export function useMarkRead(): UseMutationResult<number, Error, number> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const { error } = await supabase.from('notifications').update({ read: true }).eq('id', id);
      if (error) fail(error);
      return id;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview() });
    },
  });
}

export function useMarkAllRead(): UseMutationResult<void, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      // RLS confines this to the signed-in user, so `read = false` is the only
      // filter needed - and PostgREST refuses an unfiltered update anyway.
      const { error } = await supabase
        .from('notifications')
        .update({ read: true })
        .eq('read', false);
      if (error) fail(error);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview() });
    },
  });
}

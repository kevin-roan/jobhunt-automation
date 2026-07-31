/**
 * Keeps the react-query cache honest by listening to postgres_changes on the
 * four mirrored tables and invalidating the matching keys.
 *
 * It invalidates rather than patching the cache with the payload: the row that
 * arrives over the websocket is only the columns Supabase replicates, and a
 * filtered/paginated list cannot be spliced correctly without re-running its
 * predicate anyway. A refetch of a page of 25 rows is cheap; a subtly wrong
 * list is not.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { RealtimeChannel } from '@supabase/supabase-js';

import { supabase } from './supabase';
import { queryKeys } from './queries';

type InvalidationTarget = 'jobs' | 'applications' | 'notifications' | 'overview';

/**
 * Each target invalidates several key prefixes because the list screens and the
 * detail screens namespace themselves differently: a list is keyed on the plural
 * table name, a detail screen on the singular one plus its id. Missing the
 * singular prefix would leave an open detail screen showing a stale row until
 * its own poll came round.
 */
const TARGET_KEYS: Record<InvalidationTarget, readonly (readonly unknown[])[]> = {
  jobs: [queryKeys.jobs.all, ['job']],
  applications: [queryKeys.applications.all, ['application']],
  notifications: [queryKeys.notifications.all],
  overview: [queryKeys.overview(), ['queue-stats']],
};

/**
 * A collector run inserts jobs in bursts, which would otherwise mean one
 * refetch per row. Coalesce everything that lands inside this window.
 */
const COALESCE_MS = 300;

/**
 * Subscribes to the current user's rows and invalidates the affected queries.
 * Mount this once, high in the tree (the root layout). Mounting it twice is
 * harmless but doubles the socket traffic.
 */
export function useRealtimeInvalidation(): void {
  const queryClient = useQueryClient();
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setUserId(data.session?.user.id ?? null);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user.id ?? null);
    });

    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, []);

  const pending = useRef<Set<InvalidationTarget>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (userId === null) return;

    const flush = (client: QueryClient): void => {
      timer.current = null;
      const targets = Array.from(pending.current);
      pending.current.clear();
      for (const target of targets) {
        for (const queryKey of TARGET_KEYS[target]) {
          void client.invalidateQueries({ queryKey });
        }
      }
    };

    const schedule = (...targets: InvalidationTarget[]): void => {
      for (const target of targets) pending.current.add(target);
      if (timer.current !== null) return;
      timer.current = setTimeout(() => {
        flush(queryClient);
      }, COALESCE_MS);
    };

    // Server side filter: RLS already hides other users' rows from the socket,
    // but filtering here also stops the phone decoding events it cannot use.
    const filter = `user_id=eq.${userId}`;

    const channel: RealtimeChannel = supabase
      .channel(`mirror:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs', filter }, () => {
        schedule('jobs', 'overview');
      })
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'applications', filter },
        () => {
          schedule('applications', 'overview');
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications', filter },
        () => {
          schedule('notifications', 'overview');
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'queue_stats', filter },
        () => {
          schedule('overview');
        },
      )
      .subscribe();

    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      pending.current.clear();
      // removeChannel unsubscribes and drops the socket when it was the last
      // channel; leaving it out leaks a subscription on every sign-out.
      void supabase.removeChannel(channel);
    };
  }, [queryClient, userId]);
}

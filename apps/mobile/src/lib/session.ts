import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';

import { isConfigured, supabase } from './supabase';

export interface SessionState {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

/**
 * Session state for the pairing account.
 *
 * The Supabase session is the only identity in this app - it exists purely so
 * row level security can scope the cloud mirror to one user and so the host
 * machine can recognise commands as belonging to its owner. It grants no access
 * to anything on the host itself.
 *
 * Safe to mount in several components at once: each instance owns its own
 * auth listener and unsubscribes on unmount, and supabase-js dedupes the
 * underlying token refresh.
 */
export function useSession(): SessionState {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Without credentials there is no session to restore and no listener to
    // attach; sign-in renders its "not configured" state instead.
    if (!isConfigured()) {
      setSession(null);
      setLoading(false);
      return;
    }

    let mounted = true;

    // getSession() reads the persisted session out of SecureStore first, so the
    // app does not flash the sign-in screen on a warm start.
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!mounted) return;
        setSession(data.session);
      })
      .catch(() => {
        if (!mounted) return;
        setSession(null);
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      setLoading(false);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    if (!isConfigured()) {
      setSession(null);
      return;
    }
    // Clear locally even if the network call fails, otherwise a phone that is
    // offline can never sign out of a session it no longer wants.
    try {
      await supabase.auth.signOut();
    } finally {
      setSession(null);
    }
  }, []);

  return useMemo(
    () => ({ session, user: session?.user ?? null, loading, signOut }),
    [session, loading, signOut],
  );
}

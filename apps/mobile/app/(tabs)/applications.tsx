import * as React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../../src/lib/theme';
import { supabase } from '../../src/lib/supabase';

const PAGE_SIZE = 25;

/**
 * Cloud mirror of an application's progress. There is no confirmation text,
 * resume id or cover letter here on purpose - the documents and their contents
 * never leave the host machine.
 */
interface ApplicationRow {
  id: number;
  job_id: number;
  job_title: string | null;
  company: string | null;
  provider: string;
  status: string;
  current_step: string | null;
  attempts: number;
  max_attempts: number;
  error: string | null;
  dry_run: boolean;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

const APPLICATION_STATUS_FILTERS = [
  'pending',
  'in_progress',
  'submitted',
  'failed',
  'abandoned',
  'needs_human',
  'interview',
  'rejected',
  'offer',
] as const;

/** Statuses that need a human decision get an accent edge and a retry action. */
function isPrioritised(status: string): boolean {
  return status === 'failed' || status === 'needs_human';
}

function statusColor(status: string): string {
  switch (status) {
    case 'submitted':
    case 'offer':
      return theme.colors.success;
    case 'failed':
    case 'rejected':
      return theme.colors.danger;
    case 'needs_human':
    case 'abandoned':
      return theme.colors.warning;
    case 'in_progress':
    case 'interview':
      return theme.colors.primary;
    default:
      return theme.colors.muted;
  }
}

function relativeTime(iso: string | null): string {
  if (!iso) return '-';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '-';
  const seconds = Math.round((Date.now() - then) / 1000);
  const past = seconds >= 0;
  const abs = Math.abs(seconds);
  const units: [string, number][] = [
    ['y', 31536000],
    ['mo', 2592000],
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
  ];
  for (const [label, size] of units) {
    if (abs >= size) {
      const value = Math.floor(abs / size);
      return past ? `${value}${label} ago` : `in ${value}${label}`;
    }
  }
  return past ? 'just now' : 'in a moment';
}

async function fetchApplications(status: string | null, page: number): Promise<ApplicationRow[]> {
  const from = page * PAGE_SIZE;
  let query = supabase
    .from('applications')
    .select(
      'id,job_id,job_title,company,provider,status,current_step,attempts,max_attempts,error,dry_run,submitted_at,created_at,updated_at',
    )
    .order('updated_at', { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as ApplicationRow[];
}

/**
 * The phone never talks to the local server. It appends to `commands`, which
 * the host polls, claims and executes; the result shows up as a change to the
 * application row on the next refresh.
 */
async function queueRetry(applicationId: number): Promise<void> {
  const { data, error: authError } = await supabase.auth.getUser();
  if (authError) throw new Error(authError.message);
  const userId = data.user?.id;
  if (!userId) throw new Error('You are signed out. Sign in again to send commands.');

  const { error } = await supabase
    .from('commands')
    .insert({ user_id: userId, kind: 'application.retry', payload: { applicationId } });
  if (error) throw new Error(error.message);
}

interface ChipProps {
  label: string;
  active: boolean;
  onPress: () => void;
}

function Chip({ label, active, onPress }: ChipProps): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

interface CardProps {
  application: ApplicationRow;
  queued: boolean;
  retrying: boolean;
  onPress: () => void;
  onRetry: () => void;
}

function ApplicationCard({
  application,
  queued,
  retrying,
  onPress,
  onRetry,
}: CardProps): React.JSX.Element {
  const color = statusColor(application.status);
  const prioritised = isPrioritised(application.status);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        prioritised && { borderLeftWidth: 3, borderLeftColor: color },
        pressed && styles.cardPressed,
      ]}
    >
      <Text style={styles.title} numberOfLines={2}>
        {application.job_title ?? `Job #${application.job_id}`}
      </Text>
      <Text style={styles.company} numberOfLines={1}>
        {application.company ?? 'Unknown company'} · {application.provider}
      </Text>

      <View style={styles.metaRow}>
        <View style={[styles.pill, { borderColor: color }]}>
          <Text style={[styles.pillText, { color }]}>
            {application.status.replace(/_/g, ' ')}
          </Text>
        </View>
        {application.current_step ? (
          <Text style={styles.metaText}>{application.current_step.replace(/_/g, ' ')}</Text>
        ) : null}
        <Text style={styles.metaText}>
          {application.attempts}/{application.max_attempts}
        </Text>
        {application.dry_run ? (
          <View style={styles.dryRun}>
            <Text style={styles.dryRunText}>dry run</Text>
          </View>
        ) : null}
        <Text style={styles.metaTime}>{relativeTime(application.updated_at)}</Text>
      </View>

      {prioritised && application.error ? (
        <Text style={styles.error} numberOfLines={2}>
          {application.error}
        </Text>
      ) : null}

      {prioritised ? (
        queued ? (
          <View style={styles.queuedBanner}>
            <Ionicons name="time-outline" size={14} color={theme.colors.warning} />
            <Text style={styles.queuedText}>Queued - your machine will pick this up</Text>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry this application"
            disabled={retrying}
            onPress={onRetry}
            style={({ pressed }) => [styles.retryInline, pressed && styles.cardPressed]}
          >
            {retrying ? (
              <ActivityIndicator size="small" color={theme.colors.primary} />
            ) : (
              <Ionicons name="refresh" size={14} color={theme.colors.primary} />
            )}
            <Text style={styles.retryInlineText}>Retry</Text>
          </Pressable>
        )
      ) : null}
    </Pressable>
  );
}

export default function ApplicationsScreen(): React.JSX.Element {
  const router = useRouter();
  const [status, setStatus] = React.useState<string | null>(null);
  // appId -> the updated_at we saw when the command was queued. Once the host
  // touches the row that value changes, which is our signal the work landed.
  const [queued, setQueued] = React.useState<Record<number, string>>({});
  const [pendingId, setPendingId] = React.useState<number | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const applications = useInfiniteQuery({
    queryKey: ['applications', status],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchApplications(status, pageParam),
    getNextPageParam: (lastPage: ApplicationRow[], allPages: ApplicationRow[][]) =>
      lastPage.length < PAGE_SIZE ? undefined : allPages.length,
  });

  const rows = React.useMemo(() => applications.data?.pages.flat() ?? [], [applications.data]);

  React.useEffect(() => {
    setQueued((current) => {
      const entries = Object.entries(current);
      if (entries.length === 0) return current;
      const next: Record<number, string> = {};
      let changed = false;
      for (const [key, stamp] of entries) {
        const id = Number(key);
        const row = rows.find((item) => item.id === id);
        if (row && row.updated_at !== stamp) {
          changed = true;
          continue;
        }
        next[id] = stamp;
      }
      return changed ? next : current;
    });
  }, [rows]);

  const retry = useMutation({
    mutationFn: (application: ApplicationRow) => queueRetry(application.id),
    onMutate: (application: ApplicationRow) => {
      setActionError(null);
      setPendingId(application.id);
    },
    onSuccess: (_result, application: ApplicationRow) => {
      setQueued((current) => ({ ...current, [application.id]: application.updated_at }));
    },
    onError: (error: unknown) =>
      setActionError(error instanceof Error ? error.message : 'Could not queue the retry'),
    onSettled: () => setPendingId(null),
  });

  const listBody = ((): React.JSX.Element | null => {
    if (applications.isPending) {
      return (
        <View style={styles.state}>
          <ActivityIndicator color={theme.colors.primary} />
          <Text style={styles.stateText}>Loading applications...</Text>
        </View>
      );
    }
    if (applications.isError) {
      return (
        <View style={styles.state}>
          <Ionicons name="cloud-offline-outline" size={32} color={theme.colors.danger} />
          <Text style={styles.stateTitle}>Could not load applications</Text>
          <Text style={styles.stateText}>
            {applications.error instanceof Error ? applications.error.message : 'Unknown error'}
          </Text>
          <Pressable
            accessibilityRole="button"
            style={styles.retryButton}
            onPress={() => void applications.refetch()}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      );
    }
    if (rows.length === 0) {
      return (
        <View style={styles.state}>
          <Ionicons name="paper-plane-outline" size={32} color={theme.colors.muted} />
          <Text style={styles.stateTitle}>Nothing here yet</Text>
          <Text style={styles.stateText}>
            Applications appear once your machine starts submitting for the jobs it scored.
          </Text>
        </View>
      );
    }
    return null;
  })();

  return (
    <View style={styles.screen}>
      <View style={styles.controls}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          <Chip label="All" active={status === null} onPress={() => setStatus(null)} />
          {APPLICATION_STATUS_FILTERS.map((value) => (
            <Chip
              key={value}
              label={value.replace(/_/g, ' ')}
              active={status === value}
              onPress={() => setStatus(status === value ? null : value)}
            />
          ))}
        </ScrollView>
        {actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}
      </View>

      <FlatList
        data={rows}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => (
          <ApplicationCard
            application={item}
            queued={queued[item.id] !== undefined}
            retrying={pendingId === item.id}
            onPress={() =>
              router.push({ pathname: '/application/[id]', params: { id: String(item.id) } })
            }
            onRetry={() => retry.mutate(item)}
          />
        )}
        contentContainerStyle={rows.length === 0 ? styles.listEmpty : styles.list}
        ListEmptyComponent={listBody}
        ListFooterComponent={
          applications.isFetchingNextPage ? (
            <ActivityIndicator style={styles.footer} color={theme.colors.primary} />
          ) : null
        }
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (applications.hasNextPage && !applications.isFetchingNextPage) {
            void applications.fetchNextPage();
          }
        }}
        refreshControl={
          <RefreshControl
            refreshing={applications.isRefetching && !applications.isFetchingNextPage}
            onRefresh={() => void applications.refetch()}
            tintColor={theme.colors.primary}
            colors={[theme.colors.primary]}
          />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  controls: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  chipRow: { gap: 8, paddingRight: 16 },
  chip: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
  },
  chipActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary },
  chipText: { color: theme.colors.muted, fontSize: 13, textTransform: 'capitalize' },
  chipTextActive: { color: theme.colors.background, fontWeight: '600' },
  actionError: { color: theme.colors.danger, fontSize: 12 },
  list: { padding: 16, gap: 8, paddingBottom: 32 },
  listEmpty: { flexGrow: 1, padding: 16 },
  card: {
    backgroundColor: theme.colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 12,
    gap: 6,
  },
  cardPressed: { opacity: 0.7 },
  title: { color: theme.colors.text, fontSize: 15, fontWeight: '600' },
  company: { color: theme.colors.muted, fontSize: 13 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, borderWidth: 1 },
  pillText: { fontSize: 11, fontWeight: '600', textTransform: 'capitalize' },
  metaText: { color: theme.colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  metaTime: {
    color: theme.colors.muted,
    fontSize: 12,
    marginLeft: 'auto',
    fontVariant: ['tabular-nums'],
  },
  dryRun: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: theme.colors.border,
  },
  dryRunText: { color: theme.colors.muted, fontSize: 10, fontWeight: '700', letterSpacing: 0.4 },
  error: { color: theme.colors.danger, fontSize: 12 },
  retryInline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  retryInlineText: { color: theme.colors.primary, fontSize: 14, fontWeight: '600' },
  queuedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: theme.colors.background,
  },
  queuedText: { color: theme.colors.warning, fontSize: 12, flex: 1 },
  footer: { paddingVertical: 16 },
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 },
  stateTitle: { color: theme.colors.text, fontSize: 16, fontWeight: '600' },
  stateText: { color: theme.colors.muted, fontSize: 13, textAlign: 'center' },
  retryButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 20,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
  },
  retryText: { color: theme.colors.text, fontWeight: '600' },
});

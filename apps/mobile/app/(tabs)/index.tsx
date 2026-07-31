import { useCallback, useMemo, useState, type ComponentProps, type ReactElement } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { supabase } from '../../src/lib/supabase';
import { theme } from '../../src/lib/theme';
import type { QueueStatsRow } from '@/lib/types';

/**
 * Overview screen.
 *
 * Everything here is read from the Supabase mirror the host machine pushes to.
 * The phone never talks to the local server, so a laptop that is asleep is the
 * normal case rather than an error: staleness is surfaced explicitly instead of
 * being rendered as an empty dashboard that looks broken.
 */

/** Beyond this the host is assumed asleep and the figures are labelled stale. */
const STALE_AFTER_MS = 10 * 60 * 1000;

/** Averaging every scored job would mean downloading every scored job. */
const SCORE_SAMPLE = 500;

type IconName = ComponentProps<typeof Ionicons>['name'];

interface AttentionRow {
  id: number;
  job_id: number;
  job_title: string | null;
  company: string | null;
  status: string;
  current_step: string | null;
  attempts: number;
  max_attempts: number;
  error: string | null;
  updated_at: string;
}

interface OverviewCounts {
  jobs: number;
  scoredSample: number;
  averageScore: number | null;
  applications: number;
  submitted: number;
  needsHuman: number;
  failed: number;
}

interface ActivityItem {
  key: string;
  kind: 'job' | 'application';
  entityId: number;
  title: string;
  subtitle: string;
  status: string;
  at: string;
}

/**
 * Supabase is queried without generated database types here, so responses come
 * back loosely typed. This narrows them in one place instead of casting inline.
 */
function rows<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return value.toLocaleString();
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '-';
  const seconds = Math.round((then - Date.now()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, secondsInUnit] of units) {
    if (Math.abs(seconds) >= secondsInUnit || unit === 'second') {
      return formatter.format(Math.round(seconds / secondsInUnit), unit);
    }
  }
  return '-';
}

function titleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function statusColor(status: string): string {
  switch (status) {
    case 'submitted':
    case 'offer':
    case 'applied':
      return theme.colors.success;
    case 'failed':
    case 'abandoned':
    case 'rejected':
      return theme.colors.danger;
    case 'needs_human':
    case 'manual_review':
      return theme.colors.warning;
    case 'in_progress':
    case 'applying':
    case 'interview':
      return theme.colors.primary;
    default:
      return theme.colors.muted;
  }
}

async function fetchQueueStats(): Promise<QueueStatsRow | null> {
  const { data, error } = await supabase
    .from('queue_stats')
    .select('pending, active, completed, failed, cancelled, worker_running, updated_at')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as QueueStatsRow | null) ?? null;
}

async function fetchCounts(): Promise<OverviewCounts> {
  const [jobs, scored, applications, submitted, needsHuman, failed] = await Promise.all([
    supabase.from('jobs').select('id', { count: 'exact', head: true }),
    supabase
      .from('jobs')
      .select('score')
      .not('score', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(SCORE_SAMPLE),
    supabase.from('applications').select('id', { count: 'exact', head: true }),
    supabase
      .from('applications')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'submitted'),
    supabase
      .from('applications')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'needs_human'),
    supabase
      .from('applications')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'failed'),
  ]);

  for (const result of [jobs, scored, applications, submitted, needsHuman, failed]) {
    if (result.error) throw new Error(result.error.message);
  }

  const sample = rows<{ score: number | null }>(scored.data)
    .map((row) => row.score)
    .filter((score): score is number => typeof score === 'number');
  const average =
    sample.length > 0 ? sample.reduce((sum, score) => sum + score, 0) / sample.length : null;

  return {
    jobs: jobs.count ?? 0,
    scoredSample: sample.length,
    averageScore: average,
    applications: applications.count ?? 0,
    submitted: submitted.count ?? 0,
    needsHuman: needsHuman.count ?? 0,
    failed: failed.count ?? 0,
  };
}

async function fetchAttention(): Promise<AttentionRow[]> {
  const { data, error } = await supabase
    .from('applications')
    .select(
      'id, job_id, job_title, company, status, current_step, attempts, max_attempts, error, updated_at',
    )
    .in('status', ['needs_human', 'failed'])
    .order('updated_at', { ascending: false })
    .limit(10);
  if (error) throw new Error(error.message);
  return rows<AttentionRow>(data);
}

async function fetchActivity(): Promise<ActivityItem[]> {
  const [jobs, applications] = await Promise.all([
    supabase
      .from('jobs')
      .select('id, title, company, status, collected_at')
      .order('collected_at', { ascending: false })
      .limit(8),
    supabase
      .from('applications')
      .select('id, job_title, company, status, updated_at')
      .order('updated_at', { ascending: false })
      .limit(8),
  ]);
  if (jobs.error) throw new Error(jobs.error.message);
  if (applications.error) throw new Error(applications.error.message);

  const jobItems = rows<{
    id: number;
    title: string;
    company: string;
    status: string;
    collected_at: string;
  }>(jobs.data).map<ActivityItem>((row) => ({
    key: `job-${row.id}`,
    kind: 'job',
    entityId: row.id,
    title: row.title,
    subtitle: row.company,
    status: row.status,
    at: row.collected_at,
  }));

  const applicationItems = rows<{
    id: number;
    job_title: string | null;
    company: string | null;
    status: string;
    updated_at: string;
  }>(applications.data).map<ActivityItem>((row) => ({
    key: `application-${row.id}`,
    kind: 'application',
    entityId: row.id,
    title: row.job_title ?? `Application #${row.id}`,
    subtitle: row.company ?? 'Unknown company',
    status: row.status,
    at: row.updated_at,
  }));

  return [...jobItems, ...applicationItems]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 10);
}

/** Application ids that already have an unclaimed or in-flight retry command. */
async function fetchPendingRetries(): Promise<number[]> {
  const { data, error } = await supabase
    .from('commands')
    .select('payload')
    .eq('kind', 'application.retry')
    .in('status', ['pending', 'claimed']);
  if (error) throw new Error(error.message);
  return rows<{ payload: Record<string, unknown> | null }>(data)
    .map((row) => row.payload?.applicationId)
    .filter((id): id is number => typeof id === 'number');
}

async function queueRetry(applicationId: number): Promise<void> {
  // RLS demands user_id = auth.uid() on insert, so the id has to come from the
  // live session rather than from anything cached in the UI.
  const { data, error: authError } = await supabase.auth.getUser();
  if (authError) throw new Error(authError.message);
  const userId = data.user?.id;
  if (!userId) throw new Error('You are signed out. Sign in again to send commands.');

  const { error } = await supabase
    .from('commands')
    .insert({ user_id: userId, kind: 'application.retry', payload: { applicationId } });
  if (error) throw new Error(error.message);
}

export default function OverviewScreen(): ReactElement {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const queue = useQuery({
    queryKey: ['overview', 'queue'],
    queryFn: fetchQueueStats,
    refetchInterval: 30_000,
  });
  const counts = useQuery({
    queryKey: ['overview', 'counts'],
    queryFn: fetchCounts,
    refetchInterval: 60_000,
  });
  const attention = useQuery({
    queryKey: ['overview', 'attention'],
    queryFn: fetchAttention,
    refetchInterval: 60_000,
  });
  const activity = useQuery({
    queryKey: ['overview', 'activity'],
    queryFn: fetchActivity,
    refetchInterval: 60_000,
  });
  const pendingRetries = useQuery({
    queryKey: ['commands', 'pending-retries'],
    queryFn: fetchPendingRetries,
    refetchInterval: 15_000,
  });

  const retry = useMutation({
    mutationFn: queueRetry,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['commands', 'pending-retries'] });
    },
    onError: (error: unknown) => {
      Alert.alert(
        'Could not queue the retry',
        error instanceof Error ? error.message : 'Unknown error',
      );
    },
  });

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void Promise.all([
      queue.refetch(),
      counts.refetch(),
      attention.refetch(),
      activity.refetch(),
      pendingRetries.refetch(),
    ]).finally(() => setRefreshing(false));
  }, [queue, counts, attention, activity, pendingRetries]);

  const stats = queue.data ?? null;
  const staleness = useMemo(() => {
    if (!stats) return { stale: true, syncedAt: null as string | null };
    const age = Date.now() - new Date(stats.updated_at).getTime();
    return { stale: Number.isNaN(age) || age > STALE_AFTER_MS, syncedAt: stats.updated_at };
  }, [stats]);

  const pendingSet = useMemo(() => new Set(pendingRetries.data ?? []), [pendingRetries.data]);
  const loading = counts.isLoading || queue.isLoading;
  const error = queue.error ?? counts.error ?? attention.error ?? activity.error;

  const openApplication = (id: number): void => {
    router.push({ pathname: '/application/[id]', params: { id: String(id) } });
  };
  const openJob = (id: number): void => {
    router.push({ pathname: '/job/[id]', params: { id: String(id) } });
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={theme.colors.muted}
          colors={[theme.colors.primary]}
          progressBackgroundColor={theme.colors.card}
        />
      }
    >
      <View style={styles.header}>
        <Text style={styles.heading}>Overview</Text>
        <Text style={styles.subheading}>Mirrored from your machine. Pull down to refresh.</Text>
      </View>

      {error ? (
        <View style={[styles.card, styles.errorCard]}>
          <Ionicons name="warning-outline" size={18} color={theme.colors.danger} />
          <Text style={styles.errorText}>
            {error instanceof Error ? error.message : 'Could not reach the sync database.'}
          </Text>
        </View>
      ) : null}

      {staleness.stale ? (
        <StaleBanner syncedAt={staleness.syncedAt} loading={queue.isLoading} />
      ) : null}

      <View style={styles.grid}>
        <StatTile
          icon="briefcase-outline"
          label="Jobs collected"
          value={formatNumber(counts.data?.jobs)}
          hint={`${formatNumber(counts.data?.scoredSample)} scored recently`}
          loading={loading}
        />
        <StatTile
          icon="sparkles-outline"
          label="Average score"
          value={
            counts.data?.averageScore !== null && counts.data?.averageScore !== undefined
              ? counts.data.averageScore.toFixed(1)
              : '-'
          }
          hint={`last ${SCORE_SAMPLE} scored`}
          tone={theme.colors.primary}
          loading={loading}
        />
        <StatTile
          icon="paper-plane-outline"
          label="Applications"
          value={formatNumber(counts.data?.applications)}
          hint="all time"
          loading={loading}
        />
        <StatTile
          icon="checkmark-circle-outline"
          label="Submitted"
          value={formatNumber(counts.data?.submitted)}
          hint={
            counts.data && counts.data.applications > 0
              ? `${Math.round((counts.data.submitted / counts.data.applications) * 100)}% of runs`
              : 'no runs yet'
          }
          tone={theme.colors.success}
          loading={loading}
        />
        <StatTile
          icon="hand-left-outline"
          label="Needs you"
          value={formatNumber(counts.data?.needsHuman)}
          hint="waiting on a human"
          tone={theme.colors.warning}
          loading={loading}
        />
        <StatTile
          icon="alert-circle-outline"
          label="Failed"
          value={formatNumber(counts.data?.failed)}
          hint="retryable"
          tone={theme.colors.danger}
          loading={loading}
        />
      </View>

      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Queue</Text>
          <View style={styles.workerRow}>
            <View
              style={[
                styles.dot,
                {
                  backgroundColor:
                    stats?.worker_running && !staleness.stale
                      ? theme.colors.success
                      : theme.colors.muted,
                },
              ]}
            />
            <Text style={styles.workerText}>
              {staleness.stale
                ? 'worker unknown'
                : stats?.worker_running
                  ? 'worker running'
                  : 'worker idle'}
            </Text>
          </View>
        </View>
        <View style={styles.queueStrip}>
          <QueueCell label="Pending" value={stats?.pending ?? 0} tone={theme.colors.text} />
          <QueueCell label="Active" value={stats?.active ?? 0} tone={theme.colors.primary} />
          <QueueCell label="Failed" value={stats?.failed ?? 0} tone={theme.colors.danger} />
          <QueueCell label="Done" value={stats?.completed ?? 0} tone={theme.colors.success} />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Needs your attention</Text>
        {attention.isLoading ? (
          <View style={styles.card}>
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        ) : (attention.data ?? []).length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.emptyTitle}>Nothing is stuck</Text>
            <Text style={styles.emptyBody}>
              Applications that fail or need a human decision show up here with a one-tap retry.
            </Text>
          </View>
        ) : (
          (attention.data ?? []).map((row) => (
            <AttentionCard
              key={row.id}
              row={row}
              queued={pendingSet.has(row.id)}
              busy={retry.isPending && retry.variables === row.id}
              onOpen={() => openApplication(row.id)}
              onRetry={() => retry.mutate(row.id)}
            />
          ))
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Recent activity</Text>
        <View style={styles.card}>
          {activity.isLoading ? (
            <ActivityIndicator color={theme.colors.primary} />
          ) : (activity.data ?? []).length === 0 ? (
            <Text style={styles.emptyBody}>
              No activity yet. Once your machine collects jobs they appear here.
            </Text>
          ) : (
            (activity.data ?? []).map((item, index) => (
              <Pressable
                key={item.key}
                style={[styles.activityRow, index > 0 && styles.activityDivider]}
                onPress={() =>
                  item.kind === 'job' ? openJob(item.entityId) : openApplication(item.entityId)
                }
                accessibilityRole="button"
                accessibilityLabel={`${item.title} at ${item.subtitle}`}
              >
                <Ionicons
                  name={item.kind === 'job' ? 'briefcase-outline' : 'paper-plane-outline'}
                  size={16}
                  color={statusColor(item.status)}
                />
                <View style={styles.activityBody}>
                  <Text style={styles.activityTitle} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text style={styles.activityMeta} numberOfLines={1}>
                    {item.subtitle} - {titleCase(item.status)}
                  </Text>
                </View>
                <Text style={styles.activityTime}>{relativeTime(item.at)}</Text>
              </Pressable>
            ))
          )}
        </View>
      </View>
    </ScrollView>
  );
}

function StaleBanner({
  syncedAt,
  loading,
}: {
  syncedAt: string | null;
  loading: boolean;
}): ReactElement {
  return (
    <View style={[styles.card, styles.staleCard]}>
      <View style={styles.staleHeader}>
        <Ionicons name="cloud-offline-outline" size={18} color={theme.colors.warning} />
        <Text style={styles.staleTitle}>Waiting for your machine to sync</Text>
      </View>
      <Text style={styles.staleBody}>
        {loading
          ? 'Checking for the latest push from your machine.'
          : syncedAt
            ? `Last heard from your machine ${relativeTime(syncedAt)}. The figures below are that snapshot.`
            : 'Your machine has not pushed anything yet. Start the local server and enable sync in settings.'}
      </Text>
      <Text style={styles.staleBody}>
        This is normal when your laptop is asleep - nothing is broken, and anything you queue here
        will run as soon as it wakes up.
      </Text>
    </View>
  );
}

function StatTile({
  icon,
  label,
  value,
  hint,
  tone,
  loading,
}: {
  icon: IconName;
  label: string;
  value: string;
  hint: string;
  tone?: string;
  loading: boolean;
}): ReactElement {
  return (
    <View style={styles.tile}>
      <View style={styles.tileHeader}>
        <Ionicons name={icon} size={16} color={tone ?? theme.colors.muted} />
        <Text style={styles.tileLabel} numberOfLines={1}>
          {label}
        </Text>
      </View>
      {loading ? (
        <ActivityIndicator style={styles.tileSpinner} color={theme.colors.muted} />
      ) : (
        <Text style={[styles.tileValue, tone ? { color: tone } : null]}>{value}</Text>
      )}
      <Text style={styles.tileHint} numberOfLines={1}>
        {hint}
      </Text>
    </View>
  );
}

function QueueCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}): ReactElement {
  return (
    <View style={styles.queueCell}>
      <Text style={[styles.queueValue, { color: tone }]}>{formatNumber(value)}</Text>
      <Text style={styles.queueLabel}>{label}</Text>
    </View>
  );
}

function AttentionCard({
  row,
  queued,
  busy,
  onOpen,
  onRetry,
}: {
  row: AttentionRow;
  queued: boolean;
  busy: boolean;
  onOpen: () => void;
  onRetry: () => void;
}): ReactElement {
  const exhausted = row.attempts >= row.max_attempts;
  return (
    <View style={styles.card}>
      <Pressable onPress={onOpen} accessibilityRole="button">
        <View style={styles.attentionHeader}>
          <View style={[styles.pill, { borderColor: statusColor(row.status) }]}>
            <Text style={[styles.pillText, { color: statusColor(row.status) }]}>
              {titleCase(row.status)}
            </Text>
          </View>
          <Text style={styles.attentionTime}>{relativeTime(row.updated_at)}</Text>
        </View>
        <Text style={styles.attentionTitle} numberOfLines={2}>
          {row.job_title ?? `Application #${row.id}`}
        </Text>
        <Text style={styles.attentionMeta} numberOfLines={1}>
          {row.company ?? 'Unknown company'}
          {row.current_step ? ` - stopped at ${titleCase(row.current_step)}` : ''}
        </Text>
        {row.error ? (
          <Text style={styles.attentionError} numberOfLines={2}>
            {row.error}
          </Text>
        ) : null}
      </Pressable>

      {queued ? (
        <View style={styles.queuedNote}>
          <Ionicons name="time-outline" size={14} color={theme.colors.warning} />
          <Text style={styles.queuedText}>Queued - your machine will pick this up</Text>
        </View>
      ) : (
        <Pressable
          style={({ pressed }) => [styles.retryButton, pressed && styles.retryButtonPressed]}
          onPress={onRetry}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Retry this application"
        >
          {busy ? (
            <ActivityIndicator size="small" color={theme.colors.primary} />
          ) : (
            <>
              <Ionicons name="refresh" size={16} color={theme.colors.primary} />
              <Text style={styles.retryText}>
                {exhausted ? 'Retry anyway' : `Retry (${row.attempts}/${row.max_attempts})`}
              </Text>
            </>
          )}
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: 16, paddingBottom: 48, gap: 16 },
  header: { gap: 4 },
  heading: { color: theme.colors.text, fontSize: 28, fontWeight: '700' },
  subheading: { color: theme.colors.muted, fontSize: 13 },

  card: {
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { color: theme.colors.text, fontSize: 15, fontWeight: '600' },

  errorCard: { flexDirection: 'row', alignItems: 'center', borderColor: theme.colors.danger },
  errorText: { color: theme.colors.danger, fontSize: 13, flex: 1 },

  staleCard: { borderColor: theme.colors.warning },
  staleHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  staleTitle: { color: theme.colors.warning, fontSize: 15, fontWeight: '600' },
  staleBody: { color: theme.colors.muted, fontSize: 13, lineHeight: 19 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: {
    flexBasis: '48%',
    flexGrow: 1,
    minHeight: 92,
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  tileHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tileLabel: { color: theme.colors.muted, fontSize: 12, flex: 1 },
  tileValue: {
    color: theme.colors.text,
    fontSize: 24,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  tileSpinner: { alignSelf: 'flex-start', height: 29 },
  tileHint: { color: theme.colors.muted, fontSize: 11 },

  workerRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  workerText: { color: theme.colors.muted, fontSize: 12 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  queueStrip: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 4 },
  queueCell: { flex: 1, alignItems: 'center', gap: 2 },
  queueValue: { fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  queueLabel: { color: theme.colors.muted, fontSize: 11 },

  section: { gap: 8 },
  sectionTitle: { color: theme.colors.text, fontSize: 17, fontWeight: '600' },
  emptyTitle: { color: theme.colors.text, fontSize: 14, fontWeight: '600' },
  emptyBody: { color: theme.colors.muted, fontSize: 13, lineHeight: 19 },

  attentionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  attentionTime: { color: theme.colors.muted, fontSize: 11 },
  attentionTitle: { color: theme.colors.text, fontSize: 15, fontWeight: '600', marginTop: 6 },
  attentionMeta: { color: theme.colors.muted, fontSize: 12, marginTop: 2 },
  attentionError: { color: theme.colors.danger, fontSize: 12, marginTop: 6 },

  pill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  pillText: { fontSize: 11, fontWeight: '600' },

  retryButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    marginTop: 4,
  },
  retryButtonPressed: { borderColor: theme.colors.primary },
  retryText: { color: theme.colors.primary, fontSize: 14, fontWeight: '600' },
  queuedNote: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  queuedText: { color: theme.colors.warning, fontSize: 12 },

  activityRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  activityDivider: { borderTopWidth: 1, borderTopColor: theme.colors.border },
  activityBody: { flex: 1 },
  activityTitle: { color: theme.colors.text, fontSize: 14 },
  activityMeta: { color: theme.colors.muted, fontSize: 12, marginTop: 2 },
  activityTime: { color: theme.colors.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
});

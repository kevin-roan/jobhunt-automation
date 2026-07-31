import * as React from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../../src/lib/theme';
import { supabase } from '../../src/lib/supabase';

/**
 * Everything the cloud mirror knows about a job. The description, the parsed
 * requirements, the score reasoning and every generated document stay in the
 * local SQLite database on the host - see the privacy note rendered below.
 */
interface JobRow {
  id: number;
  title: string;
  company: string;
  location: string | null;
  source: string;
  remote_type: string;
  employment_type: string;
  experience_level: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  score: number | null;
  recommendation: string | null;
  status: string;
  application_url: string;
  posted_at: string | null;
  collected_at: string;
  updated_at: string;
}

type JobCommand = 'job.score' | 'job.archive';

function statusColor(status: string): string {
  switch (status) {
    case 'applied':
      return theme.colors.success;
    case 'failed':
      return theme.colors.danger;
    case 'queued':
    case 'applying':
    case 'manual_review':
      return theme.colors.warning;
    case 'scored':
      return theme.colors.primary;
    default:
      return theme.colors.muted;
  }
}

function recommendationColor(recommendation: string | null): string {
  switch (recommendation) {
    case 'apply':
      return theme.colors.success;
    case 'skip':
      return theme.colors.danger;
    case 'manual_review':
      return theme.colors.warning;
    default:
      return theme.colors.muted;
  }
}

function scoreColor(score: number): string {
  if (score >= 80) return theme.colors.success;
  if (score >= 60) return theme.colors.primary;
  if (score >= 40) return theme.colors.warning;
  return theme.colors.danger;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function compactMoney(value: number): string {
  return value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(Math.round(value));
}

function formatSalary(job: JobRow): string {
  if (job.salary_min === null && job.salary_max === null) return 'Not disclosed';
  const unit = job.salary_currency ?? '';
  const range =
    job.salary_min !== null && job.salary_max !== null
      ? `${compactMoney(job.salary_min)}-${compactMoney(job.salary_max)}`
      : compactMoney(job.salary_min ?? job.salary_max ?? 0);
  return `${unit} ${range}`.trim();
}

async function fetchJob(id: number): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from('jobs')
    .select(
      'id,title,company,location,source,remote_type,employment_type,experience_level,salary_min,salary_max,salary_currency,score,recommendation,status,application_url,posted_at,collected_at,updated_at',
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as JobRow | null;
}

/**
 * The phone has no route to the host. Actions are appended to `commands`; the
 * host polls, claims and executes them, then the effect shows up as a change to
 * the mirrored job row.
 */
async function sendJobCommand(kind: JobCommand, jobId: number): Promise<void> {
  const { data, error: authError } = await supabase.auth.getUser();
  if (authError) throw new Error(authError.message);
  const userId = data.user?.id;
  if (!userId) throw new Error('You are signed out. Sign in again to send commands.');

  const { error } = await supabase
    .from('commands')
    .insert({ user_id: userId, kind, payload: { jobId } });
  if (error) throw new Error(error.message);
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

export default function JobDetailScreen(): React.JSX.Element {
  const params = useLocalSearchParams<{ id: string }>();
  const jobId = Number(params.id);
  const [queuedCommand, setQueuedCommand] = React.useState<JobCommand | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const job = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => fetchJob(jobId),
    enabled: Number.isFinite(jobId),
  });

  const command = useMutation({
    mutationFn: (kind: JobCommand) => sendJobCommand(kind, jobId),
    onMutate: () => setActionError(null),
    onSuccess: (_result, kind: JobCommand) => setQueuedCommand(kind),
    onError: (error: unknown) =>
      setActionError(error instanceof Error ? error.message : 'Could not queue the command'),
  });

  const openPosting = React.useCallback((url: string) => {
    void Linking.openURL(url).catch(() => setActionError('No app available to open that link'));
  }, []);

  const screen = <Stack.Screen options={{ title: job.data?.company ?? 'Job' }} />;

  if (job.isPending) {
    return (
      <View style={styles.center}>
        {screen}
        <ActivityIndicator color={theme.colors.primary} />
        <Text style={styles.stateText}>Loading job...</Text>
      </View>
    );
  }

  if (job.isError) {
    return (
      <View style={styles.center}>
        {screen}
        <Ionicons name="cloud-offline-outline" size={32} color={theme.colors.danger} />
        <Text style={styles.stateTitle}>Could not load this job</Text>
        <Text style={styles.stateText}>
          {job.error instanceof Error ? job.error.message : 'Unknown error'}
        </Text>
        <Pressable
          accessibilityRole="button"
          style={styles.secondaryButton}
          onPress={() => void job.refetch()}
        >
          <Text style={styles.secondaryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const data = job.data;
  if (!data) {
    return (
      <View style={styles.center}>
        {screen}
        <Ionicons name="briefcase-outline" size={32} color={theme.colors.muted} />
        <Text style={styles.stateTitle}>Job not found</Text>
        <Text style={styles.stateText}>
          It may have been archived or pruned on your machine and removed from the mirror.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={job.isRefetching}
          onRefresh={() => void job.refetch()}
          tintColor={theme.colors.primary}
          colors={[theme.colors.primary]}
        />
      }
    >
      {screen}

      <View style={styles.header}>
        <Text style={styles.title}>{data.title}</Text>
        <Text style={styles.company}>
          {data.company}
          {data.location ? ` · ${data.location}` : ''}
        </Text>
        <View style={styles.badgeRow}>
          <View
            style={[
              styles.scoreBadge,
              { borderColor: data.score === null ? theme.colors.border : scoreColor(data.score) },
            ]}
          >
            <Text
              style={[
                styles.scoreText,
                { color: data.score === null ? theme.colors.muted : scoreColor(data.score) },
              ]}
            >
              {data.score === null ? 'unscored' : `${Math.round(data.score)} / 100`}
            </Text>
          </View>
          <View style={[styles.pill, { borderColor: statusColor(data.status) }]}>
            <Text style={[styles.pillText, { color: statusColor(data.status) }]}>
              {data.status.replace(/_/g, ' ')}
            </Text>
          </View>
          {data.recommendation ? (
            <View style={[styles.pill, { borderColor: recommendationColor(data.recommendation) }]}>
              <Text style={[styles.pillText, { color: recommendationColor(data.recommendation) }]}>
                {data.recommendation.replace(/_/g, ' ')}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      <View style={styles.card}>
        <Row label="Salary" value={formatSalary(data)} />
        <Row label="Source" value={data.source} />
        <Row label="Remote" value={data.remote_type.replace(/_/g, ' ')} />
        <Row label="Employment" value={data.employment_type.replace(/_/g, ' ')} />
        <Row label="Level" value={data.experience_level.replace(/_/g, ' ')} />
        <Row label="Posted" value={formatDateTime(data.posted_at)} />
        <Row label="Collected" value={formatDateTime(data.collected_at)} />
      </View>

      <Pressable
        accessibilityRole="link"
        onPress={() => openPosting(data.application_url)}
        style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}
      >
        <Ionicons name="open-outline" size={16} color={theme.colors.primary} />
        <Text style={styles.linkText}>Open the original posting</Text>
      </Pressable>

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          disabled={command.isPending}
          onPress={() => command.mutate('job.score')}
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
        >
          {command.isPending && command.variables === 'job.score' ? (
            <ActivityIndicator size="small" color={theme.colors.background} />
          ) : (
            <Ionicons name="sparkles-outline" size={16} color={theme.colors.background} />
          )}
          <Text style={styles.primaryText}>Score now</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={command.isPending}
          onPress={() => command.mutate('job.archive')}
          style={({ pressed }) => [styles.secondaryButton, styles.grow, pressed && styles.pressed]}
        >
          {command.isPending && command.variables === 'job.archive' ? (
            <ActivityIndicator size="small" color={theme.colors.text} />
          ) : (
            <Ionicons name="archive-outline" size={16} color={theme.colors.text} />
          )}
          <Text style={styles.secondaryText}>Archive</Text>
        </Pressable>
      </View>

      {queuedCommand ? (
        <View style={styles.queuedBanner}>
          <Ionicons name="time-outline" size={16} color={theme.colors.warning} />
          <Text style={styles.queuedText}>
            {queuedCommand === 'job.score' ? 'Scoring' : 'Archive'} queued - your machine will pick
            this up on its next poll and this page will update once it has.
          </Text>
        </View>
      ) : null}

      {actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}

      <View style={styles.privacy}>
        <Ionicons name="lock-closed-outline" size={16} color={theme.colors.muted} />
        <Text style={styles.privacyText}>
          The full description and the AI scoring reasoning stay on your desktop. Only operational
          metadata is mirrored here, so a stolen phone or account reveals nothing about your resume,
          your cover letters or your contact details.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: 16, gap: 16, paddingBottom: 40 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 24,
    backgroundColor: theme.colors.background,
  },
  header: { gap: 8 },
  title: { color: theme.colors.text, fontSize: 22, fontWeight: '700', lineHeight: 28 },
  company: { color: theme.colors.muted, fontSize: 15 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  scoreBadge: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, borderWidth: 1 },
  scoreText: { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  pill: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1 },
  pillText: { fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
  card: {
    backgroundColor: theme.colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 12,
    gap: 8,
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  rowLabel: { color: theme.colors.muted, fontSize: 13, width: 96 },
  rowValue: {
    color: theme.colors.text,
    fontSize: 13,
    flex: 1,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  linkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
  },
  linkText: { color: theme.colors.primary, fontSize: 14, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 8 },
  primaryButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: theme.colors.primary,
  },
  primaryText: { color: theme.colors.background, fontSize: 14, fontWeight: '700' },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 20,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
  },
  grow: { flex: 1 },
  secondaryText: { color: theme.colors.text, fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.7 },
  queuedBanner: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.warning,
    backgroundColor: theme.colors.card,
  },
  queuedText: { color: theme.colors.warning, fontSize: 12, flex: 1, lineHeight: 18 },
  actionError: { color: theme.colors.danger, fontSize: 12 },
  privacy: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderRadius: 12,
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  privacyText: { color: theme.colors.muted, fontSize: 12, flex: 1, lineHeight: 18 },
  stateTitle: { color: theme.colors.text, fontSize: 16, fontWeight: '600' },
  stateText: { color: theme.colors.muted, fontSize: 13, textAlign: 'center' },
});

import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';

import { theme } from '../../src/lib/theme';
import { supabase } from '../../src/lib/supabase';
import { useCommandStatus, useSendCommand } from '../../src/lib/commands';
import { ConfirmSheet } from '../../src/components/ConfirmSheet';

/**
 * Mirror of SyncedApplicationRow in packages/shared/src/dto.ts. Declared locally
 * because Metro does not resolve the workspace package's compiled ESM output,
 * and because it documents at the point of use exactly how little of an
 * application ever reaches the cloud: no form payloads, no answers, no
 * artifacts, only progress metadata and a short failure reason.
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
  started_at: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

const STATUS_TONE: Record<string, string> = {
  pending: theme.colors.muted,
  in_progress: theme.colors.primary,
  submitted: theme.colors.success,
  failed: theme.colors.danger,
  abandoned: theme.colors.muted,
  needs_human: theme.colors.warning,
  interview: theme.colors.primary,
  rejected: theme.colors.danger,
  offer: theme.colors.success,
};

/** Outcomes a human records by hand; the pipeline never sets these itself. */
const OUTCOMES: { value: string; label: string; icon: 'calendar' | 'close-circle' | 'trophy' }[] = [
  { value: 'interview', label: 'Interview', icon: 'calendar' },
  { value: 'rejected', label: 'Rejected', icon: 'close-circle' },
  { value: 'offer', label: 'Offer', icon: 'trophy' },
];

type PendingAction =
  | { type: 'retry' }
  | { type: 'set_status'; status: string; label: string };

function humanize(value: string): string {
  return value.replace(/_/g, ' ');
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toneFor(status: string): string {
  return STATUS_TONE[status] ?? theme.colors.muted;
}

function StatusPill({ status }: { status: string }): JSX.Element {
  const tone = toneFor(status);
  return (
    <View style={[styles.pill, { borderColor: tone, backgroundColor: `${tone}22` }]}>
      <Text style={[styles.pillText, { color: tone }]}>{humanize(status)}</Text>
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

export default function ApplicationDetailScreen(): JSX.Element {
  const params = useLocalSearchParams<{ id: string }>();
  const applicationId = Number(params.id);

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [commandId, setCommandId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const sendCommand = useSendCommand();
  const command = useCommandStatus(commandId);

  const application = useQuery({
    queryKey: ['application', applicationId],
    enabled: Number.isFinite(applicationId),
    // The host pushes changes on its own cadence, so a slow poll is the honest
    // refresh rate here; realtime would imply a liveness the sync does not have.
    refetchInterval: 15_000,
    queryFn: async (): Promise<ApplicationRow | null> => {
      const { data, error } = await supabase
        .from('applications')
        .select('*')
        .eq('id', applicationId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as ApplicationRow | null;
    },
  });

  const row = application.data ?? null;

  const confirmCopy = useMemo(() => {
    if (!pending) return null;
    if (pending.type === 'retry') {
      return {
        title: 'Retry this application?',
        body: 'Your machine will re-run the browser automation from the last completed step. Nothing happens until the desktop is awake and online.',
        confirmLabel: 'Retry',
      };
    }
    return {
      title: `Mark as ${pending.label.toLowerCase()}?`,
      body: 'This records a real world outcome on the local database. It does not contact the employer.',
      confirmLabel: `Mark ${pending.label.toLowerCase()}`,
    };
  }, [pending]);

  const runPending = useCallback(async (): Promise<void> => {
    if (!pending) return;
    const action = pending;
    setPending(null);
    setSendError(null);
    setCommandId(null);
    try {
      const created = await sendCommand.mutateAsync(
        action.type === 'retry'
          ? { kind: 'application.retry', payload: { applicationId } }
          : { kind: 'application.set_status', payload: { applicationId, status: action.status } },
      );
      setCommandId(created.id);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : 'Could not reach Supabase.');
    }
  }, [applicationId, pending, sendCommand]);

  const commandBanner = useMemo(() => {
    if (sendError) return { tone: theme.colors.danger, text: `Not sent: ${sendError}` };
    if (!commandId) return null;
    const status = command.data?.status ?? 'pending';
    if (status === 'pending') {
      return { tone: theme.colors.warning, text: 'Queued - your machine will pick this up' };
    }
    if (status === 'claimed') {
      return { tone: theme.colors.primary, text: 'Your machine picked it up' };
    }
    if (status === 'succeeded') {
      return { tone: theme.colors.success, text: command.data?.result ?? 'Done' };
    }
    return {
      tone: theme.colors.danger,
      text: `Failed: ${command.data?.result ?? 'no reason reported'}`,
    };
  }, [command.data, commandId, sendError]);

  const busy = sendCommand.isPending;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: row?.company ?? 'Application' }} />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={application.isRefetching}
            onRefresh={() => void application.refetch()}
            tintColor={theme.colors.muted}
          />
        }
      >
        {application.isLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        ) : null}

        {application.isError ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Could not load this application</Text>
            <Text style={styles.muted}>
              {application.error instanceof Error ? application.error.message : 'Unknown error.'}
            </Text>
          </View>
        ) : null}

        {!application.isLoading && !application.isError && !row ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Not synced</Text>
            <Text style={styles.muted}>
              This application is not in the cloud mirror. It may have been pruned locally, or the
              desktop has not synced yet.
            </Text>
          </View>
        ) : null}

        {row ? (
          <>
            <View style={styles.card}>
              <Text style={styles.title}>{row.job_title ?? `Application #${row.id}`}</Text>
              <Text style={styles.company}>{row.company ?? 'Unknown company'}</Text>
              <View style={styles.pillRow}>
                <StatusPill status={row.status} />
                {row.dry_run ? (
                  <View style={[styles.pill, styles.dryRunPill]}>
                    <Ionicons name="flask-outline" size={12} color={theme.colors.warning} />
                    <Text style={[styles.pillText, { color: theme.colors.warning }]}>dry run</Text>
                  </View>
                ) : null}
              </View>
              {row.dry_run ? (
                <Text style={styles.muted}>
                  Dry run: every step ran except the final submit, so no employer received this.
                </Text>
              ) : null}
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Details</Text>
              <DetailRow label="Provider" value={humanize(row.provider)} />
              <DetailRow label="Attempts" value={`${row.attempts} / ${row.max_attempts}`} />
              <DetailRow
                label="Current step"
                value={row.current_step ? humanize(row.current_step) : '-'}
              />
              <DetailRow label="Started" value={formatDateTime(row.started_at)} />
              <DetailRow label="Submitted" value={formatDateTime(row.submitted_at)} />
              <DetailRow label="Last update" value={formatDateTime(row.updated_at)} />
            </View>

            {row.error ? (
              <View style={[styles.card, styles.errorCard]}>
                <View style={styles.errorHeader}>
                  <Ionicons name="warning-outline" size={16} color={theme.colors.danger} />
                  <Text style={styles.errorTitle}>Failure reason</Text>
                </View>
                {/* Diagnosing the failure is the whole point of this screen, so the
                    text is scrollable in both axes and selectable rather than clipped. */}
                <ScrollView
                  style={styles.errorScroll}
                  nestedScrollEnabled
                  showsVerticalScrollIndicator
                >
                  <ScrollView horizontal showsHorizontalScrollIndicator>
                    <Text selectable style={styles.errorText}>
                      {row.error}
                    </Text>
                  </ScrollView>
                </ScrollView>
              </View>
            ) : null}

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Actions</Text>
              <Text style={styles.muted}>
                Actions are queued for your desktop, which runs them the next time it polls.
              </Text>

              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => setPending({ type: 'retry' })}
                style={({ pressed }) => [
                  styles.primaryButton,
                  (pressed || busy) && styles.pressed,
                ]}
              >
                <Ionicons name="refresh" size={16} color={theme.colors.background} />
                <Text style={styles.primaryButtonText}>Retry application</Text>
              </Pressable>

              <Text style={styles.sectionLabel}>Record a real world outcome</Text>
              <View style={styles.outcomeRow}>
                {OUTCOMES.map((outcome) => {
                  const active = row.status === outcome.value;
                  const tone = toneFor(outcome.value);
                  return (
                    <Pressable
                      key={outcome.value}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      disabled={busy}
                      onPress={() =>
                        setPending({
                          type: 'set_status',
                          status: outcome.value,
                          label: outcome.label,
                        })
                      }
                      style={({ pressed }) => [
                        styles.outcomeButton,
                        active && { borderColor: tone, backgroundColor: `${tone}1f` },
                        (pressed || busy) && styles.pressed,
                      ]}
                    >
                      <Ionicons
                        name={outcome.icon}
                        size={16}
                        color={active ? tone : theme.colors.muted}
                      />
                      <Text style={[styles.outcomeText, active && { color: tone }]}>
                        {outcome.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {commandBanner ? (
                <View
                  style={[
                    styles.banner,
                    { borderColor: commandBanner.tone, backgroundColor: `${commandBanner.tone}1a` },
                  ]}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={commandBanner.tone} />
                  ) : (
                    <Ionicons name="ellipse" size={8} color={commandBanner.tone} />
                  )}
                  <Text style={[styles.bannerText, { color: commandBanner.tone }]}>
                    {commandBanner.text}
                  </Text>
                </View>
              ) : null}
            </View>

            <View style={styles.footerNote}>
              <Ionicons name="desktop-outline" size={14} color={theme.colors.muted} />
              <Text style={styles.footerNoteText}>
                Screenshots and the step-by-step HTML capture for this run stay on your desktop.
                They are never uploaded, so open the local dashboard to inspect them.
              </Text>
            </View>
          </>
        ) : null}
      </ScrollView>

      <ConfirmSheet
        visible={pending !== null}
        title={confirmCopy?.title ?? ''}
        body={confirmCopy?.body ?? ''}
        confirmLabel={confirmCopy?.confirmLabel ?? 'Confirm'}
        onConfirm={() => void runPending()}
        onCancel={() => setPending(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: 16, gap: 16, paddingBottom: 48 },
  centered: { paddingVertical: 48, alignItems: 'center' },
  card: {
    backgroundColor: theme.colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 16,
    gap: 8,
  },
  cardTitle: { color: theme.colors.text, fontSize: 15, fontWeight: '600' },
  title: { color: theme.colors.text, fontSize: 20, fontWeight: '700', lineHeight: 26 },
  company: { color: theme.colors.muted, fontSize: 15 },
  muted: { color: theme.colors.muted, fontSize: 13, lineHeight: 19 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  dryRunPill: { borderColor: theme.colors.warning, backgroundColor: `${theme.colors.warning}22` },
  pillText: { fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 16,
    paddingVertical: 6,
  },
  detailLabel: { color: theme.colors.muted, fontSize: 13 },
  detailValue: {
    color: theme.colors.text,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
    textAlign: 'right',
    textTransform: 'capitalize',
  },
  errorCard: { borderColor: `${theme.colors.danger}66` },
  errorHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  errorTitle: { color: theme.colors.danger, fontSize: 15, fontWeight: '600' },
  errorScroll: {
    maxHeight: 220,
    backgroundColor: theme.colors.background,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 12,
  },
  errorText: { color: theme.colors.text, fontFamily: MONO, fontSize: 12, lineHeight: 18 },
  primaryButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: theme.colors.primary,
    borderRadius: 12,
    paddingHorizontal: 16,
    marginTop: 4,
  },
  primaryButtonText: { color: theme.colors.background, fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.6 },
  sectionLabel: {
    color: theme.colors.muted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 8,
  },
  outcomeRow: { flexDirection: 'row', gap: 8 },
  outcomeButton: {
    flex: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 12,
    paddingHorizontal: 8,
  },
  outcomeText: { color: theme.colors.text, fontSize: 13, fontWeight: '600' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 8,
  },
  bannerText: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  footerNote: { flexDirection: 'row', gap: 8, paddingHorizontal: 4 },
  footerNoteText: { color: theme.colors.muted, fontSize: 12, lineHeight: 18, flexShrink: 1 },
});

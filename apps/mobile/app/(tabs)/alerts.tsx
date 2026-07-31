import { useCallback, useMemo, useState, type ComponentProps, type ReactElement } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { supabase } from '../../src/lib/supabase';
import { theme } from '../../src/lib/theme';

/**
 * Alerts screen.
 *
 * Notification bodies are composed on the host from operational metadata only,
 * so nothing rendered here can contain a resume, a cover letter, a credential
 * or contact details. Actions are issued as rows in `commands` and executed by
 * the host when it next polls, which is why a queued action shows an explicit
 * "your machine will pick this up" state rather than a spinner that never ends.
 */

const PAGE_SIZE = 25;

type IconName = ComponentProps<typeof Ionicons>['name'];
type Filter = 'all' | 'unread' | 'action';

interface NotificationRow {
  id: number;
  kind: string;
  level: string;
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: number | null;
  read: boolean;
  actionable: boolean;
  created_at: string;
}

interface InfiniteNotifications {
  pages: NotificationRow[][];
  pageParams: number[];
}

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'action', label: 'Needs action' },
];

const SELECT_COLUMNS =
  'id, kind, level, title, body, entity_type, entity_id, read, actionable, created_at';

function rows<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
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

function levelColor(level: string): string {
  switch (level) {
    case 'success':
      return theme.colors.success;
    case 'warning':
      return theme.colors.warning;
    case 'error':
      return theme.colors.danger;
    default:
      return theme.colors.primary;
  }
}

function kindIcon(kind: string): IconName {
  switch (kind) {
    case 'application.submitted':
      return 'checkmark-circle-outline';
    case 'application.failed':
      return 'alert-circle-outline';
    case 'application.needs_human':
      return 'hand-left-outline';
    case 'job.high_score':
      return 'sparkles-outline';
    case 'credential.expired':
      return 'key-outline';
    case 'collector.failed':
      return 'cloud-offline-outline';
    case 'queue.stalled':
      return 'pause-circle-outline';
    default:
      return 'information-circle-outline';
  }
}

async function fetchPage(filter: Filter, page: number): Promise<NotificationRow[]> {
  let query = supabase
    .from('notifications')
    .select(SELECT_COLUMNS)
    .order('created_at', { ascending: false })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
  if (filter === 'unread') query = query.eq('read', false);
  if (filter === 'action') query = query.eq('actionable', true);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return rows<NotificationRow>(data);
}

async function fetchUnreadCount(): Promise<number> {
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('read', false);
  if (error) throw new Error(error.message);
  return count ?? 0;
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
  // RLS requires user_id = auth.uid() on insert, so it must come from the live
  // session rather than anything the UI happens to be holding.
  const { data, error: authError } = await supabase.auth.getUser();
  if (authError) throw new Error(authError.message);
  const userId = data.user?.id;
  if (!userId) throw new Error('You are signed out. Sign in again to send commands.');

  const { error } = await supabase
    .from('commands')
    .insert({ user_id: userId, kind: 'application.retry', payload: { applicationId } });
  if (error) throw new Error(error.message);
}

export default function AlertsScreen(): ReactElement {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const [refreshing, setRefreshing] = useState(false);

  const feed = useInfiniteQuery({
    queryKey: ['notifications', 'feed', filter],
    queryFn: ({ pageParam }) => fetchPage(filter, pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage: NotificationRow[], allPages: NotificationRow[][]) =>
      lastPage.length < PAGE_SIZE ? undefined : allPages.length,
    refetchInterval: 60_000,
  });

  const unread = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: fetchUnreadCount,
    refetchInterval: 60_000,
  });

  const pendingRetries = useQuery({
    queryKey: ['commands', 'pending-retries'],
    queryFn: fetchPendingRetries,
    refetchInterval: 15_000,
  });

  const invalidate = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  }, [queryClient]);

  /** Patch every cached filter view so the list does not flicker back. */
  const patchCaches = useCallback(
    (patch: (row: NotificationRow) => NotificationRow | null) => {
      for (const value of FILTERS) {
        queryClient.setQueryData<InfiniteNotifications>(
          ['notifications', 'feed', value.value],
          (current) =>
            current
              ? {
                  ...current,
                  pages: current.pages.map((page) =>
                    page.map(patch).filter((row): row is NotificationRow => row !== null),
                  ),
                }
              : current,
        );
      }
    },
    [queryClient],
  );

  const markRead = useMutation({
    mutationFn: async (id: number) => {
      const { error } = await supabase.from('notifications').update({ read: true }).eq('id', id);
      if (error) throw new Error(error.message);
    },
    onMutate: (id: number) => {
      patchCaches((row) => (row.id === id ? { ...row, read: true } : row));
    },
    onError: (error: unknown) => {
      Alert.alert(
        'Could not mark the alert read',
        error instanceof Error ? error.message : 'Unknown error',
      );
    },
    onSettled: invalidate,
  });

  const markAllRead = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('notifications')
        .update({ read: true })
        .eq('read', false);
      if (error) throw new Error(error.message);
    },
    onMutate: () => {
      patchCaches((row) => (row.read ? row : { ...row, read: true }));
    },
    onError: (error: unknown) => {
      Alert.alert(
        'Could not mark all read',
        error instanceof Error ? error.message : 'Unknown error',
      );
    },
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (id: number) => {
      const { error } = await supabase.from('notifications').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },
    onMutate: (id: number) => {
      patchCaches((row) => (row.id === id ? null : row));
    },
    onError: (error: unknown) => {
      Alert.alert(
        'Could not delete the alert',
        error instanceof Error ? error.message : 'Unknown error',
      );
    },
    onSettled: invalidate,
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
    void Promise.all([feed.refetch(), unread.refetch(), pendingRetries.refetch()]).finally(() =>
      setRefreshing(false),
    );
  }, [feed, unread, pendingRetries]);

  const items = useMemo(() => (feed.data?.pages ?? []).flat(), [feed.data]);
  const pendingSet = useMemo(() => new Set(pendingRetries.data ?? []), [pendingRetries.data]);

  const openEntity = useCallback(
    (row: NotificationRow): void => {
      if (row.entity_id === null) return;
      const id = String(row.entity_id);
      if (row.entity_type === 'application') {
        router.push({ pathname: '/application/[id]', params: { id } });
        return;
      }
      if (row.entity_type === 'job') {
        router.push({ pathname: '/job/[id]', params: { id } });
      }
    },
    [router],
  );

  const confirmDelete = useCallback(
    (row: NotificationRow): void => {
      Alert.alert('Delete this alert?', row.title, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => remove.mutate(row.id) },
      ]);
    },
    [remove],
  );

  const unreadCount = unread.data ?? 0;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View>
            <Text style={styles.heading}>Alerts</Text>
            <Text style={styles.subheading}>
              {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
            </Text>
          </View>
          <Pressable
            style={({ pressed }) => [
              styles.markAll,
              pressed && styles.markAllPressed,
              unreadCount === 0 && styles.markAllDisabled,
            ]}
            onPress={() => markAllRead.mutate()}
            disabled={unreadCount === 0 || markAllRead.isPending}
            accessibilityRole="button"
            accessibilityLabel="Mark all alerts read"
          >
            {markAllRead.isPending ? (
              <ActivityIndicator size="small" color={theme.colors.primary} />
            ) : (
              <>
                <Ionicons
                  name="checkmark-done-outline"
                  size={16}
                  color={unreadCount === 0 ? theme.colors.muted : theme.colors.primary}
                />
                <Text
                  style={[styles.markAllText, unreadCount === 0 && { color: theme.colors.muted }]}
                >
                  Mark all read
                </Text>
              </>
            )}
          </Pressable>
        </View>

        <View style={styles.chips}>
          {FILTERS.map((option) => {
            const active = option.value === filter;
            return (
              <Pressable
                key={option.value}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => setFilter(option.value)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <FlatList
        data={items}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={items.length === 0 ? styles.emptyContent : styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.colors.muted}
            colors={[theme.colors.primary]}
            progressBackgroundColor={theme.colors.card}
          />
        }
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
        }}
        renderItem={({ item }) => (
          <AlertRow
            row={item}
            queued={item.entity_id !== null && pendingSet.has(item.entity_id)}
            busy={retry.isPending && retry.variables === item.entity_id}
            onPress={() => {
              if (!item.read) markRead.mutate(item.id);
              openEntity(item);
            }}
            onLongPress={() => confirmDelete(item)}
            onRetry={() => {
              if (item.entity_id !== null) retry.mutate(item.entity_id);
            }}
          />
        )}
        ListEmptyComponent={
          feed.isLoading ? (
            <ActivityIndicator color={theme.colors.primary} />
          ) : (
            <EmptyState filter={filter} error={feed.error} />
          )
        }
        ListFooterComponent={
          feed.isFetchingNextPage ? (
            <ActivityIndicator style={styles.footer} color={theme.colors.muted} />
          ) : items.length > 0 && !feed.hasNextPage ? (
            <Text style={styles.footerText}>That is everything your machine has sent.</Text>
          ) : null
        }
      />
    </View>
  );
}

function EmptyState({ filter, error }: { filter: Filter; error: unknown }): ReactElement {
  if (error) {
    return (
      <View style={styles.empty}>
        <Ionicons name="warning-outline" size={22} color={theme.colors.danger} />
        <Text style={styles.emptyTitle}>Could not load alerts</Text>
        <Text style={styles.emptyBody}>
          {error instanceof Error ? error.message : 'The sync database is unreachable.'}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.empty}>
      <Ionicons name="notifications-off-outline" size={22} color={theme.colors.muted} />
      <Text style={styles.emptyTitle}>
        {filter === 'unread'
          ? 'No unread alerts'
          : filter === 'action'
            ? 'Nothing needs you'
            : 'No alerts yet'}
      </Text>
      <Text style={styles.emptyBody}>
        Alerts arrive when your machine finishes a run, gets stuck, or spots a high scoring job.
      </Text>
    </View>
  );
}

function AlertRow({
  row,
  queued,
  busy,
  onPress,
  onLongPress,
  onRetry,
}: {
  row: NotificationRow;
  queued: boolean;
  busy: boolean;
  onPress: () => void;
  onLongPress: () => void;
  onRetry: () => void;
}): ReactElement {
  const accent = levelColor(row.level);
  const canRetry =
    row.actionable &&
    row.entity_type === 'application' &&
    row.entity_id !== null &&
    (row.kind === 'application.failed' || row.kind === 'application.needs_human');
  const credentialAction = row.kind === 'credential.expired';

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel={`${row.title}. ${row.body}`}
      accessibilityHint="Long press to delete"
    >
      <View style={[styles.accent, { backgroundColor: accent }]} />
      <View style={styles.rowBody}>
        <View style={styles.rowHeader}>
          <Ionicons name={kindIcon(row.kind)} size={16} color={accent} />
          <Text style={[styles.rowTitle, !row.read && styles.rowTitleUnread]} numberOfLines={2}>
            {row.title}
          </Text>
          {!row.read ? <View style={[styles.unreadDot, { backgroundColor: accent }]} /> : null}
        </View>
        {row.body ? (
          <Text style={styles.rowText} numberOfLines={3}>
            {row.body}
          </Text>
        ) : null}
        <Text style={styles.rowMeta}>
          {row.kind.replace(/[._]/g, ' ')} - {relativeTime(row.created_at)}
        </Text>

        {canRetry ? (
          queued ? (
            <View style={styles.queuedNote}>
              <Ionicons name="time-outline" size={14} color={theme.colors.warning} />
              <Text style={styles.queuedText}>Queued - your machine will pick this up</Text>
            </View>
          ) : (
            <Pressable
              style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
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
                  <Text style={styles.actionText}>Retry application</Text>
                </>
              )}
            </Pressable>
          )
        ) : null}

        {credentialAction ? (
          <View style={styles.note}>
            <Ionicons name="lock-closed-outline" size={14} color={theme.colors.warning} />
            <Text style={styles.noteText}>
              Paste a fresh session on the desktop dashboard. Sessions never leave your machine, so
              the phone cannot hold or refresh them.
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },

  header: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  heading: { color: theme.colors.text, fontSize: 28, fontWeight: '700' },
  subheading: { color: theme.colors.muted, fontSize: 13, marginTop: 2 },
  markAll: {
    minHeight: 44,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
  },
  markAllPressed: { borderColor: theme.colors.primary },
  markAllDisabled: { opacity: 0.5 },
  markAllText: { color: theme.colors.primary, fontSize: 13, fontWeight: '600' },

  chips: { flexDirection: 'row', gap: 8 },
  chip: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
  },
  chipActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary },
  chipText: { color: theme.colors.muted, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: theme.colors.background },

  listContent: { padding: 16, paddingBottom: 48, gap: 8 },
  emptyContent: { flexGrow: 1, padding: 24, justifyContent: 'center' },

  row: {
    flexDirection: 'row',
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
    minHeight: 64,
  },
  rowPressed: { borderColor: theme.colors.primary },
  accent: { width: 3 },
  rowBody: { flex: 1, padding: 12, gap: 4 },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitle: { flex: 1, color: theme.colors.text, fontSize: 15 },
  rowTitleUnread: { fontWeight: '700' },
  unreadDot: { width: 8, height: 8, borderRadius: 4 },
  rowText: { color: theme.colors.muted, fontSize: 13, lineHeight: 19 },
  rowMeta: { color: theme.colors.muted, fontSize: 11, opacity: 0.8 },

  action: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    marginTop: 8,
  },
  actionPressed: { borderColor: theme.colors.primary },
  actionText: { color: theme.colors.primary, fontSize: 14, fontWeight: '600' },

  queuedNote: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 8,
  },
  queuedText: { color: theme.colors.warning, fontSize: 12 },

  note: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  noteText: { flex: 1, color: theme.colors.muted, fontSize: 12, lineHeight: 18 },

  empty: { alignItems: 'center', gap: 8 },
  emptyTitle: { color: theme.colors.text, fontSize: 16, fontWeight: '600' },
  emptyBody: { color: theme.colors.muted, fontSize: 13, lineHeight: 19, textAlign: 'center' },

  footer: { paddingVertical: 16 },
  footerText: {
    color: theme.colors.muted,
    fontSize: 12,
    textAlign: 'center',
    paddingVertical: 16,
  },
});

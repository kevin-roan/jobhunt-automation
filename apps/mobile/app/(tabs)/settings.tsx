import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import type { Session } from '@supabase/supabase-js';

import { theme } from '../../src/lib/theme';
import { supabase } from '../../src/lib/supabase';
import { ConfirmSheet } from '../../src/components/ConfirmSheet';
import type { QueueStatsRow } from '@/lib/types';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

interface DeviceRow {
  id: string;
  expo_push_token: string;
}

/** What this app is able to read, stated plainly rather than left to trust. */
const CAN_SEE = [
  'Job titles, companies, locations, salary ranges and scores',
  'Application status, step, attempt count and failure reason',
  'Queue counters and notification headlines',
];

/** What never leaves the host machine, and therefore cannot appear here. */
const CANNOT_SEE = [
  'Your resume, tailored resumes and cover letter text',
  'Your name, email, phone, address and any profile detail',
  'Job board cookies, sessions and tokens',
  'LLM prompts, LLM responses and the LLM api key',
  'Screenshots, HTML captures and the local encryption key',
];

function readProjectId(): string | undefined {
  const extra: unknown = Constants.expoConfig?.extra;
  if (typeof extra === 'object' && extra !== null) {
    const eas: unknown = (extra as Record<string, unknown>).eas;
    if (typeof eas === 'object' && eas !== null) {
      const projectId: unknown = (eas as Record<string, unknown>).projectId;
      if (typeof projectId === 'string' && projectId.length > 0) return projectId;
    }
  }
  const fromEas: unknown = Constants.easConfig?.projectId;
  return typeof fromEas === 'string' && fromEas.length > 0 ? fromEas : undefined;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function Card({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

function BulletList({ items, tone, icon }: {
  items: string[];
  tone: string;
  icon: 'checkmark-circle' | 'close-circle';
}): JSX.Element {
  return (
    <View style={styles.bulletList}>
      {items.map((item) => (
        <View key={item} style={styles.bulletRow}>
          <Ionicons name={icon} size={14} color={tone} style={styles.bulletIcon} />
          <Text style={styles.bulletText}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

export default function SettingsScreen(): JSX.Element {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const userId = session?.user.id ?? null;

  const stats = useQuery({
    queryKey: ['queue-stats'],
    refetchInterval: 30_000,
    queryFn: async (): Promise<QueueStatsRow | null> => {
      const { data, error } = await supabase.from('queue_stats').select('*').maybeSingle();
      if (error) throw new Error(error.message);
      return data as QueueStatsRow | null;
    },
  });

  const permission = useQuery({
    queryKey: ['push-permission'],
    queryFn: () => Notifications.getPermissionsAsync(),
  });

  const granted = permission.data?.granted === true;

  const pushToken = useQuery({
    queryKey: ['push-token'],
    enabled: granted,
    staleTime: Infinity,
    queryFn: async (): Promise<string> => {
      const projectId = readProjectId();
      const result = await Notifications.getExpoPushTokenAsync(
        projectId ? { projectId } : undefined,
      );
      return result.data;
    },
  });

  const token = pushToken.data ?? null;

  const device = useQuery({
    queryKey: ['device', token],
    enabled: token !== null,
    queryFn: async (): Promise<DeviceRow | null> => {
      if (!token) return null;
      const { data, error } = await supabase
        .from('devices')
        .select('id, expo_push_token')
        .eq('expo_push_token', token)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as DeviceRow | null;
    },
  });

  const pushEnabled = granted && device.data !== null && device.data !== undefined;

  const togglePush = useMutation({
    mutationFn: async (next: boolean): Promise<void> => {
      if (!userId) throw new Error('Not signed in.');
      if (!next) {
        if (!token) return;
        const { error } = await supabase.from('devices').delete().eq('expo_push_token', token);
        if (error) throw new Error(error.message);
        return;
      }
      let status = permission.data;
      if (status?.granted !== true) {
        status = await Notifications.requestPermissionsAsync();
        queryClient.setQueryData(['push-permission'], status);
      }
      if (status.granted !== true) {
        throw new Error('Notification permission was denied. Enable it in your system settings.');
      }
      const projectId = readProjectId();
      const issued = await Notifications.getExpoPushTokenAsync(
        projectId ? { projectId } : undefined,
      );
      queryClient.setQueryData(['push-token'], issued.data);
      // The Expo token is an opaque delivery address, not a credential for any
      // job board, so it is the one device-scoped value the mirror may hold.
      const { error } = await supabase.from('devices').upsert(
        {
          user_id: userId,
          expo_push_token: issued.data,
          platform: Platform.OS,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: 'expo_push_token' },
      );
      if (error) throw new Error(error.message);
    },
    onMutate: () => setPushError(null),
    onError: (error: unknown) =>
      setPushError(error instanceof Error ? error.message : 'Could not update push settings.'),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['push-permission'] });
      void queryClient.invalidateQueries({ queryKey: ['device'] });
    },
  });

  const copyUserId = useCallback(async (): Promise<void> => {
    if (!userId) return;
    await Clipboard.setStringAsync(userId);
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 2000);
  }, [userId]);

  const connected = !stats.isError;
  const connectionTone = stats.isLoading
    ? theme.colors.muted
    : connected
      ? theme.colors.success
      : theme.colors.danger;

  const permissionLabel = permission.isLoading
    ? 'checking'
    : granted
      ? 'granted'
      : permission.data?.canAskAgain === false
        ? 'blocked in system settings'
        : 'not requested';

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Card title="Account">
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Signed in as</Text>
            <Text style={styles.detailValue} numberOfLines={1}>
              {session?.user.email ?? '-'}
            </Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Supabase</Text>
            <View style={styles.statusInline}>
              <Ionicons name="ellipse" size={8} color={connectionTone} />
              <Text style={[styles.detailValue, { color: connectionTone }]}>
                {stats.isLoading ? 'connecting' : connected ? 'connected' : 'unreachable'}
              </Text>
            </View>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Last sync from desktop</Text>
            <Text style={styles.detailValue}>{relativeTime(stats.data?.updated_at)}</Text>
          </View>
          {stats.data ? (
            <Text style={styles.muted}>
              Worker is {stats.data.worker_running ? 'running' : 'stopped'} - {stats.data.pending}{' '}
              pending, {stats.data.active} active, {stats.data.failed} failed.
            </Text>
          ) : null}
        </Card>

        <Card title="Pair with your desktop">
          <Text style={styles.muted}>
            Open the local dashboard, go to Settings then Mobile sync, and paste this user id. Your
            machine stamps every row it uploads with it, which is how this phone finds your data and
            how your commands find your machine.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy user id"
            onPress={() => void copyUserId()}
            style={({ pressed }) => [styles.idBox, pressed && styles.pressed]}
          >
            <Text selectable style={styles.idText}>
              {userId ?? 'signed out'}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!userId}
            onPress={() => void copyUserId()}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          >
            <Ionicons
              name={copied ? 'checkmark' : 'copy-outline'}
              size={16}
              color={copied ? theme.colors.success : theme.colors.text}
            />
            <Text style={[styles.secondaryButtonText, copied && { color: theme.colors.success }]}>
              {copied ? 'Copied' : 'Copy user id'}
            </Text>
          </Pressable>
        </Card>

        <Card title="Push notifications">
          <View style={styles.switchRow}>
            <View style={styles.switchCopy}>
              <Text style={styles.switchLabel}>Alerts from your machine</Text>
              <Text style={styles.muted}>
                Submissions, failures and anything needing a human. Titles and bodies only, composed
                on your machine from metadata.
              </Text>
            </View>
            {togglePush.isPending ? (
              <ActivityIndicator color={theme.colors.primary} />
            ) : (
              <Switch
                value={pushEnabled}
                disabled={!userId}
                onValueChange={(next) => togglePush.mutate(next)}
                trackColor={{ false: theme.colors.border, true: `${theme.colors.primary}99` }}
                thumbColor={pushEnabled ? theme.colors.primary : theme.colors.muted}
              />
            )}
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Permission</Text>
            <Text style={styles.detailValue}>{permissionLabel}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>This device</Text>
            <Text style={styles.detailValue}>{pushEnabled ? 'registered' : 'not registered'}</Text>
          </View>
          {pushError ? <Text style={styles.errorText}>{pushError}</Text> : null}
        </Card>

        <Card title="What this app can see">
          <Text style={styles.muted}>
            The cloud mirror holds operational metadata so this phone can watch progress without
            your machine exposing a port. Everything else stays local.
          </Text>
          <BulletList items={CAN_SEE} tone={theme.colors.success} icon="checkmark-circle" />
          <Text style={styles.sectionLabel}>Never uploaded</Text>
          <BulletList items={CANNOT_SEE} tone={theme.colors.danger} icon="close-circle" />
          <Text style={styles.muted}>
            This app talks only to Supabase. It never connects to your machine directly - taps
            become queued commands your desktop picks up on its next poll.
          </Text>
        </Card>

        <Pressable
          accessibilityRole="button"
          onPress={() => setConfirmSignOut(true)}
          style={({ pressed }) => [styles.dangerButton, pressed && styles.pressed]}
        >
          <Ionicons name="log-out-outline" size={16} color={theme.colors.danger} />
          <Text style={styles.dangerButtonText}>Sign out</Text>
        </Pressable>

        <Text style={styles.version}>
          {Constants.expoConfig?.name ?? 'deedy'} {Constants.expoConfig?.version ?? ''}
        </Text>
      </ScrollView>

      <ConfirmSheet
        visible={confirmSignOut}
        title="Sign out?"
        body="Your session is removed from this device. Cached data is cleared and push alerts stop until you sign in again."
        confirmLabel="Sign out"
        onConfirm={() => {
          setConfirmSignOut(false);
          void supabase.auth.signOut().then(() => queryClient.clear());
        }}
        onCancel={() => setConfirmSignOut(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: 16, gap: 16, paddingBottom: 48 },
  card: {
    backgroundColor: theme.colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 16,
    gap: 8,
  },
  cardTitle: { color: theme.colors.text, fontSize: 15, fontWeight: '600' },
  muted: { color: theme.colors.muted, fontSize: 13, lineHeight: 19 },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
    paddingVertical: 6,
  },
  detailLabel: { color: theme.colors.muted, fontSize: 13, flexShrink: 0 },
  detailValue: {
    color: theme.colors.text,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
    textAlign: 'right',
  },
  statusInline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  idBox: {
    backgroundColor: theme.colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 16,
    minHeight: 44,
    justifyContent: 'center',
  },
  idText: {
    color: theme.colors.text,
    fontFamily: MONO,
    fontSize: 16,
    lineHeight: 24,
    letterSpacing: 0.5,
  },
  secondaryButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 12,
    paddingHorizontal: 16,
  },
  secondaryButtonText: { color: theme.colors.text, fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.6 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 16, minHeight: 44 },
  switchCopy: { flex: 1, gap: 4 },
  switchLabel: { color: theme.colors.text, fontSize: 14, fontWeight: '600' },
  sectionLabel: {
    color: theme.colors.muted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 8,
  },
  bulletList: { gap: 6, marginTop: 4 },
  bulletRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  bulletIcon: { marginTop: 2 },
  bulletText: { color: theme.colors.text, fontSize: 13, lineHeight: 19, flexShrink: 1 },
  errorText: { color: theme.colors.danger, fontSize: 13, lineHeight: 19 },
  dangerButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: `${theme.colors.danger}66`,
    backgroundColor: `${theme.colors.danger}14`,
    borderRadius: 12,
  },
  dangerButtonText: { color: theme.colors.danger, fontSize: 15, fontWeight: '700' },
  version: { color: theme.colors.muted, fontSize: 11, textAlign: 'center' },
});

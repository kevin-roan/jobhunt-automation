import * as React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../../src/lib/theme';
import { supabase } from '../../src/lib/supabase';

const PAGE_SIZE = 25;

/**
 * Shape of a row in the cloud `jobs` mirror. It is deliberately narrower than
 * the local JobDto: descriptions, skills, summaries and AI reasoning never
 * leave the host machine, so there is nothing here to render them from.
 */
interface JobRow {
  id: number;
  title: string;
  company: string;
  location: string | null;
  source: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  score: number | null;
  recommendation: string | null;
  status: string;
  application_url: string;
  posted_at: string | null;
  collected_at: string;
}

const JOB_STATUS_FILTERS = [
  'new',
  'scored',
  'queued',
  'applying',
  'applied',
  'skipped',
  'failed',
  'manual_review',
] as const;

const MIN_SCORE_FILTERS = [60, 70, 80, 90] as const;

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

function scoreColor(score: number): string {
  if (score >= 80) return theme.colors.success;
  if (score >= 60) return theme.colors.primary;
  if (score >= 40) return theme.colors.warning;
  return theme.colors.danger;
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

function compactMoney(value: number): string {
  return value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(Math.round(value));
}

function formatSalary(job: JobRow): string | null {
  if (job.salary_min === null && job.salary_max === null) return null;
  const unit = job.salary_currency ?? '';
  const range =
    job.salary_min !== null && job.salary_max !== null
      ? `${compactMoney(job.salary_min)}-${compactMoney(job.salary_max)}`
      : compactMoney(job.salary_min ?? job.salary_max ?? 0);
  return `${unit} ${range}`.trim();
}

/**
 * PostgREST splits an `or=` filter on commas and treats parentheses as
 * grouping, so an unescaped search term could rewrite the filter it sits
 * inside. Neutralise the operators rather than trying to quote them.
 */
function sanitiseSearch(input: string): string {
  return input.replace(/[,()\\%*]/g, ' ').trim();
}

interface JobsQueryKey {
  search: string;
  status: string | null;
  minScore: number | null;
}

async function fetchJobs(filters: JobsQueryKey, page: number): Promise<JobRow[]> {
  const from = page * PAGE_SIZE;
  let query = supabase
    .from('jobs')
    .select(
      'id,title,company,location,source,salary_min,salary_max,salary_currency,score,recommendation,status,application_url,posted_at,collected_at',
    )
    .order('collected_at', { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  if (filters.search) {
    query = query.or(`title.ilike.%${filters.search}%,company.ilike.%${filters.search}%`);
  }
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.minScore !== null) query = query.gte('score', filters.minScore);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as JobRow[];
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

function JobCard({ job, onPress }: { job: JobRow; onPress: () => void }): React.JSX.Element {
  const salary = formatSalary(job);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.cardTop}>
        <View
          style={[
            styles.scoreBadge,
            {
              borderColor: job.score === null ? theme.colors.border : scoreColor(job.score),
            },
          ]}
        >
          <Text
            style={[
              styles.scoreText,
              { color: job.score === null ? theme.colors.muted : scoreColor(job.score) },
            ]}
          >
            {job.score === null ? '-' : Math.round(job.score)}
          </Text>
        </View>
        <View style={styles.cardHeadings}>
          <Text style={styles.title} numberOfLines={2}>
            {job.title}
          </Text>
          <Text style={styles.company} numberOfLines={1}>
            {job.company}
            {job.location ? ` · ${job.location}` : ''}
          </Text>
        </View>
      </View>
      <View style={styles.cardMeta}>
        <View style={[styles.pill, { borderColor: statusColor(job.status) }]}>
          <Text style={[styles.pillText, { color: statusColor(job.status) }]}>
            {job.status.replace(/_/g, ' ')}
          </Text>
        </View>
        <Text style={styles.metaText}>{job.source}</Text>
        {salary ? <Text style={styles.metaText}>{salary}</Text> : null}
        <Text style={styles.metaTime}>{relativeTime(job.collected_at)}</Text>
      </View>
    </Pressable>
  );
}

export default function JobsScreen(): React.JSX.Element {
  const router = useRouter();
  const [search, setSearch] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [status, setStatus] = React.useState<string | null>(null);
  const [minScore, setMinScore] = React.useState<number | null>(null);

  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(sanitiseSearch(search)), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const filters: JobsQueryKey = { search: debounced, status, minScore };

  const jobs = useInfiniteQuery({
    queryKey: ['jobs', filters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchJobs(filters, pageParam),
    getNextPageParam: (lastPage: JobRow[], allPages: JobRow[][]) =>
      lastPage.length < PAGE_SIZE ? undefined : allPages.length,
  });

  const rows = React.useMemo(() => jobs.data?.pages.flat() ?? [], [jobs.data]);

  const listBody = ((): React.JSX.Element | null => {
    if (jobs.isPending) {
      return (
        <View style={styles.state}>
          <ActivityIndicator color={theme.colors.primary} />
          <Text style={styles.stateText}>Loading jobs from your synced mirror...</Text>
        </View>
      );
    }
    if (jobs.isError) {
      return (
        <View style={styles.state}>
          <Ionicons name="cloud-offline-outline" size={32} color={theme.colors.danger} />
          <Text style={styles.stateTitle}>Could not load jobs</Text>
          <Text style={styles.stateText}>
            {jobs.error instanceof Error ? jobs.error.message : 'Unknown error'}
          </Text>
          <Pressable
            accessibilityRole="button"
            style={styles.retryButton}
            onPress={() => void jobs.refetch()}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      );
    }
    if (rows.length === 0) {
      return (
        <View style={styles.state}>
          <Ionicons name="briefcase-outline" size={32} color={theme.colors.muted} />
          <Text style={styles.stateTitle}>No jobs match</Text>
          <Text style={styles.stateText}>
            Adjust the filters, or run a collector on your machine to pull in new postings.
          </Text>
        </View>
      );
    }
    return null;
  })();

  return (
    <View style={styles.screen}>
      <View style={styles.controls}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={16} color={theme.colors.muted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search title or company"
            placeholderTextColor={theme.colors.muted}
            style={styles.searchInput}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
          />
          {search.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              hitSlop={12}
              onPress={() => setSearch('')}
            >
              <Ionicons name="close-circle" size={18} color={theme.colors.muted} />
            </Pressable>
          ) : null}
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          <Chip label="All" active={status === null} onPress={() => setStatus(null)} />
          {JOB_STATUS_FILTERS.map((value) => (
            <Chip
              key={value}
              label={value.replace(/_/g, ' ')}
              active={status === value}
              onPress={() => setStatus(status === value ? null : value)}
            />
          ))}
        </ScrollView>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          <Chip label="Any score" active={minScore === null} onPress={() => setMinScore(null)} />
          {MIN_SCORE_FILTERS.map((value) => (
            <Chip
              key={value}
              label={`${value}+`}
              active={minScore === value}
              onPress={() => setMinScore(minScore === value ? null : value)}
            />
          ))}
        </ScrollView>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => (
          <JobCard
            job={item}
            onPress={() => router.push({ pathname: '/job/[id]', params: { id: String(item.id) } })}
          />
        )}
        contentContainerStyle={rows.length === 0 ? styles.listEmpty : styles.list}
        ListEmptyComponent={listBody}
        ListFooterComponent={
          jobs.isFetchingNextPage ? (
            <ActivityIndicator style={styles.footer} color={theme.colors.primary} />
          ) : null
        }
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (jobs.hasNextPage && !jobs.isFetchingNextPage) void jobs.fetchNextPage();
        }}
        refreshControl={
          <RefreshControl
            refreshing={jobs.isRefetching && !jobs.isFetchingNextPage}
            onRefresh={() => void jobs.refetch()}
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
    paddingTop: 8,
    paddingBottom: 8,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 44,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  searchInput: { flex: 1, color: theme.colors.text, fontSize: 15, padding: 0 },
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
  list: { padding: 16, gap: 8, paddingBottom: 32 },
  listEmpty: { flexGrow: 1, padding: 16 },
  card: {
    backgroundColor: theme.colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 12,
    gap: 8,
  },
  cardPressed: { opacity: 0.7 },
  cardTop: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  cardHeadings: { flex: 1, gap: 2 },
  scoreBadge: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scoreText: { fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  title: { color: theme.colors.text, fontSize: 15, fontWeight: '600' },
  company: { color: theme.colors.muted, fontSize: 13 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, borderWidth: 1 },
  pillText: { fontSize: 11, fontWeight: '600', textTransform: 'capitalize' },
  metaText: { color: theme.colors.muted, fontSize: 12 },
  metaTime: {
    color: theme.colors.muted,
    fontSize: 12,
    marginLeft: 'auto',
    fontVariant: ['tabular-nums'],
  },
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

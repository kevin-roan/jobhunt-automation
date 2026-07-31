import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { theme } from '../lib/theme';

export interface TimelineStep {
  id: string | number;
  /** Pipeline step name, e.g. "upload_resume". Underscores are humanised on render. */
  step: string;
  /** Step status: pending, running, succeeded, failed, skipped. */
  status: string;
  attempt: number;
  message?: string | null;
  error?: string | null;
  /** ISO timestamp of when the step last changed. */
  at?: string | null;
}

export interface TimelineProps {
  steps: TimelineStep[];
  /** Shown when the application has not reported any step yet. */
  emptyLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

function humanise(value: string): string {
  return value.replace(/_/g, ' ');
}

function relativeTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((then - Date.now()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000],
    ['month', 2592000],
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
  return '';
}

interface AttemptGroup {
  attempt: number;
  steps: TimelineStep[];
}

/** Newest attempt first; steps stay in the order the worker reported them. */
function groupByAttempt(steps: TimelineStep[]): AttemptGroup[] {
  const groups = new Map<number, TimelineStep[]>();
  for (const step of steps) {
    const bucket = groups.get(step.attempt);
    if (bucket === undefined) {
      groups.set(step.attempt, [step]);
    } else {
      bucket.push(step);
    }
  }
  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([attempt, grouped]) => ({ attempt, steps: grouped }));
}

function StepRow({ step, last }: { step: TimelineStep; last: boolean }): React.JSX.Element {
  const color = theme.statusColor(step.status);
  const when = relativeTime(step.at);
  const detail = step.error ?? step.message ?? null;
  const label = [
    humanise(step.step),
    humanise(step.status),
    when,
    detail === null ? '' : detail,
  ]
    .filter((part) => part !== '')
    .join(', ');

  return (
    <View accessible accessibilityRole="text" accessibilityLabel={label} style={styles.row}>
      <View style={styles.rail}>
        <View style={[styles.dot, { backgroundColor: color, borderColor: `${color}59` }]} />
        {last ? null : <View style={styles.connector} />}
      </View>
      <View style={styles.content}>
        <View style={styles.headline}>
          <Text numberOfLines={1} style={styles.step}>
            {humanise(step.step)}
          </Text>
          {when === '' ? null : <Text style={styles.time}>{when}</Text>}
        </View>
        <Text style={[styles.status, { color }]}>{humanise(step.status)}</Text>
        {detail === null || detail === '' ? null : (
          <Text
            style={
              step.error === null || step.error === undefined ? styles.message : styles.error
            }
          >
            {detail}
          </Text>
        )}
      </View>
    </View>
  );
}

export function Timeline({
  steps,
  emptyLabel = 'No steps recorded yet.',
  style,
  testID,
}: TimelineProps): React.JSX.Element {
  const groups = React.useMemo(() => groupByAttempt(steps), [steps]);

  if (groups.length === 0) {
    return (
      <View style={[styles.container, style]} testID={testID}>
        <Text style={styles.empty}>{emptyLabel}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, style]} testID={testID}>
      {groups.map((group) => (
        <View key={group.attempt}>
          <Text accessibilityRole="header" style={styles.groupHeader}>
            {`Attempt ${group.attempt}`}
          </Text>
          {group.steps.map((step, index) => (
            <StepRow key={step.id} step={step} last={index === group.steps.length - 1} />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: theme.spacing.lg,
  },
  groupHeader: {
    color: theme.colors.muted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: theme.spacing.sm,
  },
  row: {
    flexDirection: 'row',
    gap: theme.spacing.md,
  },
  rail: {
    alignItems: 'center',
    width: 14,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: theme.radius.pill,
    borderWidth: 3,
    marginTop: 4,
  },
  connector: {
    flex: 1,
    width: 2,
    backgroundColor: theme.colors.border,
    marginTop: 2,
  },
  content: {
    flex: 1,
    paddingBottom: theme.spacing.lg,
  },
  headline: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  step: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  time: {
    color: theme.colors.muted,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  status: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  message: {
    marginTop: theme.spacing.xs,
    color: theme.colors.muted,
    fontSize: 12,
    lineHeight: 17,
  },
  error: {
    marginTop: theme.spacing.xs,
    color: theme.colors.danger,
    fontSize: 12,
    lineHeight: 17,
  },
});

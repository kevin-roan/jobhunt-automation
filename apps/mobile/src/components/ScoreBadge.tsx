import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { theme } from '../lib/theme';

export interface ScoreBadgeProps {
  /** Match score, 0-100. Null renders a neutral placeholder. */
  score: number | null | undefined;
  size?: 'sm' | 'md' | 'lg';
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function scoreColor(score: number): string {
  if (score >= 75) return theme.colors.success;
  if (score >= 50) return theme.colors.warning;
  return theme.colors.danger;
}

export function ScoreBadge({
  score,
  size = 'md',
  style,
  testID,
}: ScoreBadgeProps): React.JSX.Element {
  if (score === null || score === undefined || Number.isNaN(score)) {
    return (
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel="Not scored yet"
        testID={testID}
        style={[styles.badge, sizeStyles[size], styles.empty, style]}
      >
        <Text style={[styles.value, valueStyles[size], styles.emptyText]}>-</Text>
      </View>
    );
  }

  const rounded = Math.max(0, Math.min(100, Math.round(score)));
  const color = scoreColor(rounded);

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Match score ${rounded} out of 100`}
      testID={testID}
      style={[
        styles.badge,
        sizeStyles[size],
        { backgroundColor: `${color}22`, borderColor: `${color}59` },
        style,
      ]}
    >
      <Text style={[styles.value, valueStyles[size], { color }]}>{rounded}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  empty: {
    backgroundColor: 'transparent',
    borderColor: theme.colors.border,
  },
  emptyText: {
    color: theme.colors.muted,
  },
  value: {
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  sm: {
    minWidth: 30,
    paddingHorizontal: theme.spacing.xs,
    paddingVertical: 2,
  },
  md: {
    minWidth: 38,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  lg: {
    minWidth: 52,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  smValue: { fontSize: 12 },
  mdValue: { fontSize: 15 },
  lgValue: { fontSize: 22 },
});

const sizeStyles = { sm: styles.sm, md: styles.md, lg: styles.lg } as const;
const valueStyles = { sm: styles.smValue, md: styles.mdValue, lg: styles.lgValue } as const;

import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { theme } from '../lib/theme';

export interface StatusPillProps {
  /** Any job, application, step or queue status. Unknown values fall back to muted. */
  status: string | null | undefined;
  size?: 'sm' | 'md';
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

function label(status: string): string {
  return status.replace(/_/g, ' ');
}

export function StatusPill({
  status,
  size = 'md',
  style,
  testID,
}: StatusPillProps): React.JSX.Element {
  const text = status === null || status === undefined || status === '' ? 'unknown' : status;
  const color = theme.statusColor(text);
  const small = size === 'sm';

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Status: ${label(text)}`}
      testID={testID}
      // 6-digit theme hex plus an alpha suffix keeps the tint in sync with the dot colour.
      style={[
        styles.pill,
        small ? styles.pillSmall : null,
        { backgroundColor: `${color}22`, borderColor: `${color}59` },
        style,
      ]}
    >
      <View style={[styles.dot, small ? styles.dotSmall : null, { backgroundColor: color }]} />
      <Text numberOfLines={1} style={[styles.label, small ? styles.labelSmall : null, { color }]}>
        {label(text)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pillSmall: {
    paddingHorizontal: theme.spacing.xs + 2,
    paddingVertical: 2,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: theme.radius.pill,
  },
  dotSmall: {
    width: 5,
    height: 5,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  labelSmall: {
    fontSize: 11,
  },
});

import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { theme } from '../lib/theme';

export type StatTone = 'default' | 'primary' | 'success' | 'warning' | 'danger';

export interface StatTileProps {
  label: string;
  value: string | number;
  hint?: string;
  tone?: StatTone;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

function toneColor(tone: StatTone): string {
  switch (tone) {
    case 'primary':
      return theme.colors.primary;
    case 'success':
      return theme.colors.success;
    case 'warning':
      return theme.colors.warning;
    case 'danger':
      return theme.colors.danger;
    default:
      return theme.colors.text;
  }
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
  onPress,
  style,
  testID,
}: StatTileProps): React.JSX.Element {
  const display = typeof value === 'number' ? value.toLocaleString() : value;
  const accessibilityLabel = `${label}: ${display}${hint === undefined ? '' : `. ${hint}`}`;

  const content = (
    <>
      <Text numberOfLines={1} style={styles.label}>
        {label.toUpperCase()}
      </Text>
      <Text numberOfLines={1} style={[styles.value, { color: toneColor(tone) }]}>
        {display}
      </Text>
      {hint === undefined ? null : (
        <Text numberOfLines={1} style={styles.hint}>
          {hint}
        </Text>
      )}
    </>
  );

  if (onPress === undefined) {
    return (
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={accessibilityLabel}
        testID={testID}
        style={[styles.tile, style]}
      >
        {content}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={({ pressed }) => [styles.tile, pressed ? styles.pressed : null, style]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    minWidth: 132,
    minHeight: 84,
    justifyContent: 'center',
    backgroundColor: theme.colors.card,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
  },
  pressed: {
    opacity: 0.72,
    borderColor: theme.colors.primary,
  },
  label: {
    color: theme.colors.muted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.6,
  },
  value: {
    marginTop: theme.spacing.xs,
    fontSize: 26,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  hint: {
    marginTop: 2,
    color: theme.colors.muted,
    fontSize: 11,
  },
});

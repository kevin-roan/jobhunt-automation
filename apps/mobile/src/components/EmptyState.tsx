import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ActionButton } from './ActionButton';
import { theme } from '../lib/theme';

export interface EmptyStateProps {
  title: string;
  message?: string;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function EmptyState({
  title,
  message,
  icon = 'file-tray-outline',
  actionLabel,
  onAction,
  style,
  testID,
}: EmptyStateProps): React.JSX.Element {
  return (
    <View
      accessible
      accessibilityRole="summary"
      accessibilityLabel={message === undefined ? title : `${title}. ${message}`}
      testID={testID}
      style={[styles.container, style]}
    >
      <View style={styles.iconWrap}>
        <Ionicons name={icon} size={26} color={theme.colors.muted} />
      </View>
      <Text style={styles.title}>{title}</Text>
      {message === undefined ? null : <Text style={styles.message}>{message}</Text>}
      {actionLabel !== undefined && onAction !== undefined ? (
        <ActionButton
          label={actionLabel}
          onPress={onAction}
          variant="secondary"
          style={styles.action}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.spacing.xxl,
    paddingHorizontal: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  iconWrap: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    marginBottom: theme.spacing.xs,
  },
  title: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  message: {
    color: theme.colors.muted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    maxWidth: 320,
  },
  action: {
    marginTop: theme.spacing.sm,
    alignSelf: 'center',
  },
});

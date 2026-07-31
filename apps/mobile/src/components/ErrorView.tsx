import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ActionButton } from './ActionButton';
import { theme } from '../lib/theme';

export interface ErrorViewProps {
  /** Anything thrown by react-query or supabase-js; unwrapped to a message here. */
  error: unknown;
  title?: string;
  onRetry?: () => void;
  retrying?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error;
    if (typeof message === 'string') return message;
  }
  return 'Something went wrong.';
}

export function ErrorView({
  error,
  title = 'Could not load',
  onRetry,
  retrying = false,
  style,
  testID,
}: ErrorViewProps): React.JSX.Element {
  const message = errorMessage(error);

  return (
    <View
      accessible
      accessibilityRole="alert"
      accessibilityLabel={`${title}. ${message}`}
      testID={testID}
      style={[styles.container, style]}
    >
      <View style={styles.headline}>
        <Ionicons name="alert-circle-outline" size={18} color={theme.colors.danger} />
        <Text style={styles.title}>{title}</Text>
      </View>
      <Text style={styles.message}>{message}</Text>
      {onRetry === undefined ? null : (
        <ActionButton
          label="Try again"
          icon="refresh"
          variant="secondary"
          loading={retrying}
          onPress={onRetry}
          style={styles.action}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: `${theme.colors.danger}14`,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: `${theme.colors.danger}59`,
    padding: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  headline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  title: {
    color: theme.colors.danger,
    fontSize: 15,
    fontWeight: '600',
  },
  message: {
    color: theme.colors.text,
    fontSize: 13,
    lineHeight: 19,
  },
  action: {
    marginTop: theme.spacing.xs,
  },
});

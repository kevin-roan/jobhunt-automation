import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../lib/theme';

export type ActionButtonVariant = 'primary' | 'secondary' | 'danger';

export interface ActionButtonProps {
  label: string;
  onPress: () => void;
  variant?: ActionButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  /** Stretch to fill the row instead of hugging its content. */
  fullWidth?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

interface VariantColors {
  background: string;
  border: string;
  foreground: string;
}

function variantColors(variant: ActionButtonVariant): VariantColors {
  switch (variant) {
    case 'secondary':
      return {
        background: theme.colors.card,
        border: theme.colors.border,
        foreground: theme.colors.text,
      };
    case 'danger':
      return {
        background: `${theme.colors.danger}22`,
        border: `${theme.colors.danger}59`,
        foreground: theme.colors.danger,
      };
    default:
      return {
        background: theme.colors.primary,
        border: theme.colors.primary,
        foreground: theme.colors.background,
      };
  }
}

export function ActionButton({
  label,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  icon,
  fullWidth = false,
  accessibilityHint,
  style,
  testID,
}: ActionButtonProps): React.JSX.Element {
  const colors = variantColors(variant);
  const inactive = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        fullWidth ? styles.fullWidth : null,
        { backgroundColor: colors.background, borderColor: colors.border },
        pressed && !inactive ? styles.pressed : null,
        inactive ? styles.inactive : null,
        style,
      ]}
    >
      <View style={styles.content}>
        {loading ? (
          <ActivityIndicator size="small" color={colors.foreground} />
        ) : icon === undefined ? null : (
          <Ionicons name={icon} size={16} color={colors.foreground} />
        )}
        <Text numberOfLines={1} style={[styles.label, { color: colors.foreground }]}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  fullWidth: {
    alignSelf: 'stretch',
    flex: 1,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
  },
  pressed: {
    opacity: 0.75,
  },
  inactive: {
    opacity: 0.45,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
  },
});

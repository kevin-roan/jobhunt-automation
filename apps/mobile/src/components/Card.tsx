import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { theme } from '../lib/theme';

export interface CardProps {
  children: React.ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Card({
  children,
  onPress,
  accessibilityLabel,
  style,
  testID,
}: CardProps): React.JSX.Element {
  if (onPress === undefined) {
    return (
      <View style={[styles.card, style]} testID={testID}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={({ pressed }) => [styles.card, pressed ? styles.pressed : null, style]}
    >
      {children}
    </Pressable>
  );
}

export interface CardHeaderProps {
  children: React.ReactNode;
  /** Rendered on the trailing edge: a pill, a score, a chevron. */
  right?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function CardHeader({ children, right, style }: CardHeaderProps): React.JSX.Element {
  return (
    <View style={[styles.header, style]}>
      <View style={styles.headerMain}>{children}</View>
      {right === undefined ? null : <View style={styles.headerRight}>{right}</View>}
    </View>
  );
}

export interface CardTitleProps {
  children: React.ReactNode;
  subtitle?: string;
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
}

export function CardTitle({
  children,
  subtitle,
  numberOfLines = 2,
  style,
}: CardTitleProps): React.JSX.Element {
  return (
    <View>
      <Text
        accessibilityRole="header"
        numberOfLines={numberOfLines}
        style={[styles.title, style]}
      >
        {children}
      </Text>
      {subtitle === undefined ? null : (
        <Text numberOfLines={1} style={styles.subtitle}>
          {subtitle}
        </Text>
      )}
    </View>
  );
}

export interface CardBodyProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function CardBody({ children, style }: CardBodyProps): React.JSX.Element {
  return <View style={[styles.body, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    padding: theme.spacing.lg,
  },
  pressed: {
    opacity: 0.72,
    borderColor: theme.colors.primary,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.md,
  },
  headerMain: {
    flex: 1,
    minWidth: 0,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  title: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 21,
  },
  subtitle: {
    color: theme.colors.muted,
    fontSize: 13,
    marginTop: 2,
  },
  body: {
    marginTop: theme.spacing.md,
    gap: theme.spacing.sm,
  },
});

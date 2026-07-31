import React from 'react';
import {
  Platform,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { theme } from '../lib/theme';

export interface ScreenProps {
  children: React.ReactNode;
  /** Wraps the content in a ScrollView. Turn off for FlatList screens, which scroll themselves. */
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Extra padding around the content. Off for edge-to-edge lists. */
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * RN's SafeAreaView is a no-op on Android, so the status bar height is added
 * manually rather than pulling in another dependency.
 */
const androidTopInset = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0;

export function Screen({
  children,
  scroll = false,
  refreshing = false,
  onRefresh,
  padded = true,
  style,
  contentStyle,
  testID,
}: ScreenProps): React.JSX.Element {
  const refreshControl =
    onRefresh === undefined ? undefined : (
      <RefreshControl
        refreshing={refreshing}
        onRefresh={onRefresh}
        tintColor={theme.colors.primary}
        colors={[theme.colors.primary]}
        progressBackgroundColor={theme.colors.card}
      />
    );

  return (
    <SafeAreaView style={[styles.safe, { paddingTop: androidTopInset }, style]} testID={testID}>
      <StatusBar barStyle="light-content" backgroundColor={theme.colors.background} />
      {scroll ? (
        <ScrollView
          style={styles.fill}
          contentContainerStyle={[
            padded ? styles.paddedContent : styles.bareContent,
            contentStyle,
          ]}
          keyboardShouldPersistTaps="handled"
          refreshControl={refreshControl}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.fill, padded ? styles.padded : null, contentStyle]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  fill: {
    flex: 1,
  },
  padded: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
  },
  paddedContent: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.xxl,
    gap: theme.spacing.md,
  },
  bareContent: {
    paddingBottom: theme.spacing.xxl,
  },
});

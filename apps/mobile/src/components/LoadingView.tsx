import React from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { theme } from '../lib/theme';

export interface LoadingViewProps {
  /** Number of skeleton cards to render. Match the list it stands in for. */
  rows?: number;
  /** Skeleton lines inside each card. */
  linesPerRow?: number;
  label?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

function usePulse(): Animated.AnimatedInterpolation<number> {
  const progress = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: 750,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(progress, {
          toValue: 0,
          duration: 750,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [progress]);

  return progress.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.85] });
}

const LINE_WIDTHS = ['82%', '58%', '70%', '45%'] as const;

export function LoadingView({
  rows = 4,
  linesPerRow = 3,
  label = 'Loading',
  style,
  testID,
}: LoadingViewProps): React.JSX.Element {
  const opacity = usePulse();

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      testID={testID}
      style={[styles.container, style]}
    >
      {Array.from({ length: rows }).map((_unused, rowIndex) => (
        <View key={rowIndex} style={styles.card}>
          {Array.from({ length: linesPerRow }).map((_line, lineIndex) => (
            <Animated.View
              key={lineIndex}
              style={[
                styles.line,
                lineIndex === 0 ? styles.headline : null,
                { width: LINE_WIDTHS[lineIndex % LINE_WIDTHS.length], opacity },
              ]}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: theme.spacing.md,
  },
  card: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    padding: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  line: {
    height: 10,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.border,
  },
  headline: {
    height: 14,
  },
});

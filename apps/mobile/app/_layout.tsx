import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { registerForPushNotifications, useNotificationObserver } from '../src/lib/push';
import { useRealtimeInvalidation } from '../src/lib/realtime';
import { useSession } from '../src/lib/session';
import { isConfigured } from '../src/lib/supabase';
import { theme } from '../src/lib/theme';

/**
 * Realtime keeps the cache warm, so polling on every focus would only burn
 * battery and mobile data. Retries stay low because a phone that is offline
 * should surface that quickly rather than spin.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}

/**
 * Everything that needs the query cache or the router lives below the
 * providers. Splitting it out of RootLayout is what makes that possible.
 */
function RootNavigator(): JSX.Element {
  const { session, loading } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useRealtimeInvalidation();
  useNotificationObserver();

  const signedIn = session !== null;

  useEffect(() => {
    if (loading) return;

    const onSignIn = String(segments[0] ?? '') === 'sign-in';

    // An unconfigured build has no Supabase to sign in to, so it is parked on
    // sign-in where the setup instructions are.
    if (!isConfigured() || !signedIn) {
      if (!onSignIn) router.replace('/sign-in');
      return;
    }

    if (onSignIn) router.replace('/');
  }, [loading, signedIn, segments, router]);

  useEffect(() => {
    if (!signedIn) return;
    // Fire and forget: registration is best effort and resolves to null rather
    // than throwing on simulators or after a permission denial.
    void registerForPushNotifications();
  }, [signedIn]);

  if (loading) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator color={theme.colors.primary} size="large" />
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.card },
        headerTintColor: theme.colors.text,
        headerTitleStyle: { color: theme.colors.text, fontWeight: '600' },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="sign-in" options={{ headerShown: false }} />
    </Stack>
  );
}

export default function RootLayout(): JSX.Element {
  // useState rather than a module constant so a Fast Refresh of this file does
  // not silently strand the old cache behind a new provider.
  const [queryClient] = useState(createQueryClient);

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="light" backgroundColor={theme.colors.background} />
        <RootNavigator />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    alignItems: 'center',
    backgroundColor: theme.colors.background,
    flex: 1,
    justifyContent: 'center',
  },
});

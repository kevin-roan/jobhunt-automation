import type { ComponentProps } from 'react';
import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { Tabs } from 'expo-router';

import { isConfigured, supabase } from '../../src/lib/supabase';
import { theme } from '../../src/lib/theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

interface IconProps {
  color: string;
  size: number;
  focused: boolean;
}

/**
 * Ionicons ship an outline and a filled variant of each glyph. Selecting on
 * focus gives the tab bar weight without a second icon set.
 */
function tabIcon(base: string) {
  return function TabIcon({ color, size, focused }: IconProps): JSX.Element {
    const name = (focused ? base : `${base}-outline`) as IconName;
    return <Ionicons name={name} size={size} color={color} />;
  };
}

function useUnreadCount(): number {
  const { data } = useQuery({
    // Prefixed with 'notifications' so the realtime invalidator's table-level
    // invalidation reaches this badge too.
    queryKey: ['notifications', 'unread-count'],
    enabled: isConfigured(),
    staleTime: 15_000,
    queryFn: async (): Promise<number> => {
      // head:true asks Postgres for the count without shipping any rows.
      const { count, error } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('read', false);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
  });

  return data ?? 0;
}

export default function TabsLayout(): JSX.Element {
  const unread = useUnreadCount();

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.card },
        headerTintColor: theme.colors.text,
        headerTitleStyle: { color: theme.colors.text, fontWeight: '600' },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: theme.colors.background },
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.muted,
        tabBarStyle: {
          backgroundColor: theme.colors.card,
          borderTopColor: theme.colors.border,
          borderTopWidth: 1,
          // Android tab bars are short by default; 60 keeps every target above
          // the 44pt minimum once the label is accounted for.
          height: Platform.OS === 'android' ? 60 : undefined,
          paddingTop: 6,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarBadgeStyle: {
          backgroundColor: theme.colors.danger,
          color: theme.colors.text,
          fontSize: 10,
          fontWeight: '700',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Overview', tabBarIcon: tabIcon('speedometer') }}
      />
      <Tabs.Screen name="jobs" options={{ title: 'Jobs', tabBarIcon: tabIcon('briefcase') }} />
      <Tabs.Screen
        name="applications"
        options={{ title: 'Applications', tabBarIcon: tabIcon('paper-plane') }}
      />
      <Tabs.Screen
        name="alerts"
        options={{
          title: 'Alerts',
          tabBarIcon: tabIcon('notifications'),
          tabBarBadge: unread > 0 ? (unread > 99 ? '99+' : unread) : undefined,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: 'Settings', tabBarIcon: tabIcon('settings') }}
      />
    </Tabs>
  );
}

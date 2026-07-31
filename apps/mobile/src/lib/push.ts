import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';

import { isConfigured, supabase } from './supabase';
import { theme } from './theme';

const ANDROID_CHANNEL_ID = 'default';

/**
 * Foreground presentation. Alerts pushed from the host are short operational
 * notices ("application submitted", "login expired") that are worth surfacing
 * even while the user is looking at the app.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: true,
  }),
});

/**
 * The EAS project id is required by getExpoPushTokenAsync from SDK 49 onward.
 * It lives in app.json under expo.extra.eas.projectId, but a bare `expo start`
 * against a hand-written config may not have it, so every lookup is defensive.
 */
function readProjectId(): string | undefined {
  const fromEas: unknown = Constants.easConfig?.projectId;
  if (typeof fromEas === 'string' && fromEas.length > 0) return fromEas;

  const extra: unknown = Constants.expoConfig?.extra;
  if (typeof extra !== 'object' || extra === null) return undefined;

  const eas: unknown = (extra as Record<string, unknown>).eas;
  if (typeof eas !== 'object' || eas === null) return undefined;

  const projectId: unknown = (eas as Record<string, unknown>).projectId;
  return typeof projectId === 'string' && projectId.length > 0 ? projectId : undefined;
}

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
    name: 'Agent activity',
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 200, 100, 200],
    lightColor: theme.colors.primary,
  });
}

async function requestPermission(): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) return true;
  // canAskAgain is false once the user has hard-denied; re-prompting is a no-op
  // that only wastes a round trip.
  if (!existing.canAskAgain) return false;

  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

async function storeToken(token: string): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) return;

  // The Expo push token is an opaque routing address issued by Expo. It is not
  // a credential for anything on the host and carries no device fingerprint
  // beyond the platform string.
  await supabase.from('devices').upsert(
    {
      user_id: userId,
      expo_push_token: token,
      platform: Platform.OS,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'expo_push_token' },
  );
}

/**
 * Registers this device for push and records the token against the signed-in
 * user so the host can address it.
 *
 * Never throws. Simulators have no push service, permission can be denied, and
 * the device may be offline - none of those are errors the user needs to see,
 * so the function simply returns null and the app carries on. Push is a
 * convenience layer; realtime subscriptions already keep the UI current while
 * the app is open.
 */
export async function registerForPushNotifications(): Promise<string | null> {
  if (!isConfigured()) return null;

  try {
    await ensureAndroidChannel();

    const granted = await requestPermission();
    if (!granted) return null;

    const projectId = readProjectId();
    // getExpoPushTokenAsync throws on simulators and on a device with no
    // network, which is exactly the graceful-degradation path below.
    const { data: token } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : {},
    );
    if (!token) return null;

    await storeToken(token);
    return token;
  } catch {
    return null;
  }
}

function readApplicationId(data: Record<string, unknown>): string | null {
  const direct = data.applicationId;
  if (typeof direct === 'number' || (typeof direct === 'string' && direct.length > 0)) {
    return String(direct);
  }

  // Host-composed notifications carry the generic entity pointer instead.
  if (data.entityType === 'application') {
    const entityId = data.entityId;
    if (typeof entityId === 'number' || (typeof entityId === 'string' && entityId.length > 0)) {
      return String(entityId);
    }
  }

  return null;
}

/**
 * Deep-links a tapped notification to the application it refers to.
 *
 * Handles the cold-start case too: if the app was launched by the tap, the
 * response is already waiting in getLastNotificationResponseAsync rather than
 * arriving through the listener.
 */
export function useNotificationObserver(): void {
  const router = useRouter();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const navigate = (response: Notifications.NotificationResponse): void => {
      if (!mounted) return;
      // The cold-start response is also delivered to the listener on some
      // platforms, so identifier-dedupe rather than navigating twice.
      const identifier = response.notification.request.identifier;
      if (handled.current === identifier) return;
      handled.current = identifier;

      const id = readApplicationId(response.notification.request.content.data);
      if (!id) return;
      // Object form rather than a template literal: typed routes reject an
      // interpolated `string` in an href, and this states the target route.
      router.push({ pathname: '/application/[id]', params: { id } });
    };

    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) navigate(response);
      })
      .catch(() => {
        /* a missing launch response is the normal case, not a failure */
      });

    const subscription = Notifications.addNotificationResponseReceivedListener(navigate);

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, [router]);
}

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';

import { isConfigured, supabase } from '../src/lib/supabase';
import { theme } from '../src/lib/theme';

const CODE_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 45;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Step = 'email' | 'code';

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

function NotConfigured(): JSX.Element {
  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.badge}>
          <Ionicons name="warning-outline" size={22} color={theme.colors.warning} />
        </View>
        <Text style={styles.title}>Not configured yet</Text>
        <Text style={styles.subtitle}>
          This build has no Supabase project attached, so there is nothing to pair with.
        </Text>

        <View style={styles.card}>
          <Text style={styles.stepLine}>
            <Text style={styles.stepNumber}>1. </Text>
            Run the SQL in supabase/schema.sql against your Supabase project.
          </Text>
          <Text style={styles.stepLine}>
            <Text style={styles.stepNumber}>2. </Text>
            Open Settings then Mobile sync in the local dashboard and paste the project URL and the
            service role key there. That key stays on your machine.
          </Text>
          <Text style={styles.stepLine}>
            <Text style={styles.stepNumber}>3. </Text>
            Put the same project URL and the publishable (anon) key into apps/mobile/app.json under
            expo.extra, or export EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.
          </Text>
          <Text style={styles.stepLine}>
            <Text style={styles.stepNumber}>4. </Text>
            Restart the app.
          </Text>
        </View>

        <Text style={styles.footnote}>
          Only the publishable key belongs in this app. The service role key would give anyone who
          unpacks the bundle full access to the database.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

export default function SignInScreen(): JSX.Element {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const codeInput = useRef<TextInput>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((seconds) => (seconds <= 1 ? 0 : seconds - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const sendCode = useCallback(
    async (resend: boolean): Promise<void> => {
      const address = email.trim().toLowerCase();
      if (!EMAIL_PATTERN.test(address)) {
        setError('Enter a valid email address.');
        return;
      }

      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const { error: otpError } = await supabase.auth.signInWithOtp({
          email: address,
          options: { shouldCreateUser: true },
        });
        if (otpError) throw new Error(otpError.message);

        setEmail(address);
        setStep('code');
        setCode('');
        setCooldown(RESEND_COOLDOWN_SECONDS);
        setNotice(resend ? 'A new code is on its way.' : `Code sent to ${address}.`);
        // Give the navigation transition a frame before stealing focus.
        setTimeout(() => codeInput.current?.focus(), 150);
      } catch (err: unknown) {
        setError(messageOf(err));
      } finally {
        setBusy(false);
      }
    },
    [email],
  );

  const verify = useCallback(async (): Promise<void> => {
    const token = code.trim();
    if (token.length !== CODE_LENGTH) {
      setError(`Enter the ${CODE_LENGTH} digit code from your email.`);
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email: email.trim().toLowerCase(),
        token,
        type: 'email',
      });
      if (verifyError) throw new Error(verifyError.message);
      // The auth listener in useSession picks the session up and the root
      // layout redirects; nothing to do here.
    } catch (err: unknown) {
      setError(messageOf(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  }, [code, email]);

  if (!isConfigured()) return <NotConfigured />;

  const onCodeStep = step === 'code';

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.badge}>
            <Ionicons name="phone-portrait-outline" size={22} color={theme.colors.primary} />
          </View>

          <Text style={styles.title}>Pair this phone</Text>
          <Text style={styles.subtitle}>
            This account exists only to link your phone to the machine running the agent. Your
            resumes, cover letters, credentials and profile never leave that machine - the phone
            sees job and application status, and sends back instructions.
          </Text>

          {!onCodeStep ? (
            <View style={styles.card}>
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={styles.input}
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                placeholderTextColor={theme.colors.muted}
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
                keyboardType="email-address"
                inputMode="email"
                returnKeyType="go"
                editable={!busy}
                onSubmitEditing={() => void sendCode(false)}
              />
              <Text style={styles.hint}>
                We send a one-time code. There is no password to remember or leak.
              </Text>
            </View>
          ) : (
            <View style={styles.card}>
              <Text style={styles.label}>6 digit code</Text>
              <TextInput
                ref={codeInput}
                style={[styles.input, styles.codeInput]}
                value={code}
                onChangeText={(next) => setCode(next.replace(/\D/g, '').slice(0, CODE_LENGTH))}
                placeholder="000000"
                placeholderTextColor={theme.colors.muted}
                keyboardType="number-pad"
                inputMode="numeric"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                maxLength={CODE_LENGTH}
                editable={!busy}
                onSubmitEditing={() => void verify()}
              />
              <Text style={styles.hint}>Sent to {email}. It expires in a few minutes.</Text>
            </View>
          )}

          {error !== null && (
            <View style={[styles.banner, styles.bannerError]}>
              <Ionicons name="alert-circle-outline" size={18} color={theme.colors.danger} />
              <Text style={[styles.bannerText, styles.bannerTextError]}>{error}</Text>
            </View>
          )}

          {error === null && notice !== null && (
            <View style={[styles.banner, styles.bannerOk]}>
              <Ionicons name="checkmark-circle-outline" size={18} color={theme.colors.success} />
              <Text style={[styles.bannerText, styles.bannerTextOk]}>{notice}</Text>
            </View>
          )}

          <Pressable
            style={({ pressed }) => [
              styles.primaryButton,
              (busy || pressed) && styles.primaryButtonDim,
            ]}
            disabled={busy}
            onPress={() => void (onCodeStep ? verify() : sendCode(false))}
          >
            {busy ? (
              <ActivityIndicator color={theme.colors.text} />
            ) : (
              <Text style={styles.primaryButtonText}>
                {onCodeStep ? 'Verify and pair' : 'Send code'}
              </Text>
            )}
          </Pressable>

          {onCodeStep && (
            <View style={styles.secondaryRow}>
              <Pressable
                style={styles.secondaryButton}
                disabled={busy}
                onPress={() => {
                  setStep('email');
                  setCode('');
                  setError(null);
                  setNotice(null);
                }}
              >
                <Text style={styles.secondaryText}>Use a different email</Text>
              </Pressable>

              <Pressable
                style={styles.secondaryButton}
                disabled={busy || cooldown > 0}
                onPress={() => void sendCode(true)}
              >
                <Text style={[styles.secondaryText, cooldown > 0 && styles.secondaryTextMuted]}>
                  {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
                </Text>
              </Pressable>
            </View>
          )}

          <Text style={styles.footnote}>
            Sign in with the same email you paired in the dashboard, otherwise this phone will show
            an empty account.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: 'center',
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderRadius: 12,
    borderWidth: 1,
    height: 48,
    justifyContent: 'center',
    marginBottom: 16,
    width: 48,
  },
  banner: {
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  bannerError: {
    backgroundColor: 'rgba(224, 104, 138, 0.12)',
    borderColor: theme.colors.danger,
  },
  bannerOk: {
    backgroundColor: 'rgba(74, 194, 162, 0.12)',
    borderColor: theme.colors.success,
  },
  bannerText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  bannerTextError: { color: theme.colors.danger },
  bannerTextOk: { color: theme.colors.success },
  card: {
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 16,
    padding: 16,
  },
  codeInput: {
    fontSize: 24,
    fontVariant: ['tabular-nums'],
    letterSpacing: 8,
    textAlign: 'center',
  },
  flex: { flex: 1 },
  footnote: {
    color: theme.colors.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 24,
  },
  hint: {
    color: theme.colors.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
  },
  input: {
    backgroundColor: theme.colors.background,
    borderColor: theme.colors.border,
    borderRadius: 12,
    borderWidth: 1,
    color: theme.colors.text,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  label: {
    color: theme.colors.muted,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: theme.colors.primary,
    borderRadius: 12,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
  },
  primaryButtonDim: { opacity: 0.7 },
  primaryButtonText: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  screen: {
    backgroundColor: theme.colors.background,
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
  },
  secondaryButton: {
    justifyContent: 'center',
    minHeight: 44,
    paddingVertical: 8,
  },
  secondaryRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  secondaryText: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: '500',
  },
  secondaryTextMuted: { color: theme.colors.muted },
  stepLine: {
    color: theme.colors.text,
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 12,
  },
  stepNumber: {
    color: theme.colors.primary,
    fontWeight: '700',
  },
  subtitle: {
    color: theme.colors.muted,
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 24,
  },
  title: {
    color: theme.colors.text,
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.4,
    marginBottom: 8,
  },
});

/**
 * The single source of visual truth for the mobile app. There is no UI kit and
 * no styling framework here on purpose: a hand-rolled theme object plus
 * StyleSheet keeps the bundle small and means nothing has to be configured,
 * regenerated or kept in sync with a build step.
 *
 * The palette mirrors the web dashboard so the two surfaces read as one product.
 */

export const colors = {
  background: '#0d1017',
  card: '#141821',
  /** One step above `card`, for nested surfaces such as chips and inputs. */
  surface: '#1a1f2b',
  border: '#232936',
  text: '#eef1f6',
  muted: '#949cad',
  primary: '#7c85f5',
  success: '#4ac2a2',
  warning: '#f0a541',
  danger: '#e0688a',
  /** Text placed on top of a filled primary/success/warning/danger block. */
  onAccent: '#0d1017',
} as const;

/** 8pt scale. `xs` is the half step used for tight label/value pairs. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  /** Chips, small badges, skeleton lines. */
  sm: 6,
  /** Default: cards, tiles and buttons. Matches the web dashboard's 12px corner. */
  md: 12,
  /** Sheets and anything anchored to an edge of the screen. */
  lg: 16,
  pill: 999,
} as const;

export const fontSizes = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 22,
  xxl: 30,
} as const;

export const fontWeights = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

/**
 * Minimum height for anything tappable. Below this, thumbs miss - Apple and
 * Material both land on roughly this number.
 */
export const touchTarget = 44;

/**
 * Figures (scores, counts, salaries) must not jitter as they update, so they
 * are rendered with tabular numerals. React Native exposes this only through
 * fontVariant, which is typed as a string literal union.
 */
export const tabularNumbers = { fontVariant: ['tabular-nums'] } as const;

/** Semantic buckets every status in packages/shared/src/enums.ts maps into. */
type Tone = 'neutral' | 'info' | 'progress' | 'positive' | 'negative' | 'attention';

const TONE_COLORS: Record<Tone, string> = {
  neutral: colors.muted,
  info: colors.primary,
  progress: colors.primary,
  positive: colors.success,
  negative: colors.danger,
  attention: colors.warning,
};

/**
 * Every status string the cloud mirror can carry. Values arrive from Supabase
 * as plain text rather than a narrowed enum, hence the string keys and the
 * fallback in `statusColor`.
 */
const STATUS_TONES: Record<string, Tone> = {
  // JOB_STATUSES
  new: 'info',
  scored: 'info',
  queued: 'progress',
  applying: 'progress',
  applied: 'positive',
  skipped: 'neutral',
  manual_review: 'attention',

  // APPLICATION_STATUSES ('pending' and 'failed' are shared with other enums)
  pending: 'neutral',
  in_progress: 'progress',
  submitted: 'positive',
  failed: 'negative',
  abandoned: 'neutral',
  needs_human: 'attention',
  interview: 'info',
  rejected: 'negative',
  offer: 'positive',

  // RECOMMENDATIONS ('manual_review' shared with job statuses)
  apply: 'positive',
  skip: 'neutral',

  // STEP_STATUSES / QUEUE_STATUSES / COMMAND_STATUSES
  running: 'progress',
  succeeded: 'positive',
  active: 'progress',
  completed: 'positive',
  delayed: 'attention',
  cancelled: 'neutral',
  claimed: 'progress',

  // NOTIFICATION_LEVELS
  info: 'info',
  success: 'positive',
  warning: 'attention',
  error: 'negative',

  // CREDENTIAL_STATUSES ('valid' only; 'unknown'/'expired'/'invalid' below)
  valid: 'positive',
  unknown: 'neutral',
  expired: 'negative',
  invalid: 'negative',
};

/** Colour for a status badge. Unknown values degrade to muted, never crash. */
export function statusColor(status: string): string {
  const tone = STATUS_TONES[status.toLowerCase()];
  return tone === undefined ? colors.muted : TONE_COLORS[tone];
}

/** Human-readable form of a snake_case status, e.g. `needs_human` -> `Needs human`. */
export function statusLabel(status: string): string {
  const spaced = status.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export const theme = {
  colors,
  spacing,
  radius,
  fontSizes,
  fontWeights,
  touchTarget,
  tabularNumbers,
  statusColor,
  statusLabel,
} as const;

export type Theme = typeof theme;

export default theme;

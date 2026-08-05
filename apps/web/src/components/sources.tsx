import {
  Briefcase,
  Building2,
  Layers,
  Leaf,
  Linkedin,
  PenLine,
  Puzzle,
  Search,
  Sparkles,
  Sprout,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SourceAccent {
  bg: string;
  text: string;
  ring: string;
  dot: string;
  /**
   * Literal hex for SVG charts. Recharts writes `fill` as a presentation
   * attribute, where a `var(--…)` custom property is NOT substituted, so a
   * chart colour can never be expressed as a Tailwind class or a CSS variable
   * the way the other fields are — it has to be the resolved colour itself.
   */
  chart: string;
}

/**
 * Categorical accents for platforms, in the same spirit as CHART_COLORS in
 * components/common.tsx: a fixed palette picked to stay readable on both the
 * light and the dark card background, so a source is the same colour wherever
 * it appears.
 */
const ACCENTS = {
  sky: {
    bg: 'bg-sky-500/10',
    text: 'text-sky-600 dark:text-sky-400',
    ring: 'ring-sky-500/30',
    dot: 'bg-sky-500',
    chart: '#59b3e6',
  },
  indigo: {
    bg: 'bg-indigo-500/10',
    text: 'text-indigo-600 dark:text-indigo-400',
    ring: 'ring-indigo-500/30',
    dot: 'bg-indigo-500',
    chart: '#7c85f5',
  },
  emerald: {
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-600 dark:text-emerald-400',
    ring: 'ring-emerald-500/30',
    dot: 'bg-emerald-500',
    chart: '#4ac2a2',
  },
  violet: {
    bg: 'bg-violet-500/10',
    text: 'text-violet-600 dark:text-violet-400',
    ring: 'ring-violet-500/30',
    dot: 'bg-violet-500',
    chart: '#b58ae0',
  },
  amber: {
    bg: 'bg-amber-500/10',
    text: 'text-amber-600 dark:text-amber-400',
    ring: 'ring-amber-500/30',
    dot: 'bg-amber-500',
    chart: '#f0a541',
  },
  rose: {
    bg: 'bg-rose-500/10',
    text: 'text-rose-600 dark:text-rose-400',
    ring: 'ring-rose-500/30',
    dot: 'bg-rose-500',
    chart: '#e0688a',
  },
  teal: {
    bg: 'bg-teal-500/10',
    text: 'text-teal-600 dark:text-teal-400',
    ring: 'ring-teal-500/30',
    dot: 'bg-teal-500',
    chart: '#3fb5b5',
  },
  orange: {
    bg: 'bg-orange-500/10',
    text: 'text-orange-600 dark:text-orange-400',
    ring: 'ring-orange-500/30',
    dot: 'bg-orange-500',
    chart: '#e8785a',
  },
  slate: {
    bg: 'bg-slate-500/10',
    text: 'text-slate-600 dark:text-slate-300',
    ring: 'ring-slate-500/30',
    dot: 'bg-slate-500',
    chart: '#94a3b8',
  },
} satisfies Record<string, SourceAccent>;

type AccentName = keyof typeof ACCENTS;

/** The accents an unknown plugin source is hashed into — the branded ones stay reserved. */
const FALLBACK_ACCENTS: AccentName[] = [
  'indigo',
  'emerald',
  'violet',
  'amber',
  'rose',
  'teal',
  'orange',
  'sky',
];

const SOURCE_ACCENTS: Record<string, AccentName> = {
  linkedin: 'sky',
  indeed: 'indigo',
  greenhouse: 'emerald',
  lever: 'violet',
  ashby: 'amber',
  workday: 'orange',
  smartrecruiters: 'teal',
  workable: 'rose',
  recruitee: 'emerald',
  manual: 'slate',
};

const SOURCE_LABELS: Record<string, string> = {
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workday: 'Workday',
  smartrecruiters: 'SmartRecruiters',
  workable: 'Workable',
  recruitee: 'Recruitee',
  manual: 'Manual',
};

const SOURCE_ICONS: Record<string, LucideIcon> = {
  linkedin: Linkedin,
  indeed: Search,
  greenhouse: Sprout,
  lever: Layers,
  ashby: Sparkles,
  workday: Building2,
  smartrecruiters: Users,
  workable: Briefcase,
  recruitee: Leaf,
  manual: PenLine,
};

/** Case and separators vary between the API, plugins and hand-typed ids. */
function normalise(source: string): string {
  return source.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** djb2, so an unknown plugin source keeps the same colour across reloads and pages. */
function hash(value: string): number {
  let result = 5381;
  for (let index = 0; index < value.length; index += 1) {
    result = ((result << 5) + result + value.charCodeAt(index)) >>> 0;
  }
  return result;
}

/** Stable brand-ish accent per source so a platform is recognisable at a glance across every page. */
export function sourceAccent(source: string): SourceAccent {
  const key = normalise(source);
  const named = SOURCE_ACCENTS[key];
  if (named) return ACCENTS[named];
  if (!key) return ACCENTS.slate;
  const fallback = FALLBACK_ACCENTS[hash(key) % FALLBACK_ACCENTS.length];
  return fallback ? ACCENTS[fallback] : ACCENTS.slate;
}

/** Human label: 'linkedin' -> 'LinkedIn', 'smartrecruiters' -> 'SmartRecruiters', etc. */
export function sourceLabel(source: string): string {
  const key = normalise(source);
  const named = SOURCE_LABELS[key];
  if (named) return named;
  const raw = source.trim();
  if (!raw) return 'Unknown';
  return raw
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** The icon for a source, from lucide-react only (no external assets). */
export function SourceIcon({
  source,
  className,
}: {
  source: string;
  className?: string;
}): JSX.Element {
  const Icon = SOURCE_ICONS[normalise(source)] ?? Puzzle;
  return <Icon className={cn('size-4', className)} />;
}

/** Compact chip: coloured dot + name. Used in the jobs table and the overview list. */
export function SourceBadge({
  source,
  className,
}: {
  source: string;
  className?: string;
}): JSX.Element {
  const accent = sourceAccent(source);
  return (
    <span
      className={cn(
        // Same geometry as the Badge primitive so chips line up wherever they sit next to one.
        'inline-flex items-center gap-1.5 rounded-full border border-transparent px-2 py-0.5 text-[11px] font-medium leading-4',
        accent.bg,
        accent.text,
        className,
      )}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', accent.dot)} />
      {sourceLabel(source)}
    </span>
  );
}

/** Square tile of the source icon, tinted with its accent — the card and list leading mark. */
export function SourceTile({
  source,
  className,
}: {
  source: string;
  className?: string;
}): JSX.Element {
  const accent = sourceAccent(source);
  return (
    <span
      className={cn(
        'grid size-9 shrink-0 place-items-center rounded-md ring-1 ring-inset',
        accent.bg,
        accent.text,
        accent.ring,
        className,
      )}
    >
      <SourceIcon source={source} />
    </span>
  );
}

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Star,
  Trash2,
  Wand2,
} from 'lucide-react';
import type { AssistResumeResult, ResumeDto, ResumeTemplate, ResumeTheme } from '@deedy/shared';
import { RESUME_DENSITIES, RESUME_FONTS } from '@deedy/shared';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { ErrorState, PageHeader, ScoreBadge } from '@/components/common';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  Select,
  Separator,
  Skeleton,
  Textarea,
} from '@/components/ui/primitives';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/overlays';
import { useToast } from '@/components/ui/toast';

/* -------------------------------------------------------------------------- */
/* Theme helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `ResumeTheme` stores colours as SIX HEX DIGITS WITHOUT a leading '#', because
 * they are written straight into `\definecolor{...}{HTML}{...}` and LaTeX
 * rejects the '#'. `<input type="color">`, on the other hand, only ever reads
 * and writes `#rrggbb`. So the '#' is added on the way into the input and
 * stripped on the way back out — the conversion lives only at that boundary and
 * nothing downstream of it ever sees a '#'.
 */
function toColorInput(hex: string): string {
  return `#${hex.replace(/^#/, '')}`;
}

function fromColorInput(value: string): string {
  return value.replace(/^#/, '').toUpperCase();
}

const COLOR_FIELDS: { key: ColorKey; label: string }[] = [
  { key: 'accent', label: 'Accent' },
  { key: 'primary', label: 'Primary text' },
  { key: 'headings', label: 'Headings' },
  { key: 'subheadings', label: 'Subheadings' },
  { key: 'rule', label: 'Rules' },
  { key: 'date', label: 'Dates' },
];

type ColorKey = 'accent' | 'primary' | 'headings' | 'subheadings' | 'rule' | 'date';

type NumericKey = 'baseFontSize' | 'hmargin' | 'vmargin';

/**
 * These are held as strings while the user types, never as numbers. An
 * `<input type="number">` reports `''` for a half-written decimal like "1.",
 * so coercing on every keystroke would write `0` back into the field and eat
 * the keypress — and `0` also fails `resumeThemeSchema`, which would fire the
 * debounced compile with a theme the server rejects.
 */
const NUMERIC_FIELDS: Record<
  NumericKey,
  { label: string; min: number; max: number; step: number }
> = {
  // Bounds mirror `resumeThemeSchema`; a draft outside them is never committed.
  baseFontSize: { label: 'Base font size (pt)', min: 8, max: 12, step: 0.5 },
  hmargin: { label: 'H margin (cm)', min: 0.6, max: 3.5, step: 0.05 },
  vmargin: { label: 'V margin (cm)', min: 0.6, max: 3.5, step: 0.05 },
};

type NumericDrafts = Record<NumericKey, string>;

function draftsFromTheme(theme: ResumeTheme): NumericDrafts {
  return {
    baseFontSize: String(theme.baseFontSize),
    hmargin: String(theme.hmargin),
    vmargin: String(theme.vmargin),
  };
}

const EMPTY_DRAFTS: NumericDrafts = { baseFontSize: '', hmargin: '', vmargin: '' };

const FONT_LABELS: Record<(typeof RESUME_FONTS)[number], string> = {
  raleway: 'Raleway',
  sourcesans: 'Source Sans',
  fira: 'Fira Sans',
  garamond: 'EB Garamond',
  latinmodern: 'Latin Modern',
};

const DENSITY_LABELS: Record<(typeof RESUME_DENSITIES)[number], string> = {
  compact: 'Compact',
  normal: 'Normal',
  relaxed: 'Relaxed',
};

/* -------------------------------------------------------------------------- */
/* Small building blocks                                                       */
/* -------------------------------------------------------------------------- */

function Collapsible({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {label}
      </button>
      {open ? <div className="border-t border-border p-3">{children}</div> : null}
    </div>
  );
}

function CompileLogBlock({ log, className }: { log: string; className?: string }): JSX.Element {
  return (
    <pre
      className={
        'scrollbar-thin overflow-auto whitespace-pre-wrap break-words rounded-md bg-secondary p-3 font-mono text-[11px] leading-relaxed text-foreground ' +
        (className ?? 'max-h-56')
      }
    >
      {log}
    </pre>
  );
}

/* -------------------------------------------------------------------------- */
/* Editor dialog                                                               */
/* -------------------------------------------------------------------------- */

interface EditorValues {
  name: string;
  targetRole: string;
  isDefault: boolean;
  latex: string;
  theme: ResumeTheme;
}

interface CompileState {
  status: 'idle' | 'pending' | 'ok' | 'failed';
  log: string;
  previewId: string | null;
  pages: number | null;
  engine: string | null;
  durationMs: number | null;
  /** True once the source has moved on from whatever produced `previewId`. */
  stale: boolean;
}

const IDLE_COMPILE: CompileState = {
  status: 'idle',
  log: '',
  previewId: null,
  pages: null,
  engine: null,
  durationMs: null,
  stale: false,
};

const COMPILE_DEBOUNCE_MS = 900;

function ResumeEditorDialog({
  open,
  onOpenChange,
  title,
  description,
  initial,
  resumeId,
  template,
  submitLabel,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  title: string;
  description: string;
  initial: EditorValues | null;
  /** Null for a brand-new resume; AI assist needs a saved id to work against. */
  resumeId: number | null;
  template: ResumeTemplate | undefined;
  submitLabel: string;
  pending: boolean;
  onSubmit: (values: EditorValues) => void;
}): JSX.Element {
  const toast = useToast();
  const [values, setValues] = React.useState<EditorValues | null>(initial);
  const [compile, setCompile] = React.useState<CompileState>(IDLE_COMPILE);
  const [instruction, setInstruction] = React.useState('');
  const [assistSummary, setAssistSummary] = React.useState<string[]>([]);
  const [numericDrafts, setNumericDrafts] = React.useState<NumericDrafts>(
    initial ? draftsFromTheme(initial.theme) : EMPTY_DRAFTS,
  );

  /**
   * Every compile is stamped with a monotonically increasing sequence number.
   * A response is only allowed to touch state when its stamp is still the
   * latest one issued, so a slow compile that started three keystrokes ago can
   * never overwrite the preview produced by the newest source.
   */
  const sequence = React.useRef(0);

  /**
   * Seeding is keyed on `initial`'s identity, and `initial` is memoised on the
   * `['resume-template']` query data — so any background refetch (refetchOnReconnect
   * is on by default) mints a new object. Seeding once per opening keeps the late
   * arrival of the template working while making a refetch unable to wipe a draft.
   */
  const seeded = React.useRef(false);

  React.useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (seeded.current || !initial) return;
    seeded.current = true;
    setValues(initial);
    setNumericDrafts(draftsFromTheme(initial.theme));
    setCompile(IDLE_COMPILE);
    setInstruction('');
    setAssistSummary([]);
    sequence.current += 1;
  }, [open, initial]);

  /**
   * Closing the dialog retires every stamp in flight, so a compile that is still
   * running when the user walks away can never write into the reopened form.
   */
  React.useEffect(() => {
    if (open) return;
    sequence.current += 1;
    setCompile(IDLE_COMPILE);
  }, [open]);

  const engineMissing = template !== undefined && template.engine === null;
  const latex = values?.latex ?? '';
  const theme = values?.theme;

  const runCompile = React.useCallback(
    async (source: string, activeTheme: ResumeTheme): Promise<void> => {
      if (!source.trim()) return;
      sequence.current += 1;
      const stamp = sequence.current;
      setCompile((current) => ({ ...current, status: 'pending' }));
      try {
        const result = await api.resumes.compile({ latex: source, theme: activeTheme });
        if (stamp !== sequence.current) return; // A newer compile already won.
        setCompile((current) => ({
          status: result.ok ? 'ok' : 'failed',
          log: result.log,
          // A failed compile has no PDF: keep the last good preview on screen so
          // the user still has something to fix their LaTeX against.
          previewId: result.ok ? result.previewId : current.previewId,
          pages: result.ok ? result.pages : current.pages,
          engine: result.engine ?? current.engine,
          durationMs: result.durationMs,
          stale: !result.ok && current.previewId !== null,
        }));
      } catch (error: unknown) {
        if (stamp !== sequence.current) return;
        setCompile((current) => ({
          ...current,
          status: 'failed',
          log: error instanceof Error ? error.message : 'Compile request failed.',
          stale: current.previewId !== null,
        }));
      }
    },
    [],
  );

  // Debounced auto-compile: the timer restarts on every keystroke and every
  // theme change, so only a ~900ms pause actually reaches the engine.
  React.useEffect(() => {
    if (!open || !theme || !latex.trim() || engineMissing) return;
    const timer = window.setTimeout(() => {
      void runCompile(latex, theme);
    }, COMPILE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, latex, theme, engineMissing, runCompile]);

  const assist = useMutation({
    mutationFn: (body: { id: number; latex: string; theme: ResumeTheme; instruction: string }) =>
      api.resumes.assist(body.id, {
        latex: body.latex,
        theme: body.theme,
        instruction: body.instruction,
      }),
    onSuccess: (result: AssistResumeResult) => {
      setValues((current) =>
        current
          ? { ...current, latex: result.latex, theme: { ...current.theme, ...result.theme } }
          : current,
      );
      // The drafts mirror the theme, so a model-authored theme has to be written
      // back into them or the inputs would keep showing the superseded numbers.
      setNumericDrafts(draftsFromTheme(result.theme));
      setAssistSummary(result.summary);
      setInstruction('');
      toast.success('Resume rewritten', `${result.model} produced a new draft.`);
    },
    onError: (error: unknown) =>
      toast.error('AI assist failed', error instanceof Error ? error.message : undefined),
  });

  const set = <K extends keyof EditorValues>(key: K, value: EditorValues[K]): void =>
    setValues((current) => (current ? { ...current, [key]: value } : current));

  const setTheme = <K extends keyof ResumeTheme>(key: K, value: ResumeTheme[K]): void =>
    setValues((current) =>
      current ? { ...current, theme: { ...current.theme, [key]: value } } : current,
    );

  /**
   * The draft is always what the field shows, so every keystroke survives. The
   * theme — and therefore the debounced compile — only moves when the draft is a
   * finite number inside the range `resumeThemeSchema` accepts, so no
   * half-written value ever reaches the engine as an invalid theme.
   */
  const setNumeric = (key: NumericKey, raw: string): void => {
    setNumericDrafts((current) => ({ ...current, [key]: raw }));
    const { min, max } = NUMERIC_FIELDS[key];
    const parsed = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(parsed)) return;
    if (parsed < min || parsed > max) return;
    setTheme(key, parsed);
  };

  const renderNumeric = (key: NumericKey): JSX.Element => {
    const field = NUMERIC_FIELDS[key];
    return (
      <div className="space-y-1.5">
        <Label htmlFor={`theme-${key}`}>{field.label}</Label>
        <Input
          id={`theme-${key}`}
          type="number"
          min={field.min}
          max={field.max}
          step={field.step}
          value={numericDrafts[key]}
          onChange={(event) => setNumeric(key, event.target.value)}
          // On blur the field snaps back to the committed theme, so a rejected
          // or half-typed value can never be left sitting in the input.
          onBlur={() =>
            setNumericDrafts((current) =>
              theme ? { ...current, [key]: String(theme[key]) } : current,
            )
          }
        />
      </div>
    );
  };

  const valid = (values?.name.trim().length ?? 0) > 0 && latex.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(90rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {description}
          </DialogDescription>
        </DialogHeader>

        {values === null ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <form
            className="flex min-h-0 flex-1 flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid && !pending) onSubmit(values);
            }}
          >
            {engineMissing ? (
              <div className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/10 p-3">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="space-y-1 text-xs">
                  <p className="font-medium text-destructive">No LaTeX engine on this host</p>
                  <p className="text-muted-foreground">
                    The PDF cannot be produced until one is installed, so the preview below stays
                    empty. Install{' '}
                    <code className="rounded bg-secondary px-1 py-0.5 font-mono">
                      texlive-xetex texlive-latex-extra texlive-fonts-extra
                    </code>{' '}
                    with your package manager, or drop a{' '}
                    <code className="rounded bg-secondary px-1 py-0.5 font-mono">tectonic</code>{' '}
                    binary on the PATH. The LaTeX source still saves normally.
                  </p>
                </div>
              </div>
            ) : null}

            <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.7fr)_minmax(0,1.2fr)]">
              {/* ---------------------------------------------------------- */}
              {/* Pane 1 — details + LaTeX source                            */}
              {/* ---------------------------------------------------------- */}
              <div className="flex min-h-0 flex-col gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="resume-name">Name</Label>
                  <Input
                    id="resume-name"
                    value={values.name}
                    onChange={(event) => set('name', event.target.value)}
                    placeholder="Backend engineer — 2026"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="resume-role">Target role</Label>
                  <Input
                    id="resume-role"
                    value={values.targetRole}
                    onChange={(event) => set('targetRole', event.target.value)}
                    placeholder="Senior Backend Engineer"
                  />
                </div>

                <div className="flex items-center gap-2.5">
                  <Switch
                    id="resume-default"
                    checked={values.isDefault}
                    onCheckedChange={(checked) => set('isDefault', checked)}
                  />
                  <Label htmlFor="resume-default" className="cursor-pointer">
                    Use as the default resume for scoring and applications
                  </Label>
                </div>

                <div className="flex min-h-0 flex-1 flex-col space-y-1.5">
                  <Label htmlFor="resume-latex">LaTeX source</Label>
                  <Textarea
                    id="resume-latex"
                    value={values.latex}
                    onChange={(event) => set('latex', event.target.value)}
                    spellCheck={false}
                    className="scrollbar-thin h-[30rem] resize-none font-mono text-xs leading-relaxed"
                    placeholder="\documentclass{deedy-resume-openfont}…"
                    required
                  />
                </div>
              </div>

              {/* ---------------------------------------------------------- */}
              {/* Pane 2 — theme                                             */}
              {/* ---------------------------------------------------------- */}
              <div className="scrollbar-thin flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
                <p className="text-xs font-medium">Theme</p>

                <div className="space-y-1.5">
                  <Label htmlFor="theme-font">Font</Label>
                  <Select
                    id="theme-font"
                    value={values.theme.font}
                    onChange={(event) =>
                      setTheme('font', event.target.value as ResumeTheme['font'])
                    }
                  >
                    {RESUME_FONTS.map((font) => (
                      <option key={font} value={font}>
                        {FONT_LABELS[font]}
                      </option>
                    ))}
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="theme-density">Density</Label>
                  <Select
                    id="theme-density"
                    value={values.theme.density}
                    onChange={(event) =>
                      setTheme('density', event.target.value as ResumeTheme['density'])
                    }
                  >
                    {RESUME_DENSITIES.map((density) => (
                      <option key={density} value={density}>
                        {DENSITY_LABELS[density]}
                      </option>
                    ))}
                  </Select>
                </div>

                {renderNumeric('baseFontSize')}

                <Separator />

                <div className="space-y-2">
                  {COLOR_FIELDS.map(({ key, label }) => (
                    <div key={key} className="flex items-center gap-2">
                      <Label htmlFor={`theme-${key}`} className="flex-1">
                        {label}
                      </Label>
                      <span className="font-mono text-[11px] uppercase text-muted-foreground">
                        {values.theme[key]}
                      </span>
                      <input
                        id={`theme-${key}`}
                        type="color"
                        // '#' added here and stripped on the way back — the stored
                        // theme is bare hex for `\definecolor{...}{HTML}{...}`.
                        value={toColorInput(values.theme[key])}
                        onChange={(event) => setTheme(key, fromColorInput(event.target.value))}
                        className="size-7 cursor-pointer rounded border border-input bg-background p-0.5"
                      />
                    </div>
                  ))}
                </div>

                <Separator />

                <div className="grid grid-cols-2 gap-2">
                  {renderNumeric('hmargin')}
                  {renderNumeric('vmargin')}
                </div>
              </div>

              {/* ---------------------------------------------------------- */}
              {/* Pane 3 — live PDF preview                                  */}
              {/* ---------------------------------------------------------- */}
              <div className="flex min-h-0 flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-medium">Preview</p>
                  {compile.status === 'pending' ? (
                    <Badge variant="outline" className="gap-1">
                      <RefreshCw className="size-3 animate-spin" />
                      compiling
                    </Badge>
                  ) : compile.status === 'failed' ? (
                    <Badge variant="destructive">compile failed</Badge>
                  ) : compile.status === 'ok' ? (
                    <Badge variant="success">compiled</Badge>
                  ) : (
                    <Badge variant="outline">not compiled yet</Badge>
                  )}
                  {compile.stale ? (
                    <Badge variant="outline" className="text-destructive">
                      showing last good PDF
                    </Badge>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="ml-auto"
                    disabled={compile.status === 'pending' || !latex.trim() || engineMissing}
                    onClick={() => {
                      if (values.theme) void runCompile(values.latex, values.theme);
                    }}
                  >
                    <RefreshCw />
                    Compile now
                  </Button>
                </div>

                <p className="tabular text-[11px] text-muted-foreground">
                  {compile.pages !== null ? `${compile.pages} page${compile.pages === 1 ? '' : 's'}` : '— pages'}
                  {' · '}
                  {compile.engine ?? template?.engine ?? 'no engine'}
                  {' · '}
                  {compile.durationMs !== null ? `${compile.durationMs} ms` : '— ms'}
                </p>

                <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-background">
                  {compile.previewId !== null ? (
                    <iframe
                      key={compile.previewId}
                      src={api.resumes.previewUrl(compile.previewId)}
                      title="Compiled resume PDF preview"
                      className="size-full"
                    />
                  ) : (
                    <div className="flex h-full min-h-[16rem] items-center justify-center p-6 text-center text-xs text-muted-foreground">
                      {engineMissing
                        ? 'No LaTeX engine installed — nothing to render.'
                        : 'The compiled PDF appears here a moment after you stop typing.'}
                    </div>
                  )}
                </div>

                {compile.status === 'failed' && compile.log ? (
                  <div className="rounded-md border border-destructive/40">
                    <p className="border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive">
                      Compile failed — engine log
                    </p>
                    <CompileLogBlock log={compile.log} className="max-h-40 rounded-t-none" />
                  </div>
                ) : null}
              </div>
            </div>

            {/* AI assist ------------------------------------------------- */}
            <div className="space-y-2 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  placeholder="Make it one page and lead with the platform work"
                  disabled={assist.isPending || resumeId === null}
                  className="min-w-[16rem] flex-1"
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={assist.isPending || resumeId === null || instruction.trim().length === 0}
                  title={
                    resumeId === null
                      ? 'Save this resume first — AI assist edits a stored document.'
                      : 'Rewrite the LaTeX with the local model'
                  }
                  onClick={() => {
                    if (resumeId !== null) {
                      assist.mutate({
                        id: resumeId,
                        latex: values.latex,
                        theme: values.theme,
                        instruction: instruction.trim(),
                      });
                    }
                  }}
                >
                  <Wand2 />
                  {assist.isPending ? 'Rewriting…' : 'Rewrite with AI'}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Runs on the local model on this machine — nothing leaves the host, and a full
                rewrite can take a while.
                {resumeId === null ? ' Save the resume first to enable it.' : ''}
              </p>
              {assistSummary.length > 0 ? (
                <ul className="list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
                  {assistSummary.map((entry, index) => (
                    <li key={index}>{entry}</li>
                  ))}
                </ul>
              ) : null}
            </div>

            {/* Macros reference — shown verbatim, never parsed as Markdown. */}
            {template ? (
              <Collapsible label={`Macro reference (${template.templateId})`}>
                <pre className="scrollbar-thin max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {template.macros}
                </pre>
              </Collapsible>
            ) : null}

            <div className="flex items-center justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="ghost" size="sm">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" size="sm" disabled={!valid || pending}>
                {pending ? 'Saving…' : submitLabel}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Resume card                                                                 */
/* -------------------------------------------------------------------------- */

const FORMATS: { format: 'pdf' | 'tex' | 'docx' | 'txt'; label: string }[] = [
  { format: 'pdf', label: 'PDF' },
  { format: 'tex', label: 'LaTeX' },
  { format: 'docx', label: 'DOCX' },
  { format: 'txt', label: 'Text' },
];

function ResumeCard({
  resume,
  onEdit,
  onDelete,
  onShowLog,
}: {
  resume: ResumeDto;
  onEdit?: (resume: ResumeDto) => void;
  onDelete: (resume: ResumeDto) => void;
  onShowLog: (resume: ResumeDto) => void;
}): JSX.Element {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="min-w-0 truncate">{resume.name}</CardTitle>
          <Badge variant="outline" className="tabular">
            v{resume.version}
          </Badge>
          {resume.isDefault ? (
            <Badge variant="success" className="gap-1">
              <Star className="size-3" />
              default
            </Badge>
          ) : null}
          {resume.compileOk ? (
            <Badge variant="success">compiled OK</Badge>
          ) : (
            <Badge
              variant="destructive"
              className="cursor-pointer gap-1"
              role="button"
              tabIndex={0}
              title="Show the engine log"
              onClick={() => onShowLog(resume)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                // Without this, Space also scrolls the page under the dialog.
                event.preventDefault();
                onShowLog(resume);
              }}
            >
              <AlertTriangle className="size-3" />
              failed to compile
            </Badge>
          )}
          {resume.atsScore !== null ? (
            <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
              ATS
              <ScoreBadge score={resume.atsScore} />
            </span>
          ) : null}
        </div>
        <CardDescription>
          {resume.targetRole ?? 'No target role set'} · {resume.templateId} · updated{' '}
          {formatDate(resume.updatedAt)}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-3">
        {resume.changeSummary.length > 0 ? (
          <ul className="list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
            {resume.changeSummary.map((entry, index) => (
              <li key={index}>{entry}</li>
            ))}
          </ul>
        ) : null}

        {!resume.isBase ? (
          <p className="text-[11px] text-muted-foreground">
            Generated {formatDate(resume.createdAt)}
            {resume.generatedBy ? ` by ${resume.generatedBy}` : ''}
            {resume.jobId !== null ? ` · job #${resume.jobId}` : ''}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Created {formatDate(resume.createdAt)}
          </p>
        )}

        {/* The plain-text mirror is what ATS parsers and the scoring prompt see. */}
        <Collapsible label="Extracted text (read-only)">
          <pre className="scrollbar-thin max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
            {resume.markdown.trim().length > 0
              ? resume.markdown
              : 'No text has been extracted from this document yet.'}
          </pre>
        </Collapsible>

        <Separator className="mt-auto" />

        <div className="flex flex-wrap items-center gap-1.5">
          {FORMATS.map(({ format, label }) => (
            <Button key={format} variant="outline" size="sm" asChild>
              <a href={api.resumes.downloadUrl(resume.id, format)} download>
                <Download />
                {label}
              </a>
            </Button>
          ))}

          <div className="ml-auto flex items-center gap-1">
            {onEdit ? (
              <Button
                variant="ghost"
                size="icon"
                title="Edit resume"
                aria-label={`Edit ${resume.name}`}
                onClick={() => onEdit(resume)}
              >
                <Pencil />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              title="Delete resume"
              aria-label={`Delete ${resume.name}`}
              className="text-destructive"
              onClick={() => onDelete(resume)}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export default function ResumesPage(): JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<ResumeDto | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<ResumeDto | null>(null);
  const [logTarget, setLogTarget] = React.useState<ResumeDto | null>(null);

  const resumes = useQuery({
    queryKey: ['resumes', { includeGenerated: true }],
    queryFn: () => api.resumes.list(true),
  });

  // The starter document, default theme and macro cheatsheet all come from the
  // server, so no LaTeX is hard-coded in the client.
  const template = useQuery({
    queryKey: ['resume-template'],
    queryFn: () => api.resumes.template(),
    staleTime: 5 * 60 * 1000,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['resumes'] });
  };

  const create = useMutation({
    mutationFn: (values: EditorValues) =>
      api.resumes.create({
        name: values.name.trim(),
        latex: values.latex,
        theme: values.theme,
        targetRole: values.targetRole.trim() || undefined,
        isBase: true,
        isDefault: values.isDefault,
      }),
    onSuccess: () => {
      toast.success('Resume saved');
      setCreateOpen(false);
      invalidate();
    },
    onError: (error: unknown) =>
      toast.error('Could not save resume', error instanceof Error ? error.message : undefined),
  });

  const update = useMutation({
    mutationFn: ({ id, values }: { id: number; values: EditorValues }) =>
      api.resumes.update(id, {
        name: values.name.trim(),
        latex: values.latex,
        theme: values.theme,
        targetRole: values.targetRole.trim() || undefined,
        isDefault: values.isDefault,
      }),
    onSuccess: () => {
      toast.success('Resume updated');
      setEditTarget(null);
      invalidate();
    },
    onError: (error: unknown) =>
      toast.error('Could not update resume', error instanceof Error ? error.message : undefined),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.resumes.remove(id),
    onSuccess: () => {
      toast.success('Resume deleted');
      setDeleteTarget(null);
      invalidate();
    },
    onError: (error: unknown) =>
      toast.error('Could not delete resume', error instanceof Error ? error.message : undefined),
  });

  const all = resumes.data?.resumes ?? [];
  const base = all.filter((resume) => resume.isBase);
  const generated = all.filter((resume) => !resume.isBase);

  const createInitial = React.useMemo<EditorValues | null>(
    () =>
      template.data
        ? {
            name: '',
            targetRole: '',
            isDefault: false,
            latex: template.data.latex,
            theme: template.data.theme,
          }
        : null,
    [template.data],
  );

  const editInitial = React.useMemo<EditorValues | null>(
    () =>
      editTarget
        ? {
            name: editTarget.name,
            targetRole: editTarget.targetRole ?? '',
            isDefault: editTarget.isDefault,
            latex: editTarget.latex,
            theme: editTarget.theme,
          }
        : null,
    [editTarget],
  );

  return (
    <div>
      <PageHeader
        title="Resumes"
        description="Base resumes are LaTeX documents stored on this machine and compiled locally to PDF. Tailored versions are generated by your model and never leave the host."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['resumes'] })}
            >
              <RefreshCw />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus />
              New resume
            </Button>
          </>
        }
      />

      {resumes.isError ? <ErrorState error={resumes.error} /> : null}

      {resumes.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-52 w-full" />
          <Skeleton className="h-52 w-full" />
        </div>
      ) : all.length === 0 ? (
        <EmptyState
          icon={<FileText />}
          title="No resumes yet"
          description="Write your resume once in LaTeX. Every score, tailored version and application on this machine builds on it."
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus />
              Add your first resume
            </Button>
          }
        />
      ) : (
        <Tabs defaultValue="base">
          <TabsList>
            <TabsTrigger value="base">Base resumes ({base.length})</TabsTrigger>
            <TabsTrigger value="generated">AI-generated versions ({generated.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="base">
            {base.length === 0 ? (
              <EmptyState
                icon={<FileText />}
                title="No base resumes"
                description="Create a base resume to give the tailoring pipeline something to work from."
                action={
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus />
                    New resume
                  </Button>
                }
              />
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                {base.map((resume) => (
                  <ResumeCard
                    key={resume.id}
                    resume={resume}
                    onEdit={setEditTarget}
                    onDelete={setDeleteTarget}
                    onShowLog={setLogTarget}
                  />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="generated">
            {generated.length === 0 ? (
              <EmptyState
                icon={<Sparkles />}
                title="No tailored versions yet"
                description="Open a job and run “Tailor resume” to produce a version aimed at that posting."
              />
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                {generated.map((resume) => (
                  <ResumeCard
                    key={resume.id}
                    resume={resume}
                    onDelete={setDeleteTarget}
                    onShowLog={setLogTarget}
                  />
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}

      <ResumeEditorDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New resume"
        description="Start from the bundled template and edit the LaTeX. It is stored locally and compiled to PDF on this machine."
        initial={createInitial}
        resumeId={null}
        template={template.data}
        submitLabel="Create resume"
        pending={create.isPending}
        onSubmit={(values) => create.mutate(values)}
      />

      <ResumeEditorDialog
        open={editTarget !== null}
        onOpenChange={(next) => {
          if (!next) setEditTarget(null);
        }}
        title={editTarget ? `Edit ${editTarget.name}` : 'Edit resume'}
        description="Changing the LaTeX creates a new version - the previous one is kept so earlier applications stay reproducible."
        initial={editInitial}
        resumeId={editTarget?.id ?? null}
        template={template.data}
        submitLabel="Save changes"
        pending={update.isPending}
        onSubmit={(values) => {
          if (editTarget) update.mutate({ id: editTarget.id, values });
        }}
      />

      <Dialog
        open={logTarget !== null}
        onOpenChange={(next) => {
          if (!next) setLogTarget(null);
        }}
      >
        <DialogContent className="w-[min(56rem,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold text-destructive">
              Compile log{logTarget ? ` — ${logTarget.name}` : ''}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Verbatim output from the LaTeX engine on this host.
            </DialogDescription>
          </DialogHeader>
          <CompileLogBlock
            log={logTarget?.compileLog ?? 'No log was recorded for this resume.'}
            className="max-h-[28rem]"
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
      >
        <DialogContent className="w-[min(28rem,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">Delete resume</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {deleteTarget
                ? `“${deleteTarget.name}” (v${deleteTarget.version}) and its rendered .tex, PDF and DOCX files will be removed from disk. This cannot be undone.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={remove.isPending}
              onClick={() => {
                if (deleteTarget) remove.mutate(deleteTarget.id);
              }}
            >
              <Trash2 />
              {remove.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

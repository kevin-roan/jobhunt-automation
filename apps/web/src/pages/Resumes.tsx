import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Download,
  FileText,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import type { ResumeDto } from '@deedy/shared';
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
/* Minimal markdown renderer                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Everything is HTML-escaped BEFORE any markdown rule runs, so no author-supplied
 * markup can ever reach the DOM. The rules below only ever emit tags we generate.
 */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Refuse anything that is not a plain http(s)/mailto/relative target. */
function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (!href) return null;
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (/^[./#]/.test(href)) return href;
  return null;
}

function renderInline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text: string, url: string) => {
      const href = safeHref(url);
      return href ? `<a href="${href}" target="_blank" rel="noreferrer">${text}</a>` : match;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
}

/** Headings, hr, ordered/unordered lists, blockquotes and paragraphs. Nothing else. */
function renderMarkdown(source: string): string {
  const lines = escapeHtml(source).replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let listTag: 'ul' | 'ol' | null = null;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };

  const flushList = (): void => {
    if (!listTag) return;
    html.push(`</${listTag}>`);
    listTag = null;
  };

  const openList = (tag: 'ul' | 'ol'): void => {
    if (listTag === tag) return;
    flushList();
    html.push(`<${tag}>`);
    listTag = tag;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '') {
      flushParagraph();
      flushList();
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      flushList();
      html.push('<hr />');
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      const level = (heading[1] ?? '#').length;
      html.push(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`);
      continue;
    }

    const quote = /^&gt;\s?(.*)$/.exec(trimmed);
    if (quote) {
      flushParagraph();
      flushList();
      html.push(`<blockquote>${renderInline(quote[1] ?? '')}</blockquote>`);
      continue;
    }

    const unordered = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (unordered) {
      flushParagraph();
      openList('ul');
      html.push(`<li>${renderInline(unordered[1] ?? '')}</li>`);
      continue;
    }

    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (ordered) {
      flushParagraph();
      openList('ol');
      html.push(`<li>${renderInline(ordered[1] ?? '')}</li>`);
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  return html.join('\n');
}

const PREVIEW_CLASS = [
  'text-sm leading-relaxed',
  '[&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:tracking-tight',
  '[&_h2]:mb-1.5 [&_h2]:mt-4 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-wide',
  '[&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-medium',
  '[&_h4]:mt-3 [&_h4]:text-sm [&_h4]:font-medium [&_h5]:mt-3 [&_h5]:text-sm [&_h6]:mt-3 [&_h6]:text-sm',
  '[&_p]:my-2 [&_p]:text-muted-foreground',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_li]:my-0.5 [&_li]:text-muted-foreground',
  '[&_hr]:my-3 [&_hr]:border-border',
  '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
  '[&_strong]:font-semibold [&_strong]:text-foreground',
  '[&_code]:rounded [&_code]:bg-secondary [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs',
  '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
  '[&>*:first-child]:mt-0',
].join(' ');

function MarkdownPreview({ source }: { source: string }): JSX.Element {
  const html = React.useMemo(() => renderMarkdown(source), [source]);
  if (!source.trim()) {
    return (
      <p className="text-xs text-muted-foreground">
        The preview renders here as you type.
      </p>
    );
  }
  return <div className={PREVIEW_CLASS} dangerouslySetInnerHTML={{ __html: html }} />;
}

/* -------------------------------------------------------------------------- */
/* Editor dialog                                                               */
/* -------------------------------------------------------------------------- */

const STARTER_MARKDOWN = `# Your Name

Email · Phone · City · [portfolio](https://example.com)

## Summary

One or two sentences on what you build and the impact you have had.

## Experience

### Job title — Company (2022 - present)

- Shipped something measurable, with the number attached.
- Owned a system end to end.

## Skills

TypeScript, Python, Postgres, Playwright
`;

interface EditorValues {
  name: string;
  targetRole: string;
  isDefault: boolean;
  markdown: string;
}

function ResumeEditorDialog({
  open,
  onOpenChange,
  title,
  description,
  initial,
  submitLabel,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  title: string;
  description: string;
  initial: EditorValues;
  submitLabel: string;
  pending: boolean;
  onSubmit: (values: EditorValues) => void;
}): JSX.Element {
  const [values, setValues] = React.useState<EditorValues>(initial);

  // Re-seed the form each time the dialog opens so a cancelled edit is not sticky.
  React.useEffect(() => {
    if (open) setValues(initial);
  }, [open, initial]);

  const set = <K extends keyof EditorValues>(key: K, value: EditorValues[K]): void =>
    setValues((current) => ({ ...current, [key]: value }));

  const valid = values.name.trim().length > 0 && values.markdown.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(70rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {description}
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex min-h-0 flex-1 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !pending) onSubmit(values);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
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

          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
            <div className="flex min-h-0 flex-col space-y-1.5">
              <Label htmlFor="resume-markdown">Markdown</Label>
              <Textarea
                id="resume-markdown"
                value={values.markdown}
                onChange={(event) => set('markdown', event.target.value)}
                spellCheck={false}
                className="scrollbar-thin h-[22rem] resize-none font-mono text-xs leading-relaxed"
                placeholder="# Your Name…"
                required
              />
            </div>
            <div className="flex min-h-0 flex-col space-y-1.5">
              <Label>Preview</Label>
              <div className="scrollbar-thin h-[22rem] overflow-y-auto rounded-md border border-border bg-background p-4">
                <MarkdownPreview source={values.markdown} />
              </div>
            </div>
          </div>

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
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Resume card                                                                 */
/* -------------------------------------------------------------------------- */

const FORMATS: { format: 'pdf' | 'docx' | 'md'; label: string }[] = [
  { format: 'pdf', label: 'PDF' },
  { format: 'docx', label: 'DOCX' },
  { format: 'md', label: 'Markdown' },
];

function ResumeCard({
  resume,
  onEdit,
  onDelete,
}: {
  resume: ResumeDto;
  onEdit?: (resume: ResumeDto) => void;
  onDelete: (resume: ResumeDto) => void;
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
          {resume.atsScore !== null ? (
            <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
              ATS
              <ScoreBadge score={resume.atsScore} />
            </span>
          ) : null}
        </div>
        <CardDescription>
          {resume.targetRole ?? 'No target role set'} · updated {formatDate(resume.updatedAt)}
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
                onClick={() => onEdit(resume)}
              >
                <Pencil />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              title="Delete resume"
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

const EMPTY_VALUES: EditorValues = {
  name: '',
  targetRole: '',
  isDefault: false,
  markdown: STARTER_MARKDOWN,
};

export default function ResumesPage(): JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<ResumeDto | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<ResumeDto | null>(null);

  const resumes = useQuery({
    queryKey: ['resumes', { includeGenerated: true }],
    queryFn: () => api.resumes.list(true),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['resumes'] });
  };

  const create = useMutation({
    mutationFn: (values: EditorValues) =>
      api.resumes.create({
        name: values.name.trim(),
        markdown: values.markdown,
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
        markdown: values.markdown,
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

  const editInitial = React.useMemo<EditorValues>(
    () =>
      editTarget
        ? {
            name: editTarget.name,
            targetRole: editTarget.targetRole ?? '',
            isDefault: editTarget.isDefault,
            markdown: editTarget.markdown,
          }
        : EMPTY_VALUES,
    [editTarget],
  );

  return (
    <div>
      <PageHeader
        title="Resumes"
        description="Base resumes live in plain Markdown on this machine. Tailored versions are generated locally by your model and never leave the host."
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
          description="Add your resume as Markdown once. Every score, tailored version and application on this machine builds on it."
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
                  <ResumeCard key={resume.id} resume={resume} onDelete={setDeleteTarget} />
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
        description="Write or paste your resume as Markdown. It is stored locally and rendered to PDF and DOCX on this machine."
        initial={EMPTY_VALUES}
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
        description="Changing the Markdown creates a new version - the previous one is kept so earlier applications stay reproducible."
        initial={editInitial}
        submitLabel="Save changes"
        pending={update.isPending}
        onSubmit={(values) => {
          if (editTarget) update.mutate({ id: editTarget.id, values });
        }}
      />

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
                ? `“${deleteTarget.name}” (v${deleteTarget.version}) and its rendered PDF and DOCX files will be removed from disk. This cannot be undone.`
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

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  CircleSlash,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Tags,
  Target,
  Trash2,
  TriangleAlert,
  User,
} from 'lucide-react';
import type { SearchKeywordDto } from '@deedy/shared';
import { api } from '@/lib/api';
import { cn, formatNumber, relativeTime } from '@/lib/utils';
import { ErrorState, PageHeader, ScoreBadge, StatCard } from '@/components/common';
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
} from '@/components/ui/overlays';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';

/** Shape of the `['keywords']` cache entry, needed to patch it optimistically. */
interface KeywordList {
  keywords: SearchKeywordDto[];
}

type OriginFilter = 'all' | 'user' | 'llm';
type EnabledFilter = 'all' | 'enabled' | 'disabled';
type BulkAction = 'enable-all' | 'disable-all' | 'delete-generated';

interface KeywordGroup {
  key: string;
  seed: SearchKeywordDto | null;
  label: string;
  expansions: SearchKeywordDto[];
}

const BULK_COPY: Record<BulkAction, { title: string; description: string; confirm: string }> = {
  'enable-all': {
    title: 'Enable every term?',
    description:
      'Every keyword below — yours and the ones the local model wrote — will be searched on the next collector run.',
    confirm: 'Enable all',
  },
  'disable-all': {
    title: 'Disable every term?',
    description:
      'No keyword will be typed into any platform search box until you enable at least one again, so no collector will find jobs.',
    confirm: 'Disable all',
  },
  'delete-generated': {
    title: 'Delete every AI-generated term?',
    description:
      'Your own seed terms are kept. The generated expansions are removed from the local database and can be regenerated at any time.',
    confirm: 'Delete generated',
  },
};

export default function KeywordsPage(): JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [seedText, setSeedText] = React.useState('');
  const [perSeed, setPerSeed] = React.useState('');
  const [replaceGenerated, setReplaceGenerated] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [originFilter, setOriginFilter] = React.useState<OriginFilter>('all');
  const [enabledFilter, setEnabledFilter] = React.useState<EnabledFilter>('all');
  const [scopeTargetId, setScopeTargetId] = React.useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<SearchKeywordDto | null>(null);
  const [bulkAction, setBulkAction] = React.useState<BulkAction | null>(null);

  const keywords = useQuery({
    queryKey: ['keywords'],
    queryFn: () => api.keywords.list(),
  });

  const sources = useQuery({
    queryKey: ['sources'],
    queryFn: () => api.sources.list(),
  });

  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
  });

  const items = React.useMemo<SearchKeywordDto[]>(
    () => keywords.data?.keywords ?? [],
    [keywords.data],
  );

  const configuredPerSeed = settings.data?.search.keywordExpansion.perSeed ?? 6;

  // Seed the expansion width from settings once they land, without stomping edits.
  React.useEffect(() => {
    if (settings.data && perSeed === '') setPerSeed(String(configuredPerSeed));
  }, [settings.data, configuredPerSeed, perSeed]);

  // `SourceStatusDto.activeKeywords` counts these, so any keyword write also
  // ages the sources view — which has no poll of its own.
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['keywords'] });
    void queryClient.invalidateQueries({ queryKey: ['sources'] });
  };

  const create = useMutation({
    mutationFn: (text: string) => api.keywords.create({ keywords: text, origin: 'user' }),
    onSuccess: (result) => {
      toast.success(
        `Added ${result.created} keyword${result.created === 1 ? '' : 's'}`,
        result.created === 0 ? 'Every term you entered already exists.' : undefined,
      );
      setSeedText('');
      invalidate();
    },
    onError: (error: unknown) =>
      toast.error('Could not add keywords', error instanceof Error ? error.message : undefined),
  });

  const expand = useMutation({
    mutationFn: () =>
      api.keywords.expand({
        perSeed: Number(perSeed) > 0 ? Number(perSeed) : configuredPerSeed,
        replaceGenerated,
      }),
    onSuccess: (result) => {
      toast.success(
        `${result.created} new term${result.created === 1 ? '' : 's'} from ${result.model}`,
        `${result.skipped} skipped as duplicates · ${result.removed} removed`,
      );
      invalidate();
    },
    onError: (error: unknown) =>
      toast.error('Expansion failed', error instanceof Error ? error.message : undefined),
  });

  const syncSeeds = useMutation({
    mutationFn: () => api.keywords.syncSeeds(),
    onSuccess: (result) => {
      toast.success('Seeds synced from settings', `${result.keywords.length} terms in total`);
      invalidate();
    },
    onError: (error: unknown) =>
      toast.error('Could not sync seeds', error instanceof Error ? error.message : undefined),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      api.keywords.update(id, { enabled }),
    onSuccess: (keyword) => {
      toast.success(keyword.enabled ? `"${keyword.keyword}" enabled` : `"${keyword.keyword}" disabled`);
      invalidate();
    },
    onError: (error: unknown) =>
      toast.error('Could not update keyword', error instanceof Error ? error.message : undefined),
  });

  const setScope = useMutation({
    mutationFn: ({ id, sources: next }: { id: number; sources: string[] }) =>
      api.keywords.update(id, { sources: next }),
    // The scope editor PATCHes the whole array, and it builds that array from the
    // cache. Writing the new list back before the request settles is what makes
    // three quick toggles compose instead of all forking off the same stale list.
    onMutate: async ({ id, sources: next }) => {
      // An in-flight list refetch would land after this and undo it.
      await queryClient.cancelQueries({ queryKey: ['keywords'] });
      queryClient.setQueryData<KeywordList>(['keywords'], (current) =>
        current
          ? {
              ...current,
              keywords: current.keywords.map((keyword) =>
                keyword.id === id ? { ...keyword, sources: next } : keyword,
              ),
            }
          : current,
      );
    },
    onSuccess: (keyword) => {
      toast.success(
        `Scope updated for "${keyword.keyword}"`,
        keyword.sources.length === 0 ? 'Searched on all sources' : keyword.sources.join(', '),
      );
      invalidate();
    },
    onError: (error: unknown) => {
      // The optimistic list is now a lie — pull the server's version back.
      invalidate();
      toast.error('Could not update scope', error instanceof Error ? error.message : undefined);
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.keywords.remove(id),
    onSuccess: () => {
      toast.success('Keyword deleted');
      setDeleteTarget(null);
      invalidate();
    },
    onError: (error: unknown) =>
      toast.error('Could not delete keyword', error instanceof Error ? error.message : undefined),
  });

  const bulk = useMutation({
    mutationFn: async (action: BulkAction): Promise<number> => {
      if (action === 'delete-generated') {
        const targets = items.filter((item) => item.origin === 'llm');
        for (const target of targets) await api.keywords.remove(target.id);
        return targets.length;
      }
      const enabled = action === 'enable-all';
      const targets = items.filter((item) => item.enabled !== enabled);
      for (const target of targets) await api.keywords.update(target.id, { enabled });
      return targets.length;
    },
    onSuccess: (count, action) => {
      const verb =
        action === 'delete-generated' ? 'deleted' : action === 'enable-all' ? 'enabled' : 'disabled';
      toast.success(`${count} keyword${count === 1 ? '' : 's'} ${verb}`);
      setBulkAction(null);
      invalidate();
    },
    onError: (error: unknown) =>
      toast.error('Bulk action failed', error instanceof Error ? error.message : undefined),
  });

  const matches = React.useCallback(
    (keyword: SearchKeywordDto): boolean => {
      const term = search.trim().toLowerCase();
      if (term && !keyword.keyword.toLowerCase().includes(term)) return false;
      if (originFilter !== 'all' && keyword.origin !== originFilter) return false;
      if (enabledFilter === 'enabled' && !keyword.enabled) return false;
      if (enabledFilter === 'disabled' && keyword.enabled) return false;
      return true;
    },
    [search, originFilter, enabledFilter],
  );

  const groups = React.useMemo<KeywordGroup[]>(() => {
    const seeds = items.filter((item) => item.seed === null && item.origin === 'user');
    const seedByTerm = new Map(seeds.map((seed) => [seed.keyword.toLowerCase(), seed]));

    const built: KeywordGroup[] = seeds.map((seed) => ({
      key: `seed-${seed.id}`,
      seed,
      label: seed.keyword,
      expansions: [],
    }));
    const byId = new Map(built.map((group) => [group.key, group]));
    const orphans: SearchKeywordDto[] = [];

    for (const item of items) {
      if (item.seed === null && item.origin === 'user') continue;
      const parent = item.seed ? seedByTerm.get(item.seed.toLowerCase()) : undefined;
      const group = parent ? byId.get(`seed-${parent.id}`) : undefined;
      if (group) group.expansions.push(item);
      else orphans.push(item);
    }

    if (orphans.length > 0) {
      built.push({ key: 'ungrouped', seed: null, label: 'Ungrouped', expansions: orphans });
    }

    return built
      .map((group) => ({ ...group, expansions: group.expansions.filter(matches) }))
      .filter(
        (group) =>
          group.expansions.length > 0 || (group.seed !== null && matches(group.seed)),
      );
  }, [items, matches]);

  const total = items.length;
  const enabledCount = items.filter((item) => item.enabled).length;
  const seedCount = items.filter((item) => item.seed === null && item.origin === 'user').length;
  const generatedCount = items.filter((item) => item.origin === 'llm').length;

  const sourceOptions = sources.data?.sources ?? [];
  const scopeTarget = items.find((item) => item.id === scopeTargetId) ?? null;

  const describeScope = (keyword: SearchKeywordDto): string =>
    keyword.sources.length === 0
      ? 'All sources'
      : keyword.sources
          .map((id) => sourceOptions.find((source) => source.id === id)?.name ?? id)
          .join(', ');

  const toggleScopeSource = (keyword: SearchKeywordDto, sourceId: string, on: boolean): void => {
    const next = on
      ? [...keyword.sources, sourceId]
      : keyword.sources.filter((id) => id !== sourceId);
    setScope.mutate({ id: keyword.id, sources: next });
  };

  const renderScopeButton = (keyword: SearchKeywordDto): JSX.Element => (
    <Button
      variant="outline"
      size="sm"
      className="max-w-[14rem] justify-start"
      onClick={() => setScopeTargetId(keyword.id)}
    >
      <Target />
      <span className="truncate">{describeScope(keyword)}</span>
    </Button>
  );

  const renderDeleteButton = (keyword: SearchKeywordDto): JSX.Element => (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Delete ${keyword.keyword}`}
      onClick={() => setDeleteTarget(keyword)}
    >
      <Trash2 />
    </Button>
  );

  return (
    <div>
      <PageHeader
        title="Keywords"
        description="These are the terms typed into each platform's search box. The local model widens your own terms and you decide which ones are actually used."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncSeeds.mutate()}
              disabled={syncSeeds.isPending}
            >
              <RefreshCw />
              {syncSeeds.isPending ? 'Syncing…' : 'Sync seeds from settings'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['keywords'] })}
            >
              <RefreshCw />
              Refresh
            </Button>
          </>
        }
      />

      {keywords.isError ? <ErrorState error={keywords.error} /> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Add your own terms</CardTitle>
            <CardDescription>
              One term per line is easiest — commas and semicolons work too. These become the seeds
              the model expands around.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="keyword-seeds">Keywords</Label>
              <Textarea
                id="keyword-seeds"
                value={seedText}
                onChange={(event) => setSeedText(event.target.value)}
                placeholder={'senior backend engineer\nplatform engineer\ntypescript'}
                rows={5}
              />
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={seedText.trim().length === 0 || create.isPending}
                onClick={() => create.mutate(seedText)}
              >
                <Plus />
                {create.isPending ? 'Adding…' : 'Add keywords'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Expand with AI</CardTitle>
            <CardDescription>
              The model runs on this machine and never sends anything out. On CPU this can take a
              minute or two per seed — leave the page open while it works.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="per-seed">Terms per seed</Label>
                <Input
                  id="per-seed"
                  type="number"
                  min={1}
                  max={25}
                  value={perSeed}
                  onChange={(event) => setPerSeed(event.target.value)}
                />
              </div>
              <div className="flex items-end">
                <label className="flex w-full items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                  <span className="text-xs text-muted-foreground">
                    Replace previously generated
                  </span>
                  <Switch checked={replaceGenerated} onCheckedChange={setReplaceGenerated} />
                </label>
              </div>
            </div>
            <Separator />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">
                {seedCount === 0
                  ? 'Add at least one keyword of your own first.'
                  : `Expanding ${seedCount} seed${seedCount === 1 ? '' : 's'}.`}
              </p>
              <Button
                size="sm"
                disabled={expand.isPending || seedCount === 0}
                onClick={() => expand.mutate()}
              >
                <Sparkles />
                {expand.isPending
                  ? 'Generating locally — this can be slow on CPU…'
                  : 'Generate related keywords'}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total terms"
          value={formatNumber(total)}
          icon={<Tags />}
          loading={keywords.isLoading}
        />
        <StatCard
          label="Enabled"
          value={formatNumber(enabledCount)}
          hint="Searched on the next run"
          icon={<CheckCircle2 />}
          tone={enabledCount === 0 ? 'destructive' : 'success'}
          loading={keywords.isLoading}
        />
        <StatCard
          label="Your seeds"
          value={formatNumber(seedCount)}
          icon={<User />}
          loading={keywords.isLoading}
        />
        <StatCard
          label="AI generated"
          value={formatNumber(generatedCount)}
          icon={<Sparkles />}
          loading={keywords.isLoading}
        />
      </div>

      {!keywords.isLoading && total > 0 && enabledCount === 0 ? (
        <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <p>
            No keyword is enabled. Every collector will search nothing and no jobs will be found —
            enable at least one term below.
          </p>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search keywords…"
            className="pl-8"
            aria-label="Search keywords"
          />
        </div>
        <Select
          value={originFilter}
          onChange={(event) => setOriginFilter(event.target.value as OriginFilter)}
          className="w-auto"
          aria-label="Filter by origin"
        >
          <option value="all">All origins</option>
          <option value="user">Yours</option>
          <option value="llm">AI generated</option>
        </Select>
        <Select
          value={enabledFilter}
          onChange={(event) => setEnabledFilter(event.target.value as EnabledFilter)}
          className="w-auto"
          aria-label="Filter by state"
        >
          <option value="all">Enabled and disabled</option>
          <option value="enabled">Enabled only</option>
          <option value="disabled">Disabled only</option>
        </Select>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setBulkAction('enable-all')}
          disabled={total === 0}
        >
          <CheckCircle2 />
          Enable all
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setBulkAction('disable-all')}
          disabled={total === 0}
        >
          <CircleSlash />
          Disable all
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setBulkAction('delete-generated')}
          disabled={generatedCount === 0}
        >
          <Trash2 />
          Delete generated
        </Button>
      </div>

      <div className="mt-4 space-y-4">
        {keywords.isLoading ? (
          <>
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-48 w-full" />
          </>
        ) : total === 0 ? (
          <EmptyState
            icon={<Tags />}
            title="No search keywords yet"
            description="Write the terms you would type into a job board yourself. The local model then widens them into the variations each platform actually indexes."
          />
        ) : groups.length === 0 ? (
          <EmptyState
            icon={<Search />}
            title="No keyword matches these filters"
            description="Clear the search box or widen the origin and state filters."
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearch('');
                  setOriginFilter('all');
                  setEnabledFilter('all');
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          groups.map((group) => (
            <Card key={group.key}>
              <CardHeader className="gap-2">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    {group.seed ? (
                      <Switch
                        checked={group.seed.enabled}
                        aria-label={`Enable ${group.seed.keyword}`}
                        // Only this row waits on its own request; a pending toggle
                        // elsewhere must not freeze the whole page.
                        disabled={toggle.isPending && toggle.variables?.id === group.seed.id}
                        onCheckedChange={(next) => {
                          if (group.seed) toggle.mutate({ id: group.seed.id, enabled: next });
                        }}
                      />
                    ) : null}
                    <CardTitle
                      className={cn(
                        'truncate text-sm',
                        group.seed && !group.seed.enabled && 'text-muted-foreground line-through',
                      )}
                    >
                      {group.label}
                    </CardTitle>
                    {group.seed ? (
                      <Badge variant="outline">your term</Badge>
                    ) : (
                      <Badge variant="secondary">seed no longer exists</Badge>
                    )}
                    <Badge variant="secondary">
                      {group.expansions.length} expansion
                      {group.expansions.length === 1 ? '' : 's'}
                    </Badge>
                  </div>
                  {group.seed ? (
                    <div className="flex items-center gap-2">
                      {renderScopeButton(group.seed)}
                      {renderDeleteButton(group.seed)}
                    </div>
                  ) : null}
                </div>
                {group.seed ? (
                  <CardDescription>
                    {formatNumber(group.seed.jobsFound)} job
                    {group.seed.jobsFound === 1 ? '' : 's'} found · last searched{' '}
                    {group.seed.lastUsedAt ? relativeTime(group.seed.lastUsedAt) : 'never'}
                  </CardDescription>
                ) : (
                  <CardDescription>
                    Generated terms whose seed has since been deleted. They are still searched while
                    enabled.
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="p-0">
                {group.expansions.length === 0 ? (
                  <p className="px-5 pb-5 text-xs text-muted-foreground">
                    No expansions for this seed yet — run “Generate related keywords” above.
                  </p>
                ) : (
                  <TableWrapper className="rounded-none border-x-0 border-b-0">
                    <Table>
                      <THead>
                        <TR>
                          <TH className="w-14">On</TH>
                          <TH>Keyword</TH>
                          <TH>Kind</TH>
                          <TH>Confidence</TH>
                          <TH>Scope</TH>
                          <TH className="text-right">Jobs</TH>
                          <TH className="w-12" />
                        </TR>
                      </THead>
                      <TBody>
                        {group.expansions.map((keyword) => (
                          <TR key={keyword.id}>
                            <TD>
                              <Switch
                                checked={keyword.enabled}
                                aria-label={`Enable ${keyword.keyword}`}
                                disabled={toggle.isPending && toggle.variables?.id === keyword.id}
                                onCheckedChange={(next) =>
                                  toggle.mutate({ id: keyword.id, enabled: next })
                                }
                              />
                            </TD>
                            <TD>
                              <span
                                className={cn(
                                  'text-sm',
                                  !keyword.enabled && 'text-muted-foreground line-through',
                                )}
                              >
                                {keyword.keyword}
                              </span>
                              {keyword.origin === 'user' ? (
                                <Badge variant="outline" className="ml-2">
                                  yours
                                </Badge>
                              ) : null}
                            </TD>
                            <TD>
                              <Badge variant="secondary">{keyword.kind.replace(/_/g, ' ')}</Badge>
                            </TD>
                            <TD>
                              <ScoreBadge
                                score={
                                  keyword.confidence === null ? null : keyword.confidence * 100
                                }
                              />
                            </TD>
                            <TD>{renderScopeButton(keyword)}</TD>
                            <TD className="tabular text-right">
                              {formatNumber(keyword.jobsFound)}
                            </TD>
                            <TD className="text-right">{renderDeleteButton(keyword)}</TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  </TableWrapper>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <Dialog
        open={scopeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setScopeTargetId(null);
        }}
      >
        <DialogContent className="w-[min(32rem,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle>Scope “{scopeTarget?.keyword ?? ''}”</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Pick the collectors that should search this term. With nothing picked it runs on all
              sources.
            </DialogDescription>
          </DialogHeader>

          {sources.isError ? (
            <ErrorState error={sources.error} />
          ) : sourceOptions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No collectors are configured yet.</p>
          ) : (
            <div className="scrollbar-thin max-h-72 space-y-1 overflow-y-auto">
              {sourceOptions.map((source) => (
                <label
                  key={source.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{source.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {source.enabled ? 'collector enabled' : 'collector disabled'}
                    </span>
                  </span>
                  <Switch
                    checked={scopeTarget?.sources.includes(source.id) ?? false}
                    // Not disabled while pending: every switch here belongs to the
                    // same keyword, so gating on the mutation would freeze the whole
                    // dialog. The optimistic cache write makes rapid toggles compose.
                    onCheckedChange={(next) => {
                      if (scopeTarget) toggleScopeSource(scopeTarget, source.id, next);
                    }}
                  />
                </label>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={setScope.isPending || (scopeTarget?.sources.length ?? 0) === 0}
              onClick={() => {
                if (scopeTarget) setScope.mutate({ id: scopeTarget.id, sources: [] });
              }}
            >
              Use all sources
            </Button>
            <DialogClose asChild>
              <Button size="sm">Done</Button>
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent className="w-[min(28rem,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle>Delete “{deleteTarget?.keyword ?? ''}”?</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {deleteTarget && deleteTarget.seed === null && deleteTarget.origin === 'user'
                ? 'This is one of your own seeds. Its generated expansions stay, but they move to the Ungrouped section.'
                : 'The term is removed from the local database and will not be searched again.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm">
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

      <Dialog
        open={bulkAction !== null}
        onOpenChange={(open) => {
          if (!open) setBulkAction(null);
        }}
      >
        <DialogContent className="w-[min(28rem,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle>{bulkAction ? BULK_COPY[bulkAction].title : ''}</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {bulkAction ? BULK_COPY[bulkAction].description : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant={bulkAction === 'delete-generated' ? 'destructive' : 'default'}
              size="sm"
              disabled={bulk.isPending}
              onClick={() => {
                if (bulkAction) bulk.mutate(bulkAction);
              }}
            >
              {bulk.isPending ? 'Working…' : bulkAction ? BULK_COPY[bulkAction].confirm : ''}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

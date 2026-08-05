import type {
  CreateKeywordsInput,
  ExpandKeywordsInput,
  ExpandKeywordsResult,
  KeywordExpansion,
  SearchKeywordDto,
  UpdateKeywordInput,
} from '@deedy/shared';
import { ConfigurationError, ConflictError, NotFoundError, toErrorMessage } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { NewSearchKeywordRow } from '../db/schema.js';
import {
  normalizeKeyword,
  toSearchKeywordDto,
  type KeywordRepository,
} from '../repositories/keyword.repository.js';
import { describeProfile } from './job.service.js';
import type { SettingsService } from './settings.service.js';
import type { LlmService, LlmTaskResult } from './llm/llm.service.js';

/** A search box will not take more than this, and neither will the DTO schema. */
const MAX_KEYWORD_LENGTH = 80;

/**
 * `kind` of a row that syncSeeds itself imported from `settings.search.keywords`.
 * Only these are swept when a seed disappears from Settings; anything else on
 * the Keywords page was hand-added there and is the user's to delete.
 */
const SEED_KIND = 'seed';

/** What one seed reconciliation actually did, for the caller to surface. */
export interface SyncSeedsResult {
  keywords: SearchKeywordDto[];
  /** Seed rows removed because Settings no longer lists them. */
  removedSeeds: number;
  /** Generated rows removed along with the seed they were expanded from. */
  removedExpansions: number;
  added: number;
}

/** People paste keyword lists in whatever shape their notes happen to be in. */
function splitTerms(raw: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const part of raw.split(/[\n,;]+/)) {
    const term = part.trim();
    if (term.length === 0 || term.length > MAX_KEYWORD_LENGTH) continue;
    const key = normalizeKeyword(term);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

/**
 * Owns the vocabulary the collectors search with: the candidate's own seed
 * terms, plus the local model's expansions of them. Both live as individually
 * editable rows so nothing is ever searched that the user cannot see and veto.
 */
export class KeywordService {
  constructor(
    private readonly repository: KeywordRepository,
    private readonly settingsService: SettingsService,
    private readonly llm: LlmService,
    private readonly logger: Logger,
  ) {}

  list(): SearchKeywordDto[] {
    return this.repository.list().map(toSearchKeywordDto);
  }

  /**
   * Splits free text on newlines, commas and semicolons; trims, drops blanks and duplicates.
   *
   * These terms are deliberately NOT mirrored back into `settings.search.keywords`.
   * That list is the candidate's *seed* vocabulary — the handful of terms the
   * model expands from — while this page holds every term that will actually be
   * typed into a search box, seeds included. Mirroring would (a) promote every
   * hand-typed variant into a seed and so into the next expansion's input,
   * compounding the vocabulary on each round, (b) make adding one keyword write
   * Settings, which now fires the seed-change hook and could kick off a local
   * model run per keystroke-sized edit, and (c) silently repopulate a Settings
   * field the user never touched. The two views stay consistent instead through
   * the sweep in `syncSeeds`, which only ever removes rows it created itself.
   */
  create(input: CreateKeywordsInput): { keywords: SearchKeywordDto[]; created: number } {
    const rows: NewSearchKeywordRow[] = splitTerms(input.keywords).map((keyword) => ({
      keyword,
      normalized: normalizeKeyword(keyword),
      seed: null,
      origin: input.origin,
      kind: 'alternate_title',
      confidence: null,
      enabled: true,
      sources: input.sources,
    }));

    const created = this.repository.upsertMany(rows);
    if (created.length > 0) {
      this.logger.info('keywords created', { origin: input.origin, created: created.length });
    }
    return { keywords: this.list(), created: created.length };
  }

  update(id: number, patch: UpdateKeywordInput): SearchKeywordDto {
    const current = this.repository.byId(id);
    if (!current) throw new NotFoundError('Keyword', id);

    if (patch.keyword !== undefined) {
      // The unique index spans (normalized, COALESCE(seed,'')) and a rename keeps
      // the row's seed, so a clash is only possible within the same seed group.
      // Without this check SQLite raises a bare constraint error that no handler
      // maps, and the rename comes back as a 500 carrying SQL.
      const clash = this.repository.byNormalized(normalizeKeyword(patch.keyword), current.seed);
      if (clash && clash.id !== id) {
        throw new ConflictError(`The search term "${clash.keyword}" already exists.`);
      }
    }

    const row = this.repository.update(id, patch);
    if (!row) throw new NotFoundError('Keyword', id);
    return toSearchKeywordDto(row);
  }

  remove(id: number): void {
    if (!this.repository.byId(id)) throw new NotFoundError('Keyword', id);
    this.repository.delete(id);
  }

  /**
   * Imports `settings.search.keywords` as origin='user' rows, and removes the
   * seed rows Settings no longer lists — together with the expansions generated
   * from them. Runs on every Settings save (via the container's hook) and from
   * the Keywords screen's button.
   */
  syncSeeds(): SearchKeywordDto[] {
    return this.syncSeedsDetailed().keywords;
  }

  /** As `syncSeeds`, with the counts a caller may want to report back to the user. */
  syncSeedsDetailed(): SyncSeedsResult {
    const seeds = this.settingsService.get().search.keywords;
    const wanted = new Map<string, string>();
    for (const seed of seeds) {
      const key = normalizeKeyword(seed);
      if (key.length > 0) wanted.set(key, seed.trim());
    }

    const existing = this.repository.list().filter((row) => row.origin === 'user');
    let removedSeeds = 0;
    let removedExpansions = 0;
    for (const row of existing) {
      // Only rows this sync created are Settings' to remove. Terms typed on the
      // Keywords page carry a different `kind` and must survive a sync they were
      // never part of, or the button silently destroys the user's own work.
      if (row.kind !== SEED_KIND || wanted.has(row.normalized)) continue;
      this.repository.delete(row.id);
      removedSeeds += 1;
      // Expansions reference the seed by its raw stored text, not the
      // normalized key. Left behind they would be searched forever and would
      // render under a group header that no longer exists.
      removedExpansions += this.repository.deleteGenerated(row.keyword);
    }

    const present = new Set(existing.map((row) => row.normalized));
    const missing: NewSearchKeywordRow[] = Array.from(wanted.entries())
      .filter(([key]) => !present.has(key))
      .map(([key, keyword]) => ({
        keyword,
        normalized: key,
        seed: null,
        origin: 'user',
        kind: SEED_KIND,
        confidence: null,
        enabled: true,
        sources: [],
      }));
    const added = this.repository.upsertMany(missing).length;

    if (removedSeeds > 0 || removedExpansions > 0 || added > 0) {
      this.logger.info('keyword seeds synced', { added, removedSeeds, removedExpansions });
    }

    return { keywords: this.list(), removedSeeds, removedExpansions, added };
  }

  /**
   * Reconciles the table after Settings changed its seed list, and — when
   * `autoExpandOnSeedChange` is on — widens the new seeds with the local model.
   *
   * The expansion is deliberately fire-and-forget: it can take tens of seconds
   * on CPU inference, and a settings save must not wait on it or fail with it.
   */
  handleSeedsChanged(): SyncSeedsResult {
    const result = this.syncSeedsDetailed();
    const config = this.settingsService.get().search.keywordExpansion;
    if (config.enabled && config.autoExpandOnSeedChange) {
      void this.expand({ seeds: [], replaceGenerated: false }).catch((error: unknown) => {
        this.logger.warn('automatic keyword expansion after a seed change failed', {
          error: toErrorMessage(error),
        });
      });
    }
    return result;
  }

  /** Widens the seeds with the local model into origin='llm' rows. */
  async expand(input: ExpandKeywordsInput): Promise<ExpandKeywordsResult> {
    const settings = this.settingsService.get();
    const config = settings.search.keywordExpansion;

    const requested = input.seeds.map((seed) => seed.trim()).filter((seed) => seed.length > 0);
    const stored = this.repository
      .list()
      .filter((row) => row.origin === 'user')
      .map((row) => row.keyword);
    const seeds =
      requested.length > 0 ? requested : stored.length > 0 ? stored : settings.search.keywords;

    if (seeds.length === 0) {
      throw new ConfigurationError(
        'There are no keywords to expand yet. Add your own search terms first, then ask the model to widen them.',
      );
    }

    const removed = input.replaceGenerated ? this.repository.deleteGenerated() : 0;

    // Sent to the model so it does not spend its budget re-proposing what we hold.
    const existing = this.repository.list();
    const taken = new Set(existing.map((row) => row.normalized));
    const perSeed = input.perSeed ?? config.perSeed;

    let result: LlmTaskResult<KeywordExpansion>;
    try {
      result = await this.llm.run('keyword_expansion', {
        variables: {
          seeds: seeds.join('\n'),
          perSeed: String(perSeed),
          profile: describeProfile(settings.profile),
          existing: existing.map((row) => row.keyword).join(', '),
        },
      });
    } catch (error) {
      // A local model that is down or off-schema must read as a model problem,
      // not as a raw JSON parse failure surfacing in the keywords screen.
      throw new ConfigurationError(
        `The local model could not expand these keywords: ${toErrorMessage(error)}`,
      );
    }

    const rows: NewSearchKeywordRow[] = [];
    let skipped = 0;
    for (const candidate of result.data.keywords) {
      const keyword = candidate.keyword.trim();
      const normalized = normalizeKeyword(keyword);
      if (normalized.length === 0 || keyword.length > MAX_KEYWORD_LENGTH || taken.has(normalized)) {
        skipped += 1;
        continue;
      }
      taken.add(normalized);
      rows.push({
        keyword,
        normalized,
        seed: candidate.seed.trim() || null,
        origin: 'llm',
        kind: candidate.kind,
        confidence: candidate.confidence,
        // Low-confidence terms are kept rather than dropped: they are often the
        // interesting long tail, so the user gets to switch them on themselves.
        enabled: candidate.confidence >= config.minConfidence,
        sources: [],
      });
    }

    const created = this.repository.upsertMany(rows);
    skipped += rows.length - created.length;

    this.logger.info('keywords expanded', {
      seeds: seeds.length,
      created: created.length,
      skipped,
      removed,
      model: result.model,
    });

    return {
      created: created.length,
      skipped,
      removed,
      model: result.model,
      keywords: this.list(),
    };
  }

  /**
   * The terms a collector should actually search this run: enabled rows scoped to
   * it (or unscoped), capped at settings.search.keywordExpansion.maxActiveKeywords,
   * user seeds always first so they are never crowded out by expansions.
   *
   * The fallback to settings.search.keywords applies only when the table holds
   * no rows whatsoever — an install upgraded before the user ever opened the
   * Keywords screen. Once the table has content it is authoritative: an empty
   * result for one collector means every term was disabled or scoped away from
   * it, which is a decision the user made on that screen and must not be
   * quietly overridden by re-running the raw seed list.
   */
  activeFor(collectorId: string): string[] {
    const settings = this.settingsService.get();
    // Counted across every origin, so a row written by anything other than the
    // user/model paths still counts as "the table is populated".
    if (this.repository.total() === 0) return settings.search.keywords;

    // The repository already sorts user rows ahead of expansions, so the cap
    // trims the model's guesses rather than the candidate's own terms.
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const row of this.repository.enabled(collectorId)) {
      if (seen.has(row.normalized)) continue;
      seen.add(row.normalized);
      terms.push(row.keyword);
      if (terms.length >= settings.search.keywordExpansion.maxActiveKeywords) break;
    }
    return terms;
  }

  /** Records that these terms were just searched, and how many postings the run produced. */
  markSearched(collectorId: string, keywords: string[], jobsFound: number): void {
    if (keywords.length === 0) return;
    // Collectors deal in strings; the counters live on rows, so map back through
    // the de-duplication key. Terms that came from the settings fallback have no
    // row and simply do not count.
    const wanted = new Set(keywords.map(normalizeKeyword).filter((key) => key.length > 0));
    const ids = this.repository
      .enabled(collectorId)
      .filter((row) => wanted.has(row.normalized))
      .map((row) => row.id);
    if (ids.length === 0) return;
    this.repository.markUsed(ids, jobsFound);
  }
}

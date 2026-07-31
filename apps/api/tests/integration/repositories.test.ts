import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { ApplicationStep, JobQuery } from '@deedy/shared';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { jobSkills } from '../../src/db/schema.js';
import { canonicalUrl, jobHash, normalizeText } from '../../src/core/utils.js';
import { JobRepository, type NormalizedJob } from '../../src/repositories/job.repository.js';
import {
  CoverLetterRepository,
  ResumeRepository,
} from '../../src/repositories/resume.repository.js';
import {
  AnswerBankRepository,
  ApplicationRepository,
} from '../../src/repositories/application.repository.js';

/** One throwaway directory per run; every describe gets its own database file inside it. */
let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'deedy-repo-test-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function openDb(name: string): DbHandle {
  const handle = createDb(path.join(root, `${name}.sqlite`));
  runMigrations(handle.sqlite);
  return handle;
}

function job(input: Partial<NormalizedJob> & Pick<NormalizedJob, 'title' | 'applicationUrl'>): NormalizedJob {
  return {
    source: 'greenhouse',
    company: 'Globex',
    location: 'Remote - US',
    description: 'We are hiring.',
    ...input,
  };
}

const baseQuery: JobQuery = { page: 1, pageSize: 25, sort: 'collectedAt', order: 'desc' };

describe('JobRepository.upsert deduplication', () => {
  let handle: DbHandle;
  let repo: JobRepository;

  beforeAll(() => {
    handle = openDb('jobs-upsert');
    repo = new JobRepository(handle.db);
  });

  afterAll(() => handle.close());

  it('inserts a new posting once and reports the same row as a duplicate', () => {
    const input = job({ title: 'Staff Backend Engineer', applicationUrl: 'https://boards.example.com/jobs/100' });

    const first = repo.upsert(input);
    expect(first.outcome).toBe('inserted');

    const second = repo.upsert(input);
    expect(second).toEqual({ outcome: 'duplicate', jobId: first.jobId });

    expect(repo.countAll()).toBe(1);
    expect(repo.byHash(jobHash({ source: 'greenhouse', company: 'Globex', title: 'Staff Backend Engineer', location: 'Remote - US' }))?.id).toBe(first.jobId);
  });

  it('treats the same canonical URL with different tracking params as a duplicate', () => {
    const first = repo.upsert(
      job({
        title: 'Data Platform Engineer',
        applicationUrl: 'https://boards.example.com/jobs/200?utm_source=newsletter&utm_campaign=july',
      }),
    );
    expect(first.outcome).toBe('inserted');

    // Different company and title, so only the URL can link these two rows.
    const second = repo.upsert(
      job({
        title: 'Completely Different Title',
        company: 'Initech',
        applicationUrl: 'https://www.boards.example.com/jobs/200/?trk=feed&refId=abc#apply',
      }),
    );
    expect(second).toEqual({ outcome: 'duplicate', jobId: first.jobId });

    expect(repo.byId(first.jobId)?.applicationUrl).toBe('https://boards.example.com/jobs/200');
    expect(canonicalUrl('https://www.boards.example.com/jobs/200/?trk=feed#apply')).toBe(
      'https://boards.example.com/jobs/200',
    );
  });

  it('treats a differently-cased company and title as a duplicate', () => {
    const first = repo.upsert(
      job({ title: 'Senior Platform Engineer', company: 'Globex', applicationUrl: 'https://boards.example.com/jobs/300' }),
    );
    expect(first.outcome).toBe('inserted');

    const second = repo.upsert(
      job({
        title: 'SENIOR PLATFORM ENGINEER',
        company: 'GLOBEX',
        applicationUrl: 'https://boards.example.com/jobs/301',
      }),
    );
    expect(second).toEqual({ outcome: 'duplicate', jobId: first.jobId });
  });
});

describe('JobRepository.replaceSkills', () => {
  let handle: DbHandle;
  let repo: JobRepository;
  let jobId: number;

  beforeAll(() => {
    handle = openDb('jobs-skills');
    repo = new JobRepository(handle.db);
    jobId = repo.upsert(job({ title: 'Skills Engineer', applicationUrl: 'https://boards.example.com/jobs/400' })).jobId;
  });

  afterAll(() => handle.close());

  it('is idempotent and mirrors the skills onto the jobs.skills JSON column', () => {
    const skills = ['TypeScript', 'typescript ', 'React'];

    repo.replaceSkills(jobId, skills);
    const afterFirst = handle.db.select().from(jobSkills).where(eq(jobSkills.jobId, jobId)).all();
    expect(afterFirst.map((r) => r.normalized).sort()).toEqual(['react', 'typescript']);
    expect(afterFirst.every((r) => r.kind === 'hard')).toBe(true);

    repo.replaceSkills(jobId, skills);
    const afterSecond = handle.db.select().from(jobSkills).where(eq(jobSkills.jobId, jobId)).all();
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond.map((r) => r.normalized).sort()).toEqual(['react', 'typescript']);

    expect(repo.byId(jobId)?.skills).toEqual(['TypeScript', 'typescript', 'React']);
  });

  it('replaces the previous set rather than appending to it', () => {
    repo.replaceSkills(jobId, ['Go', 'Kubernetes'], 'soft');

    const rows = handle.db.select().from(jobSkills).where(eq(jobSkills.jobId, jobId)).all();
    expect(rows.map((r) => r.normalized).sort()).toEqual(['go', 'kubernetes']);
    expect(rows.every((r) => r.kind === 'soft')).toBe(true);
    expect(repo.byId(jobId)?.skills).toEqual(['Go', 'Kubernetes']);
  });
});

describe('JobRepository.recordScore', () => {
  let handle: DbHandle;
  let repo: JobRepository;

  beforeAll(() => {
    handle = openDb('jobs-scores');
    repo = new JobRepository(handle.db);
  });

  afterAll(() => handle.close());

  it('stores the score row and promotes the job to scored', () => {
    const jobId = repo.upsert(job({ title: 'Scored Engineer', applicationUrl: 'https://boards.example.com/jobs/500' })).jobId;

    const scoreId = repo.recordScore({
      jobId,
      resumeId: null,
      score: 87.5,
      confidence: 0.8,
      recommendation: 'apply',
      matchedSkills: ['typescript'],
      missingSkills: ['rust'],
      redFlags: [],
      reasoning: 'Strong overlap with the platform work.',
      interviewProbability: 0.42,
      model: 'llama3.1:8b',
    });

    const stored = repo.scoresForJob(jobId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(scoreId);
    expect(stored[0]?.matchedSkills).toEqual(['typescript']);
    expect(stored[0]?.redFlags).toEqual([]);
    expect(stored[0]?.interviewProbability).toBe(0.42);

    const row = repo.byId(jobId);
    expect(row?.status).toBe('scored');
    expect(row?.score).toBe(87.5);
    expect(row?.recommendation).toBe('apply');
  });

  it('marks the job skipped when the recommendation is skip', () => {
    const jobId = repo.upsert(job({ title: 'Skipped Engineer', applicationUrl: 'https://boards.example.com/jobs/501' })).jobId;

    repo.recordScore({
      jobId,
      resumeId: null,
      score: 21,
      confidence: 0.9,
      recommendation: 'skip',
      matchedSkills: [],
      missingSkills: ['php'],
      redFlags: ['unpaid overtime'],
      reasoning: 'Wrong stack.',
      interviewProbability: null,
      model: 'llama3.1:8b',
    });

    const row = repo.byId(jobId);
    expect(row?.status).toBe('skipped');
    expect(row?.score).toBe(21);
    expect(row?.recommendation).toBe('skip');
    expect(repo.readyToApply(0, 10).map((r) => r.id)).not.toContain(jobId);
  });

  it('keeps every score version for a job, newest first', () => {
    const jobId = repo.upsert(job({ title: 'Rescored Engineer', applicationUrl: 'https://boards.example.com/jobs/502' })).jobId;

    for (const score of [40, 60]) {
      repo.recordScore({
        jobId,
        resumeId: null,
        score,
        confidence: 0.5,
        recommendation: 'manual_review',
        matchedSkills: [],
        missingSkills: [],
        redFlags: [],
        reasoning: `scored ${score}`,
        interviewProbability: null,
        model: 'test',
      });
    }

    expect(repo.scoresForJob(jobId)).toHaveLength(2);
    expect(repo.byId(jobId)?.score).toBe(60);
    expect(repo.byId(jobId)?.status).toBe('scored');
  });
});

describe('JobRepository.search', () => {
  let handle: DbHandle;
  let repo: JobRepository;
  const ids = new Map<string, number>();

  beforeAll(() => {
    handle = openDb('jobs-search');
    repo = new JobRepository(handle.db);

    const fixtures: Array<{ title: string; source: string; score?: number; recommendation?: string }> = [
      { title: 'Alpha Engineer', source: 'greenhouse', score: 90, recommendation: 'apply' },
      { title: 'Bravo Engineer', source: 'greenhouse', score: 70, recommendation: 'apply' },
      { title: 'Charlie Engineer', source: 'greenhouse', score: 40, recommendation: 'skip' },
      { title: 'Delta Engineer', source: 'greenhouse' },
      { title: 'Echo Engineer', source: 'lever', score: 85, recommendation: 'apply' },
      { title: 'Foxtrot Engineer', source: 'lever' },
    ];

    fixtures.forEach((fixture, index) => {
      const { jobId } = repo.upsert(
        job({
          title: fixture.title,
          source: fixture.source,
          applicationUrl: `https://boards.example.com/search/${index}`,
        }),
      );
      ids.set(fixture.title, jobId);
      if (fixture.score !== undefined && fixture.recommendation) {
        repo.recordScore({
          jobId,
          resumeId: null,
          score: fixture.score,
          confidence: 0.7,
          recommendation: fixture.recommendation,
          matchedSkills: [],
          missingSkills: [],
          redFlags: [],
          reasoning: 'fixture',
          interviewProbability: null,
          model: 'test',
        });
      }
    });
  });

  afterAll(() => handle.close());

  it('filters by status', () => {
    const scored = repo.search({ ...baseQuery, status: 'scored' });
    expect(scored.total).toBe(3);
    expect(scored.items.map((i) => i.title).sort()).toEqual([
      'Alpha Engineer',
      'Bravo Engineer',
      'Echo Engineer',
    ]);

    expect(repo.search({ ...baseQuery, status: 'skipped' }).total).toBe(1);
    expect(repo.search({ ...baseQuery, status: 'new' }).total).toBe(2);
  });

  it('filters by source', () => {
    const lever = repo.search({ ...baseQuery, source: 'lever' });
    expect(lever.total).toBe(2);
    expect(lever.items.every((i) => i.source === 'lever')).toBe(true);
    expect(repo.search({ ...baseQuery, source: 'greenhouse' }).total).toBe(4);
    expect(repo.distinctSources().sort()).toEqual(['greenhouse', 'lever']);
  });

  it('filters by minScore, excluding unscored jobs', () => {
    const strong = repo.search({ ...baseQuery, minScore: 80 });
    expect(strong.items.map((i) => i.title).sort()).toEqual(['Alpha Engineer', 'Echo Engineer']);
    expect(repo.search({ ...baseQuery, minScore: 0 }).total).toBe(4);
  });

  it('combines filters', () => {
    const result = repo.search({ ...baseQuery, status: 'scored', source: 'greenhouse', minScore: 60 });
    expect(result.items.map((i) => i.title).sort()).toEqual(['Alpha Engineer', 'Bravo Engineer']);
  });

  it('paginates deterministically', () => {
    const query: JobQuery = { ...baseQuery, sort: 'title', order: 'asc', pageSize: 2 };

    const page1 = repo.search(query);
    expect(page1.total).toBe(6);
    expect(page1.totalPages).toBe(3);
    expect(page1.page).toBe(1);
    expect(page1.pageSize).toBe(2);
    expect(page1.items.map((i) => i.title)).toEqual(['Alpha Engineer', 'Bravo Engineer']);

    expect(repo.search({ ...query, page: 2 }).items.map((i) => i.title)).toEqual([
      'Charlie Engineer',
      'Delta Engineer',
    ]);
    expect(repo.search({ ...query, page: 3 }).items.map((i) => i.title)).toEqual([
      'Echo Engineer',
      'Foxtrot Engineer',
    ]);
    expect(repo.search({ ...query, page: 4 }).items).toEqual([]);
  });

  it('excludes archived jobs unless asked for them', () => {
    const archivedId = ids.get('Foxtrot Engineer');
    expect(archivedId).toBeDefined();
    repo.setArchived(archivedId as number, true);

    expect(repo.search(baseQuery).total).toBe(5);
    const archived = repo.search({ ...baseQuery, archived: true });
    expect(archived.total).toBe(1);
    expect(archived.items[0]?.id).toBe(archivedId);

    repo.setArchived(archivedId as number, false);
  });
});

describe('JobRepository.search ordering by collection time', () => {
  let handle: DbHandle;
  let repo: JobRepository;

  beforeAll(() => {
    handle = openDb('jobs-ordering');
    repo = new JobRepository(handle.db);

    // collectedAt comes from Date.now(); freeze it so the ordering is not a tie.
    vi.useFakeTimers();
    try {
      const titles = ['First Engineer', 'Second Engineer', 'Third Engineer'];
      titles.forEach((title, index) => {
        vi.setSystemTime(new Date(Date.UTC(2026, 0, 1 + index, 12, 0, 0)));
        repo.upsert(job({ title, applicationUrl: `https://boards.example.com/order/${index}` }));
      });
    } finally {
      vi.useRealTimers();
    }
  });

  afterAll(() => handle.close());

  it('returns the most recently collected job first', () => {
    const result = repo.search(baseQuery);
    expect(result.items.map((i) => i.title)).toEqual([
      'Third Engineer',
      'Second Engineer',
      'First Engineer',
    ]);
    expect(result.items[0]?.collectedAt).toBe('2026-01-03T12:00:00.000Z');

    const oldestFirst = repo.search({ ...baseQuery, order: 'asc' });
    expect(oldestFirst.items[0]?.title).toBe('First Engineer');
  });
});

describe('ResumeRepository', () => {
  let handle: DbHandle;
  let repo: ResumeRepository;
  let jobA: number;
  let jobB: number;

  beforeAll(() => {
    handle = openDb('resumes');
    const jobRepo = new JobRepository(handle.db);
    repo = new ResumeRepository(handle.db);
    jobA = jobRepo.upsert(job({ title: 'Resume Target A', applicationUrl: 'https://boards.example.com/resume/a' })).jobId;
    jobB = jobRepo.upsert(job({ title: 'Resume Target B', applicationUrl: 'https://boards.example.com/resume/b' })).jobId;
  });

  afterAll(() => handle.close());

  it('versions base resumes by name', () => {
    const v1 = repo.create({ name: 'Backend', markdown: '# v1', isBase: true });
    const v2 = repo.create({ name: 'Backend', markdown: '# v2', isBase: true });
    const other = repo.create({ name: 'Frontend', markdown: '# fe', isBase: true });

    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(other.version).toBe(1);
    expect(repo.nextVersion('Backend')).toBe(3);
    expect(repo.nextVersion('Unknown Name')).toBe(1);
    expect(repo.countBase()).toBe(3);
  });

  it('keeps isDefault exclusive across all resumes', () => {
    const first = repo.create({ name: 'Default A', markdown: '# a', isBase: true, isDefault: true });
    expect(repo.byId(first.id)?.isDefault).toBe(true);
    expect(repo.defaultResume()?.id).toBe(first.id);

    const second = repo.create({ name: 'Default B', markdown: '# b', isBase: true, isDefault: true });
    expect(repo.byId(first.id)?.isDefault).toBe(false);
    expect(repo.byId(second.id)?.isDefault).toBe(true);
    expect(repo.defaultResume()?.id).toBe(second.id);

    const third = repo.create({ name: 'Default C', markdown: '# c', isBase: true });
    repo.update(third.id, { isDefault: true });
    expect(repo.byId(second.id)?.isDefault).toBe(false);
    expect(repo.defaultResume()?.id).toBe(third.id);

    expect(repo.list().filter((r) => r.isDefault)).toHaveLength(1);
  });

  it('finds the tailored resume for a specific job and parent', () => {
    const parent = repo.create({ name: 'Tailor Parent', markdown: '# base', isBase: true });
    const tailoredA = repo.create({
      name: 'Tailor Parent - Job A',
      markdown: '# tailored a',
      isBase: false,
      parentId: parent.id,
      jobId: jobA,
      generatedBy: 'llama3.1:8b',
      changeSummary: ['Reordered bullets'],
      atsScore: 78,
    });
    const tailoredB = repo.create({
      name: 'Tailor Parent - Job B',
      markdown: '# tailored b',
      isBase: false,
      parentId: parent.id,
      jobId: jobB,
    });

    const foundA = repo.tailoredFor(jobA, parent.id);
    expect(foundA?.id).toBe(tailoredA.id);
    expect(foundA?.changeSummary).toEqual(['Reordered bullets']);
    expect(foundA?.atsScore).toBe(78);

    expect(repo.tailoredFor(jobB, parent.id)?.id).toBe(tailoredB.id);
    expect(repo.tailoredFor(jobA, tailoredB.id)).toBeUndefined();
    // Tailored resumes must not be counted as base resumes.
    expect(repo.list(false).some((r) => r.id === tailoredA.id)).toBe(false);
  });
});

describe('CoverLetterRepository', () => {
  let handle: DbHandle;
  let repo: CoverLetterRepository;
  let jobA: number;
  let jobB: number;

  beforeAll(() => {
    handle = openDb('cover-letters');
    const jobRepo = new JobRepository(handle.db);
    repo = new CoverLetterRepository(handle.db);
    jobA = jobRepo.upsert(job({ title: 'Letter Target A', applicationUrl: 'https://boards.example.com/letter/a' })).jobId;
    jobB = jobRepo.upsert(job({ title: 'Letter Target B', applicationUrl: 'https://boards.example.com/letter/b' })).jobId;
  });

  afterAll(() => handle.close());

  it('increments the version per job', () => {
    const a1 = repo.create({ jobId: jobA, subject: 'Application', body: 'first draft' });
    const a2 = repo.create({ jobId: jobA, subject: 'Application', body: 'second draft', tone: 'direct' });
    const b1 = repo.create({ jobId: jobB, subject: 'Application', body: 'other job' });

    expect(a1.version).toBe(1);
    expect(a2.version).toBe(2);
    expect(b1.version).toBe(1);

    expect(repo.latestForJob(jobA)?.id).toBe(a2.id);
    expect(repo.forJob(jobA).map((r) => r.version)).toEqual([2, 1]);
    expect(repo.byId(a2.id)?.tone).toBe('direct');
  });

  it('versions job-less letters on their own sequence', () => {
    const g1 = repo.create({ jobId: null, subject: 'Generic', body: 'generic one' });
    const g2 = repo.create({ jobId: null, subject: 'Generic', body: 'generic two' });

    expect(g1.version).toBe(1);
    expect(g2.version).toBe(2);
    expect(repo.latestForJob(jobA)?.version).toBe(2);
  });
});

describe('ApplicationRepository', () => {
  let handle: DbHandle;
  let repo: ApplicationRepository;
  let jobRepo: JobRepository;

  beforeAll(() => {
    handle = openDb('applications');
    jobRepo = new JobRepository(handle.db);
    repo = new ApplicationRepository(handle.db);
  });

  afterAll(() => handle.close());

  function newJob(slug: string): number {
    return jobRepo.upsert(
      job({ title: `Application ${slug}`, applicationUrl: `https://boards.example.com/apply/${slug}` }),
    ).jobId;
  }

  it('ensures exactly one application row per job', () => {
    const jobId = newJob('ensure');
    const first = repo.ensure({ jobId, provider: 'greenhouse', resumeId: null, maxAttempts: 3, dryRun: true });

    expect(first.status).toBe('pending');
    expect(first.attempts).toBe(0);

    const second = repo.ensure({ jobId, provider: 'lever', resumeId: null, maxAttempts: 9, dryRun: false });
    expect(second.id).toBe(first.id);
    // The existing row wins; ensure never rewrites the in-flight configuration.
    expect(second.provider).toBe('greenhouse');
    expect(second.maxAttempts).toBe(3);
    expect(repo.byJobId(jobId)?.id).toBe(first.id);
    expect(repo.search({ page: 1, pageSize: 25, jobId }).total).toBe(1);
  });

  it('returns only the succeeded steps from completedSteps', () => {
    const jobId = newJob('steps');
    const app = repo.ensure({ jobId, provider: 'greenhouse', resumeId: null, maxAttempts: 3, dryRun: true });

    const events: Array<{ step: ApplicationStep; status: 'succeeded' | 'failed' | 'running' | 'skipped' }> = [
      { step: 'navigate', status: 'succeeded' },
      { step: 'start_application', status: 'succeeded' },
      { step: 'upload_resume', status: 'failed' },
      { step: 'fill_form', status: 'running' },
      { step: 'review', status: 'skipped' },
    ];
    for (const event of events) {
      repo.recordEvent({ applicationId: app.id, step: event.step, status: event.status, attempt: 1 });
    }

    const completed = repo.completedSteps(app.id);
    expect(Array.from(completed).sort()).toEqual(['navigate', 'start_application']);
    expect(completed.has('upload_resume')).toBe(false);
    expect(repo.events(app.id)).toHaveLength(events.length);

    // Steps of a different application never leak in.
    const otherApp = repo.ensure({
      jobId: newJob('steps-other'),
      provider: 'greenhouse',
      resumeId: null,
      maxAttempts: 3,
      dryRun: true,
    });
    repo.recordEvent({ applicationId: otherApp.id, step: 'submit', status: 'succeeded', attempt: 1 });
    expect(repo.completedSteps(app.id).has('submit')).toBe(false);
    expect(repo.incrementAttempt(app.id)).toBe(1);
    expect(repo.incrementAttempt(app.id)).toBe(2);
  });

  it('counts submitted applications on or after the cutoff only', () => {
    const submittedAt = ['2026-07-29T09:00:00.000Z', '2026-07-30T09:00:00.000Z', '2026-07-31T09:00:00.000Z'];
    submittedAt.forEach((iso, index) => {
      const app = repo.ensure({
        jobId: newJob(`submitted-${index}`),
        provider: 'greenhouse',
        resumeId: null,
        maxAttempts: 3,
        dryRun: false,
      });
      repo.update(app.id, { status: 'submitted', submittedAt: iso });
    });

    // Pending and failed rows must never be counted, whatever their timestamp.
    const failed = repo.ensure({
      jobId: newJob('failed'),
      provider: 'greenhouse',
      resumeId: null,
      maxAttempts: 3,
      dryRun: false,
    });
    repo.update(failed.id, { status: 'failed', submittedAt: '2026-07-31T10:00:00.000Z' });

    expect(repo.countSubmittedSince('2026-07-01T00:00:00.000Z')).toBe(3);
    expect(repo.countSubmittedSince('2026-07-30T00:00:00.000Z')).toBe(2);
    expect(repo.countSubmittedSince('2026-07-31T09:00:00.000Z')).toBe(1);
    expect(repo.countSubmittedSince('2026-08-01T00:00:00.000Z')).toBe(0);
    expect(repo.countSubmittedForCompanySince('Globex', '2026-07-30T00:00:00.000Z')).toBe(2);
    expect(repo.countSubmittedForCompanySince('Initech', '2026-07-01T00:00:00.000Z')).toBe(0);
  });
});

describe('AnswerBankRepository', () => {
  let handle: DbHandle;
  let repo: AnswerBankRepository;

  beforeAll(() => {
    handle = openDb('answer-bank');
    repo = new AnswerBankRepository(handle.db);
  });

  afterAll(() => handle.close());

  it('upserts by normalized question, finds it back and tracks usage', () => {
    repo.upsert({
      question: 'Are you legally authorized to work in the United States?',
      answer: 'Yes',
      fieldType: 'radio',
    });

    const found = repo.find('Are you LEGALLY authorized to work in the United States?');
    expect(found).toBeDefined();
    expect(found?.answer).toBe('Yes');
    expect(found?.fieldType).toBe('radio');
    expect(found?.useCount).toBe(0);
    expect(found?.normalized).toBe(
      normalizeText('Are you legally authorized to work in the United States?'),
    );

    repo.markUsed(found?.normalized ?? '');
    repo.markUsed(found?.normalized ?? '');
    expect(repo.find('Are you legally authorized to work in the United States?')?.useCount).toBe(2);

    // A second upsert updates the answer in place and preserves the usage count.
    repo.upsert({
      question: 'are you legally authorized to work in the united states',
      answer: 'Yes, without sponsorship',
      fieldType: 'select',
    });
    const updated = repo.find('Are you legally authorized to work in the United States?');
    expect(updated?.id).toBe(found?.id);
    expect(updated?.answer).toBe('Yes, without sponsorship');
    expect(updated?.fieldType).toBe('select');
    expect(updated?.useCount).toBe(2);
    expect(repo.list()).toHaveLength(1);
  });

  it('returns undefined for unknown questions and orders the list by usage', () => {
    expect(repo.find('What is your favourite colour?')).toBeUndefined();

    repo.upsert({ question: 'Do you require sponsorship?', answer: 'No', fieldType: 'radio' });
    const listed = repo.list();
    expect(listed).toHaveLength(2);
    expect(listed[0]?.useCount).toBe(2);

    const sponsorship = repo.find('Do you require sponsorship?');
    expect(sponsorship).toBeDefined();
    repo.delete(sponsorship?.id ?? -1);
    expect(repo.list()).toHaveLength(1);
  });
});

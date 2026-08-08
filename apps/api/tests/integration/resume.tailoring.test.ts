import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LlmTask } from '@deedy/shared';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { JobRepository } from '../../src/repositories/job.repository.js';
import { ResumeRepository } from '../../src/repositories/resume.repository.js';
import { ResumeService } from '../../src/services/resume.service.js';
import type { DocumentService } from '../../src/services/document.service.js';
import type { LatexService } from '../../src/services/latex/latex.service.js';
import type { LlmService, RunTaskOptions } from '../../src/services/llm/llm.service.js';
import { latexToPlainText } from '../../src/services/latex/latex.utils.js';
import type { Logger } from '../../src/core/logger.js';

const BASE_LATEX = String.raw`\documentclass{deedy-resume-openfont}
\begin{document}
\namesection{REDACTED}{NAME}{Backend Engineer}

\section{Summary}
Backend engineer with six years on payment systems.

\section{Skills}
\skillrow{Languages}{TypeScript \sep SQL}

\section{Experience}
\entryline{\runsubsection{Northwind Trading}}{\location{Mar 2021 -- Present}}
\entryline{\descript{Senior Backend Engineer}}{\location{Remote}}
\begin{tightemize}
  \item Cut settlement latency from 900ms to 120ms across the ledger service.
\end{tightemize}

\entrysep
\entryline{\runsubsection{Contoso Logistics}}{\location{Jan 2019 -- Feb 2021}}
\entryline{\descript{Backend Engineer}}{\location{On-site, Cork}}
\begin{tightemize}
  \item Migrated 40\% of the fleet API off a shared monolith.
\end{tightemize}

\section{Projects}
\entryline{\runsubsection{Tideline}}{\location{2022}}
\descript{TypeScript, SQLite}
\begin{tightemize}
  \item Reconciles two ledgers without a server round trip.
\end{tightemize}
\end{document}
`;

/** The only legitimate tailoring: the summary is rewritten, the skills reordered. */
const GOOD_TAILORED = BASE_LATEX.replace(
  'Backend engineer with six years on payment systems.',
  'Backend engineer with six years on payment systems, focused on ledger throughput.',
).replace('\\skillrow{Languages}{TypeScript \\sep SQL}', '\\skillrow{Languages}{SQL \\sep TypeScript}');

const DROPPED_EXPERIENCE = BASE_LATEX.replace(
  /\\entrysep\n\\entryline\{\\runsubsection\{Contoso Logistics\}\}[\s\S]*?\\end\{tightemize\}\n/,
  '',
);

const ALTERED_PROJECT = BASE_LATEX.replace(
  '\\item Reconciles two ledgers without a server round trip.',
  '\\item Reconciles two ledgers across a Kubernetes cluster without a round trip.',
);

const MODEL = 'test-model';

interface Recorded {
  task: LlmTask;
  variables: Record<string, string>;
}

let root: string;
let handle: DbHandle;
let resumes: ResumeRepository;
let service: ResumeService;
let calls: Recorded[];
let tailoredLatex: string;
let baseId: number;
let jobId: number;

const noop = (): void => undefined;
const logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  trace: noop,
  fatal: noop,
  child: () => logger,
} as unknown as Logger;

/** Answers both prompt tasks from the fixtures above; records what it was asked. */
const llm = {
  run: async (task: LlmTask, options: RunTaskOptions) => {
    calls.push({ task, variables: options.variables });
    if (task === 'ats_keywords') {
      return {
        data: {
          keywords: ['ledger', 'payments'],
          missingFromResume: ['Kubernetes', 'Kafka'],
          suggestions: [],
          estimatedAtsScore: 71,
        },
        model: MODEL,
      };
    }
    return {
      data: {
        latex: tailoredLatex,
        changeSummary: ['Rewrote the summary around ledger throughput.'],
        injectedKeywords: ['ledger'],
      },
      model: MODEL,
    };
  },
} as unknown as LlmService;

const latex = {
  macros: () => '(macro reference)',
  compile: async () => ({
    ok: true,
    pdfPath: null,
    log: '',
    pages: 1,
    engine: 'stub',
    durationMs: 1,
  }),
} as unknown as LatexService;

const documents = {
  renderPlainTextDocx: async () => null,
} as unknown as DocumentService;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'deedy-tailoring-test-'));
  handle = createDb(path.join(root, 'deedy.sqlite'));
  runMigrations(handle.sqlite);

  resumes = new ResumeRepository(handle.db);
  const jobs = new JobRepository(handle.db);
  service = new ResumeService(resumes, jobs, documents, latex, llm, logger);

  baseId = resumes.create({
    name: 'Base',
    latex: BASE_LATEX,
    markdown: latexToPlainText(BASE_LATEX),
    isBase: true,
    isDefault: true,
    generatedBy: 'user',
  }).id;

  const upserted = jobs.upsert({
    source: 'greenhouse',
    company: 'Globex',
    title: 'Senior Backend Engineer',
    location: 'Remote',
    description: 'Ledger and payments work. Kubernetes and Kafka are a plus.',
    applicationUrl: 'https://example.com/jobs/1',
  });
  jobId = upserted.jobId!;
});

afterAll(() => {
  handle.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
});

/** Each case re-tailors from scratch; `force` skips the cached-version shortcut. */
async function tailor(latexFromModel: string) {
  tailoredLatex = latexFromModel;
  return service.tailorForJob({ jobId, baseResumeId: baseId, force: true });
}

describe('ResumeService.tailorForJob preservation', () => {
  it('accepts a summary-and-skills-only edit', async () => {
    const row = await tailor(GOOD_TAILORED);

    expect(row.latex).toBe(GOOD_TAILORED);
    expect(row.generatedBy).toBe(MODEL);
    expect(row.changeSummary).toEqual(['Rewrote the summary around ledger throughput.']);
  });

  it('rejects a tailored document that drops an experience entry', async () => {
    const row = await tailor(DROPPED_EXPERIENCE);

    expect(row.latex).toBe(BASE_LATEX);
    expect(row.markdown).toBe(latexToPlainText(BASE_LATEX));
  });

  it('rejects a tailored document that alters a project bullet', async () => {
    const row = await tailor(ALTERED_PROJECT);
    expect(row.latex).toBe(BASE_LATEX);
  });

  it('records the fallback rather than the discarded draft', async () => {
    const row = await tailor(DROPPED_EXPERIENCE);

    // The row previously claimed the model's name and the model's change list
    // while holding the base document, which made a rejection invisible.
    expect(row.generatedBy).not.toBe(MODEL);
    expect(row.changeSummary.join(' ')).toMatch(/discarded/i);
    // The ATS score describes the base document, so it still stands.
    expect(row.atsScore).toBe(71);
  });

  it('keeps the ATS score when the draft is accepted', async () => {
    const row = await tailor(GOOD_TAILORED);
    expect(row.atsScore).toBe(71);
  });
});

describe('ResumeService.tailorForJob prompt inputs', () => {
  it('never offers the terms the candidate lacks as material to use', async () => {
    await tailor(GOOD_TAILORED);
    const tailoring = calls.find((c) => c.task === 'resume_tailoring');

    // `missingFromResume` is by definition what this candidate cannot claim.
    // Merging it into `keywords` was an instruction to fabricate.
    expect(tailoring?.variables.keywords).toBe('ledger, payments');
    expect(tailoring?.variables.keywords).not.toMatch(/kubernetes|kafka/i);
    expect(tailoring?.variables.missingKeywords).toBe('Kubernetes, Kafka');
  });

  it('scores the prose mirror, not the LaTeX macros', async () => {
    await tailor(GOOD_TAILORED);
    const ats = calls.find((c) => c.task === 'ats_keywords');

    expect(ats?.variables.resume).not.toMatch(/\\runsubsection|\\documentclass/);
    expect(ats?.variables.resume).toMatch(/Northwind Trading/);
  });
});

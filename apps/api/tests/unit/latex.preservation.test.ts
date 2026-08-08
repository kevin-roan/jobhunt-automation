import { describe, expect, it } from 'vitest';
import {
  extractProtectedEntries,
  findPreservationBreach,
} from '../../src/services/latex/latex.utils.js';

/**
 * The base document these tests compare against. It is the shape the class
 * actually produces — `\entryline{\runsubsection{...}}{\location{...}}` for the
 * heading of an entry, `\descript` for the role or stack, `tightemize` for the
 * claims — so a guard that passes here is reading real resumes, not a fixture.
 */
const BASE = String.raw`\documentclass{deedy-resume-openfont}
\begin{document}
\cvmeta{REDACTED NAME}{Backend Engineer}
\namesection{REDACTED}{NAME}{Backend Engineer}

\section{Summary}
Backend engineer with six years on payment systems.

\section{Skills}
\skillrow{Languages}{\custombold{TypeScript} \sep Python \sep SQL}
\skillrow{Backend}{Node.js \sep PostgreSQL}

\section{Experience}
\entryline{\runsubsection{Northwind Trading}}{\location{Mar 2021 -- Present}}
\entryline{\descript{Senior Backend Engineer}}{\location{Remote}}
\begin{tightemize}
  \item Cut settlement latency from 900ms to 120ms across the ledger service.
  \item Owned the payout pipeline end to end, from the API down to the deploy.
\end{tightemize}

\entrysep
\entryline{\runsubsection{Contoso Logistics}}{\location{Jan 2019 -- Feb 2021}}
\entryline{\descript{Backend Engineer}}{\location{On-site, Cork}}
\begin{tightemize}
  \item Migrated 40\% of the fleet API off a shared monolith.
\end{tightemize}

\section{Projects}
\entryline{\runsubsection{Tideline} \location{-- an offline-first ledger}}{\location{\href{https://example.com}{Demo}}}
\descript{TypeScript, SQLite, Rust}
\begin{tightemize}
  \item Reconciles two ledgers without a server round trip.
\end{tightemize}

\section{Education}
\entryline{\runsubsection{University of REDACTED}}{\location{2013 -- 2017}}
\end{document}
`;

/** Replaces the first occurrence, failing loudly rather than silently no-op'ing. */
function swap(source: string, find: string, replacement: string): string {
  if (!source.includes(find)) throw new Error(`fixture drift: ${find} is not in the base document`);
  return source.replace(find, replacement);
}

describe('extractProtectedEntries', () => {
  it('collects the experience and project evidence, and nothing else', () => {
    const entries = extractProtectedEntries(BASE);
    const text = entries.map((e) => e.text);

    expect(text).toContain('northwind trading');
    expect(text).toContain('senior backend engineer');
    expect(text).toContain('mar 2021 - present');
    expect(text).toContain('tideline');
    expect(text).toContain('reconciles two ledgers without a server round trip');

    // The summary and the skills are the editable surface; they must not be
    // captured, or every legitimate tailoring would be rejected.
    expect(text.some((t) => t.includes('six years on payment systems'))).toBe(false);
    // `\skillrow` content is the editable surface; only the project's own
    // `\descript` stack line mentions a language, and that one is evidence.
    expect(text.some((t) => t.includes('python'))).toBe(false);
    // Education is transcribed too, but it is not a section this guard polices.
    expect(text.some((t) => t.includes('university of'))).toBe(false);
  });

  it('buckets entries by protected block rather than by heading wording', () => {
    const sections = new Set(extractProtectedEntries(BASE).map((e) => e.section));
    expect(sections).toEqual(new Set(['experience', 'projects']));
  });
});

describe('findPreservationBreach — rejections', () => {
  it('rejects a tailored document that drops an experience entry', () => {
    const tailored = swap(
      BASE,
      String.raw`\entrysep
\entryline{\runsubsection{Contoso Logistics}}{\location{Jan 2019 -- Feb 2021}}
\entryline{\descript{Backend Engineer}}{\location{On-site, Cork}}
\begin{tightemize}
  \item Migrated 40\% of the fleet API off a shared monolith.
\end{tightemize}`,
      '',
    );

    const breach = findPreservationBreach(BASE, tailored);
    expect(breach).not.toBeNull();
    expect(breach?.missing.map((e) => e.text)).toContain('contoso logistics');
    expect(breach?.reason).toMatch(/dropped or altered/);
  });

  it('rejects a tailored document that drops a single experience bullet', () => {
    const tailored = swap(
      BASE,
      '  \\item Owned the payout pipeline end to end, from the API down to the deploy.\n',
      '',
    );
    expect(findPreservationBreach(BASE, tailored)?.missing).toHaveLength(1);
  });

  it('rejects a reworded experience bullet even when the meaning survives', () => {
    // This is the failure the old prompt actively invited: "reword bullets to
    // lead with the most relevant work" turns a claim into the model's claim.
    const tailored = swap(
      BASE,
      'Cut settlement latency from 900ms to 120ms across the ledger service.',
      'Drove a 7x settlement latency improvement across distributed ledger services.',
    );
    const breach = findPreservationBreach(BASE, tailored);
    expect(breach?.missing).toHaveLength(1);
    expect(breach?.invented).toHaveLength(1);
  });

  it('rejects a dropped projects section', () => {
    const tailored = BASE.replace(/\\section\{Projects\}[\s\S]*?\\section\{Education\}/, '\\section{Education}');
    const breach = findPreservationBreach(BASE, tailored);
    expect(breach?.missing.map((e) => e.text)).toContain('tideline');
  });

  it('rejects a renamed project', () => {
    const tailored = swap(BASE, '\\runsubsection{Tideline}', '\\runsubsection{Tideline Payments}');
    expect(findPreservationBreach(BASE, tailored)).not.toBeNull();
  });

  it('rejects an altered project tech stack', () => {
    const tailored = swap(BASE, '\\descript{TypeScript, SQLite, Rust}', '\\descript{TypeScript, SQLite, Rust, Kubernetes}');
    expect(findPreservationBreach(BASE, tailored)).not.toBeNull();
  });

  it('rejects an altered employment date', () => {
    const tailored = swap(BASE, '\\location{Jan 2019 -- Feb 2021}', '\\location{Jan 2018 -- Feb 2021}');
    expect(findPreservationBreach(BASE, tailored)).not.toBeNull();
  });

  it('rejects an invented experience entry', () => {
    const tailored = swap(
      BASE,
      '\\section{Projects}',
      String.raw`\entrysep
\entryline{\runsubsection{Initech}}{\location{Jun 2017 -- Dec 2018}}
\entryline{\descript{Platform Engineer}}{\location{Remote}}
\begin{tightemize}
  \item Ran the Kubernetes migration for the billing estate.
\end{tightemize}

\section{Projects}`,
    );
    const breach = findPreservationBreach(BASE, tailored);
    expect(breach?.missing).toHaveLength(0);
    expect(breach?.invented.map((e) => e.text)).toContain('initech');
  });
});

describe('findPreservationBreach — acceptances', () => {
  /** The test that keeps the guard honest: real tailoring has to get through. */
  it('accepts a summary and skills rewrite', () => {
    let tailored = swap(
      BASE,
      'Backend engineer with six years on payment systems.',
      String.raw`\custombold{Backend engineer} with six years on \custombold{payment systems}, ` +
        'building the ledger and payout services this role asks for.',
    );
    tailored = swap(
      tailored,
      '\\skillrow{Languages}{\\custombold{TypeScript} \\sep Python \\sep SQL}\n\\skillrow{Backend}{Node.js \\sep PostgreSQL}',
      '\\skillrow{Backend}{\\custombold{Node.js} \\sep \\custombold{PostgreSQL} \\sep REST APIs}\n' +
        '\\skillrow{Languages}{\\custombold{TypeScript} \\sep SQL \\sep Python}',
    );

    expect(findPreservationBreach(BASE, tailored)).toBeNull();
  });

  it('accepts an unchanged document', () => {
    expect(findPreservationBreach(BASE, BASE)).toBeNull();
  });

  it('accepts reflowed whitespace and re-indented entries', () => {
    const tailored = swap(
      BASE,
      '  \\item Cut settlement latency from 900ms to 120ms across the ledger service.',
      '\t\\item Cut settlement latency from 900ms\n     to 120ms across the ledger\n     service.',
    );
    expect(findPreservationBreach(BASE, tailored)).toBeNull();
  });

  it('accepts a renamed section heading that stays protected', () => {
    const tailored = swap(BASE, '\\section{Experience}', '\\section{Professional Experience}');
    expect(findPreservationBreach(BASE, tailored)).toBeNull();
  });

  it('accepts inline emphasis added around wording that is otherwise identical', () => {
    // Bolding a technology is typography, not a new claim, and the class's own
    // template does it everywhere.
    const tailored = swap(BASE, 'the ledger service', 'the \\custombold{ledger service}');
    expect(findPreservationBreach(BASE, tailored)).toBeNull();
  });

  it('accepts an en dash written where the source used a double hyphen', () => {
    const tailored = swap(BASE, '\\location{Mar 2021 -- Present}', '\\location{Mar 2021 – Present}');
    expect(findPreservationBreach(BASE, tailored)).toBeNull();
  });

  it('accepts a comment stripped from the source', () => {
    const commented = swap(BASE, '\\section{Experience}', '%-----------EXPERIENCE-----------\n\\section{Experience}');
    expect(findPreservationBreach(commented, BASE)).toBeNull();
  });

  it('accepts anything when the base has no protected sections to defend', () => {
    const bare = String.raw`\documentclass{deedy-resume-openfont}
\begin{document}
\section{Summary}
A one-line resume.
\end{document}`;
    expect(findPreservationBreach(bare, BASE)).toBeNull();
  });
});

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import {
  findUnsafeConstruct,
  normalizeForScan,
  summarizeLog,
} from '../../src/services/latex/latex.utils.js';
import { LatexService } from '../../src/services/latex/latex.service.js';
import type { AppPaths } from '../../src/config/env.js';
import type { Logger } from '../../src/core/logger.js';

const wrap = (payload: string): string =>
  `\\documentclass{deedy-resume-openfont}\n\\begin{document}\n${payload}\n\\end{document}\n`;

describe('findUnsafeConstruct', () => {
  /**
   * The escape this suite exists for: `\csname input\endcsname{^^2fetc^^2fhostname}`
   * compiled cleanly and embedded /etc/hostname in the returned PDF, because the
   * primitive was assembled from letters and the slashes were written in TeX's
   * hex notation. Both halves have to stay caught.
   */
  it('rejects a control sequence assembled with \\csname', () => {
    expect(findUnsafeConstruct(wrap('\\csname input\\endcsname{/etc/hostname}'))).toMatch(/csname/i);
  });

  it('rejects the full proven exploit, csname plus hex-escaped path', () => {
    expect(findUnsafeConstruct(wrap('\\csname input\\endcsname{^^2fetc^^2fhostname}'))).not.toBeNull();
  });

  it('decodes ^^XX hex notation before matching paths', () => {
    // ^^2f is a slash to the engine's input processor, so the path rules have to
    // see the slash too.
    expect(findUnsafeConstruct(wrap('\\somemacro{^^2fetc^^2fpasswd}'))).toBe('absolute path');
    expect(normalizeForScan('^^2fetc^^2fhostname')).toBe('/etc/hostname');
  });

  it('decodes single-character ^^ notation', () => {
    // ^^A is character 1; ^^M is a carriage return. The transform is bit 6 flipped.
    expect(normalizeForScan('^^A')).toBe('\u0001');
    // ^^e IS a comment character once decoded, so it comments out the rest of
    // its line — which is exactly how a split primitive gets past a scanner
    // that only looks for a literal `%`.
    expect(normalizeForScan('\\in^^ehidden\n put{x}')).toBe('\\input{x}');
    expect(findUnsafeConstruct(wrap('\\in^^ehidden\n put{/etc/hostname}'))).toMatch(/input/i);
  });

  it('rejoins a primitive split by a comment', () => {
    // TeX eats `%`, the rest of the line, the newline and the next line's
    // indentation, so this is a single \input token to the engine.
    expect(normalizeForScan('\\in%comment\n   put{x}')).toBe('\\input{x}');
    expect(findUnsafeConstruct(wrap('\\in%comment\n   put{/etc/hostname}'))).toMatch(/input/i);
  });

  it('keeps an escaped percent sign as literal text', () => {
    expect(normalizeForScan('growth of 40\\% year on year')).toBe('growth of 40\\% year on year');
    expect(findUnsafeConstruct(wrap('Grew revenue 40\\% \\& retention'))).toBeNull();
  });

  it('matches regardless of case', () => {
    expect(findUnsafeConstruct(wrap('\\INPUT{secret.tex}'))).toMatch(/input/i);
    // The absolute-path rule used to omit the `i` flag, so /Users/ only matched
    // in one casing.
    expect(findUnsafeConstruct(wrap('\\somemacro{/Users/someone/.ssh/id_rsa}'))).toBe(
      'absolute path',
    );
    expect(findUnsafeConstruct(wrap('\\somemacro{/ETC/shadow}'))).toBe('absolute path');
  });

  it.each([
    ['\\input', '\\input{/etc/hostname}'],
    ['\\@@input', '\\@@input /etc/hostname '],
    ['\\include', '\\include{secret}'],
    ['\\InputIfFileExists', '\\InputIfFileExists{/etc/hostname}{}{}'],
    ['\\import', '\\import{/etc/}{hostname}'],
    ['\\subimport', '\\subimport{sub/}{file}'],
    ['\\includegraphics', '\\includegraphics{/etc/hostname}'],
    ['\\lstinputlisting', '\\lstinputlisting{/etc/hostname}'],
    ['\\verbatiminput', '\\verbatiminput{/etc/hostname}'],
    ['\\special', '\\special{dvipdfmx:. /etc/hostname}'],
    ['\\pdffiledump', '\\pdffiledump offset 0 length 99 {/etc/hostname}'],
    ['\\openin', '\\newread\\r\\openin\\r=/etc/hostname'],
    ['\\read', '\\read\\r to\\line'],
    ['\\write18', '\\immediate\\write18{cat /etc/hostname}'],
    ['\\ShellEscape', '\\ShellEscape{id}'],
    ['\\directlua', "\\directlua{io.open('/etc/hostname')}"],
    ['\\latelua', "\\latelua{os.execute('id')}"],
    ['\\expandafter', '\\expandafter\\somecs\\somearg'],
    ['\\string', '\\string\\input'],
    ['\\meaning', '\\meaning\\input'],
    ['\\detokenize', '\\detokenize{\\input}'],
    ['\\scantokens', '\\scantokens{\\input{x}}'],
    ['\\catcode', '\\catcode`\\@=0'],
    ['\\endlinechar', '\\endlinechar=-1'],
    ['\\usepackage', '\\usepackage{shellesc}'],
    ['path traversal', '\\somemacro{../../etc/hostname}'],
  ])('rejects %s', (_label, payload) => {
    expect(findUnsafeConstruct(wrap(payload))).not.toBeNull();
  });

  it('accepts the shipped template unchanged', () => {
    const template = resolve('assets/latex/resume-template.tex');
    // Guards the other direction: a denylist that rejects the product's own
    // starter document is a broken denylist, not a strict one.
    if (!existsSync(template)) return;
    expect(findUnsafeConstruct(readFileSync(template, 'utf8'))).toBeNull();
  });

  it('accepts ordinary resume prose', () => {
    const document = wrap(
      [
        '\\namesection{REDACTED}{NAME}{Staff Engineer}',
        '\\section{Experience}',
        '\\runsubsection{Analytical Engines} \\descript{| Staff Engineer}',
        '\\begin{tightemize}\\item Cut p99 latency 45\\% and saved \\$1.2M.\\end{tightemize}',
        '\\skillrow{Languages}{TypeScript \\sep Rust \\sep C++}',
        '\\href{https://example.com/profile}{example.com/profile}',
      ].join('\n'),
    );
    expect(findUnsafeConstruct(document)).toBeNull();
  });
});

describe('summarizeLog', () => {
  it('caps the summary hard, because it is returned to the caller', () => {
    // A document that does manage to read something must not be able to pipe it
    // back out through the engine log.
    const leaked = `! LaTeX Error: something.\n${'SECRET'.repeat(4000)}`;
    const summary = summarizeLog(leaked);
    expect(summary.length).toBeLessThanOrEqual(2100);
    // Even a caller asking for more than the cap cannot raise it.
    expect(summarizeLog(leaked, 1_000_000).length).toBeLessThanOrEqual(2100);
  });

  it('truncates individual lines of engine context', () => {
    const summary = summarizeLog(`! Undefined control sequence.\nl.5 ${'x'.repeat(5000)}`);
    for (const line of summary.split('\n')) expect(line.length).toBeLessThanOrEqual(201);
  });

  it('leads with the engine error rather than the source context', () => {
    const summary = summarizeLog('! LaTeX Error: File `x.tex\' not found.\nl.3 \\input{x}');
    expect(summary.split('\n')[0]).toContain('LaTeX Error');
  });
});

const hasEngine = ['xelatex', 'lualatex', 'tectonic'].some((binary) =>
  (process.env.PATH ?? '')
    .split(delimiter)
    .some((dir) => dir.length > 0 && existsSync(join(dir, binary))),
);
const hasBwrap = (process.env.PATH ?? '')
  .split(delimiter)
  .some((dir) => dir.length > 0 && existsSync(join(dir, 'bwrap')));

describe('engine sandbox', () => {
  const root = mkdtempSync(join(tmpdir(), 'deedy-latex-test-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

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

  const paths: AppPaths = {
    root,
    db: join(root, 'deedy.sqlite'),
    artifacts: root,
    screenshots: root,
    html: root,
    resumes: join(root, 'resumes'),
    coverLetters: root,
    browserProfiles: root,
    backups: root,
    plugins: root,
    keyFile: join(root, '.encryption-key'),
  };

  // The denylist is the second layer; if this ever reports false on a host that
  // can run it, the compiler is back to being protected by regex alone.
  it.skipIf(!hasEngine || !hasBwrap)('is active when the host can provide it', async () => {
    const service = new LatexService(paths, logger);
    await expect(service.sandboxAvailable()).resolves.toBe(true);
  }, 60_000);
});

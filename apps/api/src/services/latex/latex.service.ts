import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
} from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';
import {
  DEFAULT_RESUME_THEME,
  type CompileResumeResult,
  type ResumeTemplate,
  type ResumeTheme,
} from '@deedy/shared';
import type { AppPaths } from '../../config/env.js';
import type { Logger } from '../../core/logger.js';
import { slugify } from '../../core/utils.js';
import { applyTheme, findUnsafeConstruct, summarizeLog } from './latex.utils.js';

const run = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));

const CLASS_FILE = 'deedy-resume-openfont.cls';
const TEMPLATE_FILE = 'resume-template.tex';
const MACROS_FILE = 'MACROS.md';
const TEMPLATE_ID = 'deedy-resume-openfont';

const DEFAULT_TIMEOUT_MS = 60_000;
/** Long enough for the editor to load a preview, short enough to bound the disk. */
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const PREVIEW_DIR = '.previews';

/**
 * A compile is a latexmk -> xelatex -> xdvipdfmx process tree, and the endpoint
 * that starts one is unauthenticated. Two at a time leaves the box usable.
 */
const MAX_CONCURRENT_COMPILES = Math.max(1, Math.min(2, os.cpus().length - 1));
/**
 * A resume preview is interactive: a caller who waits behind four builds has
 * already given up. Failing fast is a better answer than an unbounded queue,
 * which is also how this turns into a memory-exhaustion channel.
 */
const MAX_QUEUED_COMPILES = MAX_CONCURRENT_COMPILES * 2;

const BUSY_MESSAGE =
  'The LaTeX compiler is busy with other documents right now. Wait a moment and compile again.';

/**
 * Read-only paths a TeX engine needs inside the sandbox. All of them are
 * distribution data — fonts, the TeX tree, libpaper's page sizes, the loader
 * cache. DATA_DIR, $HOME and the rest of the filesystem are deliberately absent,
 * which is what makes `\input{/etc/...}` fail with "file not found".
 */
const SANDBOX_RO_PATHS: readonly string[] = [
  '/usr',
  '/opt',
  '/etc/fonts',
  '/etc/texmf',
  '/etc/texmfrc',
  '/etc/papersize',
  '/etc/paperspecs',
  '/etc/libpaper.d',
  '/etc/localtime',
  '/etc/ld.so.cache',
  '/etc/ld.so.conf',
  '/etc/ld.so.conf.d',
  '/etc/alternatives',
  '/var/lib/texmf',
  '/var/cache/fontconfig',
];

/** Symlinks into /usr on a merged-usr host, real directories on an older one. */
const SANDBOX_LEGACY_ROOTS: readonly string[] = ['/bin', '/lib', '/lib64', '/sbin'];

/** Exits 0 and prints a banner; used to prove the sandbox can run the engine. */
function versionFlag(engine: string): string {
  return path.basename(engine).startsWith('tectonic') ? '--version' : '-v';
}

/**
 * Caps how many compiles run at once and how many may wait. `acquire` resolves
 * with a release function, or null when the queue is already full.
 */
class CompileSemaphore {
  private active = 0;
  private readonly waiting: Array<(release: () => void) => void> = [];

  constructor(
    private readonly limit: number,
    private readonly maxQueued: number,
  ) {}

  async acquire(): Promise<(() => void) | null> {
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    if (this.waiting.length >= this.maxQueued) return null;

    return new Promise<(() => void) | null>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    // The slot is handed straight to the next waiter rather than freed, so a
    // burst of requests cannot all see `active < limit` at once.
    if (next) next(() => this.release());
    else this.active--;
  }
}

export interface LatexCompileInput {
  latex: string;
  theme?: ResumeTheme;
  baseName?: string;
  timeoutMs?: number;
}

export interface LatexCompileResult {
  ok: boolean;
  pdfPath: string | null;
  log: string;
  pages: number | null;
  engine: string | null;
  durationMs: number;
}

/**
 * Compiles resume LaTeX to PDF with the bundled deedy-resume-openfont class.
 *
 * The documents come from a language model or from an unauthenticated HTTP
 * request, and TeX is a programming language, so containment is layered:
 *
 *  1. `findUnsafeConstruct` rejects the obvious attacks before anything is
 *     written. It is a denylist over a Turing-complete language, so it is a
 *     filter, never the guarantee.
 *  2. The engine runs inside a bubblewrap mount namespace that contains only
 *     the TeX distribution and the throwaway work directory. This is the
 *     control that actually stops a file read; `openin_any` was measured on
 *     TeX Live 2026 and does NOT restrict absolute paths.
 *  3. `shell_escape=f` blocks `\write18`, which does hold, even through latexmk.
 *
 * When bubblewrap is unavailable the compile still runs, but only layer 1 and 3
 * are in force, and the operator is warned once at startup.
 */
export class LatexService {
  private cachedAssetsDir: string | null = null;
  private cachedEngine: string | null | undefined;
  private sandboxProbe: Promise<boolean> | null = null;
  private readonly semaphore = new CompileSemaphore(
    MAX_CONCURRENT_COMPILES,
    MAX_QUEUED_COMPILES,
  );

  constructor(
    private readonly paths: AppPaths,
    private readonly logger: Logger,
  ) {
    // Probed at construction rather than on the first compile so the operator
    // learns the compile path is only regex-protected at startup, not from the
    // logs of the request that needed the protection.
    void this.sandboxAvailable().catch(() => false);
  }

  /**
   * Whether the engine can be run inside a bubblewrap namespace on this host,
   * probed once by actually building the sandbox and running the engine in it.
   * A host without bwrap (or without unprivileged user namespaces — Docker's
   * default seccomp profile blocks them) is supported, loudly.
   */
  async sandboxAvailable(): Promise<boolean> {
    this.sandboxProbe ??= this.probeSandbox();
    return this.sandboxProbe;
  }

  private async probeSandbox(): Promise<boolean> {
    const engine = this.engine();
    if (!engine) return false;

    if (!onPath('bwrap')) {
      this.warnUnsandboxed('bubblewrap (bwrap) is not installed');
      return false;
    }

    const probeDir = await mkdtemp(path.join(os.tmpdir(), 'deedy-latex-probe-'));
    try {
      await run('bwrap', [...sandboxArgs(probeDir, engine), engine, versionFlag(engine)], {
        timeout: 20_000,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      this.logger.info('latex compiles run inside a bubblewrap sandbox', {
        engine,
        maxConcurrent: MAX_CONCURRENT_COMPILES,
      });
      return true;
    } catch (error) {
      this.warnUnsandboxed(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private warnUnsandboxed(reason: string): void {
    this.logger.warn(
      'LaTeX compiles are NOT sandboxed: the engine can read any file this process can. ' +
        'Only the construct denylist protects /resumes/compile. Install bubblewrap (bwrap) ' +
        'and allow unprivileged user namespaces to restore containment.',
      { reason },
    );
  }

  /** Absolute path to the bundled assets directory, resolved for src and dist layouts. */
  assetsDir(): string {
    if (this.cachedAssetsDir) return this.cachedAssetsDir;

    const candidates = [
      path.resolve(here, '../../../assets/latex'),
      path.resolve(here, '../../../../assets/latex'),
      path.resolve(process.cwd(), 'assets/latex'),
      path.resolve(process.cwd(), 'apps/api/assets/latex'),
    ];
    for (const dir of candidates) {
      if (existsSync(path.join(dir, CLASS_FILE))) {
        this.cachedAssetsDir = dir;
        return dir;
      }
    }
    throw new Error(`Could not locate the LaTeX assets directory. Tried: ${candidates.join(', ')}`);
  }

  /** The starter document, default theme, macro cheatsheet and the resolved engine. */
  template(): ResumeTemplate {
    return {
      templateId: TEMPLATE_ID,
      latex: readFileSync(path.join(this.assetsDir(), TEMPLATE_FILE), 'utf8'),
      theme: DEFAULT_RESUME_THEME,
      macros: this.macros(),
      engine: this.engine(),
    };
  }

  /** The MACROS.md contract, injected verbatim into every resume prompt. */
  macros(): string {
    return readFileSync(path.join(this.assetsDir(), MACROS_FILE), 'utf8');
  }

  /**
   * The engine this host will use, resolved once and cached. Order mirrors
   * assets/latex/build.sh: latexmk+xelatex, xelatex, lualatex, tectonic on PATH,
   * then the bundled ./cv/tectonic. Null when none is installed.
   */
  engine(): string | null {
    if (this.cachedEngine !== undefined) return this.cachedEngine;

    const xelatex = onPath('xelatex');
    let resolved: string | null = null;

    if (onPath('latexmk') && xelatex) resolved = 'latexmk';
    else if (xelatex) resolved = 'xelatex';
    else if (onPath('lualatex')) resolved = 'lualatex';
    else if (onPath('tectonic')) resolved = 'tectonic';
    else {
      const bundled = this.bundledTectonic();
      if (bundled) resolved = bundled;
    }

    this.cachedEngine = resolved;
    if (!resolved) this.logger.warn('no LaTeX engine found; resume compilation is unavailable');
    return resolved;
  }

  /**
   * Compiles a document in an isolated temp directory with the class copied in,
   * so a resume can never reach the rest of the filesystem. Never throws for a
   * LaTeX error — a failed compile is a normal result with `ok:false` and the log.
   */
  async compile(input: LatexCompileInput): Promise<LatexCompileResult> {
    const base = `${slugify(input.baseName ?? 'resume')}-${Date.now()}`;
    return this.build(input, path.join(this.paths.resumes, `${base}.pdf`));
  }

  /**
   * Compile-only, for the editor's live preview. Writes the PDF under a
   * short-lived preview id and prunes previews older than the TTL.
   */
  async compilePreview(input: {
    latex: string;
    theme?: ResumeTheme;
  }): Promise<CompileResumeResult> {
    await this.prunePreviews();

    const previewId = randomUUID();
    const dir = path.join(this.paths.resumes, PREVIEW_DIR);
    await mkdir(dir, { recursive: true });

    const result = await this.build(input, path.join(dir, `${previewId}.pdf`));
    return {
      ok: result.ok,
      log: result.log,
      previewId: result.ok ? previewId : null,
      pages: result.pages,
      engine: result.engine,
      durationMs: result.durationMs,
    };
  }

  /** Absolute path for a preview id, or null when it has expired or never existed. */
  previewPath(previewId: string): string | null {
    // The id reaches this from a URL, so it is treated as untrusted input: only
    // a bare UUID may address a file inside the preview directory.
    if (!/^[0-9a-f-]{36}$/i.test(previewId)) return null;

    const file = path.join(this.paths.resumes, PREVIEW_DIR, `${previewId}.pdf`);
    try {
      const stat = statSync(file);
      if (Date.now() - stat.mtimeMs > PREVIEW_TTL_MS) return null;
      return file;
    } catch {
      return null;
    }
  }

  /** Shared body of compile() and compilePreview(): build once, copy the PDF out. */
  private async build(input: LatexCompileInput, destination: string): Promise<LatexCompileResult> {
    const startedAt = Date.now();

    // Checked before anything is written: a rejected document must not even
    // reach a temp directory.
    const unsafe = findUnsafeConstruct(input.latex);
    if (unsafe) {
      return {
        ok: false,
        pdfPath: null,
        log: `Rejected before compiling: the document uses ${unsafe}, which is not permitted. Remove it and try again.`,
        pages: null,
        engine: null,
        durationMs: Date.now() - startedAt,
      };
    }

    const engine = this.engine();
    if (!engine) {
      return {
        ok: false,
        pdfPath: null,
        log: 'No LaTeX engine is installed. Install texlive-xetex (xelatex) or place a tectonic binary in ./cv.',
        pages: null,
        engine: null,
        durationMs: Date.now() - startedAt,
      };
    }

    // Held for the whole build, not just the spawn: the temp directory and the
    // PDF copy are part of what a flood of requests would exhaust.
    const release = await this.semaphore.acquire();
    if (!release) {
      return {
        ok: false,
        pdfPath: null,
        log: BUSY_MESSAGE,
        pages: null,
        engine,
        durationMs: Date.now() - startedAt,
      };
    }

    const latex = input.theme ? applyTheme(input.latex, input.theme) : input.latex;
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'deedy-latex-'));

    try {
      const job = 'resume';
      const source = path.join(workDir, `${job}.tex`);
      const outDir = path.join(workDir, 'out');
      await mkdir(outDir, { recursive: true });
      await writeFile(source, latex, 'utf8');
      // Copied, not symlinked: a symlink would let the engine follow the link
      // back out of the sandbox directory.
      await copyFile(path.join(this.assetsDir(), CLASS_FILE), path.join(workDir, CLASS_FILE));

      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const { ok, log } = await this.runEngine(engine, job, workDir, outDir, timeoutMs);

      const produced = ok ? findPdf(outDir, job) : null;
      if (!produced) {
        return {
          ok: false,
          pdfPath: null,
          log: summarizeLog(log),
          pages: null,
          engine,
          durationMs: Date.now() - startedAt,
        };
      }

      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(produced, destination);
      const pages = countPages(await readFile(destination));

      return {
        ok: true,
        pdfPath: destination,
        log: summarizeLog(log),
        pages,
        engine,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      this.logger.error('latex compile failed', {
        engine,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        pdfPath: null,
        log: error instanceof Error ? error.message : String(error),
        pages: null,
        engine,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      release();
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Runs the engine's passes. A non-zero exit is a result, not an exception. */
  private async runEngine(
    engine: string,
    job: string,
    workDir: string,
    outDir: string,
    timeoutMs: number,
  ): Promise<{ ok: boolean; log: string }> {
    const isTectonic = path.basename(engine).startsWith('tectonic');
    const passes: string[][] = isTectonic
      ? // Tectonic always runs to a fixed point, so one pass settles references.
        [['-k', '--outdir', outDir, `${job}.tex`]]
      : engine === 'latexmk'
        ? [
            [
              '-xelatex',
              '-halt-on-error',
              '-interaction=nonstopmode',
              `-jobname=${job}`,
              `-outdir=${outDir}`,
              `${job}.tex`,
            ],
          ]
        : [
            [
              '-halt-on-error',
              '-interaction=nonstopmode',
              '-no-shell-escape',
              `-jobname=${job}`,
              `-output-directory=${outDir}`,
              `${job}.tex`,
            ],
            [
              '-halt-on-error',
              '-interaction=nonstopmode',
              '-no-shell-escape',
              `-jobname=${job}`,
              `-output-directory=${outDir}`,
              `${job}.tex`,
            ],
          ];

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      openout_any: 'p',
      openin_any: 'p',
      shell_escape: 'f',
      // Paranoid mode restricts absolute paths to TEXMFOUTPUT, so pointing it at
      // the work directory is what gives `openin_any=p` something to enforce.
      // Measured on TeX Live 2026: it enforces nothing for \input, which is why
      // the bubblewrap namespace below is the real control and this is a hint.
      TEXMFOUTPUT: workDir,
      HOME: workDir,
      TMPDIR: workDir,
    };

    const sandboxed = await this.sandboxAvailable();

    let log = '';
    const deadline = Date.now() + timeoutMs;

    for (const args of passes) {
      const remaining = Math.max(1000, deadline - Date.now());
      const command = sandboxed ? 'bwrap' : engine;
      const argv = sandboxed ? [...sandboxArgs(workDir, engine), engine, ...args] : args;
      try {
        const { stdout, stderr } = await run(command, argv, {
          cwd: workDir,
          env,
          timeout: remaining,
          killSignal: 'SIGKILL',
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        });
        log += stdout + stderr;
      } catch (error) {
        const failure = error as {
          stdout?: string;
          stderr?: string;
          message?: string;
          killed?: boolean;
        };
        log += (failure.stdout ?? '') + (failure.stderr ?? '');
        if (failure.killed) log += `\n! Compilation timed out after ${timeoutMs}ms and was killed.`;
        else if (!failure.stdout && !failure.stderr)
          log += `\n! ${failure.message ?? 'engine failed to start'}`;
        return { ok: false, log };
      }
    }

    return { ok: true, log };
  }

  /** The static binary the user keeps beside the original CV builder. */
  private bundledTectonic(): string | null {
    const roots = [
      path.resolve(this.assetsDir(), '../../../..'),
      path.resolve(this.assetsDir(), '../../../../..'),
      process.cwd(),
    ];
    for (const root of roots) {
      const binary = path.join(root, 'cv', 'tectonic');
      if (isExecutable(binary)) return binary;
    }
    return null;
  }

  /** Drops preview PDFs past their TTL so the directory cannot grow unbounded. */
  private async prunePreviews(): Promise<void> {
    const dir = path.join(this.paths.resumes, PREVIEW_DIR);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    const cutoff = Date.now() - PREVIEW_TTL_MS;
    for (const entry of entries) {
      const file = path.join(dir, entry);
      try {
        if (statSync(file).mtimeMs < cutoff) await rm(file, { force: true });
      } catch {
        // A preview removed by another request is exactly the desired state.
      }
    }
  }
}

/**
 * Builds the bubblewrap argument list that precedes the engine command.
 *
 * The mount set is an allowlist: nothing is visible inside the namespace except
 * the TeX distribution (read-only) and the throwaway work directory (writable).
 * A document that asks for `/etc/hostname`, DATA_DIR/.encryption-key or
 * deedy.sqlite gets "file not found" from the engine itself, with no denylist
 * involved. Networking, PID, IPC and UTS namespaces are dropped as well, so a
 * hypothetical code-execution bug cannot phone home either.
 */
function sandboxArgs(workDir: string, engine: string): string[] {
  const args = [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    // Empty stand-ins: fontconfig and latexmk write into these if they exist,
    // and an empty directory is a safer answer than the host's.
    '--tmpfs',
    '/home',
    '--tmpfs',
    '/root',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/var/tmp',
  ];

  for (const target of SANDBOX_RO_PATHS) {
    if (existsSync(target)) args.push('--ro-bind', target, target);
  }

  for (const target of SANDBOX_LEGACY_ROOTS) {
    if (!existsSync(target)) continue;
    let link: string | null = null;
    try {
      if (lstatSync(target).isSymbolicLink()) link = readlinkSync(target);
    } catch {
      // Unreadable: fall through and bind it like a directory.
    }
    if (link) args.push('--symlink', link, target);
    else args.push('--ro-bind', target, target);
  }

  // The bundled ./cv/tectonic lives outside the distribution paths above, so
  // whatever binary was resolved has to be reachable by its own path.
  if (engine.includes(path.sep)) {
    const engineDir = path.dirname(path.resolve(engine));
    if (existsSync(engineDir)) args.push('--ro-bind', engineDir, engineDir);
  }

  // Last, so it wins over the /tmp tmpfs that the work directory sits under.
  args.push(
    '--bind',
    workDir,
    workDir,
    '--chdir',
    workDir,
    '--setenv',
    'HOME',
    workDir,
    '--setenv',
    'TMPDIR',
    workDir,
  );

  return args;
}

/** Locates an executable on PATH without spawning it. */
function onPath(command: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => dir.length > 0);
  return dirs.some((dir) => isExecutable(path.join(dir, command)));
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** latexmk and xelatex name the PDF after -jobname; tectonic after the source stem. */
function findPdf(outDir: string, job: string): string | null {
  const candidates = [path.join(outDir, `${job}.pdf`)];
  try {
    for (const entry of readdirSync(outDir)) {
      if (entry.endsWith('.pdf')) candidates.push(path.join(outDir, entry));
    }
  } catch {
    return null;
  }
  return candidates.find((file) => existsSync(file)) ?? null;
}

/**
 * Counts page objects in the PDF itself. Shelling out to pdfinfo would add a
 * dependency that most hosts do not have, for one integer.
 *
 * XeLaTeX writes PDF 1.5+, where the page objects live inside compressed
 * object streams, so the raw bytes have to be inflated before they can be
 * counted. zlib is in the standard library, so this stays dependency-free.
 */
function countPages(pdf: Buffer): number | null {
  let text = pdf.toString('latin1');

  for (const stream of inflatedStreams(pdf)) text += stream;

  const pages = text.match(/\/Type\s*\/Page[^s]/g);
  if (pages) return pages.length;

  // Fallback: the page tree records its own size.
  const count = /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/.exec(text)?.[1];
  return count ? Number(count) : null;
}

/** Inflates every Flate-compressed stream, skipping the ones that are not. */
function* inflatedStreams(pdf: Buffer): Generator<string> {
  const marker = Buffer.from('stream');
  const endMarker = Buffer.from('endstream');

  let cursor = 0;
  while (cursor < pdf.length) {
    const start = pdf.indexOf(marker, cursor);
    if (start < 0) return;
    const end = pdf.indexOf(endMarker, start);
    if (end < 0) return;
    cursor = end + endMarker.length;

    // Skip the EOL that must follow the `stream` keyword.
    let from = start + marker.length;
    if (pdf[from] === 0x0d) from++;
    if (pdf[from] === 0x0a) from++;

    try {
      yield inflateSync(pdf.subarray(from, end)).toString('latin1');
    } catch {
      // Not Flate-compressed (or an image); nothing to count in it.
    }
  }
}

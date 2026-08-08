import type { ResumeTheme } from '@deedy/shared';

/** Escapes the characters that change meaning in LaTeX, for interpolating plain text. */
export function escapeLatex(value: string): string {
  return value
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

/**
 * The class's own defaults, in the order it declares them. Every size scales
 * from `bodysize`, so one base size rescales the whole document.
 */
const SIZE_DEFAULTS = {
  bodysize: 10,
  bodyleading: 12.5,
  namesize: 30,
  nameleading: 34,
  taglinesize: 10.5,
  taglineleading: 13,
  metasize: 9.5,
  metaleading: 13,
  sectionsize: 11,
  sectionleading: 13,
  subsize: 10.5,
  subleading: 12,
  smallsize: 9.5,
  smallleading: 12,
} as const;

/** Vertical gaps, in points. Density scales these; the font size does not. */
const GAP_DEFAULTS = {
  sectiongap: 9,
  sectionafter: 3,
  entrygap: 4,
  itemsep: 1.5,
  listtopsep: 3,
  skillgap: 2.5,
} as const;

/**
 * `density` has no key of its own in the class — it is a shorthand for the
 * seven gap/leading lengths below, which is why it expands rather than maps.
 */
const DENSITY_SCALE: Record<ResumeTheme['density'], { gap: number; leading: number }> = {
  compact: { gap: 0.72, leading: 0.94 },
  normal: { gap: 1, leading: 1 },
  relaxed: { gap: 1.35, leading: 1.07 },
};

/** TeX rejects `1.5000000000000002pt`, and a trailing `.0` is just noise. */
function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * Renders a theme as the class's `\cvtheme{...}` key list. Values come from a
 * validated ResumeTheme, so a theme can never inject arbitrary LaTeX.
 */
export function renderThemeMacro(theme: ResumeTheme): string {
  const fontScale = theme.baseFontSize / SIZE_DEFAULTS.bodysize;
  const { gap, leading } = DENSITY_SCALE[theme.density];
  const pairs: string[] = [`font=${theme.font}`];

  for (const [key, value] of Object.entries(SIZE_DEFAULTS)) {
    // Leading absorbs the density multiplier as well; a compact resume needs
    // tighter lines, not just tighter gaps, or it only saves a few millimetres.
    const scaled = key.endsWith('leading') ? value * fontScale * leading : value * fontScale;
    pairs.push(`${key}=${num(scaled)}`);
  }

  pairs.push(
    `primary=${theme.primary}`,
    `headings=${theme.headings}`,
    `subheadings=${theme.subheadings}`,
    `date=${theme.date}`,
    `rule=${theme.rule}`,
    `accent=${theme.accent}`,
  );

  for (const [key, value] of Object.entries(GAP_DEFAULTS)) {
    pairs.push(`${key}=${num(value * gap)}pt`);
  }

  pairs.push(`hmargin=${num(theme.hmargin)}cm`, `vmargin=${num(theme.vmargin)}cm`);
  return `\\cvtheme{${pairs.join(', ')}}`;
}

const CVTHEME_LINE = /^[ \t]*\\cvtheme\s*\{[\s\S]*?\}[ \t]*\r?\n?/m;
const DOCUMENTCLASS = /\\documentclass(?:\[[^\]]*\])?\s*\{[^}]*\}[ \t]*\r?\n?/;

/**
 * Inserts (or replaces) the `\cvtheme` line between \documentclass and
 * \begin{document}. A document that already carries one is rewritten, so the
 * theme panel is always authoritative.
 */
export function applyTheme(latex: string, theme: ResumeTheme): string {
  const macro = renderThemeMacro(theme);

  if (CVTHEME_LINE.test(latex)) return latex.replace(CVTHEME_LINE, `${macro}\n`);

  const declaration = DOCUMENTCLASS.exec(latex);
  if (declaration) {
    const end = declaration.index + declaration[0].length;
    return `${latex.slice(0, end)}\n${macro}\n${latex.slice(end)}`;
  }

  // No \documentclass at all: the document will fail to build anyway, but the
  // theme still belongs ahead of whatever the model produced.
  const begin = latex.indexOf('\\begin{document}');
  if (begin >= 0) return `${latex.slice(0, begin)}${macro}\n${latex.slice(begin)}`;
  return `${macro}\n${latex}`;
}

/**
 * Ordered so the most specific construct wins the report: `\immediate\write18`
 * should be named as shell escape, not as a plain `\write`.
 *
 * Every pattern carries `i`. TeX itself is case-sensitive, so `\Input` would
 * never run — but a rejection is free and a missing `i` is how `/Users/` slipped
 * past the absolute-path rule.
 *
 * This list is the SECOND layer. The engine sandbox in latex.service.ts is what
 * actually contains a read; TeX is Turing-complete and no denylist over its
 * surface syntax can be complete on its own.
 */
const UNSAFE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\\write\s*18/i, label: '\\write18 (shell escape)' },
  { pattern: /\\(?:ShellEscape|DeleteFile|CopyFile)\b/i, label: '\\ShellEscape' },
  { pattern: /--?shell-escape\b/i, label: '--shell-escape' },
  { pattern: /\\immediate\s*\\write/i, label: '\\immediate\\write' },
  { pattern: /\\(?:openout|openin|closeout|closein)\b/i, label: '\\openout / \\openin' },
  { pattern: /\\(?:read|readline)\b/i, label: '\\read' },
  { pattern: /\\write\b/i, label: '\\write' },
  {
    pattern: /\\(?:@@input|input|include|includeonly|subfile|import|subimport)\b/i,
    label: '\\input / \\include',
  },
  {
    pattern: /\\(?:InputIfFileExists|IfFileExists|openin@|scantokens)\b/i,
    label: '\\InputIfFileExists',
  },
  // Every one of these reads a file the caller names, in a package the class
  // may already have loaded.
  {
    pattern: /\\(?:includegraphics|lstinputlisting|verbatiminput|VerbatimInput|pdffiledump)\b/i,
    label: '\\includegraphics / \\lstinputlisting',
  },
  // \special reaches the driver (xdvipdfmx), which has its own file-opening
  // verbs, so it must not survive to the .xdv.
  { pattern: /\\special\b/i, label: '\\special' },
  // The class already loads everything the macros need, and a package is an
  // arbitrary-code channel (shellesc, catchfile, spath3, ...).
  {
    pattern: /\\(?:usepackage|RequirePackage|LoadClass|LoadClassWithOptions)\b/i,
    label: '\\usepackage',
  },
  // `\csname input\endcsname` builds a banned primitive out of letters, so the
  // primitive's own name never appears. The builders have to be banned too, or
  // every rule above is decorative.
  {
    pattern: /\\(?:csname|expandafter|noexpand|string|meaning|detokenize|unexpanded)\b/i,
    label: '\\csname / \\expandafter (control-sequence construction)',
  },
  // Recategorising a character is how a document smuggles a banned primitive
  // past a textual check -- \catcode`\\=12 and friends.
  {
    pattern: /\\(?:catcode|makeatletter|endlinechar|newlinechar|escapechar|lccode|uccode)\b/i,
    label: '\\catcode',
  },
  { pattern: /\\(?:directlua|latelua|luadirect|luaexec|jobname\s*=)\b/i, label: '\\directlua' },
  { pattern: /\.\.[/\\]/i, label: '.. path traversal' },
  // An absolute path can only appear in a file argument here; `https://` is
  // excluded by requiring the slash not to follow a colon.
  {
    pattern:
      /(?<![:\w.])\/(?:etc|usr|var|home|root|proc|sys|dev|tmp|bin|sbin|opt|users|mnt|data|srv|lib|boot|private)\//i,
    label: 'absolute path',
  },
  { pattern: /[{[=]\s*~?\//i, label: 'absolute path' },
];

/**
 * Decodes TeX's `^^` notation. The input processor resolves it before catcodes
 * are assigned, so `^^2f` IS a slash and `^^25` IS a comment character as far as
 * the engine is concerned — a denylist reading raw bytes sees neither.
 * Two rounds, because the first can uncover a second (`^^^^5e^^5e2f`).
 */
function decodeCaretNotation(src: string): string {
  let out = src;
  for (let round = 0; round < 2; round++) {
    // The single-character form is restricted to printable ASCII: a raw control
    // character in the source would be rejected long before it mattered, and
    // matching one here only makes the pattern harder to read.
    const next = out.replace(/\^\^([0-9a-f]{2}|[\x20-\x7e])/g, (match, token: string) => {
      if (token.length === 2) return String.fromCharCode(parseInt(token, 16));
      const code = token.charCodeAt(0);
      // TeX's single-character form: flip bit 6 of the following character.
      return String.fromCharCode(code < 64 ? code + 64 : code - 64);
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Removes `%` comments the way TeX does: the comment character, the rest of the
 * line, the newline AND the next line's indentation all vanish. That is what
 * makes `\in%\n  put` a single `\input` token to the engine, so the scanner has
 * to see it the same way.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;

  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\') {
      // An escaped `%` is a literal percent sign, not a comment.
      out += ch + (src[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (ch === '%') {
      const newline = src.indexOf('\n', i);
      if (newline < 0) break;
      i = newline + 1;
      while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
      continue;
    }
    out += ch;
    i++;
  }

  return out;
}

/** The document as the engine's input processor will see it, for scanning only. */
export function normalizeForScan(latex: string): string {
  return stripComments(decodeCaretNotation(latex.replace(/\r\n/g, '\n')));
}

/**
 * Rejects documents that could read or write the filesystem or shell out.
 * Returns the offending construct, or null when the document is safe.
 *
 * Scans the raw text and the engine-normalised text: the raw form keeps
 * constructs that normalisation would eat, the normalised form exposes the ones
 * hidden behind `^^` escapes and comment splitting.
 */
export function findUnsafeConstruct(latex: string): string | null {
  const normalized = normalizeForScan(latex);
  // Lowercasing is only sound because every pattern already carries `i`; it is
  // kept as a distinct variant so a future case-sensitive rule stays honest.
  const variants = [latex, normalized, normalized.toLowerCase()];

  for (const { pattern, label } of UNSAFE_PATTERNS) {
    for (const variant of variants) {
      if (pattern.test(variant)) return label;
    }
  }
  return null;
}

/**
 * The sections whose content is the candidate's evidence rather than their
 * pitch. Tailoring may rewrite the summary and reshuffle the skills rows; it may
 * not touch anything matched here. Matched on the `\section{...}` heading, so a
 * document that calls it "Professional Experience" or "Selected Projects" is
 * still protected.
 */
const PROTECTED_SECTION = /\b(experience|employment|work\s*history|projects?|portfolio)\b/i;

/**
 * Which protected bucket a heading belongs to. Comparing on the bucket rather
 * than on the heading text lets a model retitle "Experience" to "Professional
 * Experience" — pure presentation — while still catching an entry that moved
 * from the projects section into the work history, which is a claim about
 * employment that the base document never made.
 */
function protectedSectionKind(heading: string): 'experience' | 'projects' | null {
  if (!PROTECTED_SECTION.test(heading)) return null;
  return /\b(projects?|portfolio)\b/i.test(heading) ? 'projects' : 'experience';
}

/** The macros that carry an entry's identity: who, what role, and when. */
const ENTRY_MACROS = ['runsubsection', 'descript', 'location'] as const;

export interface ProtectedEntry {
  /** Which protected block the entry was found in, regardless of the heading's wording. */
  section: 'experience' | 'projects';
  /** `entry` for an employer/project/date line, `bullet` for a `\item` claim. */
  kind: 'entry' | 'bullet';
  /** Normalised prose, for comparison. */
  text: string;
}

/**
 * Comparison form for one fragment of resume evidence. Two documents that say
 * the same thing must produce the same string here, or a re-indent would read as
 * a falsified employer; two that say different things must not, or the guard is
 * decorative.
 *
 * Macro expansion runs first so `\custombold{Acme}` and plain `Acme` agree, and
 * `\href{url}{label}` compares on the label the reader actually sees.
 */
function normalizeEntryText(raw: string): string {
  return expandMacros(raw)
    .replace(/~/g, ' ')
    // Every dash the class or a model might use for a date range is the same dash.
    .replace(/[‐-―]|--+/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    // Trailing punctuation is typography, not a claim.
    .replace(/[\s.,;:|-]+$/, '')
    .replace(/^[\s.,;:|-]+/, '')
    .trim()
    .toLowerCase();
}

/** The document body, with comments removed — a `%` hides its line from the engine. */
function documentBody(latex: string): string {
  const text = latex.replace(/\r\n/g, '\n').replace(/(^|[^\\])%.*$/gm, '$1');
  const begin = text.indexOf('\\begin{document}');
  const end = text.lastIndexOf('\\end{document}');
  if (begin < 0) return end > 0 ? text.slice(0, end) : text;
  return text.slice(begin + '\\begin{document}'.length, end > begin ? end : undefined);
}

/** Every `\section{...}` in the body, paired with the text that runs up to the next one. */
function splitSections(body: string): { heading: string; content: string }[] {
  const marker = /\\section\*?\s*\{/g;
  const sections: { heading: string; content: string }[] = [];
  const starts: { heading: string; from: number }[] = [];

  for (let match = marker.exec(body); match; match = marker.exec(body)) {
    const group = readGroup(body, match.index + match[0].length - 1);
    if (!group) continue;
    starts.push({ heading: normalizeEntryText(group.body), from: group.end });
    marker.lastIndex = group.end;
  }

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const next = starts[i + 1];
    // The next heading's content begins at its own `\section` token, which sits
    // before the recorded `from`; slicing to the group start is close enough
    // because a heading contributes no entries of its own.
    const until = next ? body.lastIndexOf('\\section', next.from) : body.length;
    sections.push({ heading: start.heading, content: body.slice(start.from, until) });
  }

  return sections;
}

/** The `\item` bullets inside one section, each running to the next item or list end. */
function extractBullets(content: string): string[] {
  const bullets: string[] = [];
  const marker = /\\item\b/g;

  for (let match = marker.exec(content); match; match = marker.exec(content)) {
    const from = match.index + match[0].length;
    const stop = content.slice(from).search(/\\item\b|\\end\s*\{|\\section\b|\\entryline\b/);
    bullets.push(content.slice(from, stop < 0 ? content.length : from + stop));
  }

  return bullets;
}

/**
 * The candidate's evidence, as comparable fragments: every employer, role, date
 * and project identity line, plus every bullet claimed under them.
 *
 * Order is preserved but is not itself compared by `findPreservationBreach` —
 * see there for why.
 */
export function extractProtectedEntries(latex: string): ProtectedEntry[] {
  const entries: ProtectedEntry[] = [];

  for (const { heading, content } of splitSections(documentBody(latex))) {
    const section = protectedSectionKind(heading);
    if (!section) continue;

    for (const macro of ENTRY_MACROS) {
      const marker = new RegExp(`\\\\${macro}\\s*\\{`, 'g');
      for (let match = marker.exec(content); match; match = marker.exec(content)) {
        const group = readGroup(content, match.index + match[0].length - 1);
        if (!group) continue;
        marker.lastIndex = group.end;
        const text = normalizeEntryText(group.body);
        if (text) entries.push({ section, kind: 'entry', text });
      }
    }

    for (const bullet of extractBullets(content)) {
      const text = normalizeEntryText(bullet);
      if (text) entries.push({ section, kind: 'bullet', text });
    }
  }

  return entries;
}

/** `section|kind|text`, the key the two documents' evidence is matched on. */
function entryKey(entry: ProtectedEntry): string {
  return `${entry.section}|${entry.kind}|${entry.text}`;
}

export interface PreservationBreach {
  /** Evidence present in the base document that the tailored one no longer states. */
  missing: ProtectedEntry[];
  /** Evidence the tailored document states that the base never did. */
  invented: ProtectedEntry[];
  /** One line naming the breach, for the rejection log. */
  reason: string;
}

/**
 * Compares the protected evidence of a tailored document against its base.
 * Returns null when the tailoring is legitimate — that is, when it only touched
 * the summary and the skills rows.
 *
 * Compared as multisets rather than as sequences: a model that re-emits the same
 * entries in a different order has still told the truth, and rejecting that
 * would train the fallback to fire on every generation. A dropped, altered or
 * invented entry changes the multiset and is caught.
 *
 * Everything is normalised first (macro expansion, whitespace, dashes, escaped
 * literals, case), so re-indenting an entry or writing `\custombold{Acme}` for
 * `Acme` is not a breach, while renaming the employer is.
 */
export function findPreservationBreach(
  baseLatex: string,
  tailoredLatex: string,
): PreservationBreach | null {
  const base = extractProtectedEntries(baseLatex);
  // A base with no protected sections has no evidence to protect; anything the
  // model returns is, by construction, not a falsification of it.
  if (base.length === 0) return null;

  const remaining = new Map<string, ProtectedEntry[]>();
  for (const entry of extractProtectedEntries(tailoredLatex)) {
    const bucket = remaining.get(entryKey(entry));
    if (bucket) bucket.push(entry);
    else remaining.set(entryKey(entry), [entry]);
  }

  const missing: ProtectedEntry[] = [];
  for (const entry of base) {
    const bucket = remaining.get(entryKey(entry));
    if (bucket && bucket.length > 0) bucket.pop();
    else missing.push(entry);
  }

  const invented = [...remaining.values()].flat();
  if (missing.length === 0 && invented.length === 0) return null;

  const describe = (entry: ProtectedEntry): string =>
    `${entry.section}/${entry.kind}: "${truncateEntry(entry.text)}"`;
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`${missing.length} dropped or altered (${missing.map(describe).join('; ')})`);
  }
  if (invented.length > 0) {
    parts.push(`${invented.length} added or reworded (${invented.map(describe).join('; ')})`);
  }

  return { missing, invented, reason: `protected sections changed — ${parts.join(', ')}` };
}

const ENTRY_LOG_CHARS = 80;

function truncateEntry(text: string): string {
  return text.length > ENTRY_LOG_CHARS ? `${text.slice(0, ENTRY_LOG_CHARS)}…` : text;
}

interface Group {
  body: string;
  end: number;
}

/** Reads a balanced `{...}` starting at `start`, or null when one is not there. */
function readGroup(src: string, start: number): Group | null {
  if (src[start] !== '{') return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { body: src.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** How many `{...}` arguments each macro swallows before its text resumes. */
const MACRO_ARITY: Readonly<Record<string, number>> = {
  namesection: 3,
  entryline: 2,
  skillrow: 2,
  href: 2,
  cvmeta: 2,
  cvtheme: 1,
  documentclass: 1,
  section: 1,
  subsection: 1,
  subsubsection: 1,
  runsubsection: 1,
  descript: 1,
  location: 1,
  custombold: 1,
  customitalic: 1,
  customtitle: 1,
  accenttext: 1,
  skilllabel: 1,
  linksline: 1,
  infoline: 1,
  textbf: 1,
  textit: 1,
  emph: 1,
  underline: 1,
  texttt: 1,
  hspace: 1,
  vspace: 1,
  color: 1,
  textcolor: 2,
};

/** What each macro contributes to the prose mirror, given its expanded args. */
const MACRO_TEXT: Readonly<Record<string, (args: readonly string[]) => string>> = {
  namesection: (a) => `${a[0] ?? ''} ${a[1] ?? ''}\n${a[2] ?? ''}\n`,
  entryline: (a) => `${a[0] ?? ''} — ${a[1] ?? ''}\n`,
  skillrow: (a) => `${a[0] ?? ''}: ${a[1] ?? ''}\n`,
  href: (a) => a[1] ?? '',
  // Metadata and the theme are markup-only; they carry no prose.
  cvmeta: () => '',
  cvtheme: () => '',
  documentclass: () => '',
  section: (a) => `\n\n${a[0] ?? ''}\n`,
  subsection: (a) => `\n${a[0] ?? ''}\n`,
  subsubsection: (a) => `\n${a[0] ?? ''}\n`,
  linksline: (a) => `${a[0] ?? ''}\n`,
  infoline: (a) => `${a[0] ?? ''}\n`,
  runsubsection: (a) => a[0] ?? '',
  descript: (a) => a[0] ?? '',
  location: (a) => a[0] ?? '',
  custombold: (a) => a[0] ?? '',
  customitalic: (a) => a[0] ?? '',
  customtitle: (a) => `${a[0] ?? ''}\n`,
  accenttext: (a) => a[0] ?? '',
  skilllabel: (a) => a[0] ?? '',
  textcolor: (a) => a[1] ?? '',
  color: () => '',
  hspace: () => ' ',
  vspace: () => '\n',
  sep: () => ' | ',
  item: () => '\n- ',
  lastupdated: () => '',
  sectionsep: () => '\n',
  entrysep: () => '\n',
  underlineheader: () => '\n',
  today: () => '',
  par: () => '\n',
  newpage: () => '\n',
  centering: () => '',
  raggedright: () => '',
  raggedleft: () => '',
  noindent: () => '',
  strut: () => '',
  itshape: () => '',
  bfseries: () => '',
};

const ESCAPED_LITERALS = '&%$#_{}';

/** Expands the class's macros into the prose they render. */
function expandMacros(src: string): string {
  let out = '';
  let i = 0;

  while (i < src.length) {
    const ch = src[i]!;

    if (ch !== '\\') {
      // Braces are grouping only; their contents are already plain text.
      out += ch === '{' || ch === '}' ? '' : ch;
      i++;
      continue;
    }

    const next = src[i + 1] ?? '';
    if (ESCAPED_LITERALS.includes(next)) {
      out += next;
      i += 2;
      continue;
    }
    if (next === '\\') {
      out += '\n';
      i += 2;
      continue;
    }

    const name = /^[A-Za-z@]+\*?/.exec(src.slice(i + 1))?.[0];
    if (name === undefined) {
      // A spacing control symbol such as `\,` or `\;`.
      out += ' ';
      i += 2;
      continue;
    }

    let j = i + 1 + name.length;

    if (name === 'begin' || name === 'end') {
      const env = readGroup(src, j);
      if (env) j = env.end;
      const options = skipOptional(src, j);
      out += '\n';
      i = options;
      continue;
    }

    j = skipOptional(src, j);

    const arity = MACRO_ARITY[name] ?? 0;
    const args: string[] = [];
    for (let k = 0; k < arity; k++) {
      let scan = j;
      while (scan < src.length && /\s/.test(src[scan]!)) scan++;
      const group = readGroup(src, scan);
      if (!group) break;
      args.push(expandMacros(group.body));
      j = group.end;
    }

    const render = MACRO_TEXT[name];
    // An unknown macro keeps its arguments' text: \somewrapper{words} is far
    // more likely to be emphasis than to be markup worth dropping.
    out += render ? render(args) : args.join(' ');
    i = j;
  }

  return out;
}

/** Skips a `[...]` optional argument when one follows. */
function skipOptional(src: string, index: number): number {
  if (src[index] !== '[') return index;
  const close = src.indexOf(']', index);
  return close < 0 ? index : close + 1;
}

/**
 * A readable plain-text mirror of a LaTeX resume. The scoring, ATS and
 * cover-letter prompts all read prose, not markup, so every resume keeps a
 * derived text form.
 */
export function latexToPlainText(latex: string): string {
  let text = latex.replace(/\r\n/g, '\n');

  // Comments first: an unescaped `%` hides the rest of its line from the engine,
  // so it must be invisible here too.
  text = text.replace(/(^|[^\\])%.*$/gm, '$1');

  const begin = text.indexOf('\\begin{document}');
  const end = text.lastIndexOf('\\end{document}');
  if (begin >= 0) {
    text = text.slice(begin + '\\begin{document}'.length, end > begin ? end : undefined);
  }

  text = expandMacros(text);

  return text
    .replace(/~/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]*[-—|]\s*$/gm, '')
    .trim();
}

/**
 * The engine echoes source context into its log, and this summary is returned
 * to an unauthenticated caller — so the log is an exfiltration channel in its
 * own right. Every line is truncated, the number of lines is bounded, and the
 * whole summary is capped, so a document that manages to read something can
 * still only ever get a few hundred bytes of it back.
 */
const LOG_MAX_LINE_CHARS = 200;
const LOG_CONTEXT_LINES = 3;
const LOG_TAIL_LINES = 15;
const LOG_MAX_CHARS = 2000;

function clipLine(line: string): string {
  const trimmed = line.trimEnd();
  return trimmed.length > LOG_MAX_LINE_CHARS ? `${trimmed.slice(0, LOG_MAX_LINE_CHARS)}…` : trimmed;
}

/** Extracts the part of an engine log that explains a failure (the `!` blocks). */
export function summarizeLog(log: string, maxChars = LOG_MAX_CHARS): string {
  const lines = log.replace(/\r\n/g, '\n').split('\n');
  const errors: string[] = [];
  const context: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // `!` opens a TeX error block; tectonic and latexmk prefix theirs instead.
    if (!/^(!|error:|Error:|.*?:\d+:)/.test(line) && !/^\s*l\.\d+/.test(line)) continue;

    // The `!` line itself is the engine's own diagnosis and is preferred; the
    // lines after it are the offending source, which may be file content.
    errors.push(clipLine(line));
    for (let j = i + 1; j < Math.min(i + 1 + LOG_CONTEXT_LINES, lines.length); j++) {
      const following = lines[j]!;
      if (following.trim().length > 0) context.push(clipLine(following));
    }
    i += LOG_CONTEXT_LINES;
  }

  // Nothing matched: the tail is where an engine that died quietly says why.
  const picked =
    errors.length > 0
      ? [...errors, '', ...context]
      : lines.slice(-LOG_TAIL_LINES).map(clipLine);

  const summary = picked.join('\n').trim();
  const cap = Math.max(0, Math.min(maxChars, LOG_MAX_CHARS));
  return summary.length > cap ? `${summary.slice(0, cap)}\n… log truncated` : summary;
}

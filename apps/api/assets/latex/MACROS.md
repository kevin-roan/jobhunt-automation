# deedy-resume-openfont — macro reference

Every resume in this system is a LaTeX document using the class
`deedy-resume-openfont`, compiled with XeLaTeX (or LuaLaTeX / Tectonic). This
file is the complete authoring surface: it is shown in the editor and injected
verbatim into the prompts the local model receives, so it doubles as the
contract the model must write against.

## Document skeleton

```latex
\documentclass{deedy-resume-openfont}
\begin{document}
\cvmeta{Full Name}{Target Role}          % fills the PDF metadata ATS parsers read
\namesection{First}{Last}{Target Role}
\linksline{City \sep \href{mailto:a@b.c}{a@b.c} \sep \href{https://x}{x}}
\section{Summary}
...
\end{document}
```

The `\cvtheme{...}` line, when present, sits between `\documentclass` and
`\begin{document}`. The renderer writes it from the stored theme, so a document
that omits it still compiles.

## Structure

| Macro | Purpose |
| --- | --- |
| `\section{Name}` | Uppercase section heading with a rule under it |
| `\entryline{left}{right}` | One row: title flush left, dates/links flush right |
| `\runsubsection{Employer}` | Employer or project name, semibold |
| `\descript{Job title or tech stack}` | Slanted secondary line |
| `\location{Dates or place}` | Muted right-hand text |
| `\entrysep` | Vertical gap between two entries |
| `\sectionsep` | Larger gap, between blocks |
| `\skillrow{Category}{values}` | Two-column skills row |
| `\begin{tightemize} \item ... \end{tightemize}` | Tight bullet list |

## Inline

| Macro | Purpose |
| --- | --- |
| `\custombold{text}` | Emphasis for a technology or a metric |
| `\customitalic{text}` | Slanted emphasis |
| `\accenttext{text}` | Emphasis in the theme's accent colour |
| `\sep` | Vertical-bar separator inside a links or tech line |
| `\href{url}{label}` | Link; the label is what a text extractor sees |
| `\lastupdated` | "Last updated <date>" in the top-right corner |

## Rules that matter

- Escape `&`, `%`, `$`, `#`, `_`, `{`, `}` as `\&`, `\%`, `\$`, `\#`, `\_`,
  `\{`, `\}`. An unescaped `%` silently swallows the rest of the line.
- Never `\usepackage` anything: the class already loads geometry, xcolor,
  hyperref, titlesec, fontspec, enumitem, tabularx and microtype.
- Never use `\input`, `\include`, `\write18`, or absolute paths. The renderer
  rejects those documents before they reach the engine.
- Keep to one or two pages. Everything is single-column; there is no float
  environment and no `\newpage` in normal use.
- Bullets belong in `tightemize`, never in a bare `itemize` — the class only
  tunes the spacing of the former.

## Theme keys (`\cvtheme{key=value, ...}`)

| Key | Values |
| --- | --- |
| `font` | `raleway`, `sourcesans`, `fira`, `garamond`, `latinmodern` |
| `primary`, `headings`, `subheadings`, `date`, `rule`, `accent` | six hex digits, no `#` |
| `bodysize`, `bodyleading`, `namesize`, `nameleading`, `taglinesize`, `taglineleading`, `metasize`, `metaleading`, `sectionsize`, `sectionleading`, `subsize`, `subleading`, `smallsize`, `smallleading` | bare point numbers |
| `tracking`, `nametracking` | letterspacing, bare numbers |
| `sectiongap`, `sectionafter`, `entrygap`, `itemsep`, `listtopsep`, `skillwidth`, `skillgap` | TeX lengths, e.g. `9pt`, `3.3cm` |
| `hmargin`, `vmargin` | page margins, e.g. `1.45cm` |

The editor never asks a model to write this line by hand: it stores a small
theme object (font, palette, base size, density, margins) and expands it into
the full key list. Density and base size drive every size and gap above, so
changing one value rescales the document consistently.

-- The resume_tailoring prompt is rewritten to protect the candidate's history.
--
-- The old wording opened with "Rewrite this resume" and explicitly licensed
-- rewording the experience bullets; the word "project" never appeared in it at
-- all. The new wording confines every edit to the summary and the skills rows
-- and requires the experience and projects sections to be reproduced verbatim,
-- which is what the preservation check in latex.utils.ts then enforces on the
-- document that comes back.
--
-- Editing prompts.ts alone would not reach an existing install: llm.service.ts
-- prefers the active row in this table over the built-in default, and the
-- seeded 'built-in' row is what the prompt editor shows and copies from. So the
-- seeded row is rewritten in place. A template the user authored themselves
-- (any name other than 'built-in') is left alone -- that one is theirs.

UPDATE prompt_templates
SET system = 'You tailor resumes truthfully and you write LaTeX for the deedy-resume-openfont document class. You never fabricate experience, employers, dates, projects, or credentials, and you never rewrite the candidate''s history — you copy it across verbatim. Respond with a single JSON object that conforms exactly to the provided schema. Do not include markdown fences, comments, or any prose outside the JSON object.',
    user = 'Reproduce this resume as a complete LaTeX document, retargeting ONLY its
summary and skills at the job below. This is a copy-and-retarget task, not a
rewrite: the candidate''s history is evidence and is transcribed, not authored.

# Output
"latex" must be a COMPLETE, compilable document for the deedy-resume-openfont
class: it starts with \documentclass{deedy-resume-openfont} and ends with
\end{document}. Not a fragment, not a diff, not Markdown.

# What you may change — and nothing else
- The summary / objective / profile section: rewrite it freely, using only facts
  already present elsewhere in the source resume.
- The skills / technologies / keywords rows: reorder them, regroup them, and
  lead with the posting''s terms that the source resume ALREADY evidences.

# What must be reproduced VERBATIM
- The ENTIRE experience section: every entry AND every bullet under it, copied
  character for character, in the source order.
- The ENTIRE projects section: every project, its description line AND every
  bullet under it, copied character for character, in the source order.
- The header, education, and certifications blocks.
Copy these across unchanged. Do not delete, drop, merge, split, reorder,
summarise, reword, retitle or invent any entry or bullet inside them — not to
save space, not to echo the posting''s vocabulary, not to improve the phrasing.
A bullet you find awkward still ships exactly as written. The output is checked
against the source and is DISCARDED in full if a single entry differs.

# Truthfulness rules
- Keep every employer, job title, project name and date exactly as written.
- Never add a skill, tool, achievement, or credential not present in the source.
- The terms listed as lacking below are absent from this candidate''s history.
  Never claim them, anywhere in the document, in any wording.
- To shorten, cut or tighten existing content; never replace it with invention.
- List in injectedKeywords only the posting terms you were able to use truthfully.

# LaTeX rules
- Use only the macros in the macro reference below.
- Escape the characters &, %, $, #, _ and braces as \&, \%, \$, \#, \_, \{, \}.
  An unescaped % silently swallows the rest of the line.
- Never write \usepackage: the class already loads everything it needs.
- Never write \input, \include, \write18, or an absolute path.
- No \newpage. One or two pages is preferred, but length is the LOWEST priority
  here: never drop or trim an experience or project entry to reach it.
- Do not emit a \cvtheme line; the renderer writes it from the stored theme.

# Macro reference
{{macros}}

# Target job
Title: {{title}}
Company: {{company}}

## Job description
{{description}}

## Keywords the resume already evidences — prioritise these when truthful
{{keywords}}

## Terms the candidate lacks — do NOT claim these
{{missingKeywords}}

# Source resume (LaTeX)
{{resume}}',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE task = 'resume_tailoring' AND name = 'built-in';

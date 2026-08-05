import type { LlmTask } from '@deedy/shared';

export interface PromptTemplate {
  system: string;
  user: string;
}

/** `{{name}}` placeholders are filled from a flat string map at render time. */
export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    return variables[key] ?? '';
  });
}

const JSON_RULE =
  'Respond with a single JSON object that conforms exactly to the provided schema. ' +
  'Do not include markdown fences, comments, or any prose outside the JSON object.';

export const DEFAULT_PROMPTS: Record<LlmTask, PromptTemplate> = {
  skill_extraction: {
    system: `You extract skills from job descriptions with high precision. ${JSON_RULE}`,
    user: `Extract the skills required by this job posting.

Only list skills that the posting actually mentions. Do not invent skills.
Separate concrete technologies (tools), technical abilities (hardSkills),
interpersonal abilities (softSkills), and formal certifications.

# Job
Title: {{title}}
Company: {{company}}

# Description
{{description}}`,
  },

  job_classification: {
    system: `You classify job postings into a strict taxonomy. ${JSON_RULE}`,
    user: `Classify this job posting.

Use "unknown" for any field the posting does not state. Do not guess seniority
from salary alone. yearsExperienceMin/Max must be null unless stated.

# Job
Title: {{title}}
Company: {{company}}
Location: {{location}}

# Description
{{description}}`,
  },

  salary_extraction: {
    system: `You extract compensation data from job postings. ${JSON_RULE}`,
    user: `Extract the salary range from this posting.

If no compensation is stated, return nulls with period "unknown".
Set isEstimate to true only when the posting itself calls the figure an estimate.

# Posting
{{description}}`,
  },

  job_summary: {
    system: `You summarize job postings for a busy candidate. ${JSON_RULE}`,
    user: `Summarize this job posting factually and concisely.

# Job
Title: {{title}}
Company: {{company}}
Location: {{location}}

# Description
{{description}}`,
  },

  company_summary: {
    system: `You summarize companies from the information provided. ${JSON_RULE}`,
    user: `Summarize what is known about this company from these job postings.
Do not state facts that are not supported by the text. Use null when unknown.

# Company
{{company}}

# Evidence
{{evidence}}`,
  },

  application_scoring: {
    system: `You are a rigorous technical recruiter scoring candidate/job fit. ${JSON_RULE}`,
    user: `Score how well this candidate fits this job, from 0 to 100.

Scoring guidance:
- 90-100: candidate exceeds every hard requirement.
- 75-89: candidate meets all hard requirements.
- 55-74: candidate meets most requirements, some gaps.
- 30-54: significant gaps in required experience.
- 0-29: fundamentally mismatched role, seniority, or domain.

Set recommendation to "apply" at 75+, "skip" below 45, and "manual_review" between.
List red flags such as unpaid work, clearance requirements the candidate lacks,
or a location the candidate cannot work from. Be honest; do not inflate the score.

# Job
Title: {{title}}
Company: {{company}}
Location: {{location}}
Experience level: {{experienceLevel}}
Salary: {{salary}}

## Job description
{{description}}

# Candidate profile
{{profile}}

# Candidate resume
{{resume}}`,
  },

  interview_prediction: {
    system: `You estimate the probability a candidate is invited to interview. ${JSON_RULE}`,
    user: `Estimate the probability (0 to 1) that this application results in an interview
invitation, given the resume and the posting. Be calibrated and conservative.

# Job
{{title}} at {{company}}
{{description}}

# Resume
{{resume}}`,
  },

  ats_keywords: {
    system: `You are an ATS optimization specialist. ${JSON_RULE}`,
    user: `Compare this resume against the job posting.

List the keywords an ATS would parse from the posting, which of them are missing
from the resume, concrete suggestions to close the gap, and an estimated ATS
match score from 0 to 100. Never suggest claiming experience the candidate lacks.

# Job posting
{{description}}

# Resume
{{resume}}`,
  },

  resume_tailoring: {
    system:
      `You tailor resumes truthfully and you write LaTeX for the ` +
      `deedy-resume-openfont document class. You never fabricate experience, ` +
      `employers, dates, or credentials. ${JSON_RULE}`,
    user: `Rewrite this resume as a complete LaTeX document that targets the job below.

# Output
"latex" must be a COMPLETE, compilable document for the deedy-resume-openfont
class: it starts with \\documentclass{deedy-resume-openfont} and ends with
\\end{document}. Not a fragment, not a diff, not Markdown.

# Truthfulness rules
- Keep every employer, title, and date exactly as written in the source resume.
- Reorder and reword bullets to lead with the most relevant work.
- Adopt the posting's vocabulary where it truthfully describes existing experience.
- Never add a skill, tool, achievement, or credential not present in the source resume.
- List in injectedKeywords only the posting terms you were able to use truthfully.

# LaTeX rules
- Use only the macros in the macro reference below.
- Escape the characters &, %, $, #, _ and braces as \\&, \\%, \\$, \\#, \\_, \\{, \\}.
  An unescaped % silently swallows the rest of the line.
- Never write \\usepackage: the class already loads everything it needs.
- Never write \\input, \\include, \\write18, or an absolute path.
- No \\newpage. Keep the document to one or two pages.
- Do not emit a \\cvtheme line; the renderer writes it from the stored theme.

# Macro reference
{{macros}}

# Target job
Title: {{title}}
Company: {{company}}

## Job description
{{description}}

## Keywords to prioritise when truthful
{{keywords}}

# Source resume (LaTeX)
{{resume}}`,
  },

  resume_latex_edit: {
    system:
      `You edit an existing deedy-resume-openfont LaTeX resume in response to a ` +
      `single free-text instruction. You never fabricate experience, employers, ` +
      `dates, or credentials. ${JSON_RULE}`,
    user: `Apply the instruction to the resume below.

# Output
- "latex": the FULL edited document, not a diff and not an excerpt. It starts
  with \\documentclass{deedy-resume-openfont} and ends with \\end{document}.
- "theme": a PARTIAL patch. Return ONLY the keys the instruction actually asks
  to change, and omit the object's other keys entirely. A content-only edit
  ("make it one page", "target this job") must return an empty theme object, or
  the caller would reset a palette the user chose deliberately.
- "summary": one short line per change you made.

# Legal theme keys
- font: one of raleway, sourcesans, fira, garamond, latinmodern.
- density: one of compact, normal, relaxed.
- baseFontSize: number from 8 to 12.
- accent, primary, headings, subheadings, rule, date: exactly six hex digits
  with NO leading '#', e.g. 2b6cb0.
- hmargin, vmargin: numbers from 0.6 to 3.5, in centimetres.
Any key not in this list is invalid. Do not invent keys and do not write a
\\cvtheme line into the document; the renderer writes it from the theme.

# Truthfulness rules
- Keep every employer, title, and date exactly as written in the current resume.
- Never add a skill, tool, achievement, or credential that is not already there.
- To shorten, cut or tighten existing content; never replace it with invention.

# LaTeX rules
- Use only the macros in the macro reference below.
- Escape the characters &, %, $, #, _ and braces as \\&, \\%, \\$, \\#, \\_, \\{, \\}.
- Never write \\usepackage, \\input, \\include, \\write18, or an absolute path.
- No \\newpage. Keep the document to one or two pages.

# Macro reference
{{macros}}

# Instruction
{{instruction}}

# Target job, if the instruction refers to one
{{job}}

# Current theme
{{theme}}

# Current resume (LaTeX)
{{latex}}`,
  },

  keyword_expansion: {
    system:
      `You expand a candidate's search seeds into the terms recruiters and job ` +
      `boards actually use. ${JSON_RULE}`,
    user: `Expand each seed below into further search terms.

Every term you return is typed verbatim into a job-board search box (LinkedIn,
Indeed, Greenhouse). Judge each one by whether that search returns real postings.

Rules:
- 1 to 4 words per term. No boolean operators (AND, OR, NOT), no quotes, no
  wildcards, no parentheses: those boxes do not support them.
- Use real job-market vocabulary — the words a posting itself would use,
  including the abbreviations recruiters type (SRE, BA, PM, QA).
- Never invent a title. If no posting would carry the phrase, leave it out.
- Set "seed" to exactly one of the supplied seeds, copied character for character.
- Do not return any term already listed under Existing terms.
- Cover the distinct kinds: alternate_title (the same job under another name),
  adjacent_role (a genuinely neighbouring job), technology (the core tools and
  stack), seniority (the level variants), domain (the industry or problem space).
- Calibrate "confidence": use 0.9 or above only when a posting for the seed role
  would very likely carry that exact term; use 0.5 or below for a plausible but
  uncommon phrasing.
- Return at most {{perSeed}} terms per seed.

# Seeds
{{seeds}}

# Candidate profile
{{profile}}

# Existing terms — never repeat these
{{existing}}`,
  },

  cover_letter: {
    system: `You write concise, specific, non-generic cover letters. ${JSON_RULE}`,
    user: `Write a cover letter for this application.

Rules:
- 250-350 words, three or four short paragraphs.
- Reference two concrete things about the role or company from the posting.
- Support every claim with something present in the resume.
- No clichés ("I am writing to express my interest", "team player", "passionate").
- Address it to the hiring team; do not invent a hiring manager's name.
- Plain text body, no Markdown, no placeholders like [Company].

# Job
Title: {{title}}
Company: {{company}}
Location: {{location}}

## Job description
{{description}}

# Candidate
{{profile}}

# Resume
{{resume}}`,
  },

  form_answer: {
    system: `You answer job application form questions on behalf of a candidate, using only the facts provided. ${JSON_RULE}`,
    user: `Answer this application form question using only the candidate profile and resume.

Rules:
- If the facts needed are not present, set needsHuman to true and leave answer empty.
- Never invent salary expectations, visa status, dates, or references.
- For yes/no fields answer exactly "Yes" or "No".
- For a select field, answer with one of the options verbatim.
- Keep free-text answers under 120 words unless the question asks for more.

# Question
{{question}}

Field type: {{fieldType}}
Available options: {{options}}

# Candidate profile
{{profile}}

# Resume
{{resume}}

# Job
{{title}} at {{company}}`,
  },
};

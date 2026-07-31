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
    system: `You tailor resumes truthfully. You never fabricate experience, employers, dates, or credentials. ${JSON_RULE}`,
    user: `Rewrite this resume in Markdown so it targets the job below.

Rules:
- Keep every employer, title, and date exactly as written in the source resume.
- Reorder and reword bullets to lead with the most relevant work.
- Adopt the posting's vocabulary where it truthfully describes existing experience.
- Never add a skill, tool, or achievement not present in the source resume.
- Preserve Markdown structure with headings and bullet lists.
- Keep it to a maximum of two pages of content.

# Target job
Title: {{title}}
Company: {{company}}

## Job description
{{description}}

## Keywords to prioritise when truthful
{{keywords}}

# Source resume (Markdown)
{{resume}}`,
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

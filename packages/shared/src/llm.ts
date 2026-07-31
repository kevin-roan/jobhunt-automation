import { z } from 'zod';
import {
  employmentTypeSchema,
  experienceLevelSchema,
  recommendationSchema,
  remoteTypeSchema,
} from './enums.js';

/**
 * Every LLM task declares a Zod schema. The schema is both the runtime validator
 * and the source of the JSON Schema sent to the model, so a task can never be
 * added without structured-output validation.
 */

export const skillExtractionSchema = z.object({
  hardSkills: z.array(z.string().min(1)).max(60),
  softSkills: z.array(z.string().min(1)).max(30),
  tools: z.array(z.string().min(1)).max(60),
  certifications: z.array(z.string().min(1)).max(20),
});
export type SkillExtraction = z.infer<typeof skillExtractionSchema>;

export const jobClassificationSchema = z.object({
  category: z.string().min(1),
  seniority: experienceLevelSchema,
  employmentType: employmentTypeSchema,
  remoteType: remoteTypeSchema,
  yearsExperienceMin: z.number().int().min(0).max(50).nullable(),
  yearsExperienceMax: z.number().int().min(0).max(50).nullable(),
  requiresSecurityClearance: z.boolean(),
  isManagementRole: z.boolean(),
});
export type JobClassification = z.infer<typeof jobClassificationSchema>;

export const salaryExtractionSchema = z.object({
  currency: z.string().max(8).nullable(),
  min: z.number().min(0).nullable(),
  max: z.number().min(0).nullable(),
  period: z.enum(['hour', 'day', 'week', 'month', 'year', 'unknown']),
  isEstimate: z.boolean(),
});
export type SalaryExtraction = z.infer<typeof salaryExtractionSchema>;

export const applicationScoringSchema = z.object({
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  matchedSkills: z.array(z.string()).max(40),
  missingSkills: z.array(z.string()).max(40),
  reasoning: z.string().min(1).max(4000),
  recommendation: recommendationSchema,
  redFlags: z.array(z.string()).max(20),
});
export type ApplicationScoring = z.infer<typeof applicationScoringSchema>;

export const interviewPredictionSchema = z.object({
  interviewProbability: z.number().min(0).max(1),
  rationale: z.string().max(2000),
  strengthenBy: z.array(z.string()).max(15),
});
export type InterviewPrediction = z.infer<typeof interviewPredictionSchema>;

export const jobSummarySchema = z.object({
  headline: z.string().min(1).max(200),
  summary: z.string().min(1).max(2500),
  responsibilities: z.array(z.string()).max(20),
  requirements: z.array(z.string()).max(20),
  benefits: z.array(z.string()).max(20),
});
export type JobSummary = z.infer<typeof jobSummarySchema>;

export const companySummarySchema = z.object({
  name: z.string().min(1),
  industry: z.string().nullable(),
  sizeEstimate: z.string().nullable(),
  summary: z.string().max(2500),
  culturePoints: z.array(z.string()).max(15),
});
export type CompanySummary = z.infer<typeof companySummarySchema>;

export const atsKeywordSchema = z.object({
  keywords: z.array(z.string()).max(60),
  missingFromResume: z.array(z.string()).max(60),
  suggestions: z.array(z.string()).max(30),
  estimatedAtsScore: z.number().min(0).max(100),
});
export type AtsKeywords = z.infer<typeof atsKeywordSchema>;

export const resumeTailoringSchema = z.object({
  markdown: z.string().min(50),
  changeSummary: z.array(z.string()).max(30),
  injectedKeywords: z.array(z.string()).max(60),
});
export type ResumeTailoring = z.infer<typeof resumeTailoringSchema>;

export const coverLetterSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(100),
  tone: z.string().max(60),
});
export type CoverLetterOutput = z.infer<typeof coverLetterSchema>;

export const formAnswerSchema = z.object({
  answer: z.string().max(4000),
  confidence: z.number().min(0).max(1),
  needsHuman: z.boolean(),
});
export type FormAnswer = z.infer<typeof formAnswerSchema>;

export const LLM_OUTPUT_SCHEMAS = {
  skill_extraction: skillExtractionSchema,
  job_classification: jobClassificationSchema,
  salary_extraction: salaryExtractionSchema,
  application_scoring: applicationScoringSchema,
  interview_prediction: interviewPredictionSchema,
  job_summary: jobSummarySchema,
  company_summary: companySummarySchema,
  ats_keywords: atsKeywordSchema,
  resume_tailoring: resumeTailoringSchema,
  cover_letter: coverLetterSchema,
  form_answer: formAnswerSchema,
} as const;

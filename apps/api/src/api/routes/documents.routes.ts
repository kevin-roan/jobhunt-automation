import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  assistResumeResultSchema,
  assistResumeSchema,
  compileResumeResultSchema,
  compileResumeSchema,
  coverLetterDtoSchema,
  createResumeSchema,
  resumeDtoSchema,
  resumeTemplateSchema,
  updateResumeSchema,
} from '@deedy/shared';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import type { Container } from '../../core/container.js';
import { toCoverLetterDto, toResumeDto } from '../../repositories/resume.repository.js';
import { commonErrors, idParamSchema, okSchema, type ApiInstance } from '../types.js';

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.md': 'text/markdown; charset=utf-8',
  '.tex': 'application/x-tex; charset=utf-8',
  '.png': 'image/png',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
};

export async function documentRoutes(app: ApiInstance, container: Container): Promise<void> {
  const { resumes, coverLetters, applications } = container.repositories;
  const dataRoot = path.resolve(container.config.paths.root);

  /** Guards against path traversal: only files inside DATA_DIR are servable. */
  const assertInsideDataDir = (filePath: string): string => {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(dataRoot + path.sep) && resolved !== dataRoot) {
      throw new ValidationError('Refusing to serve a file outside the data directory');
    }
    if (!existsSync(resolved)) throw new NotFoundError('File', path.basename(resolved));
    return resolved;
  };

  app.get(
    '/resumes',
    {
      schema: {
        tags: ['resumes'],
        summary: 'List resumes, including AI-generated versions',
        querystring: z.object({ includeGenerated: z.coerce.boolean().default(true) }),
        response: { 200: z.object({ resumes: z.array(resumeDtoSchema) }), ...commonErrors },
      },
    },
    async (request) => ({
      resumes: resumes.list(request.query.includeGenerated).map(toResumeDto),
    }),
  );

  // Registered BEFORE `GET /resumes/:id` or Fastify will match "template" as an
  // id — `idParamSchema` coerces to a number so it would 400 instead of 404.
  app.get(
    '/resumes/template',
    {
      schema: {
        tags: ['resumes'],
        summary: 'Starter LaTeX document, default theme and macro cheatsheet',
        description:
          "Everything the editor needs for a blank slate, plus the host's resolved LaTeX engine (null when none is installed).",
        response: { 200: resumeTemplateSchema, ...commonErrors },
      },
    },
    async () => container.services.latex.template(),
  );

  app.post(
    '/resumes/compile',
    {
      // The global limit is 16MB, sized for uploads. This route hands its body
      // to a TeX engine and takes no authentication, so it gets a limit sized
      // for a resume instead: the schema already caps `latex` at 400k, and
      // rejecting at the socket costs less than parsing 16MB to reject at zod.
      bodyLimit: 1024 * 1024,
      schema: {
        tags: ['resumes'],
        summary: 'Compile LaTeX to a preview PDF without saving it',
        description:
          'Drives the editor live preview; nothing is persisted. A failed compile is a 200 with `ok:false` and the engine log, not an error status — the editor renders the log.',
        body: compileResumeSchema,
        response: { 200: compileResumeResultSchema, ...commonErrors },
      },
    },
    async (request) => container.services.latex.compilePreview(request.body),
  );

  // Also before `/resumes/:id`: literal segments must beat the parameterised one.
  app.get(
    '/resumes/preview/:previewId',
    {
      schema: {
        tags: ['resumes'],
        summary: 'Stream a compiled preview PDF',
        params: z.object({ previewId: z.string().min(1).max(100) }),
      },
    },
    async (request, reply) => {
      const previewPath = container.services.latex.previewPath(request.params.previewId);
      if (!previewPath) throw new NotFoundError('Resume preview', request.params.previewId);

      const resolved = assertInsideDataDir(previewPath);
      // Displayed in an `<iframe>` by the editor, so inline rather than attachment.
      return reply
        .type('application/pdf')
        .header('content-disposition', 'inline')
        .send(createReadStream(resolved));
    },
  );

  app.get(
    '/resumes/:id',
    {
      schema: {
        tags: ['resumes'],
        summary: 'Read one resume',
        params: idParamSchema,
        response: { 200: resumeDtoSchema, ...commonErrors },
      },
    },
    async (request) => {
      const row = resumes.byId(request.params.id);
      if (!row) throw new NotFoundError('Resume', request.params.id);
      return toResumeDto(row);
    },
  );

  app.post(
    '/resumes',
    {
      schema: {
        tags: ['resumes'],
        summary: 'Create a resume from LaTeX and render its PDF and DOCX',
        body: createResumeSchema,
        response: { 201: resumeDtoSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const created = await container.services.resumes.create(request.body);
      return reply.status(201).send(toResumeDto(created));
    },
  );

  app.patch(
    '/resumes/:id',
    {
      schema: {
        tags: ['resumes'],
        summary: 'Update a resume',
        description:
          'Changing the LaTeX or the theme creates a new version rather than editing in place.',
        params: idParamSchema,
        body: updateResumeSchema,
        response: { 200: resumeDtoSchema, ...commonErrors },
      },
    },
    async (request) => toResumeDto(await container.services.resumes.update(request.params.id, request.body)),
  );

  app.delete(
    '/resumes/:id',
    {
      schema: {
        tags: ['resumes'],
        summary: 'Delete a resume version',
        params: idParamSchema,
        response: { 200: okSchema, ...commonErrors },
      },
    },
    async (request) => {
      resumes.delete(request.params.id);
      return { ok: true as const };
    },
  );

  app.post(
    '/resumes/:id/tailor',
    {
      schema: {
        tags: ['resumes'],
        summary: 'Generate a job-specific version of a resume',
        params: idParamSchema,
        body: z.object({
          jobId: z.number().int().positive(),
          force: z.boolean().default(false),
          immediate: z.boolean().default(true),
        }),
        response: {
          200: z.object({
            resume: resumeDtoSchema.nullable(),
            queueJobId: z.number().int().nullable(),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      if (!request.body.immediate) {
        const queued = container.repositories.queue.enqueue({
          task: 'resume.tailor',
          payload: {
            jobId: request.body.jobId,
            baseResumeId: request.params.id,
            force: request.body.force,
          },
          dedupeKey: `resume.tailor:${request.body.jobId}:${request.params.id}`,
          priority: 6,
        });
        return { resume: null, queueJobId: queued.id };
      }

      const tailored = await container.services.resumes.tailorForJob({
        jobId: request.body.jobId,
        baseResumeId: request.params.id,
        force: request.body.force,
      });
      return { resume: toResumeDto(tailored), queueJobId: null };
    },
  );

  app.post(
    '/resumes/:id/assist',
    {
      schema: {
        tags: ['resumes'],
        summary: 'Edit a resume with a free-text instruction',
        description:
          'Runs the local model over the document and returns the edited LaTeX without saving it; POST the result back to persist. Can take a while on CPU inference.',
        params: idParamSchema,
        body: assistResumeSchema,
        response: { 200: assistResumeResultSchema, ...commonErrors },
      },
    },
    async (request) => container.services.resumes.assist(request.params.id, request.body),
  );

  app.get(
    '/resumes/:id/download',
    {
      schema: {
        tags: ['resumes'],
        summary: 'Download a rendered resume',
        params: idParamSchema,
        querystring: z.object({ format: z.enum(['pdf', 'docx', 'txt', 'tex']).default('pdf') }),
      },
    },
    async (request, reply) => {
      const row = resumes.byId(request.params.id);
      if (!row) throw new NotFoundError('Resume', request.params.id);

      // The plain-text mirror is derived from the LaTeX on every render and kept
      // in the row rather than on disk, so it is served from the column instead
      // of streamed. It is what an ATS parser and the scoring prompt actually
      // see, which makes it worth exposing on its own.
      if (request.query.format === 'txt') {
        return reply
          .type('text/plain; charset=utf-8')
          .header('content-disposition', `attachment; filename="resume-v${row.version}.txt"`)
          .send(row.markdown);
      }

      const target = {
        pdf: row.pdfPath,
        docx: row.docxPath,
        tex: row.texPath,
      }[request.query.format];
      if (!target) {
        throw new NotFoundError(`Rendered ${request.query.format} for resume`, request.params.id);
      }

      const resolved = assertInsideDataDir(target);
      const extension = path.extname(resolved).toLowerCase();
      return reply
        .type(CONTENT_TYPES[extension] ?? 'application/octet-stream')
        .header(
          'content-disposition',
          `attachment; filename="${path.basename(resolved).replace(/"/g, '')}"`,
        )
        .send(createReadStream(resolved));
    },
  );

  app.get(
    '/cover-letters',
    {
      schema: {
        tags: ['cover-letters'],
        summary: 'List generated cover letters',
        querystring: z.object({
          jobId: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
        response: {
          200: z.object({ coverLetters: z.array(coverLetterDtoSchema) }),
          ...commonErrors,
        },
      },
    },
    async (request) => ({
      coverLetters: (request.query.jobId
        ? coverLetters.forJob(request.query.jobId)
        : coverLetters.list(request.query.limit)
      ).map(toCoverLetterDto),
    }),
  );

  app.post(
    '/cover-letters',
    {
      schema: {
        tags: ['cover-letters'],
        summary: 'Generate a cover letter for a job',
        body: z.object({
          jobId: z.number().int().positive(),
          resumeId: z.number().int().positive().nullable().optional(),
          regenerate: z.boolean().default(false),
        }),
        response: { 201: coverLetterDtoSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const letter = await container.services.coverLetters.generate({
        jobId: request.body.jobId,
        resumeId: request.body.resumeId ?? null,
        reuseExisting: !request.body.regenerate,
      });
      return reply.status(201).send(toCoverLetterDto(letter));
    },
  );

  app.delete(
    '/cover-letters/:id',
    {
      schema: {
        tags: ['cover-letters'],
        summary: 'Delete a cover letter version',
        params: idParamSchema,
        response: { 200: okSchema, ...commonErrors },
      },
    },
    async (request) => {
      coverLetters.delete(request.params.id);
      return { ok: true as const };
    },
  );

  app.get(
    '/artifacts/:id/file',
    {
      schema: {
        tags: ['applications'],
        summary: 'Download a stored screenshot or HTML snapshot',
        params: idParamSchema,
      },
    },
    async (request, reply) => {
      const row = applications.artifactById(request.params.id);
      if (!row) throw new NotFoundError('Artifact', request.params.id);

      const resolved = assertInsideDataDir(row.path);
      const extension = path.extname(resolved).toLowerCase();
      const stats = statSync(resolved);
      return reply
        .type(CONTENT_TYPES[extension] ?? 'application/octet-stream')
        .header('content-length', String(stats.size))
        .send(createReadStream(resolved));
    },
  );

  app.get(
    '/artifacts/screenshots',
    {
      schema: {
        tags: ['applications'],
        summary: 'Most recent screenshots captured by the browser pipeline',
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(24) }),
        response: {
          200: z.object({
            screenshots: z.array(
              z.object({
                id: z.number().int(),
                applicationId: z.number().int().nullable(),
                jobId: z.number().int().nullable(),
                step: z.string().nullable(),
                createdAt: z.string(),
              }),
            ),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => ({
      screenshots: applications
        .recentArtifacts('screenshot', request.query.limit)
        .map((row) => ({
          id: row.id,
          applicationId: row.applicationId,
          jobId: row.jobId,
          step: row.step,
          createdAt: row.createdAt,
        })),
    }),
  );
}

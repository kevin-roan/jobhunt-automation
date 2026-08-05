import { pipelineControlSchema, pipelineStatusSchema } from '@deedy/shared';
import type { Container } from '../../core/container.js';
import { commonErrors, type ApiInstance } from '../types.js';

export async function pipelineRoutes(app: ApiInstance, container: Container): Promise<void> {
  const { pipeline } = container.services;

  app.get(
    '/pipeline',
    {
      schema: {
        tags: ['queue'],
        summary: 'Current start/stop state of every pipeline stage',
        description:
          'Reports the master switch, the worker and scheduler state, and per-stage pending/in-flight/failed counts, so the dashboard can show exactly which stages are allowed to claim work.',
        response: { 200: pipelineStatusSchema, ...commonErrors },
      },
    },
    async () => pipeline.status(),
  );

  app.post(
    '/pipeline/control',
    {
      schema: {
        tags: ['queue'],
        summary: 'Start or stop the whole pipeline, or a single stage',
        description:
          'Omit "stage" to target the whole pipeline. Stopping with abortInFlight aborts work that is already executing and returns those queue jobs to pending, so nothing is lost — the aborted jobs simply run again once the stage is started. The new state is returned, so the caller never has to re-read /pipeline.',
        body: pipelineControlSchema,
        response: { 200: pipelineStatusSchema, ...commonErrors },
      },
    },
    async (request) => pipeline.control(request.body),
  );
}

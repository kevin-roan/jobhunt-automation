import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { LlmTask, SkillExtraction } from '@deedy/shared';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createLogger } from '../../src/core/logger.js';
import { EventBus } from '../../src/core/events.js';
import { ConfigurationError, LlmError } from '../../src/core/errors.js';
import { SettingsRepository } from '../../src/repositories/settings.repository.js';
import {
  LlmCallRepository,
  PromptTemplateRepository,
} from '../../src/repositories/observability.repository.js';
import { SettingsService } from '../../src/services/settings.service.js';
import { LlmService } from '../../src/services/llm/llm.service.js';

interface OllamaChatRequestBody {
  model: string;
  messages: { role: string; content: string }[];
  stream: boolean;
  options: { temperature: number; num_predict: number };
  format?: Record<string, unknown>;
}

interface RecordedRequest {
  url: string;
  body: OllamaChatRequestBody;
}

const PROMPT_TOKENS = 120;
const COMPLETION_TOKENS = 45;

/** Response bodies the stubbed endpoint hands back, oldest first. */
let responseQueue: string[] = [];
let requests: RecordedRequest[] = [];

function enqueueContent(...contents: string[]): void {
  responseQueue.push(...contents);
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

const fetchMock = vi.fn(
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawBody = typeof init?.body === 'string' ? init.body : '{}';
    requests.push({ url: requestUrl(input), body: JSON.parse(rawBody) as OllamaChatRequestBody });

    const content = responseQueue.shift();
    if (content === undefined) {
      throw new Error('LLM endpoint received more requests than the test enqueued responses');
    }
    return new Response(
      JSON.stringify({
        model: 'test-model',
        message: { role: 'assistant', content },
        prompt_eval_count: PROMPT_TOKENS,
        eval_count: COMPLETION_TOKENS,
        done: true,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  },
);

const VALID_SKILLS: SkillExtraction = {
  hardSkills: ['TypeScript', 'Distributed systems'],
  softSkills: ['Written communication'],
  tools: ['Postgres', 'Playwright'],
  certifications: [],
};

const VARIABLES = {
  title: 'Staff Engineer',
  company: 'REDACTED',
  location: 'Remote',
  description: 'We need TypeScript, Postgres and Playwright experience.',
};

let dir: string;
let handle: DbHandle;
let settingsService: SettingsService;
let llmCalls: LlmCallRepository;
let service: LlmService;

/** All rows for a task, oldest attempt first. */
function callsFor(task: LlmTask) {
  return llmCalls
    .search({ page: 1, pageSize: 50, task })
    .items.slice()
    .sort((a, b) => a.id - b.id);
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'deedy-llm-test-'));
  handle = createDb(path.join(dir, 'test.db'));
  runMigrations(handle.sqlite);

  const logger = createLogger({ level: 'fatal' });
  const events = new EventBus();
  settingsService = new SettingsService(
    new SettingsRepository(handle.db),
    Buffer.alloc(32, 7),
    logger,
    events,
  );
  settingsService.bootstrap();
  settingsService.update({
    llm: {
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'test-model',
      fastModel: '',
      maxRetries: 1,
      requestTimeoutMs: 5000,
      useStructuredOutputs: true,
    },
  });

  llmCalls = new LlmCallRepository(handle.db);
  service = new LlmService(
    settingsService,
    llmCalls,
    new PromptTemplateRepository(handle.db),
    logger,
    events,
  );

  vi.stubGlobal('fetch', fetchMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('LlmService.run', () => {
  it('parses, validates and persists a valid structured response', async () => {
    responseQueue = [];
    requests = [];
    enqueueContent(JSON.stringify(VALID_SKILLS));

    const result = await service.run('skill_extraction', { variables: VARIABLES, jobId: 42 });

    expect(result.data).toEqual(VALID_SKILLS);
    expect(result.model).toBe('test-model');
    expect(result.totalTokens).toBe(PROMPT_TOKENS + COMPLETION_TOKENS);

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.url).toBe('http://localhost:11434/api/chat');
    expect(request?.body.model).toBe('test-model');
    expect(request?.body.stream).toBe(false);
    // Structured outputs are on, so Ollama must receive the JSON schema.
    expect(request?.body.format).toBeTypeOf('object');
    expect(request?.body.messages.map((m) => m.role)).toEqual(['system', 'user']);

    const rows = callsFor('skill_extraction');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.success).toBe(true);
    expect(rows[0]?.attempt).toBe(1);
    expect(rows[0]?.error).toBeNull();
    expect(rows[0]?.promptTokens).toBe(PROMPT_TOKENS);
    expect(rows[0]?.completionTokens).toBe(COMPLETION_TOKENS);
    expect(rows[0]?.totalTokens).toBe(PROMPT_TOKENS + COMPLETION_TOKENS);
    expect(rows[0]?.jobId).toBe(42);
    expect(rows[0]?.id).toBe(result.callId);
  });

  it('retries with corrective feedback after a schema violation and then succeeds', async () => {
    responseQueue = [];
    requests = [];
    // period "fortnight" is not in the enum, so Zod rejects the first attempt.
    enqueueContent(
      JSON.stringify({
        currency: 'USD',
        min: 100,
        max: 200,
        period: 'fortnight',
        isEstimate: false,
      }),
      JSON.stringify({
        currency: 'USD',
        min: 180000,
        max: 220000,
        period: 'year',
        isEstimate: false,
      }),
    );

    const result = await service.run('salary_extraction', { variables: VARIABLES });

    expect(result.data.period).toBe('year');
    expect(result.data.max).toBe(220000);

    expect(requests).toHaveLength(2);
    const retryMessages = requests[1]?.body.messages ?? [];
    expect(retryMessages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    const correction = retryMessages[retryMessages.length - 1]?.content ?? '';
    expect(correction).toContain('That response was rejected');
    expect(correction).toContain('schema validation');

    const rows = callsFor('salary_extraction');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.attempt).toBe(1);
    expect(rows[0]?.success).toBe(false);
    expect(rows[0]?.error).toContain('Output failed schema validation');
    expect(rows[1]?.attempt).toBe(2);
    expect(rows[1]?.success).toBe(true);
    expect(rows[1]?.id).toBe(result.callId);
  });

  it('throws LlmError once maxRetries is exhausted', async () => {
    responseQueue = [];
    requests = [];
    settingsService.update({ llm: { maxRetries: 2 } });
    enqueueContent('not json at all', '{"headline": 12}', 'still nonsense');

    await expect(service.run('job_summary', { variables: VARIABLES })).rejects.toBeInstanceOf(
      LlmError,
    );

    expect(requests).toHaveLength(3);
    const rows = callsFor('job_summary');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.success === false)).toBe(true);

    settingsService.update({ llm: { maxRetries: 1 } });
  });
});

describe('LlmService.resolveModel', () => {
  it('throws ConfigurationError when no model is configured', () => {
    settingsService.update({ llm: { model: '', fastModel: '' } });

    expect(() => service.resolveModel()).toThrow(ConfigurationError);
    expect(() => service.resolveModel(true)).toThrow(ConfigurationError);

    settingsService.update({ llm: { model: 'test-model' } });
  });

  it('prefers the fast model only when useFastModel is set and a fast model exists', () => {
    settingsService.update({ llm: { model: 'main-model', fastModel: 'fast-model' } });
    expect(service.resolveModel(true)).toBe('fast-model');
    expect(service.resolveModel(false)).toBe('main-model');

    settingsService.update({ llm: { fastModel: '' } });
    expect(service.resolveModel(true)).toBe('main-model');

    settingsService.update({ llm: { model: 'test-model' } });
  });
});

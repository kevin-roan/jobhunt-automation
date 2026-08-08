import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { LLM_OUTPUT_SCHEMAS, type LlmTask } from '@deedy/shared';
import { ConfigurationError, LlmError, toErrorMessage } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import { Redactor } from '../../core/redact.js';
import type { EventBus } from '../../core/events.js';
import type { LlmCallRepository, PromptTemplateRepository } from '../../repositories/observability.repository.js';
import type { SettingsService } from '../settings.service.js';
import { createLlmClient, LlmAbortError } from './providers.js';
import { DEFAULT_PROMPTS, renderTemplate } from './prompts.js';
import type { ChatMessage, LlmClient, ModelInfo } from './types.js';

export interface RunTaskOptions {
  /** Placeholder values for the prompt template. */
  variables: Record<string, string>;
  jobId?: number | null;
  applicationId?: number | null;
  /** Prefer the configured fast model for cheap classification-style tasks. */
  useFastModel?: boolean;
  signal?: AbortSignal;
}

export interface LlmTaskResult<T> {
  data: T;
  model: string;
  totalTokens: number | null;
  durationMs: number;
  callId: number;
}

/**
 * Extracts the first balanced JSON object from a model response. Local models
 * frequently wrap JSON in prose or code fences even when asked not to.
 */
export function extractJson(text: string): string {
  // Reasoning models emit a chain-of-thought block first. It routinely contains
  // braces and draft JSON, so it must be removed before scanning or we parse
  // the model's scratch work instead of its answer.
  const withoutThinking = text
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, ' ')
    // An unterminated block means generation stopped mid-thought.
    .replace(/<think(?:ing)?>[\s\S]*$/i, ' ');

  const trimmed = withoutThinking.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  const start = candidate.indexOf('{');
  if (start === -1) throw new LlmError('Model response contained no JSON object');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const char = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  throw new LlmError('Model response contained an unterminated JSON object');
}

/**
 * Keywords that grammar-based samplers (llama.cpp, and therefore Ollama and
 * LM Studio) cannot compile cheaply. `maxLength: 4000` expands to a grammar
 * with 4000 alternatives and the server rejects it with
 * "failed to parse grammar", so the constraint is dropped from the decoding
 * hint. Zod still enforces every one of these when the response is validated,
 * so nothing is actually relaxed.
 */
const UNSUPPORTED_GRAMMAR_KEYWORDS = ['minLength', 'maxLength', 'pattern', 'format'] as const;

function stripUnsupportedKeywords(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupportedKeywords);
  if (typeof node !== 'object' || node === null) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if ((UNSUPPORTED_GRAMMAR_KEYWORDS as readonly string[]).includes(key)) continue;
    out[key] = stripUnsupportedKeywords(value);
  }
  return out;
}

export function jsonSchemaFor(task: LlmTask): Record<string, unknown> {
  const schema = LLM_OUTPUT_SCHEMAS[task];
  const converted = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
  delete converted.$schema;
  return stripUnsupportedKeywords(converted) as Record<string, unknown>;
}

/**
 * Runs every LLM task in the system. Each call is schema-constrained, validated
 * against Zod, retried with corrective feedback, and persisted to `llm_calls`.
 */
export class LlmService {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly llmCalls: LlmCallRepository,
    private readonly prompts: PromptTemplateRepository,
    private readonly logger: Logger,
    private readonly events: EventBus,
  ) {
    this.redactor = new Redactor(settingsService);
  }

  /** Inference calls executing right now, maintained by `run()`. */
  private inFlight = 0;

  /**
   * Applied to the `llm_calls` COPY of a prompt only.
   *
   * `userPrompt` is the rendered template, so it physically contains the
   * candidate's email, phone and the entire resume; storing it verbatim turned
   * an audit trail into the most complete PII dump in the database. The model
   * still receives `conversation` untouched - that is the whole point, the
   * tailoring is worthless without the real values - and only what is written
   * to the table is scrubbed.
   */
  private readonly redactor: Redactor;

  /** Inference calls executing right now. The dashboard's stop controls read this. */
  activeCalls(): number {
    return this.inFlight;
  }

  private client(): LlmClient {
    return createLlmClient(this.settingsService.get().llm);
  }

  resolveModel(useFastModel = false): string {
    const llm = this.settingsService.get().llm;
    const model = useFastModel && llm.fastModel.trim() ? llm.fastModel : llm.model;
    if (!model.trim()) {
      throw new ConfigurationError(
        'No LLM model is configured. Choose one under Settings → Local LLM before running AI tasks.',
      );
    }
    return model;
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.client().listModels();
  }

  async health(): Promise<{ reachable: boolean; model: string; error: string | null }> {
    const llm = this.settingsService.get().llm;
    const result = await this.client().health();
    return { ...result, model: llm.model };
  }

  /** Renders the active DB template for a task, falling back to the built-in one. */
  private template(task: LlmTask, variables: Record<string, string>): ChatMessage[] {
    const stored = this.prompts.active(task);
    const fallback = DEFAULT_PROMPTS[task];
    const system = stored?.system ?? fallback.system;
    const user = stored?.user ?? fallback.user;
    return [
      { role: 'system', content: renderTemplate(system, variables) },
      { role: 'user', content: renderTemplate(user, variables) },
    ];
  }

  async run<T extends LlmTask>(
    task: T,
    options: RunTaskOptions,
  ): Promise<LlmTaskResult<z.infer<(typeof LLM_OUTPUT_SCHEMAS)[T]>>> {
    const settings = this.settingsService.get().llm;
    const model = this.resolveModel(options.useFastModel);
    const schema = LLM_OUTPUT_SCHEMAS[task] as z.ZodType<z.infer<(typeof LLM_OUTPUT_SCHEMAS)[T]>>;
    const messages = this.template(task, options.variables);
    const client = this.client();
    const jsonSchema = settings.useStructuredOutputs
      ? { name: task, schema: jsonSchemaFor(task) }
      : undefined;

    let lastError = '';
    const conversation: ChatMessage[] = [...messages];

    for (let attempt = 1; attempt <= settings.maxRetries + 1; attempt += 1) {
      const startedAt = Date.now();
      let response: Awaited<ReturnType<LlmClient['complete']>> | null = null;
      try {
        // Stop pressed between attempts: no further request may be issued.
        if (options.signal?.aborted) throw new LlmAbortError();

        // Counted per attempt, not per task: a retry is one call at a time, so
        // releasing it here keeps the gauge equal to the real concurrent load.
        this.inFlight += 1;
        try {
          response = await client.complete({
            model,
            messages: conversation,
            temperature: settings.temperature,
            maxTokens: settings.maxTokens,
            jsonSchema,
            timeoutMs: settings.requestTimeoutMs,
            signal: options.signal,
          });
        } finally {
          this.inFlight -= 1;
        }

        const parsed: unknown = JSON.parse(extractJson(response.content));
        const validated = schema.parse(parsed);
        const durationMs = Date.now() - startedAt;

        const callId = this.llmCalls.record({
          task,
          provider: settings.provider,
          model: response.model,
          // Redacted at the write, not at the source: `conversation` above is
          // still the real, unredacted text that went to the model.
          systemPrompt: this.redactor.text(conversation[0]?.content ?? ''),
          userPrompt: this.redactor.text(conversation[conversation.length - 1]?.content ?? ''),
          // A tailored resume or a filled answer echoes the profile straight
          // back, so the response is no safer to store than the prompt.
          response: this.redactor.text(response.content),
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          durationMs,
          success: true,
          attempt,
          error: null,
          jobId: options.jobId ?? null,
          applicationId: options.applicationId ?? null,
        });

        this.events.emit('llm.call', {
          task,
          model: response.model,
          success: true,
          totalTokens: response.usage.totalTokens,
        });
        this.logger.debug('llm task succeeded', {
          task,
          model: response.model,
          attempt,
          durationMs,
          totalTokens: response.usage.totalTokens,
        });

        return {
          data: validated,
          model: response.model,
          totalTokens: response.usage.totalTokens,
          durationMs,
          callId,
        };
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        // An abort is the operator's decision, not a model failure; the row says
        // so plainly so the call log does not read as an endpoint problem.
        const aborted = error instanceof LlmAbortError || options.signal?.aborted === true;
        lastError = aborted
          ? 'Cancelled by the operator before the model responded (not a model failure)'
          : error instanceof z.ZodError
            ? `Output failed schema validation: ${JSON.stringify(error.issues).slice(0, 800)}`
            : toErrorMessage(error);

        this.llmCalls.record({
          task,
          provider: settings.provider,
          model,
          systemPrompt: this.redactor.text(conversation[0]?.content ?? ''),
          userPrompt: this.redactor.text(conversation[conversation.length - 1]?.content ?? ''),
          response: this.redactor.nullable(response?.content ?? null),
          promptTokens: response?.usage.promptTokens ?? null,
          completionTokens: response?.usage.completionTokens ?? null,
          totalTokens: response?.usage.totalTokens ?? null,
          durationMs,
          success: false,
          attempt,
          // Schema-validation failures quote the offending output verbatim.
          error: this.redactor.text(lastError),
          jobId: options.jobId ?? null,
          applicationId: options.applicationId ?? null,
        });

        this.events.emit('llm.call', { task, model, success: false, totalTokens: null });

        // Retrying a cancelled call would start the very generation the user
        // asked to stop, so the abort propagates immediately.
        if (aborted) {
          this.logger.info('llm task cancelled', { task, attempt });
          throw error instanceof LlmAbortError ? error : new LlmAbortError();
        }

        this.logger.warn('llm task attempt failed', { task, attempt, error: lastError });

        if (attempt > settings.maxRetries) break;

        // Feed the failure back so the model can correct itself on the next try.
        if (response?.content) {
          conversation.push({ role: 'assistant', content: response.content.slice(0, 4000) });
        }
        conversation.push({
          role: 'user',
          content: `That response was rejected: ${lastError}\n\nReturn only a valid JSON object matching the schema.`,
        });
      }
    }

    throw new LlmError(`LLM task "${task}" failed after ${settings.maxRetries + 1} attempts`, {
      lastError,
    });
  }
}

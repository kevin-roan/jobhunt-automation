import type { LlmProvider, LlmSettings } from '@deedy/shared';
import { LlmError } from '../../core/errors.js';
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  LlmClient,
  ModelInfo,
} from './types.js';

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onAbort);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new LlmError(`LLM endpoint returned ${response.status}: ${text.slice(0, 500)}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new LlmError(`LLM endpoint returned non-JSON body: ${text.slice(0, 300)}`);
    }
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new LlmError(`LLM request timed out after ${timeoutMs}ms`);
    }
    throw new LlmError(
      `Could not reach LLM endpoint at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onAbort);
  }
}

function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey.trim().length > 0) headers.authorization = `Bearer ${apiKey.trim()}`;
  return headers;
}

interface OpenAiChatResponse {
  choices?: { message?: { content?: string | null } }[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface OpenAiModelsResponse {
  data?: { id?: string }[];
}

/**
 * Works with any OpenAI-compatible server: llama.cpp `--server`, LM Studio,
 * vLLM, LocalAI, text-generation-webui, and local OpenRouter-compatible proxies.
 */
export class OpenAiCompatibleClient implements LlmClient {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(settings: LlmSettings, id = 'openai_compatible') {
    this.id = id;
    this.baseUrl = trimTrailingSlash(settings.baseUrl);
    this.apiKey = settings.apiKey;
  }

  private endpoint(path: string): string {
    // Accept base URLs given with or without the /v1 suffix.
    const base = this.baseUrl.endsWith('/v1') ? this.baseUrl : `${this.baseUrl}/v1`;
    return `${base}${path}`;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: false,
    };
    if (request.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: request.jsonSchema.name,
          strict: true,
          schema: request.jsonSchema.schema,
        },
      };
    }

    const payload = (await fetchJson(
      this.endpoint('/chat/completions'),
      { method: 'POST', headers: authHeaders(this.apiKey), body: JSON.stringify(body) },
      request.timeoutMs,
      request.signal,
    )) as OpenAiChatResponse;

    const content = payload.choices?.[0]?.message?.content ?? '';
    return {
      content,
      model: payload.model ?? request.model,
      usage: {
        promptTokens: payload.usage?.prompt_tokens ?? null,
        completionTokens: payload.usage?.completion_tokens ?? null,
        totalTokens: payload.usage?.total_tokens ?? null,
      },
      raw: payload,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const payload = (await fetchJson(
      this.endpoint('/models'),
      { method: 'GET', headers: authHeaders(this.apiKey) },
      15000,
    )) as OpenAiModelsResponse;
    return (payload.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string')
      .map((id) => ({ id, name: id }));
  }

  async health(): Promise<{ reachable: boolean; error: string | null }> {
    try {
      await this.listModels();
      return { reachable: true, error: null };
    } catch (error) {
      return { reachable: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

interface OllamaChatResponse {
  message?: { content?: string };
  model?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaTagsResponse {
  models?: { name?: string; model?: string; size?: number }[];
}

/** Native Ollama client — uses /api/chat so it also supports its `format` schema. */
export class OllamaClient implements LlmClient {
  readonly id = 'ollama';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly disableThinking: boolean;
  /** Flipped once a server rejects the `think` field, so we stop sending it. */
  private thinkFieldRejected = false;

  constructor(settings: LlmSettings) {
    this.baseUrl = trimTrailingSlash(settings.baseUrl);
    this.apiKey = settings.apiKey;
    this.disableThinking = settings.disableThinking;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const buildBody = (withThinkField: boolean): string => {
      const body: Record<string, unknown> = {
        model: request.model,
        messages: request.messages satisfies ChatMessage[],
        stream: false,
        options: {
          temperature: request.temperature,
          num_predict: request.maxTokens,
        },
      };
      if (request.jsonSchema) body.format = request.jsonSchema.schema;
      if (withThinkField) body.think = false;
      return JSON.stringify(body);
    };

    const sendThinkField = this.disableThinking && !this.thinkFieldRejected;

    let payload: OllamaChatResponse;
    try {
      payload = (await fetchJson(
        `${this.baseUrl}/api/chat`,
        { method: 'POST', headers: authHeaders(this.apiKey), body: buildBody(sendThinkField) },
        request.timeoutMs,
        request.signal,
      )) as OllamaChatResponse;
    } catch (error) {
      // Older Ollama builds and non-reasoning models reject `think`. Fall back
      // once, then remember so later calls skip the wasted round trip.
      const message = error instanceof Error ? error.message : String(error);
      if (!sendThinkField || !/think/i.test(message)) throw error;
      this.thinkFieldRejected = true;
      payload = (await fetchJson(
        `${this.baseUrl}/api/chat`,
        { method: 'POST', headers: authHeaders(this.apiKey), body: buildBody(false) },
        request.timeoutMs,
        request.signal,
      )) as OllamaChatResponse;
    }

    const promptTokens = payload.prompt_eval_count ?? null;
    const completionTokens = payload.eval_count ?? null;
    return {
      content: payload.message?.content ?? '',
      model: payload.model ?? request.model,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens:
          promptTokens !== null && completionTokens !== null
            ? promptTokens + completionTokens
            : null,
      },
      raw: payload,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const payload = (await fetchJson(
      `${this.baseUrl}/api/tags`,
      { method: 'GET', headers: authHeaders(this.apiKey) },
      15000,
    )) as OllamaTagsResponse;
    return (payload.models ?? []).map((m) => ({
      id: m.model ?? m.name ?? '',
      name: m.name ?? m.model ?? '',
      sizeBytes: m.size ?? null,
    }));
  }

  async health(): Promise<{ reachable: boolean; error: string | null }> {
    try {
      await this.listModels();
      return { reachable: true, error: null };
    } catch (error) {
      return { reachable: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

const OPENAI_COMPATIBLE: LlmProvider[] = [
  'openai_compatible',
  'llamacpp',
  'lmstudio',
  'openrouter_local',
];

export function createLlmClient(settings: LlmSettings): LlmClient {
  if (settings.provider === 'ollama') return new OllamaClient(settings);
  if (OPENAI_COMPATIBLE.includes(settings.provider)) {
    return new OpenAiCompatibleClient(settings, settings.provider);
  }
  throw new LlmError(`Unsupported LLM provider: ${settings.provider}`);
}

import type { LlmSettings } from '@deedy/shared';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  /** JSON Schema the server should constrain generation to, when supported. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface CompletionUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface CompletionResponse {
  content: string;
  usage: CompletionUsage;
  model: string;
  raw: unknown;
}

export interface ModelInfo {
  id: string;
  name: string;
  sizeBytes?: number | null;
}

/** A local inference backend. Implementations must not require cloud access. */
export interface LlmClient {
  readonly id: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  listModels(): Promise<ModelInfo[]>;
  health(): Promise<{ reachable: boolean; error: string | null }>;
}

export type LlmClientFactory = (settings: LlmSettings) => LlmClient;

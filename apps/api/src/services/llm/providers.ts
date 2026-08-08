import type { LlmProvider, LlmSettings } from '@deedy/shared';
import { ConfigurationError, LlmError } from '../../core/errors.js';
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

/**
 * A request the caller stopped — pressing Stop on the dashboard, not a fault of
 * the model or the endpoint. It is deliberately distinct from a timeout so the
 * retry loop can tell "the user wants the machine back" apart from "that
 * attempt failed, try again"; collapsing the two is what made Stop launch fresh
 * generations instead of ending them.
 */
export class LlmAbortError extends LlmError {
  constructor(message = 'LLM request was cancelled by the caller') {
    super(message);
  }
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<unknown> {
  // Bail before touching the network: an already-stopped caller must never
  // cause a socket to open, or the "cancelled" work simply restarts here.
  if (externalSignal?.aborted) throw new LlmAbortError();

  // One composed signal instead of hand-wired listeners, so the signal handed
  // to fetch is the same object that is already aborted when the caller stops.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, timeoutSignal])
    : timeoutSignal;

  try {
    const response = await fetch(url, { ...init, signal });
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
    // Abort identity is preserved: the caller's stop is reported as an abort,
    // and only a genuine timeout is reported as one.
    if (externalSignal?.aborted) throw new LlmAbortError();
    if (timeoutSignal.aborted) {
      throw new LlmError(`LLM request timed out after ${timeoutMs}ms`);
    }
    throw new LlmError(
      `Could not reach LLM endpoint at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
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
      // A cancelled request is never retried — the fallback would start a second
      // generation on a machine the user just asked to free.
      if (error instanceof LlmAbortError) throw error;
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

/** RFC1918, plus loopback and link-local, in the v4 space. */
function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.');
  if (octets.length !== 4) return false;
  const parts = octets.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  if (parts.some((part) => part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return true; // 127.0.0.0/8 — all of it, not just .0.0.1
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  return false;
}

function isPrivateIpv6(host: string): boolean {
  // `new URL(...).hostname` keeps the brackets on a v6 literal.
  const address = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (address === '::1' || address === '::') return true;

  // IPv4-mapped addresses, judged on the v4 part they carry. Both spellings
  // matter: a user types `::ffff:127.0.0.1`, but WHATWG `URL` normalises the
  // host and hands back the compressed hex form `::ffff:7f00:1`, so checking
  // only the dotted spelling would reject a loopback the user correctly typed.
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (dotted?.[1]) return isPrivateIpv4(dotted[1]);
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (hex?.[1] && hex[2]) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return isPrivateIpv4(
      [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'),
    );
  }
  if (/^fe[89ab][0-9a-f]?:/.test(address)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return true; // fc00::/7 unique local
  return false;
}

/**
 * Whether a base URL's host is one we are willing to call "this machine or its
 * private network" without asking.
 *
 * The rule is deliberately about the *shape of the name*, not a DNS lookup.
 * `createLlmClient` is synchronous and runs on every call, and resolving here
 * would be both a blocking round trip and a TOCTOU illusion — the answer can
 * change between the check and the socket. What this reliably stops is the case
 * that actually happens: someone pastes a hosted provider's URL into the Base
 * URL box and every prompt, with the candidate's full resume in it, silently
 * ships off the host.
 *
 * Accepted:
 *   - `localhost`, `*.localhost`, and any loopback/RFC1918/link-local literal
 *   - `*.local` — mDNS, which by definition only answers on the link
 *   - `*.internal` — covers `host.docker.internal`, which this project's own
 *     install docs tell users to point at a host-side Ollama
 *   - a bare single-label hostname such as `ollama`
 *
 * The single-label case is the interesting one, and this project depends on it:
 * `start.sh` and the compose docs configure `http://ollama:11434`, so rejecting
 * a dotless name would break the shipped configuration on first run. It is also
 * defensible on its own terms. A name with no dot has no registrable public
 * suffix and cannot be resolved by public DNS; it can only be answered by
 * something the operator already controls — `/etc/hosts`, Docker's embedded DNS
 * on a compose network, a Kubernetes service, or the LAN's own resolver. Nobody
 * can buy `ollama` and have it resolve for you.
 *
 * The honest gap: a resolver configured with a search domain can expand a bare
 * `ollama` into `ollama.corp.example.com` and reach off the box. That is a
 * machine whose resolver its owner configured, which is a different threat model
 * from an accidental paste — and anyone who disagrees has `allowRemoteEndpoint`
 * to make the decision explicit in the other direction.
 */
export function isLocalEndpointHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host.length === 0) return false;
  if (host.startsWith('[') || host.includes(':')) return isPrivateIpv6(host);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateIpv4(host);
  // Single-label name: unresolvable by public DNS, so it is somebody's local
  // resolver answering. See the note above.
  return !host.includes('.');
}

/**
 * The single choke point. Every LLM call in the app builds its client here, so
 * refusing a remote endpoint here refuses it everywhere — there is no second
 * path to `fetch` that skips this.
 */
export function assertLocalLlmEndpoint(settings: LlmSettings): void {
  if (settings.allowRemoteEndpoint) return;

  let hostname: string;
  try {
    hostname = new URL(settings.baseUrl).hostname;
  } catch {
    throw new ConfigurationError(
      `The LLM base URL is not a valid URL: ${settings.baseUrl}. Fix it under Settings → Local LLM.`,
    );
  }

  if (isLocalEndpointHost(hostname)) return;

  // The host is named, never the credentials or the rest of the URL.
  throw new ConfigurationError(
    `Refusing to send prompts to "${hostname}" — it is not on this machine or its private network. ` +
      'Prompts contain your name, contact details, full resume and the job description. ' +
      'Point Settings → Local LLM at a local endpoint, or, if you really intend to use a remote ' +
      'one, turn on "Allow remote LLM endpoint" in the same section.',
  );
}

export function createLlmClient(settings: LlmSettings): LlmClient {
  assertLocalLlmEndpoint(settings);
  if (settings.provider === 'ollama') return new OllamaClient(settings);
  if (OPENAI_COMPATIBLE.includes(settings.provider)) {
    return new OpenAiCompatibleClient(settings, settings.provider);
  }
  throw new LlmError(`Unsupported LLM provider: ${settings.provider}`);
}

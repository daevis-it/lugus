import { BuiltPrompt } from './core/prompts';
import { cleanModelOutput } from './core/text';

export type Provider = 'anthropic' | 'openai' | 'ollama' | 'custom';

export interface ResolvedProviderConfig {
  provider: Provider;
  baseUrl: string;
  model: string;
  requiresApiKey: boolean;
}

export interface CompletionRequest {
  config: ResolvedProviderConfig;
  apiKey?: string;
  prompt: BuiltPrompt;
  timeoutMs: number;
  signal?: AbortSignal;
}

const MAX_OUTPUT_TOKENS = 8192;
const ANTHROPIC_API_VERSION = '2026-10-21';

const PROVIDER_DEFAULTS: Record<Exclude<Provider, 'custom'>, { baseUrl: string; model: string }> = {
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-haiku-4-5' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b' }
};

const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

/** Resolves and validates endpoint and model settings for the selected provider. */
export function resolveProviderConfig(
  provider: Provider,
  baseUrlOverride: string,
  modelOverride: string
): ResolvedProviderConfig {
  const url = baseUrlOverride.trim().replace(/\/+$/, '');
  const model = modelOverride.trim();

  if (provider === 'custom') {
    if (!url) {
      throw new Error("Provider is set to 'custom', but 'lugus.baseUrl' is empty.");
    }
    if (!model) {
      throw new Error("Provider is set to 'custom', but 'lugus.model' is empty.");
    }
    return { provider, baseUrl: url, model, requiresApiKey: !LOCAL_URL.test(url) };
  }

  const defaults = PROVIDER_DEFAULTS[provider];
  if (!defaults) {
    throw new Error(`Unknown provider '${provider}'.`);
  }
  const baseUrl = url || defaults.baseUrl;
  return {
    provider,
    baseUrl,
    model: model || defaults.model,
    requiresApiKey: provider !== 'ollama' && !LOCAL_URL.test(baseUrl)
  };
}

/** Catches common API key / provider mismatches before any network call. */
export function validateApiKeyForProvider(provider: Provider, apiKey: string): void {
  if (provider === 'openai' && apiKey.startsWith('sk-ant-')) {
    throw new Error(
      "Detected an Anthropic API key (sk-ant-...) while 'lugus.provider' is 'openai'. Switch the provider to 'anthropic' in Settings."
    );
  }
  if (provider === 'anthropic' && apiKey.startsWith('sk-') && !apiKey.startsWith('sk-ant-')) {
    throw new Error(
      "Detected an OpenAI-style key while 'lugus.provider' is 'anthropic'. Switch the provider to 'openai' or update the API key."
    );
  }
}

/** Sends the prompt and returns clean, dedented code. */
export async function requestCode(req: CompletionRequest): Promise<string> {
  const useAnthropic =
    req.config.provider === 'anthropic' || /(^|\.)anthropic\.com/i.test(hostOf(req.config.baseUrl));
  const raw = useAnthropic ? await callAnthropic(req) : await callOpenAICompatible(req);
  const code = cleanModelOutput(raw);
  if (!code.trim()) {
    throw new Error('The model returned an empty response.');
  }
  return code;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function requestSignal(req: CompletionRequest): AbortSignal {
  const timeout = AbortSignal.timeout(req.timeoutMs);
  return req.signal ? AbortSignal.any([timeout, req.signal]) : timeout;
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const snippet = text.trim().slice(0, 160);
    throw new Error(`Invalid response from the endpoint (HTTP ${response.status})${snippet ? `: ${snippet}` : '.'}`);
  }
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  error?: { message?: string };
}

async function callAnthropic(req: CompletionRequest): Promise<string> {
  const response = await fetch(`${req.config.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': req.apiKey ?? '',
      'anthropic-version': ANTHROPIC_API_VERSION
    },
    signal: requestSignal(req),
    body: JSON.stringify({
      model: req.config.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: req.prompt.system,
      messages: [{ role: 'user', content: req.prompt.user }]
    })
  });

  const data = await readJson<AnthropicResponse>(response);
  if (!response.ok) {
    throw new Error(`Anthropic API error: ${data.error?.message || `HTTP ${response.status}`}`);
  }
  if (data.stop_reason === 'max_tokens') {
    throw new Error('The model output was cut off (token limit). Nothing was changed; split the block into smaller rules.');
  }
  if (data.stop_reason === 'refusal') {
    throw new Error('The model declined this request. Nothing was changed.');
  }
  return (data.content ?? [])
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('');
}

interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  error?: { message?: string };
}

async function callOpenAICompatible(req: CompletionRequest): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (req.apiKey) {
    headers['Authorization'] = `Bearer ${req.apiKey}`;
  }

  const response = await fetch(`${req.config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    signal: requestSignal(req),
    body: JSON.stringify({
      model: req.config.model,
      messages: [
        { role: 'system', content: req.prompt.system },
        { role: 'user', content: req.prompt.user }
      ]
    })
  });

  const data = await readJson<OpenAIResponse>(response);
  if (!response.ok) {
    throw new Error(`API error: ${data.error?.message || `HTTP ${response.status}`}`);
  }
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new Error('The model output was cut off (token limit). Nothing was changed; split the block into smaller rules.');
  }
  return choice?.message?.content ?? '';
}

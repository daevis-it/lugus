export type Provider = 'anthropic' | 'openai' | 'ollama' | 'custom';

export interface ResolvedProviderConfig {
  provider: Provider;
  baseUrl: string;
  model: string;
  requiresApiKey: boolean;
}

export interface TranslationRequest {
  provider: Provider;
  baseUrl: string;
  apiKey?: string;
  model: string;
  language: string;
  prompt: string;
  contextBefore: string;
  contextAfter: string;
  timeoutMs: number;
}

interface OpenAICompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

interface AnthropicMessageResponse {
  content?: Array<{
    type: string;
    text?: string;
  }>;
  error?: {
    message?: string;
  };
}

const PROVIDER_DEFAULTS: Record<Exclude<Provider, 'custom'>, { baseUrl: string; model: string }> = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-haiku-4-5'
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  },
  ollama: {
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5-coder:7b'
  }
};

/**
 * Resolves and validates endpoint and model settings for the selected provider.
 */
export function resolveProviderConfig(
  provider: Provider,
  baseUrlOverride: string,
  modelOverride: string
): ResolvedProviderConfig {
  const trimmedUrl = baseUrlOverride.trim().replace(/\/+$/, '');
  const trimmedModel = modelOverride.trim();

  if (provider === 'custom') {
    if (!trimmedUrl) {
      throw new Error("Provider is set to 'custom', but 'lugus.baseUrl' is empty.");
    }
    if (!trimmedModel) {
      throw new Error("Provider is set to 'custom', but 'lugus.model' is empty.");
    }
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmedUrl);
    return {
      provider,
      baseUrl: trimmedUrl,
      model: trimmedModel,
      requiresApiKey: !isLocal
    };
  }

  const defaults = PROVIDER_DEFAULTS[provider];
  const baseUrl = trimmedUrl || defaults.baseUrl;
  const model = trimmedModel || defaults.model;
  const isLocal =
    provider === 'ollama' ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(baseUrl);

  return {
    provider,
    baseUrl,
    model,
    requiresApiKey: !isLocal
  };
}

/**
 * Catches common API key / provider mismatches before issuing a network call.
 */
export function validateApiKeyForProvider(provider: Provider, apiKey: string): void {
  if (provider === 'openai' && apiKey.startsWith('sk-ant-')) {
    throw new Error(
      "Detected an Anthropic API key (sk-ant-...) while 'lugus.provider' is set to 'openai'. Switch provider to 'anthropic' in Settings."
    );
  }
  if (provider === 'anthropic' && apiKey.startsWith('sk-') && !apiKey.startsWith('sk-ant-')) {
    throw new Error(
      "Detected an OpenAI-style key while 'lugus.provider' is set to 'anthropic'. Switch provider to 'openai' or update your API key."
    );
  }
}

/**
 * Sends the pseudocode instruction and optional local context to either
 * Anthropic's Messages API or any OpenAI-compatible `/chat/completions` endpoint.
 */
export async function translatePseudocode(req: TranslationRequest): Promise<string> {
  const systemPrompt = [
    `You are Lugus, a deterministic translator from natural-language pseudocode to ${req.language}.`,
    `The user's instruction may be written in any human language. Translate its exact logic into idiomatic ${req.language} code.`,
    `Strict rules:`,
    `1. Output ONLY executable ${req.language} code matching the instruction.`,
    `2. Do NOT wrap the output in markdown code fences (\`\`\`), and do NOT include explanations or prose.`,
    `3. Do NOT add imports/using statements or outer class/function wrappers unless explicitly requested.`,
    `4. Start at column 0 (no shared base indentation); preserve only internal block indentation.`,
    `5. Match variable names and coding style from the surrounding local context when provided.`
  ].join('\n');

  const userSections: string[] = [];
  if (req.contextBefore.trim()) {
    userSections.push(`--- CONTEXT BEFORE ---\n${req.contextBefore}`);
  }
  userSections.push(`--- INSTRUCTION (TARGET: ${req.language}) ---\n${req.prompt}`);
  if (req.contextAfter.trim()) {
    userSections.push(`--- CONTEXT AFTER ---\n${req.contextAfter}`);
  }
  const userPrompt = userSections.join('\n\n');

  const useAnthropicProtocol =
    req.provider === 'anthropic' || req.baseUrl.includes('anthropic.com');

  const rawContent = useAnthropicProtocol
    ? await callAnthropic(req, systemPrompt, userPrompt)
    : await callOpenAICompatible(req, systemPrompt, userPrompt);

  return cleanModelOutput(rawContent);
}

async function callAnthropic(
  req: TranslationRequest,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const endpoint = `${req.baseUrl}/messages`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': req.apiKey ?? '',
      'anthropic-version': '2023-06-01'
    },
    signal: AbortSignal.timeout(req.timeoutMs),
    body: JSON.stringify({
      model: req.model,
      max_tokens: 2048,
      temperature: 0.1,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  let data: AnthropicMessageResponse;
  try {
    data = (await response.json()) as AnthropicMessageResponse;
  } catch {
    throw new Error(`Invalid JSON response (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const errMsg = data?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Anthropic API error: ${errMsg}`);
  }

  const textBlock = data.content?.find((block) => block.type === 'text' && block.text);
  if (!textBlock?.text) {
    throw new Error('Model returned an empty response.');
  }

  return textBlock.text;
}

async function callOpenAICompatible(
  req: TranslationRequest,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const endpoint = `${req.baseUrl}/chat/completions`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (req.apiKey) {
    headers['Authorization'] = `Bearer ${req.apiKey}`;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(req.timeoutMs),
    body: JSON.stringify({
      model: req.model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });

  let data: OpenAICompletionResponse;
  try {
    data = (await response.json()) as OpenAICompletionResponse;
  } catch {
    throw new Error(`Invalid JSON response (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const errMsg = data?.error?.message || `HTTP ${response.status}`;
    throw new Error(`API error: ${errMsg}`);
  }

  const rawContent = data.choices?.[0]?.message?.content;
  if (!rawContent) {
    throw new Error('Model returned an empty response.');
  }

  return rawContent;
}

/**
 * Strips accidental markdown fences and normalizes shared leading indentation.
 */
function cleanModelOutput(raw: string): string {
  let cleaned = raw.replace(/\r\n/g, '\n').trim();

  const fenceMatch = cleaned.match(/^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n?```$/);
  if (fenceMatch) {
    cleaned = fenceMatch[1];
  }

  cleaned = cleaned.replace(/^\n+|\n+$/g, '');
  return dedentCommonIndent(cleaned);
}

function dedentCommonIndent(code: string): string {
  const lines = code.split('\n');
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  if (nonEmptyLines.length === 0) {
    return code;
  }

  const minIndent = Math.min(
    ...nonEmptyLines.map((line) => {
      const match = line.match(/^(\s*)/);
      return match ? match[1].length : 0;
    })
  );

  if (minIndent === 0) {
    return code;
  }

  return lines.map((line) => line.slice(minIndent)).join('\n');
}

/**
 * Applies the cursor block's base indentation to every non-empty line.
 */
export function applyIndentation(code: string, baseIndent: string): string {
  return code
    .split('\n')
    .map((line) => (line.trim().length > 0 ? `${baseIndent}${line}` : ''))
    .join('\n');
}
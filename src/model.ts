import * as vscode from 'vscode';
import { Provider, ResolvedProviderConfig, requestCode, resolveProviderConfig, validateApiKeyForProvider } from './aiClient';
import { buildPrompt, TranslationMode } from './core/prompts';
import { contextAround } from './commentParser';
import { loadProjectRules } from './projectRules';

export const API_KEY_SECRET = 'lugus.apiKey';

export interface ModelRequest {
  document: vscode.TextDocument;
  mode: TranslationMode;
  rule: string;
  /** Current implementation, dedented (update mode). */
  currentCode?: string;
  /** Lines of the block itself: excluded from the surrounding context. */
  blockStart: number;
  blockEnd: number;
  /** Rule of the whole file (sidecar), sent as a constraint. Omit when updating that rule itself. */
  fileRule?: string;
}

/** Settings, API key, prompt and the cancellable request: shared by inline and sidecar commands. */
export class ModelClient {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  public timeoutMs(): number {
    return vscode.workspace.getConfiguration('lugus').get<number>('timeoutMs', 60000);
  }

  private async apiKey(config: ResolvedProviderConfig): Promise<string | undefined | null> {
    let key = await this.secrets.get(API_KEY_SECRET);
    if (config.requiresApiKey && !key) {
      const choice = await vscode.window.showWarningMessage(
        `Lugus: no API key configured for provider '${config.provider}'.`,
        'Set API Key'
      );
      if (choice === 'Set API Key') {
        await vscode.commands.executeCommand('lugus.setApiKey');
        key = await this.secrets.get(API_KEY_SECRET);
      }
      if (!key) {
        return null;
      }
    }
    if (key) {
      validateApiKeyForProvider(config.provider, key);
    }
    return key;
  }

  /** Dedented code from the model, or null when the user dismissed the API key prompt. Throws on errors. */
  public async generate(req: ModelRequest): Promise<string | null> {
    const settings = vscode.workspace.getConfiguration('lugus');
    const config = resolveProviderConfig(
      settings.get<Provider>('provider', 'anthropic'),
      settings.get<string>('baseUrl', ''),
      settings.get<string>('model', '')
    );
    const apiKey = await this.apiKey(config);
    if (apiKey === null) {
      return null;
    }
    const context = contextAround(req.document, req.blockStart, req.blockEnd, settings.get<number>('contextLines', 20));
    const prompt = buildPrompt({
      mode: req.mode,
      language: settings.get<string>('languageOverride', '').trim() || req.document.languageId,
      rule: req.rule,
      currentCode: req.currentCode,
      contextBefore: context.before,
      contextAfter: context.after,
      projectRules: await loadProjectRules(req.document),
      fileRule: req.fileRule
    });
    const timeoutMs = this.timeoutMs();
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: req.mode === 'update' ? 'Lugus: updating code…' : 'Lugus: translating…',
        cancellable: true
      },
      (_progress, cancel) => {
        const controller = new AbortController();
        cancel.onCancellationRequested(() => controller.abort());
        return requestCode({ config, apiKey, prompt, timeoutMs, signal: controller.signal });
      }
    );
  }
}

import * as vscode from 'vscode';
import { extractCommentBlock, extractLocalContext } from './commentParser';
import {
  Provider,
  resolveProviderConfig,
  validateApiKeyForProvider,
  translatePseudocode,
  applyIndentation
} from './aiClient';

const API_KEY_SECRET = 'lugus.apiKey';

export function activate(context: vscode.ExtensionContext): void {
  const loadingDecoration = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: '  ⟳ translating...',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic'
    }
  });

  const setKeyCmd = vscode.commands.registerCommand('lugus.setApiKey', async () => {
    const key = await vscode.window.showInputBox({
      prompt: 'Enter your API key (stored securely in VS Code SecretStorage)',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'sk-ant-... or sk-...'
    });

    if (key === undefined) {
      return;
    }

    if (key.trim() === '') {
      await context.secrets.delete(API_KEY_SECRET);
      vscode.window.showInformationMessage('Lugus: API key removed.');
    } else {
      await context.secrets.store(API_KEY_SECRET, key.trim());
      vscode.window.showInformationMessage('Lugus: API key saved securely.');
    }
  });

  const translateCmd = vscode.commands.registerCommand('lugus.translate', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const document = editor.document;
    const cursorLine = editor.selection.active.line;
    const block = extractCommentBlock(document, cursorLine);

    if (!block) {
      vscode.window.setStatusBarMessage(
        'Lugus: place the cursor on a pseudocode comment (e.g. //>, #>, -->).',
        4000
      );
      return;
    }

    const config = vscode.workspace.getConfiguration('lugus');
    const provider = config.get<Provider>('provider', 'anthropic');
    const baseUrlOverride = config.get<string>('baseUrl', '');
    const modelOverride = config.get<string>('model', '');
    const keepComment = config.get<boolean>('keepComment', false);
    const contextLines = config.get<number>('contextLines', 20);
    const languageOverride = config.get<string>('languageOverride', '').trim();
    const timeoutMs = config.get<number>('timeoutMs', 30000);
    const targetLanguage = languageOverride || document.languageId;

    let resolved;
    try {
      resolved = resolveProviderConfig(provider, baseUrlOverride, modelOverride);
    } catch (err: unknown) {
      vscode.window.showErrorMessage(`Lugus: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let apiKey = await context.secrets.get(API_KEY_SECRET);

    if (resolved.requiresApiKey && !apiKey) {
      const choice = await vscode.window.showWarningMessage(
        `Lugus: no API key configured for provider '${resolved.provider}'.`,
        'Set API Key'
      );
      if (choice === 'Set API Key') {
        await vscode.commands.executeCommand('lugus.setApiKey');
        apiKey = await context.secrets.get(API_KEY_SECRET);
      }
      if (!apiKey) {
        return;
      }
    }

    if (apiKey) {
      try {
        validateApiKeyForProvider(resolved.provider, apiKey);
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Lugus: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    const decorationRange = new vscode.Range(block.range.end, block.range.end);
    editor.setDecorations(loadingDecoration, [decorationRange]);

    try {
      const localContext = extractLocalContext(document, block.range, contextLines);
      const generated = await translatePseudocode({
        provider: resolved.provider,
        baseUrl: resolved.baseUrl,
        apiKey,
        model: resolved.model,
        language: targetLanguage,
        prompt: block.prompt,
        contextBefore: localContext.before,
        contextAfter: localContext.after,
        timeoutMs
      });

      let finalText = applyIndentation(generated, block.indent);

      if (keepComment) {
        const preservedComments = block.rawLines
          .map((line) => `${block.indent}${block.commentToken} ${line}`)
          .join('\n');
        finalText = `${preservedComments}\n${finalText}`;
      }

      await editor.edit((editBuilder) => {
        editBuilder.replace(block.range, finalText);
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error && err.name === 'TimeoutError'
          ? `Request timed out after ${timeoutMs}ms.`
          : err instanceof Error
            ? err.message
            : String(err);

      vscode.window.showErrorMessage(`Lugus: ${message}`);
    } finally {
      editor.setDecorations(loadingDecoration, []);
    }
  });

  context.subscriptions.push(loadingDecoration, setKeyCmd, translateCmd);
}

export function deactivate(): void {}
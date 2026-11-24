import * as vscode from 'vscode';
import {
  extractCommentBlock,
  extractLocalContext,
  formatEndMarker
} from './commentParser';
import {
  Provider,
  resolveProviderConfig,
  validateApiKeyForProvider,
  translatePseudocode,
  applyIndentation
} from './aiClient';
import { loadProjectRules } from './projectRules';
import { LugusCodeLensProvider } from './codeLensProvider';

type BlockMode = 'linked' | 'replace' | 'comment';

const API_KEY_SECRET = 'lugus.apiKey';

export function activate(context: vscode.ExtensionContext): void {
  const loadingDecoration = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: '  ⟳ translating...',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic'
    }
  });

  const codeLensProvider = new LugusCodeLensProvider();
  const codeLensRegistration = vscode.languages.registerCodeLensProvider(
    [{ scheme: 'file' }, { scheme: 'untitled' }],
    codeLensProvider
  );

  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('lugus.enableCodeLens')) {
      codeLensProvider.refresh();
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

  const translateCmd = vscode.commands.registerCommand(
    'lugus.translate',
    async (targetLine?: number) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      const document = editor.document;
      const line = typeof targetLine === 'number' ? targetLine : editor.selection.active.line;
      const block = extractCommentBlock(document, line);

      if (!block) {
        vscode.window.setStatusBarMessage(
          'Lugus: place the cursor on a pseudocode comment or inside a linked block.',
          4000
        );
        return;
      }

      const config = vscode.workspace.getConfiguration('lugus');
      const provider = config.get<Provider>('provider', 'anthropic');
      const baseUrlOverride = config.get<string>('baseUrl', '');
      const modelOverride = config.get<string>('model', '');
      const blockMode = config.get<BlockMode>('blockMode', 'linked');
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

      const decorationRange = new vscode.Range(block.commentRange.end, block.commentRange.end);
      editor.setDecorations(loadingDecoration, [decorationRange]);

      try {
        const [localContext, projectRules] = await Promise.all([
          Promise.resolve(extractLocalContext(document, block, contextLines)),
          loadProjectRules(document)
        ]);

        const generated = await translatePseudocode({
          provider: resolved.provider,
          baseUrl: resolved.baseUrl,
          apiKey,
          model: resolved.model,
          language: targetLanguage,
          prompt: block.prompt,
          contextBefore: localContext.before,
          contextAfter: localContext.after,
          projectRules,
          timeoutMs
        });

        const indentedCode = applyIndentation(generated, block.indent);
        let finalText = indentedCode;

        if (blockMode === 'linked') {
          const headerComments = block.rawLines
            .map((rawLine) => `${block.indent}${block.commentToken}> ${rawLine}`)
            .join('\n');
          const endMarker = formatEndMarker(block.indent, block.commentToken);
          finalText = `${headerComments}\n${indentedCode}\n${endMarker}`;
        } else if (blockMode === 'comment') {
          const preservedComments = block.rawLines
            .map((rawLine) => `${block.indent}${block.commentToken} ${rawLine}`)
            .join('\n');
          finalText = `${preservedComments}\n${indentedCode}`;
        }

        await editor.edit((editBuilder) => {
          editBuilder.replace(block.replaceRange, finalText);
        });

        codeLensProvider.refresh();
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
    }
  );

  const detachCmd = vscode.commands.registerCommand(
    'lugus.detach',
    async (targetLine?: number) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      const document = editor.document;
      const line = typeof targetLine === 'number' ? targetLine : editor.selection.active.line;
      const block = extractCommentBlock(document, line);

      if (!block || !block.isLinked || block.endMarkerLine === null) {
        vscode.window.setStatusBarMessage(
          'Lugus: cursor is not on a linked block to detach.',
          4000
        );
        return;
      }

      const codeStartLine = block.commentRange.end.line + 1;
      const codeEndLine = block.endMarkerLine - 1;

      let cleanCode = '';
      if (codeStartLine <= codeEndLine) {
        const codeRange = new vscode.Range(
          new vscode.Position(codeStartLine, 0),
          document.lineAt(codeEndLine).range.end
        );
        cleanCode = document.getText(codeRange);
      }

      await editor.edit((editBuilder) => {
        editBuilder.replace(block.replaceRange, cleanCode);
      });

      codeLensProvider.refresh();
    }
  );

  context.subscriptions.push(
    loadingDecoration,
    codeLensProvider,
    codeLensRegistration,
    configListener,
    setKeyCmd,
    translateCmd,
    detachCmd
  );
}

export function deactivate(): void {}
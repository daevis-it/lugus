import * as vscode from 'vscode';
import { BlockMode, composeBlock, formatMarker } from './core/blocks';
import { buildPrompt, TranslationMode } from './core/prompts';
import { applyIndentation, canonicalCode, commonIndent, dedent } from './core/text';
import {
  Provider,
  ResolvedProviderConfig,
  requestCode,
  resolveProviderConfig,
  validateApiKeyForProvider
} from './aiClient';
import { CommentBlock, extractLocalContext, getBlockAt, relocateBlock } from './commentParser';
import { LugusCodeLensProvider } from './codeLensProvider';
import { linkSelection } from './linkSelection';
import { loadProjectRules } from './projectRules';
import { reviewReplacement } from './reviewReplacement';

const API_KEY_SECRET = 'lugus.apiKey';

interface Target {
  editor: vscode.TextEditor;
  line: number;
}

class UserFacingError extends Error {}

export function activate(context: vscode.ExtensionContext): void {
  const codeLens = new LugusCodeLensProvider();
  const loading = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: '  ⟳ Lugus is working…',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic'
    }
  });
  /** One model request per document at a time: edits would race otherwise. */
  const busyDocuments = new Set<string>();

  /**
   * Commands are called from CodeLens as (uri, line), from the keybinding and
   * the palette with no arguments (cursor position is used).
   */
  async function resolveTarget(uriArg?: unknown, lineArg?: unknown): Promise<Target | null> {
    if (uriArg instanceof vscode.Uri && typeof lineArg === 'number') {
      const editor =
        vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uriArg.toString()) ??
        (await vscode.window.showTextDocument(uriArg));
      return { editor, line: lineArg };
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return null;
    }
    return { editor, line: typeof uriArg === 'number' ? uriArg : editor.selection.active.line };
  }

  async function blockAtTarget(uriArg: unknown, lineArg: unknown, emptyMessage: string) {
    const target = await resolveTarget(uriArg, lineArg);
    if (!target) {
      return null;
    }
    const block = getBlockAt(target.editor.document, target.line);
    if (!block) {
      vscode.window.setStatusBarMessage(emptyMessage, 4000);
      return null;
    }
    return { editor: target.editor, block };
  }

  async function getApiKey(config: ResolvedProviderConfig): Promise<string | undefined | null> {
    let apiKey = await context.secrets.get(API_KEY_SECRET);
    if (config.requiresApiKey && !apiKey) {
      const choice = await vscode.window.showWarningMessage(
        `Lugus: no API key configured for provider '${config.provider}'.`,
        'Set API Key'
      );
      if (choice === 'Set API Key') {
        await vscode.commands.executeCommand('lugus.setApiKey');
        apiKey = await context.secrets.get(API_KEY_SECRET);
      }
      if (!apiKey) {
        return null;
      }
    }
    if (apiKey) {
      validateApiKeyForProvider(config.provider, apiKey);
    }
    return apiKey;
  }

  // ---------------------------------------------------------------- Set key

  const setApiKey = vscode.commands.registerCommand('lugus.setApiKey', async () => {
    const key = await vscode.window.showInputBox({
      prompt: 'Enter your API key (stored in VS Code SecretStorage). Leave empty to remove it.',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'sk-ant-... or sk-...'
    });
    if (key === undefined) {
      return;
    }
    if (!key.trim()) {
      await context.secrets.delete(API_KEY_SECRET);
      vscode.window.showInformationMessage('Lugus: API key removed.');
    } else {
      await context.secrets.store(API_KEY_SECRET, key.trim());
      vscode.window.showInformationMessage('Lugus: API key saved.');
    }
  });

  // ---------------------------------------------------- Translate / Update

  const translate = vscode.commands.registerCommand('lugus.translate', async (uriArg?: unknown, lineArg?: unknown) => {
    const found = await blockAtTarget(
      uriArg,
      lineArg,
      'Lugus: place the cursor on a //> rule or inside a linked block.'
    );
    if (!found) {
      return;
    }
    const { editor, block } = found;
    const document = editor.document;
    const docKey = document.uri.toString();

    if (busyDocuments.has(docKey)) {
      vscode.window.showInformationMessage('Lugus: a request for this file is already running.');
      return;
    }
    const rule = block.ruleLines.join('\n').trim();
    if (!rule) {
      vscode.window.showInformationMessage('Lugus: the rule is empty. Write it after the //> prefix.');
      return;
    }
    if (block.state === 'aligned') {
      const pick = await vscode.window.showInformationMessage(
        'Lugus: this block already matches its rule.',
        'Update Anyway'
      );
      if (pick !== 'Update Anyway') {
        return;
      }
    }

    const settings = vscode.workspace.getConfiguration('lugus');
    const blockMode = settings.get<BlockMode>('blockMode', 'linked');
    const contextLines = settings.get<number>('contextLines', 20);
    const timeoutMs = settings.get<number>('timeoutMs', 60000);
    const language = settings.get<string>('languageOverride', '').trim() || document.languageId;

    busyDocuments.add(docKey);
    editor.setDecorations(loading, [new vscode.Range(block.ruleRange.end, block.ruleRange.end)]);
    try {
      const provider = resolveProviderConfig(
        settings.get<Provider>('provider', 'anthropic'),
        settings.get<string>('baseUrl', ''),
        settings.get<string>('model', '')
      );
      const apiKey = await getApiKey(provider);
      if (apiKey === null) {
        return;
      }

      const hasCode = block.markerLine !== null && block.body.some((line) => line.trim());
      const mode: TranslationMode = hasCode ? 'update' : 'generate';
      const currentCode = block.body.join('\n');
      const baseIndent = hasCode ? commonIndent(block.body) : block.indent;

      const localContext = extractLocalContext(document, block, contextLines);
      const prompt = buildPrompt({
        mode,
        language,
        rule,
        currentCode: hasCode ? dedent(currentCode) : undefined,
        contextBefore: localContext.before,
        contextAfter: localContext.after,
        projectRules: await loadProjectRules(document)
      });

      const generated = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: mode === 'update' ? 'Lugus: updating code…' : 'Lugus: translating…',
          cancellable: true
        },
        (_progress, cancel) => {
          const controller = new AbortController();
          cancel.onCancellationRequested(() => controller.abort());
          return requestCode({ config: provider, apiKey, prompt, timeoutMs, signal: controller.signal });
        }
      );
      const newCode = applyIndentation(generated, baseIndent);

      let current = relocateBlock(document, block);
      if (!current) {
        throw new UserFacingError('The block changed while Lugus was working. Nothing was applied; run the command again.');
      }

      if (hasCode && canonicalCode(newCode) === canonicalCode(currentCode)) {
        if (current.markerLine !== null) {
          await restampMarker(await editorFor(document), current);
        }
        vscode.window.showInformationMessage('Lugus: the code already implements this rule. Marked as aligned.');
        return;
      }

      const finalText = composeBlock({
        mode: blockMode,
        headerLines: current.snapshot.split('\n').slice(0, current.promptEnd - current.promptStart + 1),
        indent: current.indent,
        token: current.token,
        ruleLines: current.ruleLines,
        code: newCode
      });

      // Existing code is never overwritten without the user seeing the diff.
      if (hasCode) {
        const approved = await reviewReplacement(
          document,
          current.snapshot,
          finalText,
          'Lugus: review the proposed change to this block.'
        );
        if (!approved) {
          return;
        }
        current = relocateBlock(document, current);
        if (!current) {
          throw new UserFacingError('The block changed during the review. Nothing was applied; run the command again.');
        }
      }

      // The diff may have taken focus: edit through an editor that is still alive.
      const target = current;
      const targetEditor = await editorFor(document);
      const applied = await targetEditor.edit((edit) => edit.replace(target.fullRange, withEol(document, finalText)));
      if (!applied) {
        throw new UserFacingError('Could not apply the change. Make sure the file is still open and editable.');
      }
    } catch (err: unknown) {
      reportError(err, timeoutMs);
    } finally {
      busyDocuments.delete(docKey);
      editor.setDecorations(loading, []);
      codeLens.refresh();
    }
  });

  // ------------------------------------------------------------------ Accept

  const accept = vscode.commands.registerCommand('lugus.accept', async (uriArg?: unknown, lineArg?: unknown) => {
    const found = await blockAtTarget(uriArg, lineArg, 'Lugus: place the cursor inside a linked block.');
    if (!found) {
      return;
    }
    if (found.block.markerLine === null) {
      vscode.window.setStatusBarMessage('Lugus: this rule has no code yet. Translate it first.', 4000);
      return;
    }
    if (!(await restampMarker(found.editor, found.block))) {
      vscode.window.showWarningMessage('Lugus: could not update the marker. Try again.');
    }
    codeLens.refresh();
  });

  // ------------------------------------------------------------------ Detach

  const detach = vscode.commands.registerCommand('lugus.detach', async (uriArg?: unknown, lineArg?: unknown) => {
    const found = await blockAtTarget(uriArg, lineArg, 'Lugus: place the cursor inside a linked block.');
    if (!found) {
      return;
    }
    const { editor, block } = found;
    if (block.markerLine === null) {
      vscode.window.setStatusBarMessage('Lugus: only linked blocks can be detached.', 4000);
      return;
    }
    const document = editor.document;
    const markerLine = block.markerLine;
    await editor.edit((edit) => {
      if (markerLine > block.promptEnd + 1) {
        // Keep the body: remove the rule lines and the marker line.
        edit.delete(new vscode.Range(block.promptStart, 0, block.promptEnd + 1, 0));
        edit.delete(new vscode.Range(document.lineAt(markerLine - 1).range.end, document.lineAt(markerLine).range.end));
      } else {
        edit.delete(wholeLines(document, block.promptStart, markerLine));
      }
    });
    codeLens.refresh();
  });

  context.subscriptions.push(
    loading,
    codeLens,
    vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: 'untitled' }], codeLens),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('lugus')) {
        codeLens.refresh();
      }
    }),
    setApiKey,
    translate,
    accept,
    detach,
    vscode.commands.registerCommand('lugus.linkSelection', async () => {
      await linkSelection();
      codeLens.refresh();
    })
  );
}

export function deactivate(): void {}

// ------------------------------------------------------------------ helpers

async function editorFor(document: vscode.TextDocument): Promise<vscode.TextEditor> {
  return (
    vscode.window.visibleTextEditors.find((e) => e.document === document) ??
    (await vscode.window.showTextDocument(document, { preserveFocus: false }))
  );
}

/** Rewrites the marker with fingerprints of the current rule and code. No model call. */
async function restampMarker(editor: vscode.TextEditor, block: CommentBlock): Promise<boolean> {
  if (block.markerLine === null) {
    return false;
  }
  const line = editor.document.lineAt(block.markerLine);
  const markerIndent = line.text.match(/^[\t ]*/)?.[0] ?? '';
  const marker = formatMarker(markerIndent, block.token, block.body.join('\n'), block.ruleLines);
  if (marker === line.text) {
    return true;
  }
  return editor.edit((edit) => edit.replace(line.range, marker));
}

/** Range covering whole lines `from`..`to`, including one line break. */
function wholeLines(document: vscode.TextDocument, from: number, to: number): vscode.Range {
  if (to + 1 < document.lineCount) {
    return new vscode.Range(from, 0, to + 1, 0);
  }
  if (from > 0) {
    return new vscode.Range(document.lineAt(from - 1).range.end, document.lineAt(to).range.end);
  }
  return new vscode.Range(0, 0, to, document.lineAt(to).text.length);
}

function withEol(document: vscode.TextDocument, text: string): string {
  return document.eol === vscode.EndOfLine.CRLF ? text.replace(/\n/g, '\r\n') : text;
}

function reportError(err: unknown, timeoutMs: number): void {
  if (err instanceof Error && err.name === 'AbortError') {
    vscode.window.setStatusBarMessage('Lugus: request cancelled.', 3000);
    return;
  }
  const message =
    err instanceof Error && err.name === 'TimeoutError'
      ? `Request timed out after ${timeoutMs} ms. Increase 'lugus.timeoutMs' for slow or local models.`
      : err instanceof Error
        ? err.message
        : String(err);
  vscode.window.showErrorMessage(`Lugus: ${message}`);
}

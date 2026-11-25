import * as vscode from 'vscode';
import { blockEnd, BlockMode, composeBlock, formatMarker } from './core/blocks';
import { TranslationMode } from './core/prompts';
import { findCodeByHash, SnapshotStore } from './core/snapshots';
import { applyIndentation, canonicalCode, commonIndent, dedent } from './core/text';
import { CommentBlock, getBlockAt, relocateBlock } from './commentParser';
import { LugusCodeLensProvider } from './codeLensProvider';
import { DriftMonitor, showDriftedBlocks } from './drift';
import { editorFor, readCommittedVersion, reportError, UserFacingError, wholeLines, withEol } from './editorUtils';
import { linkSelection } from './linkSelection';
import { API_KEY_SECRET, ModelClient } from './model';
import { reviewReplacement } from './reviewReplacement';
import { Sidecar } from './sidecar';
import { SidecarCommands } from './sidecarCommands';

interface Target {
  editor: vscode.TextEditor;
  line: number;
  /** True when invoked from CodeLens / quick fix with an explicit position. */
  explicit: boolean;
}

export function activate(context: vscode.ExtensionContext): void {
  const snapshots = new SnapshotStore(context.workspaceState);
  const sidecar = new Sidecar();
  const model = new ModelClient(context.secrets);
  const codeLens = new LugusCodeLensProvider(sidecar);
  const drift = new DriftMonitor(snapshots, sidecar);
  /** One model request per document at a time: edits would race otherwise. */
  const busyDocuments = new Set<string>();
  const sidecarCommands = new SidecarCommands(sidecar, snapshots, model, busyDocuments, () => codeLens.refresh());

  const loading = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: '  ⟳ Lugus is working…',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic'
    }
  });

  /**
   * Inline commands are called from CodeLens as (uri, line), from the keybinding
   * and the palette with no arguments (cursor position is used).
   */
  async function resolveTarget(uriArg?: unknown, lineArg?: unknown): Promise<Target | null> {
    if (uriArg instanceof vscode.Uri && typeof lineArg === 'number') {
      const editor =
        vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uriArg.toString()) ??
        (await vscode.window.showTextDocument(uriArg));
      return { editor, line: lineArg, explicit: true };
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return null;
    }
    return {
      editor,
      line: typeof uriArg === 'number' ? uriArg : editor.selection.active.line,
      explicit: typeof uriArg === 'number'
    };
  }

  /**
   * The inline block at the target. Without one, at the cursor, the command
   * falls through to the sidecar rule of the symbol there (if any).
   */
  async function inlineBlockOrSidecar(
    uriArg: unknown,
    lineArg: unknown,
    sidecarCommand: string,
    emptyMessage: string
  ): Promise<{ editor: vscode.TextEditor; block: CommentBlock } | null> {
    const target = await resolveTarget(uriArg, lineArg);
    if (!target) {
      return null;
    }
    const block = getBlockAt(target.editor.document, target.line);
    if (block) {
      return { editor: target.editor, block };
    }
    if (!target.explicit && (await sidecarCommands.hasRuleAt(target.editor.document, target.line))) {
      await vscode.commands.executeCommand(sidecarCommand);
      return null;
    }
    vscode.window.setStatusBarMessage(emptyMessage, 4000);
    return null;
  }

  /** The code as it was when the block was last aligned: local snapshot first, then the committed file. */
  async function findAlignedCode(document: vscode.TextDocument, block: CommentBlock): Promise<string | undefined> {
    const codeHash = block.marker?.codeHash;
    if (!codeHash) {
      return undefined;
    }
    const local = snapshots.get(codeHash);
    if (local !== undefined) {
      return local;
    }
    const committed = await readCommittedVersion(document.uri);
    return committed === undefined ? undefined : findCodeByHash(committed, block.token, codeHash);
  }

  /** Puts the last aligned code back, keeping the rule as written. Diff review first. */
  async function restoreBlock(document: vscode.TextDocument, block: CommentBlock, code: string): Promise<boolean> {
    if (block.markerLine === null) {
      return false;
    }
    const header = block.snapshot.split('\n').slice(0, block.promptEnd - block.promptStart + 1);
    const marker = document.lineAt(block.markerLine).text;
    const finalText = [...header, applyIndentation(code, block.indent), marker].join('\n');
    const approved = await reviewReplacement(
      document,
      block.snapshot,
      finalText,
      'Lugus: restore the code as it was when it last matched the rule?'
    );
    if (!approved) {
      return false;
    }
    const current = relocateBlock(document, block);
    if (!current) {
      throw new UserFacingError('The block changed during the review. Nothing was restored; run the command again.');
    }
    const editor = await editorFor(document);
    return editor.edit((edit) => edit.replace(current.fullRange, withEol(document, finalText)));
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
    const found = await inlineBlockOrSidecar(
      uriArg,
      lineArg,
      'lugus.sidecar.update',
      'Lugus: place the cursor on a //> rule, inside a linked block, or in a symbol with a sidecar rule.'
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

    const blockMode = vscode.workspace.getConfiguration('lugus').get<BlockMode>('blockMode', 'linked');
    busyDocuments.add(docKey);
    editor.setDecorations(loading, [new vscode.Range(block.ruleRange.end, block.ruleRange.end)]);
    try {
      const hasCode = block.markerLine !== null && block.body.some((line) => line.trim());
      const mode: TranslationMode = hasCode ? 'update' : 'generate';
      const currentCode = block.body.join('\n');
      const baseIndent = hasCode ? commonIndent(block.body) : block.indent;

      const generated = await model.generate({
        document,
        mode,
        rule,
        currentCode: hasCode ? dedent(currentCode) : undefined,
        blockStart: block.promptStart,
        blockEnd: blockEnd(block),
        fileRule: await sidecar.fileRule(document.uri)
      });
      if (generated === null) {
        return;
      }
      const newCode = applyIndentation(generated, baseIndent);

      let current = relocateBlock(document, block);
      if (!current) {
        throw new UserFacingError('The block changed while Lugus was working. Nothing was applied; run the command again.');
      }

      if (hasCode && canonicalCode(newCode) === canonicalCode(currentCode)) {
        if (block.state === 'code-edited' || block.state === 'both-changed') {
          // The model sees nothing to fix, but the code was edited by hand:
          // never accept those edits silently. Let the user decide.
          const aligned = await findAlignedCode(document, current);
          const pick = await vscode.window.showInformationMessage(
            'Lugus: the model says the current code, hand edits included, already satisfies the rule. Keep it, or go back to the last aligned version?',
            ...(aligned !== undefined ? ['Accept Current Code', 'Restore Last Aligned'] : ['Accept Current Code'])
          );
          if (pick === 'Accept Current Code') {
            await restampMarker(await editorFor(document), current);
          } else if (pick === 'Restore Last Aligned' && aligned !== undefined) {
            await restoreBlock(document, current, aligned);
          }
          return;
        }
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
      if (blockMode === 'linked') {
        await snapshots.remember(newCode);
      }
    } catch (err: unknown) {
      reportError(err, model.timeoutMs());
    } finally {
      busyDocuments.delete(docKey);
      editor.setDecorations(loading, []);
      codeLens.refresh();
    }
  });

  // ------------------------------------------------------------------ Accept

  const accept = vscode.commands.registerCommand('lugus.accept', async (uriArg?: unknown, lineArg?: unknown) => {
    const found = await inlineBlockOrSidecar(uriArg, lineArg, 'lugus.sidecar.accept', 'Lugus: place the cursor inside a linked block.');
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

  // ----------------------------------------------------------------- Restore

  const restore = vscode.commands.registerCommand('lugus.restore', async (uriArg?: unknown, lineArg?: unknown) => {
    const found = await inlineBlockOrSidecar(uriArg, lineArg, 'lugus.sidecar.restore', 'Lugus: place the cursor inside a linked block.');
    if (!found) {
      return;
    }
    const { editor, block } = found;
    if (block.state !== 'code-edited' && block.state !== 'both-changed') {
      vscode.window.setStatusBarMessage('Lugus: nothing to restore, the code matches its last aligned version.', 4000);
      return;
    }
    try {
      const code = await findAlignedCode(editor.document, block);
      if (code === undefined) {
        vscode.window.showWarningMessage(
          'Lugus: no copy of the last aligned code was found (neither saved by Lugus nor in the last commit). Use Undo or your version control.'
        );
        return;
      }
      await restoreBlock(editor.document, block, code);
    } catch (err: unknown) {
      reportError(err);
    } finally {
      codeLens.refresh();
    }
  });

  // ------------------------------------------------------------------ Detach

  const detach = vscode.commands.registerCommand('lugus.detach', async (uriArg?: unknown, lineArg?: unknown) => {
    const found = await inlineBlockOrSidecar(uriArg, lineArg, 'lugus.sidecar.detach', 'Lugus: place the cursor inside a linked block.');
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

  // -------------------------------------------------------------------- Link

  /** Inline: rule above the selected lines, marker below. */
  const link = vscode.commands.registerCommand('lugus.linkSelection', async () => {
    try {
      await linkSelection();
    } catch (err: unknown) {
      reportError(err);
    } finally {
      codeLens.refresh();
    }
  });

  /** Sidecar: rule for the whole file (from the editor, or a file in the Explorer). */
  const linkFile = vscode.commands.registerCommand('lugus.linkFile', async (uriArg?: unknown) => {
    try {
      await sidecarCommands.linkFile(uriArg);
    } catch (err: unknown) {
      reportError(err);
    } finally {
      codeLens.refresh();
    }
  });

  /** Sidecar: rule attached to the function, method or class at the cursor, stored in .lugus/rules. */
  const linkSymbol = vscode.commands.registerCommand('lugus.linkSymbol', async () => {
    try {
      await sidecarCommands.link();
    } catch (err: unknown) {
      reportError(err);
    } finally {
      codeLens.refresh();
    }
  });

  context.subscriptions.push(
    loading,
    codeLens,
    drift,
    sidecar,
    vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: 'untitled' }], codeLens),
    vscode.languages.registerCodeActionsProvider([{ scheme: 'file' }, { scheme: 'untitled' }], drift, {
      providedCodeActionKinds: DriftMonitor.providedCodeActionKinds
    }),
    sidecar.onDidChange(() => codeLens.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('lugus')) {
        codeLens.refresh();
      }
    }),
    vscode.commands.registerCommand('lugus.showDrifted', () => showDriftedBlocks(drift)),
    setApiKey,
    translate,
    accept,
    restore,
    detach,
    link,
    linkSymbol,
    linkFile,
    ...sidecarCommands.register()
  );
}

export function deactivate(): void {}

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

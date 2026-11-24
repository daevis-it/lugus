import * as vscode from 'vscode';
import { adviseState, describeState, isDrift, mayContainBlocks } from './core/check';
import { CommentBlock, getBlocks } from './commentParser';

type SeveritySetting = 'off' | 'hint' | 'information' | 'warning';

const SOURCE = 'Lugus';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_FILES = 20000;
const WORKSPACE_EXCLUDE =
  '**/{node_modules,.git,dist,out,build,bin,obj,.venv,venv,__pycache__,Binaries,Intermediate,Saved,DerivedDataCache,Library,Temp,.godot}/**';

export interface DriftEntry {
  uri: vscode.Uri;
  block: CommentBlock;
}

/**
 * Publishes drifted and unverified blocks as diagnostics, so they show in the
 * Problems panel, and offers Update / Accept as quick fixes.
 *
 * Open documents are re-checked as you type. Files found by a workspace scan
 * keep their diagnostics after being closed and are re-checked when they
 * change on disk (for example after a git checkout).
 */
export class DriftMonitor implements vscode.Disposable, vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  private readonly collection = vscode.languages.createDiagnosticCollection('lugus');
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*', true, false, false);
    this.disposables.push(
      this.collection,
      watcher,
      watcher.onDidChange((uri) => this.recheckIfTracked(uri)),
      watcher.onDidDelete((uri) => this.collection.delete(uri)),
      vscode.workspace.onDidOpenTextDocument((doc) => this.refresh(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
      vscode.workspace.onDidRenameFiles((e) => e.files.forEach((f) => this.collection.delete(f.oldUri))),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('lugus.driftSeverity')) {
          this.refreshAll();
        }
      })
    );
    this.refreshAll();
  }

  public dispose(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.disposables.forEach((d) => d.dispose());
  }

  private severity(): SeveritySetting {
    return vscode.workspace.getConfiguration('lugus').get<SeveritySetting>('driftSeverity', 'warning');
  }

  public refreshAll(): void {
    vscode.workspace.textDocuments.forEach((doc) => this.refresh(doc));
  }

  private schedule(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.refresh(document);
      }, 300)
    );
  }

  /** Recomputes diagnostics for one document. */
  public refresh(document: vscode.TextDocument): void {
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
      return;
    }
    const setting = this.severity();
    if (setting === 'off' || !mayContainBlocks(document.getText())) {
      this.collection.delete(document.uri);
      return;
    }
    const diagnostics = getBlocks(document)
      .filter((block) => isDrift(block.state) || block.state === 'unverified')
      .map((block) => this.toDiagnostic(block, setting));
    this.collection.set(document.uri, diagnostics);
  }

  private toDiagnostic(block: CommentBlock, setting: SeveritySetting): vscode.Diagnostic {
    const severity = !isDrift(block.state)
      ? vscode.DiagnosticSeverity.Information
      : setting === 'hint'
        ? vscode.DiagnosticSeverity.Hint
        : setting === 'information'
          ? vscode.DiagnosticSeverity.Information
          : vscode.DiagnosticSeverity.Warning;
    const diagnostic = new vscode.Diagnostic(
      block.ruleRange,
      `Lugus: ${describeState(block.state)}. ${adviseState(block.state)}`,
      severity
    );
    diagnostic.source = SOURCE;
    diagnostic.code = block.state;
    return diagnostic;
  }

  private async recheckIfTracked(uri: vscode.Uri): Promise<void> {
    if (!this.collection.has(uri)) {
      return;
    }
    try {
      this.refresh(await vscode.workspace.openTextDocument(uri));
    } catch {
      this.collection.delete(uri);
    }
  }

  public provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== SOURCE) {
        continue;
      }
      const args = [document.uri, diagnostic.range.start.line];
      const update = new vscode.CodeAction('Lugus: Update code to match the rule', vscode.CodeActionKind.QuickFix);
      update.command = { title: update.title, command: 'lugus.translate', arguments: args };
      update.diagnostics = [diagnostic];
      const accept = new vscode.CodeAction('Lugus: Accept block as aligned', vscode.CodeActionKind.QuickFix);
      accept.command = { title: accept.title, command: 'lugus.accept', arguments: args };
      accept.diagnostics = [diagnostic];
      // Hand edits are usually intentional: offer Accept first for them.
      actions.push(...(diagnostic.code === 'code-edited' ? [accept, update] : [update, accept]));
    }
    return actions;
  }

  /**
   * Scans the workspace for linked blocks. Files are pre-filtered on raw bytes,
   * so only files that contain a marker are opened as documents.
   */
  public async scanWorkspace(token?: vscode.CancellationToken): Promise<{ checked: number; entries: DriftEntry[] }> {
    const uris = await vscode.workspace.findFiles('**/*', WORKSPACE_EXCLUDE, MAX_WORKSPACE_FILES, token);
    const marker = Buffer.from('</lugus>');
    const entries: DriftEntry[] = [];
    let checked = 0;

    for (let i = 0; i < uris.length; i += 50) {
      if (token?.isCancellationRequested) {
        break;
      }
      const batch = await Promise.all(
        uris.slice(i, i + 50).map(async (uri) => {
          try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.size > MAX_FILE_BYTES) {
              return null;
            }
            const bytes = await vscode.workspace.fs.readFile(uri);
            return Buffer.from(bytes).includes(marker) ? uri : null;
          } catch {
            return null;
          }
        })
      );
      for (const uri of batch) {
        if (!uri) {
          continue;
        }
        const document = await vscode.workspace.openTextDocument(uri);
        this.refresh(document);
        for (const block of getBlocks(document)) {
          if (block.markerLine === null) {
            continue;
          }
          checked++;
          if (isDrift(block.state) || block.state === 'unverified') {
            entries.push({ uri, block });
          }
        }
      }
    }
    return { checked, entries };
  }
}

/** Command: scan the workspace and let the user jump to a drifted block. */
export async function showDriftedBlocks(monitor: DriftMonitor): Promise<void> {
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Lugus: checking blocks…', cancellable: true },
    (_progress, token) => monitor.scanWorkspace(token)
  );
  if (result.entries.length === 0) {
    vscode.window.showInformationMessage(
      result.checked
        ? `Lugus: all ${result.checked} linked blocks are aligned.`
        : 'Lugus: no linked blocks found in this workspace.'
    );
    return;
  }

  const items = result.entries
    .sort((a, b) => Number(isDrift(b.block.state)) - Number(isDrift(a.block.state)))
    .map((entry) => ({
      label: `${isDrift(entry.block.state) ? '$(warning)' : '$(question)'} ${entry.block.ruleLines.join(' ')}`,
      description: `${describeState(entry.block.state)} · ${vscode.workspace.asRelativePath(entry.uri)}:${entry.block.promptStart + 1}`,
      entry
    }));
  const pick = await vscode.window.showQuickPick(items, {
    title: `Lugus: ${items.length} block${items.length === 1 ? '' : 's'} to review (of ${result.checked})`,
    placeHolder: 'Select a block to open it',
    matchOnDescription: true
  });
  if (!pick) {
    return;
  }
  const editor = await vscode.window.showTextDocument(pick.entry.uri);
  const position = new vscode.Position(pick.entry.block.promptStart, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

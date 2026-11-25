import * as vscode from 'vscode';
import { BlockState } from './core/blocks';
import { adviseState, describeState, isDrift, mayContainBlocks } from './core/check';
import { parseSidecar, regionText, SIDECAR_DIR } from './core/sidecar';
import { SnapshotStore } from './core/snapshots';
import { documentLines, getBlocks } from './commentParser';
import { Sidecar } from './sidecar';

type SeveritySetting = 'off' | 'hint' | 'information' | 'warning';

const INLINE_SOURCE = 'Lugus';
const SIDECAR_SOURCE = 'Lugus sidecar';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_FILES = 20000;
const WORKSPACE_EXCLUDE =
  '**/{node_modules,.git,dist,out,build,bin,obj,.venv,venv,__pycache__,Binaries,Intermediate,Saved,DerivedDataCache,Library,Temp,.godot}/**';

/** One block that needs attention, inline or sidecar. */
export interface DriftEntry {
  uri: vscode.Uri;
  /** Zero-based line to open. */
  line: number;
  state: BlockState;
  rule: string[];
  sidecar: boolean;
}

/**
 * Publishes drifted, orphaned and not-verified blocks as diagnostics (Problems
 * panel) with quick fixes, and remembers every aligned version it sees so the
 * code can be restored later.
 *
 * Open documents are re-checked as you type. Files found by a workspace scan
 * keep their diagnostics after being closed and are re-checked when they
 * change on disk (for example after a git checkout).
 */
export class DriftMonitor implements vscode.Disposable, vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  private readonly collection = vscode.languages.createDiagnosticCollection('lugus');
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly generations = new Map<string, number>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly snapshots: SnapshotStore,
    private readonly sidecar: Sidecar
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*', true, false, false);
    this.disposables.push(
      this.collection,
      watcher,
      watcher.onDidChange((uri) => void this.recheckIfTracked(uri)),
      watcher.onDidDelete((uri) => this.collection.delete(uri)),
      vscode.workspace.onDidOpenTextDocument((doc) => void this.refresh(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
      vscode.workspace.onDidRenameFiles((e) => e.files.forEach((f) => this.collection.delete(f.oldUri))),
      sidecar.onDidChange((source) => void this.recheck(source)),
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

  private severitySetting(): SeveritySetting {
    return vscode.workspace.getConfiguration('lugus').get<SeveritySetting>('driftSeverity', 'warning');
  }

  public refreshAll(): void {
    vscode.workspace.textDocuments.forEach((doc) => void this.refresh(doc));
  }

  private schedule(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.refresh(document);
      }, 300)
    );
  }

  /** Recomputes diagnostics for one document (inline blocks and sidecar rules). */
  public async refresh(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
      return;
    }
    const key = document.uri.toString();
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);

    const setting = this.severitySetting();
    const diagnostics: vscode.Diagnostic[] = [];

    if (mayContainBlocks(document.getText())) {
      for (const block of getBlocks(document)) {
        // Every aligned block seen is saved, so a later hand edit can be restored exactly.
        if (block.state === 'aligned') {
          void this.snapshots.remember(block.body.join('\n'));
        }
        if (setting !== 'off' && (isDrift(block.state) || block.state === 'unverified')) {
          diagnostics.push(
            this.diagnostic(block.ruleRange, block.state, setting, INLINE_SOURCE, adviseState(block.state))
          );
        }
      }
    }

    const sidecar = await this.sidecar.blocks(document);
    if (this.generations.get(key) !== generation) {
      return; // a newer refresh is running
    }
    if (sidecar.error) {
      const d = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 0),
        `Lugus: cannot read the sidecar rules for this file. ${sidecar.error}`,
        vscode.DiagnosticSeverity.Warning
      );
      d.source = SIDECAR_SOURCE;
      diagnostics.push(d);
    }
    const lines = sidecar.blocks.length ? documentLines(document) : [];
    for (const block of sidecar.blocks) {
      if (block.exact && block.symbol && block.state === 'aligned') {
        void this.snapshots.remember(regionText(lines, block.symbol.startLine, block.symbol.endLine));
      }
      if (setting !== 'off' && isDrift(block.state)) {
        const line = Math.min(block.line, Math.max(0, document.lineCount - 1));
        const range = document.lineAt(line).range;
        const message = `${describeState(block.state)}: "${block.entry.rule.join(' ')}". ${adviseState(block.state)}`;
        diagnostics.push(this.diagnostic(range, block.state, setting, SIDECAR_SOURCE, message));
      }
    }

    if (diagnostics.length) {
      this.collection.set(document.uri, diagnostics);
    } else {
      this.collection.delete(document.uri);
    }
  }

  private diagnostic(
    range: vscode.Range,
    state: BlockState,
    setting: SeveritySetting,
    source: string,
    detail: string
  ): vscode.Diagnostic {
    const severity = !isDrift(state)
      ? vscode.DiagnosticSeverity.Information
      : setting === 'hint'
        ? vscode.DiagnosticSeverity.Hint
        : setting === 'information'
          ? vscode.DiagnosticSeverity.Information
          : vscode.DiagnosticSeverity.Warning;
    const message =
      source === INLINE_SOURCE ? `Lugus: ${describeState(state)}. ${detail}` : `Lugus: ${detail}`;
    const diagnostic = new vscode.Diagnostic(range, message, severity);
    diagnostic.source = source;
    diagnostic.code = state;
    return diagnostic;
  }

  private async recheck(uri: vscode.Uri): Promise<void> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) {
      await this.refresh(open);
    } else {
      await this.recheckIfTracked(uri);
    }
  }

  private async recheckIfTracked(uri: vscode.Uri): Promise<void> {
    if (!this.collection.has(uri)) {
      return;
    }
    try {
      await this.refresh(await vscode.workspace.openTextDocument(uri));
    } catch {
      this.collection.delete(uri);
    }
  }

  public async provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): Promise<vscode.CodeAction[]> {
    const actions: vscode.CodeAction[] = [];
    let sidecarBlocks: Awaited<ReturnType<Sidecar['blocks']>> | undefined;

    const action = (title: string, command: string, args: unknown[], diagnostic: vscode.Diagnostic) => {
      const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      a.command = { title, command, arguments: args };
      a.diagnostics = [diagnostic];
      return a;
    };

    for (const diagnostic of context.diagnostics) {
      const state = diagnostic.code as BlockState;
      if (diagnostic.source === INLINE_SOURCE) {
        const args = [document.uri, diagnostic.range.start.line];
        const update = action('Lugus: Update code to match the rule', 'lugus.translate', args, diagnostic);
        const accept = action('Lugus: Accept block as aligned', 'lugus.accept', args, diagnostic);
        const restore = action('Lugus: Restore last aligned code', 'lugus.restore', args, diagnostic);
        actions.push(...orderActions(state, update, accept, restore));
      } else if (diagnostic.source === SIDECAR_SOURCE) {
        sidecarBlocks ??= await this.sidecar.blocks(document);
        const block = sidecarBlocks.blocks.find((b) => b.line === diagnostic.range.start.line && b.state === state);
        if (!block?.exact) {
          continue;
        }
        const args = [document.uri, block.entry.id];
        if (state === 'orphaned') {
          actions.push(
            action('Lugus: Re-attach the rule to a symbol', 'lugus.sidecar.reattach', args, diagnostic),
            action('Lugus: Delete the rule', 'lugus.sidecar.detach', args, diagnostic)
          );
          continue;
        }
        const update = action('Lugus: Update code to match the rule', 'lugus.sidecar.update', args, diagnostic);
        const accept = action('Lugus: Accept as aligned', 'lugus.sidecar.accept', args, diagnostic);
        const restore = action('Lugus: Restore last aligned code', 'lugus.sidecar.restore', args, diagnostic);
        actions.push(...orderActions(state, update, accept, restore));
      }
    }
    return actions;
  }

  /**
   * Scans the workspace: inline blocks (files are pre-filtered on raw bytes, so
   * only files with a marker are opened) and every sidecar rules file.
   */
  public async scanWorkspace(token?: vscode.CancellationToken): Promise<{ checked: number; entries: DriftEntry[] }> {
    const entries: DriftEntry[] = [];
    let checked = 0;
    const needsAttention = (state: BlockState) => isDrift(state) || state === 'unverified';

    const uris = await vscode.workspace.findFiles('**/*', WORKSPACE_EXCLUDE, MAX_WORKSPACE_FILES, token);
    const marker = Buffer.from('</lugus>');
    for (let i = 0; i < uris.length; i += 50) {
      if (token?.isCancellationRequested) {
        break;
      }
      const batch = await Promise.all(
        uris.slice(i, i + 50).map(async (uri) => {
          if (uri.path.includes(`/${SIDECAR_DIR}/`)) {
            return null;
          }
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
        void this.refresh(document);
        for (const block of getBlocks(document)) {
          if (block.markerLine === null) {
            continue;
          }
          checked++;
          if (needsAttention(block.state)) {
            entries.push({ uri, line: block.promptStart, state: block.state, rule: block.ruleLines, sidecar: false });
          }
        }
      }
    }

    const sidecarFiles = await vscode.workspace.findFiles(`**/${SIDECAR_DIR}/**/*.json`, '**/node_modules/**', undefined, token);
    for (const jsonUri of sidecarFiles) {
      if (token?.isCancellationRequested) {
        break;
      }
      const source = this.sidecar.sourceUri(jsonUri);
      if (!source) {
        continue;
      }
      let document: vscode.TextDocument | undefined;
      try {
        document = await vscode.workspace.openTextDocument(source);
      } catch {
        // Source file gone: every rule in the sidecar is orphaned.
        try {
          const file = parseSidecar(new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(jsonUri)));
          for (const entry of file.blocks) {
            checked++;
            entries.push({ uri: jsonUri, line: 0, state: 'orphaned', rule: entry.rule, sidecar: true });
          }
        } catch {
          // unreadable sidecar for a missing file: nothing useful to report
        }
        continue;
      }
      void this.refresh(document);
      for (const block of (await this.sidecar.blocks(document)).blocks) {
        checked++;
        if (needsAttention(block.state)) {
          entries.push({ uri: source, line: block.line, state: block.state, rule: block.entry.rule, sidecar: true });
        }
      }
    }
    return { checked, entries };
  }
}

function orderActions(
  state: BlockState,
  update: vscode.CodeAction,
  accept: vscode.CodeAction,
  restore: vscode.CodeAction
): vscode.CodeAction[] {
  if (state === 'code-edited') {
    // Hand edits are usually intentional: offer Accept first, then Restore.
    return [accept, restore, update];
  }
  if (state === 'both-changed') {
    return [update, accept, restore];
  }
  return [update, accept];
}

/** Command: scan the workspace and let the user jump to a block that needs attention. */
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
    .sort((a, b) => Number(isDrift(b.state)) - Number(isDrift(a.state)))
    .map((entry) => ({
      label: `${isDrift(entry.state) ? '$(warning)' : '$(question)'} ${entry.rule.join(' ')}`,
      description: `${describeState(entry.state)} · ${vscode.workspace.asRelativePath(entry.uri)}:${entry.line + 1}${entry.sidecar ? ' · sidecar' : ''}`,
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
  const position = new vscode.Position(pick.entry.line, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

import * as vscode from 'vscode';
import { BlockState } from './core/blocks';
import {
  emptySidecar,
  entryState,
  fileSymbol,
  isFileEntry,
  entryStateWithoutSymbols,
  parseSidecar,
  resolveAnchor,
  serializeSidecar,
  SidecarEntry,
  SidecarFile,
  sidecarPathFor,
  SIDECAR_DIR,
  sourcePathFor,
  SymbolInfo
} from './core/sidecar';
import { documentLines } from './commentParser';

/** A sidecar rule as seen in an open document. */
export interface SidecarBlock {
  entry: SidecarEntry;
  state: BlockState;
  /**
   * The symbol the rule is attached to, from the language's symbol provider.
   * Null when the rule is orphaned or the provider is not available yet.
   */
  symbol: SymbolInfo | null;
  /** Line where the status is shown (symbol start, best guess, or 0 for orphans). */
  line: number;
  /** True when the state comes from real symbols. Edits are only allowed then. */
  exact: boolean;
}

export interface SidecarBlocksResult {
  blocks: SidecarBlock[];
  /** Set when the sidecar file exists but cannot be read. */
  error?: string;
  sidecarUri?: vscode.Uri;
}

function relativeTo(folder: vscode.Uri, uri: vscode.Uri): string | undefined {
  const base = folder.path.endsWith('/') ? folder.path : `${folder.path}/`;
  return uri.path.startsWith(base) ? uri.path.slice(base.length) : undefined;
}

/** Flattens DocumentSymbol trees or SymbolInformation lists into dotted paths. */
function flattenSymbols(items: Array<vscode.DocumentSymbol | vscode.SymbolInformation>): SymbolInfo[] {
  const result: SymbolInfo[] = [];
  const kindName = (kind: vscode.SymbolKind) => String(vscode.SymbolKind[kind] ?? kind);
  const visit = (symbol: vscode.DocumentSymbol, prefix: string) => {
    const path = prefix ? `${prefix}.${symbol.name}` : symbol.name;
    result.push({ path, kind: kindName(symbol.kind), startLine: symbol.range.start.line, endLine: symbol.range.end.line });
    symbol.children?.forEach((child) => visit(child, path));
  };
  for (const item of items) {
    if ('children' in item) {
      visit(item, '');
    } else if ('location' in item) {
      const path = item.containerName ? `${item.containerName}.${item.name}` : item.name;
      result.push({
        path,
        kind: kindName(item.kind),
        startLine: item.location.range.start.line,
        endLine: item.location.range.end.line
      });
    }
  }
  return result;
}

/**
 * Reads and writes `.lugus/rules/<path>.json` next to the workspace sources,
 * and resolves rules against the symbols of open documents.
 */
export class Sidecar implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  /** Fires with the SOURCE uri whose rules changed (by Lugus or on disk). */
  public readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [this.emitter];

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher(`**/${SIDECAR_DIR}/**/*.json`);
    const fire = (jsonUri: vscode.Uri) => {
      const source = this.sourceUri(jsonUri);
      if (source) {
        this.emitter.fire(source);
      }
    };
    this.disposables.push(
      watcher,
      watcher.onDidChange(fire),
      watcher.onDidCreate(fire),
      watcher.onDidDelete(fire),
      vscode.workspace.onDidRenameFiles((event) => event.files.forEach((f) => void this.followRename(f.oldUri, f.newUri)))
    );
  }

  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  /** Sidecar file for a source file; undefined outside a workspace folder or for sidecar files themselves. */
  public sidecarUri(source: vscode.Uri): vscode.Uri | undefined {
    if (source.scheme !== 'file') {
      return undefined;
    }
    const folder = vscode.workspace.getWorkspaceFolder(source);
    const rel = folder && relativeTo(folder.uri, source);
    if (!folder || !rel || rel.startsWith('.lugus/')) {
      return undefined;
    }
    return vscode.Uri.joinPath(folder.uri, ...sidecarPathFor(rel).split('/'));
  }

  public sourceUri(sidecar: vscode.Uri): vscode.Uri | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(sidecar);
    const rel = folder && relativeTo(folder.uri, sidecar);
    const source = rel && sourcePathFor(rel);
    return folder && source ? vscode.Uri.joinPath(folder.uri, ...source.split('/')) : undefined;
  }

  /** Rules for a source file. Missing file = no rules. Throws if the file is unreadable or malformed. */
  public async read(source: vscode.Uri): Promise<SidecarFile> {
    const uri = this.sidecarUri(source);
    if (!uri) {
      return emptySidecar();
    }
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return emptySidecar();
    }
    try {
      return parseSidecar(new TextDecoder('utf-8').decode(bytes));
    } catch (err) {
      throw new Error(
        `${vscode.workspace.asRelativePath(uri)}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Writes the rules for a source file; removes the sidecar file when no rules are left. */
  public async write(source: vscode.Uri, file: SidecarFile): Promise<void> {
    const uri = this.sidecarUri(source);
    if (!uri) {
      throw new Error('Sidecar rules need the file to be inside an open workspace folder.');
    }
    if (file.blocks.length === 0) {
      try {
        await vscode.workspace.fs.delete(uri);
      } catch {
        // already gone
      }
    } else {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(serializeSidecar(file)));
    }
    this.emitter.fire(source);
  }

  /** Applies `change` to the stored rules of `source` (read-modify-write). */
  public async update(source: vscode.Uri, change: (blocks: SidecarEntry[]) => SidecarEntry[]): Promise<void> {
    const file = await this.read(source);
    await this.write(source, { version: 1, blocks: change(file.blocks) });
  }

  /** Symbols of the document, or null when no symbol provider answered (yet). */
  public async symbols(document: vscode.TextDocument): Promise<SymbolInfo[] | null> {
    try {
      const result = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
        'vscode.executeDocumentSymbolProvider',
        document.uri
      );
      return result && result.length ? flattenSymbols(result) : null;
    } catch {
      return null;
    }
  }

  public async blocks(document: vscode.TextDocument): Promise<SidecarBlocksResult> {
    const sidecarUri = this.sidecarUri(document.uri);
    if (!sidecarUri) {
      return { blocks: [] };
    }
    let file: SidecarFile;
    try {
      file = await this.read(document.uri);
    } catch (err) {
      return { blocks: [], error: err instanceof Error ? err.message : String(err), sidecarUri };
    }
    if (!file.blocks.length) {
      return { blocks: [], sidecarUri };
    }
    const lines = documentLines(document);
    // File rules need no symbols: their region is the whole file.
    const symbols = file.blocks.some((e) => !isFileEntry(e)) ? await this.symbols(document) : null;
    const blocks = file.blocks.map((entry): SidecarBlock => {
      if (isFileEntry(entry)) {
        const whole = fileSymbol(lines);
        return { entry, state: entryState(entry, lines, whole), symbol: whole, line: 0, exact: true };
      }
      if (symbols) {
        const symbol = resolveAnchor(entry, symbols, lines) ?? null;
        return {
          entry,
          state: entryState(entry, lines, symbol ?? undefined),
          symbol,
          line: symbol ? symbol.startLine : 0,
          exact: true
        };
      }
      const guess = entryStateWithoutSymbols(entry, lines);
      return { entry, state: guess.state, symbol: null, line: guess.line, exact: false };
    });
    return { blocks, sidecarUri };
  }

  /** Rule of the whole file, if it has one (sent as context when updating code inside it). */
  public async fileRule(source: vscode.Uri): Promise<string | undefined> {
    try {
      const entry = (await this.read(source)).blocks.find(isFileEntry);
      return entry?.rule.join('\n');
    } catch {
      return undefined;
    }
  }

  /** Keeps rules attached when a source file or folder is renamed or moved. */
  private async followRename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const from = this.sidecarUri(oldUri);
    const to = this.sidecarUri(newUri);
    if (!from || !to) {
      return;
    }
    // A renamed folder maps to the folder of the same name under .lugus/rules (no .json suffix).
    const candidates: Array<[vscode.Uri, vscode.Uri]> = [
      [from, to],
      [from.with({ path: from.path.slice(0, -'.json'.length) }), to.with({ path: to.path.slice(0, -'.json'.length) })]
    ];
    for (const [source, target] of candidates) {
      try {
        await vscode.workspace.fs.stat(source);
      } catch {
        continue;
      }
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
      await vscode.workspace.fs.rename(source, target, { overwrite: false });
      this.emitter.fire(newUri);
    }
  }
}

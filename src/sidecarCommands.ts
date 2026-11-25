import * as vscode from 'vscode';
import { formatPromptLine, getCommentToken, hashRule, isMarkerLine, isPromptLine } from './core/blocks';
import {
  fileSymbol,
  findEntryCodeIn,
  isFileEntry,
  LINKABLE_KINDS,
  makeEntry,
  newEntryId,
  regionText,
  SidecarEntry,
  symbolAt,
  SymbolInfo
} from './core/sidecar';
import { SnapshotStore } from './core/snapshots';
import { applyIndentation, canonicalCode, canonicalRule, commonIndent, dedent, splitLines } from './core/text';
import { documentLines, getBlockAt } from './commentParser';
import { editorFor, lineSpan, readCommittedVersion, reportError, UserFacingError, withEol } from './editorUtils';
import { ModelClient } from './model';
import { reviewReplacement } from './reviewReplacement';
import { Sidecar, SidecarBlock } from './sidecar';

interface Found {
  document: vscode.TextDocument;
  block: SidecarBlock;
}

interface Region {
  start: number;
  end: number;
  symbol: SymbolInfo;
}

/** Above this size, updating a whole-file rule asks first (the model must return the entire file). */
const LARGE_FILE_LINES = 300;

const NOT_READY =
  'Lugus: this file’s symbols are not available yet (the language extension is still loading or not installed). Try again in a moment.';

/**
 * Commands for sidecar rules. They take (uri, ruleId) from CodeLens and quick
 * fixes, or nothing (the rule attached to the symbol at the cursor).
 *
 * Every edit to code requires real symbols from the language's provider and
 * re-checks that the region still holds exactly the text it started from.
 */
export class SidecarCommands {
  constructor(
    private readonly sidecar: Sidecar,
    private readonly snapshots: SnapshotStore,
    private readonly model: ModelClient,
    private readonly busyDocuments: Set<string>,
    private readonly refresh: () => void
  ) {}

  public register(): vscode.Disposable[] {
    const cmd = (id: string, fn: (...args: unknown[]) => Promise<void>) =>
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await fn(...args);
        } catch (err) {
          reportError(err, this.model.timeoutMs());
        } finally {
          this.refresh();
        }
      });
    return [
      cmd('lugus.sidecar.update', (u, i) => this.update(u, i)),
      cmd('lugus.sidecar.accept', (u, i) => this.accept(u, i)),
      cmd('lugus.sidecar.restore', (u, i) => this.restore(u, i)),
      cmd('lugus.sidecar.editRule', (u, i) => this.editRule(u, i)),
      cmd('lugus.sidecar.detach', (u, i) => this.detach(u, i)),
      cmd('lugus.sidecar.reattach', (u, i) => this.reattach(u, i)),
      cmd('lugus.sidecar.openRules', (u) => this.openRules(u)),
      cmd('lugus.moveToSidecar', (u, l) => this.moveToSidecar(u, l)),
      cmd('lugus.moveInline', (u, i) => this.moveInline(u, i))
    ];
  }

  /** True when a sidecar rule is attached to a symbol containing `line` in `document`. */
  public async hasRuleAt(document: vscode.TextDocument, line: number): Promise<boolean> {
    return (await this.blockAt(document, line)) !== undefined;
  }

  // ----------------------------------------------------------------- lookup

  private async blockAt(document: vscode.TextDocument, line: number): Promise<SidecarBlock | undefined> {
    const { blocks } = await this.sidecar.blocks(document);
    return blocks
      .filter((b) => b.symbol && line >= b.symbol.startLine && line <= b.symbol.endLine)
      .sort((a, b) => a.symbol!.endLine - a.symbol!.startLine - (b.symbol!.endLine - b.symbol!.startLine))[0];
  }

  private async find(uriArg: unknown, idArg: unknown): Promise<Found | null> {
    if (uriArg instanceof vscode.Uri && typeof idArg === 'string') {
      const document = await vscode.workspace.openTextDocument(uriArg);
      const block = (await this.sidecar.blocks(document)).blocks.find((b) => b.entry.id === idArg);
      if (!block) {
        vscode.window.setStatusBarMessage('Lugus: this rule no longer exists.', 4000);
        return null;
      }
      return { document, block };
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return null;
    }
    const block = await this.blockAt(editor.document, editor.selection.active.line);
    if (!block) {
      vscode.window.setStatusBarMessage('Lugus: no sidecar rule is attached to the symbol at the cursor.', 4000);
      return null;
    }
    return { document: editor.document, block };
  }

  /** The block's region when edits are allowed; otherwise explains why not. */
  private region(found: Found): Region | null {
    const { block } = found;
    if (!block.exact) {
      vscode.window.showWarningMessage(NOT_READY);
      return null;
    }
    if (!block.symbol) {
      vscode.window.showInformationMessage(
        `Lugus: the symbol "${block.entry.anchor.symbol}" no longer exists. Re-attach the rule or delete it.`
      );
      return null;
    }
    return { start: block.symbol.startLine, end: block.symbol.endLine, symbol: block.symbol };
  }

  /** Re-finds the rule's region and checks it still holds `expected`. */
  private async relocate(document: vscode.TextDocument, id: string, expected: string): Promise<Region | null> {
    const block = (await this.sidecar.blocks(document)).blocks.find((b) => b.entry.id === id);
    if (!block?.exact || !block.symbol) {
      return null;
    }
    const lines = documentLines(document);
    const { startLine, endLine } = block.symbol;
    return regionText(lines, startLine, endLine) === expected ? { start: startLine, end: endLine, symbol: block.symbol } : null;
  }

  private async replaceRegion(document: vscode.TextDocument, region: Region, text: string): Promise<void> {
    const editor = await editorFor(document);
    const ok = await editor.edit((edit) => edit.replace(lineSpan(document, region.start, region.end), withEol(document, text)));
    if (!ok) {
      throw new UserFacingError('Could not apply the change. Make sure the file is still open and editable.');
    }
  }

  private async alignedCode(document: vscode.TextDocument, entry: SidecarEntry): Promise<string | undefined> {
    const local = this.snapshots.get(entry.code);
    if (local !== undefined) {
      return local;
    }
    const committed = await readCommittedVersion(document.uri);
    return committed === undefined ? undefined : findEntryCodeIn(committed, entry);
  }

  /** Records the rule and the region's current code as aligned. No model call. */
  private async restamp(document: vscode.TextDocument, id: string, rule: string[], region: Region): Promise<void> {
    const lines = documentLines(document);
    await this.sidecar.update(document.uri, (blocks) =>
      blocks.map((e) => (e.id === id ? makeEntry(id, rule, { ...region.symbol, startLine: region.start, endLine: region.end }, lines) : e))
    );
    await this.snapshots.remember(regionText(lines, region.start, region.end));
  }

  // ---------------------------------------------------------------- actions

  private async update(uriArg: unknown, idArg: unknown): Promise<void> {
    const found = await this.find(uriArg, idArg);
    const region = found && this.region(found);
    if (!found || !region) {
      return;
    }
    const { document, block } = found;
    const key = document.uri.toString();
    if (this.busyDocuments.has(key)) {
      vscode.window.showInformationMessage('Lugus: a request for this file is already running.');
      return;
    }
    if (block.state === 'aligned') {
      const pick = await vscode.window.showInformationMessage('Lugus: this code already matches its rule.', 'Update Anyway');
      if (pick !== 'Update Anyway') {
        return;
      }
    }

    const fileRule = isFileEntry(block.entry);
    const lineCount = region.end - region.start + 1;
    if (fileRule && lineCount > LARGE_FILE_LINES) {
      const pick = await vscode.window.showWarningMessage(
        `Lugus: this file has ${lineCount} lines. To follow a whole-file rule the model must return the entire file: it can be slow and may hit the output limit (nothing is applied if it does).`,
        { modal: true },
        'Update Anyway'
      );
      if (pick !== 'Update Anyway') {
        return;
      }
    }

    this.busyDocuments.add(key);
    try {
      const lines = documentLines(document);
      const currentCode = regionText(lines, region.start, region.end);
      const generated = await this.model.generate({
        document,
        mode: 'update',
        rule: block.entry.rule.join('\n'),
        currentCode: dedent(currentCode),
        blockStart: region.start,
        blockEnd: region.end,
        fileRule: fileRule ? undefined : await this.sidecar.fileRule(document.uri)
      });
      if (generated === null) {
        return;
      }
      const newCode = applyIndentation(generated, commonIndent(lines.slice(region.start, region.end + 1)));

      let current = await this.relocate(document, block.entry.id, currentCode);
      if (!current) {
        throw new UserFacingError('The code changed while Lugus was working. Nothing was applied; run the command again.');
      }

      if (canonicalCode(newCode) === canonicalCode(currentCode)) {
        if (block.state === 'code-edited' || block.state === 'both-changed') {
          const aligned = await this.alignedCode(document, block.entry);
          const pick = await vscode.window.showInformationMessage(
            'Lugus: the model says the current code, hand edits included, already satisfies the rule. Keep it, or go back to the last aligned version?',
            ...(aligned !== undefined ? ['Accept Current Code', 'Restore Last Aligned'] : ['Accept Current Code'])
          );
          if (pick === 'Accept Current Code') {
            await this.restamp(document, block.entry.id, block.entry.rule, current);
          } else if (pick === 'Restore Last Aligned' && aligned !== undefined) {
            await this.restoreRegion(document, block, current, aligned);
          }
          return;
        }
        await this.restamp(document, block.entry.id, block.entry.rule, current);
        vscode.window.showInformationMessage('Lugus: the code already implements this rule. Marked as aligned.');
        return;
      }

      const approved = await reviewReplacement(
        document,
        currentCode,
        newCode,
        `Lugus: review the proposed change to ${label(block.entry)}.`
      );
      if (!approved) {
        return;
      }
      current = await this.relocate(document, block.entry.id, currentCode);
      if (!current) {
        throw new UserFacingError('The code changed during the review. Nothing was applied; run the command again.');
      }
      await this.replaceRegion(document, current, newCode);

      // Record the alignment from the new text, without waiting for the language server.
      const newEnd = current.start + splitLines(newCode).length - 1;
      const newLines = documentLines(document);
      const usedRule = block.entry.rule;
      await this.sidecar.update(document.uri, (blocks) =>
        blocks.map((e) => {
          if (e.id !== block.entry.id) {
            return e;
          }
          const fresh = makeEntry(e.id, usedRule, { ...current!.symbol, startLine: current!.start, endLine: newEnd }, newLines);
          // If the rule was edited while the model was working, keep that edit (it will show as "rule changed").
          return { ...fresh, rule: e.rule, ruleHash: hashRule(usedRule) };
        })
      );
      await this.snapshots.remember(newCode);
    } finally {
      this.busyDocuments.delete(key);
    }
  }

  private async accept(uriArg: unknown, idArg: unknown): Promise<void> {
    const found = await this.find(uriArg, idArg);
    const region = found && this.region(found);
    if (!found || !region) {
      return;
    }
    await this.restamp(found.document, found.block.entry.id, found.block.entry.rule, region);
  }

  private async restore(uriArg: unknown, idArg: unknown): Promise<void> {
    const found = await this.find(uriArg, idArg);
    const region = found && this.region(found);
    if (!found || !region) {
      return;
    }
    if (found.block.state !== 'code-edited' && found.block.state !== 'both-changed') {
      vscode.window.setStatusBarMessage('Lugus: nothing to restore, the code matches its last aligned version.', 4000);
      return;
    }
    const aligned = await this.alignedCode(found.document, found.block.entry);
    if (aligned === undefined) {
      vscode.window.showWarningMessage(
        'Lugus: no copy of the last aligned code was found (neither saved by Lugus nor in the last commit). Use Undo or your version control.'
      );
      return;
    }
    await this.restoreRegion(found.document, found.block, region, aligned);
  }

  private async restoreRegion(document: vscode.TextDocument, block: SidecarBlock, region: Region, code: string): Promise<void> {
    const lines = documentLines(document);
    const currentCode = regionText(lines, region.start, region.end);
    const restored = applyIndentation(code, commonIndent(lines.slice(region.start, region.end + 1)));
    const approved = await reviewReplacement(
      document,
      currentCode,
      restored,
      `Lugus: restore ${label(block.entry)} as it was when it last matched the rule?`
    );
    if (!approved) {
      return;
    }
    const current = await this.relocate(document, block.entry.id, currentCode);
    if (!current) {
      throw new UserFacingError('The code changed during the review. Nothing was restored; run the command again.');
    }
    await this.replaceRegion(document, current, restored);
  }

  private async editRule(uriArg: unknown, idArg: unknown): Promise<void> {
    const found = await this.find(uriArg, idArg);
    if (!found) {
      return;
    }
    const { entry } = found.block;
    const value = await vscode.window.showInputBox({
      title: `Lugus: Rule for ${label(entry)}`,
      prompt:
        'Edit the rule. The code is not changed now: use Update Code when you want it to follow. For a multi-line rule, edit the .lugus rules file.',
      value: entry.rule.join(' '),
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'The rule cannot be empty. Use Detach to remove it.')
    });
    if (!value?.trim() || canonicalRule([value]) === canonicalRule(entry.rule)) {
      return;
    }
    await this.sidecar.update(found.document.uri, (blocks) =>
      blocks.map((e) => (e.id === entry.id ? { ...e, rule: [value.trim()] } : e))
    );
  }

  private async detach(uriArg: unknown, idArg: unknown): Promise<void> {
    const found = await this.find(uriArg, idArg);
    if (!found) {
      return;
    }
    const { entry } = found.block;
    const pick = await vscode.window.showWarningMessage(
      `Delete the rule for ${label(entry)}? The code is kept.`,
      { modal: true, detail: entry.rule.join('\n') },
      'Delete Rule'
    );
    if (pick !== 'Delete Rule') {
      return;
    }
    await this.sidecar.update(found.document.uri, (blocks) => blocks.filter((e) => e.id !== entry.id));
  }

  private async reattach(uriArg: unknown, idArg: unknown): Promise<void> {
    const found = await this.find(uriArg, idArg);
    if (!found || isFileEntry(found.block.entry)) {
      return;
    }
    const symbols = await this.sidecar.symbols(found.document);
    if (!symbols) {
      vscode.window.showWarningMessage(NOT_READY);
      return;
    }
    const lines = documentLines(found.document);
    const items = symbols
      .filter((s) => LINKABLE_KINDS.has(s.kind))
      .map((s) => ({ label: s.path, description: `${s.kind} · line ${s.startLine + 1}`, symbol: s }));
    const pick = await vscode.window.showQuickPick(items, {
      title: `Lugus: attach "${found.block.entry.rule.join(' ')}" to…`,
      placeHolder: 'Pick the function, method or class this rule describes'
    });
    if (!pick) {
      return;
    }
    const { anchor } = makeEntry(found.block.entry.id, found.block.entry.rule, pick.symbol, lines);
    // Fingerprints are kept: if the new symbol's code differs, the rule shows as "code edited".
    await this.sidecar.update(found.document.uri, (blocks) =>
      blocks.map((e) => (e.id === found.block.entry.id ? { ...e, anchor } : e))
    );
  }

  private async openRules(uriArg: unknown): Promise<void> {
    const source = uriArg instanceof vscode.Uri ? uriArg : vscode.window.activeTextEditor?.document.uri;
    const uri = source && this.sidecar.sidecarUri(source);
    if (!uri) {
      vscode.window.showInformationMessage('Lugus: sidecar rules are only available for files inside a workspace folder.');
      return;
    }
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      vscode.window.showInformationMessage('Lugus: this file has no sidecar rules yet.');
      return;
    }
    await vscode.window.showTextDocument(uri);
  }

  // ------------------------------------------------------------------- link

  /** Attaches a new rule to the function, method or class at the cursor. No model call. */
  public async link(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const { document } = editor;
    if (!this.sidecar.sidecarUri(document.uri)) {
      vscode.window.showInformationMessage('Lugus: sidecar rules need the file to be inside an open workspace folder.');
      return;
    }
    const symbols = await this.sidecar.symbols(document);
    if (!symbols) {
      vscode.window.showWarningMessage(NOT_READY);
      return;
    }
    const symbol = symbolAt(symbols, editor.selection.start.line);
    if (!symbol) {
      vscode.window.showInformationMessage('Lugus: place the cursor inside a function, method or class to attach a rule to it.');
      return;
    }
    const lines = documentLines(document);
    const token = getCommentToken(document.languageId);
    if (lines.slice(symbol.startLine, symbol.endLine + 1).some((l) => isPromptLine(l, token) || isMarkerLine(l, token))) {
      vscode.window.showInformationMessage(`Lugus: ${symbol.path} contains inline Lugus blocks. Keep it inline, or detach them first.`);
      return;
    }
    const existing = (await this.sidecar.blocks(document)).blocks.find(
      (b) => !isFileEntry(b.entry) && b.symbol && b.symbol.startLine === symbol.startLine && b.symbol.endLine === symbol.endLine
    );
    if (existing) {
      vscode.window.showInformationMessage(`Lugus: ${symbol.path} already has a rule. Use Edit Rule to change it.`);
      return;
    }

    const version = document.version;
    const rule = await vscode.window.showInputBox({
      title: `Lugus: Rule for ${symbol.path}`,
      prompt: 'Describe, in your own words, the rule this code implements. It is stored in .lugus/rules, not in the source.',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'Enter the rule for this code.')
    });
    if (!rule?.trim()) {
      return;
    }
    if (document.isClosed || document.version !== version) {
      vscode.window.showWarningMessage('Lugus: the file changed while you were typing. Run the command again.');
      return;
    }
    const current = documentLines(document);
    await this.sidecar.update(document.uri, (blocks) => [
      ...blocks,
      makeEntry(newEntryId(blocks), [rule.trim()], symbol, current)
    ]);
    await this.snapshots.remember(regionText(current, symbol.startLine, symbol.endLine));
  }

  /** Attaches a rule to the whole file. Works for any file type: no symbols needed. No model call. */
  public async linkFile(uriArg: unknown): Promise<void> {
    const uri = uriArg instanceof vscode.Uri ? uriArg : vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      return;
    }
    if (!this.sidecar.sidecarUri(uri)) {
      vscode.window.showInformationMessage('Lugus: file rules need the file to be inside an open workspace folder.');
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const name = vscode.workspace.asRelativePath(uri);
    if ((await this.sidecar.read(uri)).blocks.some(isFileEntry)) {
      vscode.window.showInformationMessage(`Lugus: ${name} already has a file rule. Use Edit Rule to change it.`);
      return;
    }
    const version = document.version;
    const rule = await vscode.window.showInputBox({
      title: `Lugus: Rule for the whole file ${name}`,
      prompt:
        'Describe what this file is and the rules it must respect. It is stored in .lugus/rules and is also given to the model as a constraint when code inside this file is updated.',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'Enter the rule for this file.')
    });
    if (!rule?.trim()) {
      return;
    }
    if (document.isClosed || document.version !== version) {
      vscode.window.showWarningMessage('Lugus: the file changed while you were typing. Run the command again.');
      return;
    }
    const lines = documentLines(document);
    const whole = fileSymbol(lines);
    await this.sidecar.update(uri, (blocks) => [...blocks, makeEntry(newEntryId(blocks), [rule.trim()], whole, lines)]);
    await this.snapshots.remember(regionText(lines, whole.startLine, whole.endLine));
  }

  // -------------------------------------------------------------- migration

  /** Inline linked block → sidecar rule. Fingerprints (and so the drift state) are kept. */
  private async moveToSidecar(uriArg: unknown, lineArg: unknown): Promise<void> {
    const editor =
      uriArg instanceof vscode.Uri ? await vscode.window.showTextDocument(uriArg) : vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const { document } = editor;
    const block = getBlockAt(document, typeof lineArg === 'number' ? lineArg : editor.selection.active.line);
    if (!block || block.markerLine === null) {
      vscode.window.setStatusBarMessage('Lugus: place the cursor inside a linked inline block.', 4000);
      return;
    }
    if (!block.marker?.codeHash || !block.marker.ruleHash) {
      vscode.window.showInformationMessage('Lugus: this block has no fingerprints yet. Accept it first, then move it.');
      return;
    }
    if (!this.sidecar.sidecarUri(document.uri)) {
      vscode.window.showInformationMessage('Lugus: sidecar rules need the file to be inside an open workspace folder.');
      return;
    }
    const symbols = await this.sidecar.symbols(document);
    if (!symbols) {
      vscode.window.showWarningMessage(NOT_READY);
      return;
    }
    let bodyStart = block.promptEnd + 1;
    let bodyEnd = block.markerLine - 1;
    while (bodyStart <= bodyEnd && !block.body[bodyStart - block.promptEnd - 1].trim()) {
      bodyStart++;
    }
    while (bodyEnd >= bodyStart && !block.body[bodyEnd - block.promptEnd - 1].trim()) {
      bodyEnd--;
    }
    const symbol = symbols.find((s) => LINKABLE_KINDS.has(s.kind) && s.startLine === bodyStart && s.endLine === bodyEnd);
    if (!symbol) {
      vscode.window.showInformationMessage(
        'Lugus: sidecar rules attach to a whole function, method or class, and this block is not exactly one. Keep it inline.'
      );
      return;
    }

    const lines = documentLines(document);
    const headerCount = block.promptEnd - block.promptStart + 1;
    const markerLine = block.markerLine;
    const ok = await editor.edit((edit) => {
      edit.delete(new vscode.Range(block.promptStart, 0, block.promptEnd + 1, 0));
      edit.delete(new vscode.Range(document.lineAt(markerLine - 1).range.end, document.lineAt(markerLine).range.end));
    });
    if (!ok) {
      throw new UserFacingError('Could not remove the inline markers. Nothing was moved.');
    }
    try {
      await this.sidecar.update(document.uri, (blocks) => [
        ...blocks,
        {
          id: newEntryId(blocks),
          rule: block.ruleLines,
          anchor: {
            symbol: symbol.path,
            kind: symbol.kind,
            line: symbol.startLine - headerCount,
            firstLine: lines[symbol.startLine].trim(),
            lineCount: symbol.endLine - symbol.startLine + 1
          },
          code: block.marker!.codeHash!,
          ruleHash: block.marker!.ruleHash!
        }
      ]);
    } catch (err) {
      throw new UserFacingError(
        `The rule could not be saved (${err instanceof Error ? err.message : String(err)}). Undo (Ctrl+Z) brings the inline block back.`
      );
    }
  }

  /** Sidecar rule → inline block around its symbol. Fingerprints are kept. */
  private async moveInline(uriArg: unknown, idArg: unknown): Promise<void> {
    const found = await this.find(uriArg, idArg);
    const region = found && this.region(found);
    if (!found || !region) {
      return;
    }
    const { document, block } = found;
    if (isFileEntry(block.entry)) {
      vscode.window.showInformationMessage('Lugus: whole-file rules live only in .lugus/rules: there is nothing to wrap inline.');
      return;
    }
    const lines = documentLines(document);
    const token = getCommentToken(document.languageId);
    if (region.start > 0 && isPromptLine(lines[region.start - 1], token)) {
      vscode.window.showInformationMessage('Lugus: there is an inline rule right above this symbol. Move or remove it first.');
      return;
    }
    if (lines.slice(region.start, region.end + 1).some((l) => isPromptLine(l, token) || isMarkerLine(l, token))) {
      vscode.window.showInformationMessage('Lugus: this symbol already contains inline Lugus blocks.');
      return;
    }
    const indent = lines[region.start].match(/^[\t ]*/)?.[0] ?? '';
    const header = block.entry.rule.map((r) => formatPromptLine(indent, token, r)).join('\n');
    const marker = `${indent}${token} </lugus> code:${block.entry.code} rule:${block.entry.ruleHash}`;
    const editor = await editorFor(document);
    const end = document.lineAt(region.end).range.end;
    const ok = await editor.edit((edit) => {
      edit.insert(new vscode.Position(region.start, 0), withEol(document, header + '\n'));
      edit.insert(end, withEol(document, '\n' + marker));
    });
    if (!ok) {
      throw new UserFacingError('Could not insert the inline block. Nothing was moved.');
    }
    await this.sidecar.update(document.uri, (blocks) => blocks.filter((e) => e.id !== block.entry.id));
  }
}

/** How a rule's target is named in messages. */
function label(entry: SidecarEntry): string {
  return isFileEntry(entry) ? 'this file' : entry.anchor.symbol;
}

import * as vscode from 'vscode';
import {
  blockEnd,
  findBlocks,
  formatMarker,
  formatPromptLine,
  getCommentToken,
  isMarkerLine,
  isPromptLine
} from './core/blocks';
import { commonIndent } from './core/text';
import { documentLines } from './commentParser';

/**
 * Links existing code to a rule the user writes. Purely local: no model call.
 * The code is kept exactly as it is; Lugus only adds the rule above it and a
 * fingerprinted marker below it.
 */
export async function linkSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const { document } = editor;
  if (editor.selections.length !== 1 || editor.selection.isEmpty) {
    vscode.window.showInformationMessage('Lugus: select the lines of code you want to link to a rule.');
    return;
  }

  // Work on whole lines. A selection ending at column 0 does not include that line.
  const selection = editor.selection;
  const firstLine = selection.start.line;
  const lastLine =
    selection.end.character === 0 && selection.end.line > firstLine ? selection.end.line - 1 : selection.end.line;

  const lines = documentLines(document);
  const token = getCommentToken(document.languageId);
  const selected = lines.slice(firstLine, lastLine + 1);

  if (!selected.some((line) => line.trim())) {
    vscode.window.showInformationMessage('Lugus: the selection contains no code.');
    return;
  }
  if (selected.some((line) => isPromptLine(line, token) || isMarkerLine(line, token))) {
    vscode.window.showInformationMessage('Lugus: the selection already contains Lugus lines. Select plain code only.');
    return;
  }
  const overlaps = findBlocks(lines, token).some(
    (block) => firstLine <= blockEnd(block) && lastLine >= block.promptStart
  );
  // A rule line right above the selection would merge with the new rule.
  const touchesRuleAbove = firstLine > 0 && isPromptLine(lines[firstLine - 1], token);
  if (overlaps || touchesRuleAbove) {
    vscode.window.showInformationMessage('Lugus: choose code outside existing Lugus blocks.');
    return;
  }

  const version = document.version;
  const rule = await vscode.window.showInputBox({
    title: 'Lugus: Link Selected Code',
    prompt: 'Describe, in your own words, the rule this code implements. You can add more //> lines later.',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'Enter the rule for this code.')
  });
  if (!rule?.trim()) {
    return;
  }
  if (document.isClosed || document.version !== version) {
    vscode.window.showWarningMessage('Lugus: the file changed while you were typing. Select the code again to link it.');
    return;
  }

  const ruleLines = [rule.trim()];
  const indent = commonIndent(selected);
  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const header = formatPromptLine(indent, token, ruleLines[0]);
  const marker = formatMarker(indent, token, selected.join('\n'), ruleLines);
  const lastRange = document.lineAt(lastLine).range;

  const applied = await editor.edit((edit) => {
    edit.insert(new vscode.Position(firstLine, 0), header + eol);
    edit.insert(lastRange.end, eol + marker);
  });
  if (!applied) {
    vscode.window.showWarningMessage('Lugus: could not link this selection. Try again.');
  }
}

import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

/** An error whose message is meant for the user as is. */
export class UserFacingError extends Error {}

/** An editor showing `document`, opening one if needed (the diff view may have taken focus). */
export async function editorFor(document: vscode.TextDocument): Promise<vscode.TextEditor> {
  return (
    vscode.window.visibleTextEditors.find((e) => e.document === document) ??
    (await vscode.window.showTextDocument(document, { preserveFocus: false }))
  );
}

/** Converts `\n` to the document's line ending. */
export function withEol(document: vscode.TextDocument, text: string): string {
  return document.eol === vscode.EndOfLine.CRLF ? text.replace(/\n/g, '\r\n') : text;
}

/** Range covering whole lines `from`..`to`, including one line break. */
export function wholeLines(document: vscode.TextDocument, from: number, to: number): vscode.Range {
  if (to + 1 < document.lineCount) {
    return new vscode.Range(from, 0, to + 1, 0);
  }
  if (from > 0) {
    return new vscode.Range(document.lineAt(from - 1).range.end, document.lineAt(to).range.end);
  }
  return new vscode.Range(0, 0, to, document.lineAt(to).text.length);
}

/** Range of lines `from`..`to`, without the trailing line break. */
export function lineSpan(document: vscode.TextDocument, from: number, to: number): vscode.Range {
  return new vscode.Range(from, 0, to, document.lineAt(to).text.length);
}

/** The file as committed at HEAD, or undefined outside git / when untracked. */
export function readCommittedVersion(uri: vscode.Uri): Promise<string | undefined> {
  if (uri.scheme !== 'file') {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        ['show', `HEAD:./${path.basename(uri.fsPath)}`],
        { cwd: path.dirname(uri.fsPath), timeout: 5000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout) => resolve(error ? undefined : stdout)
      );
    } catch {
      resolve(undefined); // git missing or folder gone: no fallback, not an error
    }
  });
}

export function reportError(err: unknown, timeoutMs = 0): void {
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

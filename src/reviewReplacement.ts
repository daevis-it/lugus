import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { normalizeEol } from './core/text';

const APPLY = 'Apply';
const KEEP = 'Keep Current';

/**
 * Shows current vs proposed text in a diff editor and asks the user to choose.
 * Closing the diff tab counts as "Keep Current". Resolves to true only on Apply.
 */
export async function reviewReplacement(
  document: vscode.TextDocument,
  before: string,
  after: string,
  message: string
): Promise<boolean> {
  const scheme = `lugus-review-${randomUUID()}`;
  const filename = document.uri.path.split('/').pop() || 'block';
  const current = vscode.Uri.from({ scheme, path: `/current/${filename}` });
  const proposed = vscode.Uri.from({ scheme, path: `/proposed/${filename}` });
  const contents = new Map([
    [current.path, normalizeEol(before)],
    [proposed.path, normalizeEol(after)]
  ]);

  const disposables: vscode.Disposable[] = [
    vscode.workspace.registerTextDocumentContentProvider(scheme, {
      provideTextDocumentContent: (uri) => contents.get(uri.path) ?? ''
    })
  ];
  const isReviewTab = (tab: vscode.Tab) =>
    tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === scheme;

  try {
    await vscode.commands.executeCommand('vscode.diff', current, proposed, `Lugus: ${filename} (current ↔ proposed)`, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false
    });

    const tabClosed = new Promise<undefined>((resolve) => {
      disposables.push(
        vscode.window.tabGroups.onDidChangeTabs((event) => {
          if (event.closed.some(isReviewTab)) {
            resolve(undefined);
          }
        })
      );
    });

    const choice = await Promise.race([
      vscode.window.showInformationMessage(message, APPLY, KEEP),
      tabClosed
    ]);
    return choice === APPLY;
  } finally {
    const tab = vscode.window.tabGroups.all.flatMap((group) => group.tabs).find(isReviewTab);
    if (tab) {
      await vscode.window.tabGroups.close(tab, true);
    }
    disposables.forEach((d) => d.dispose());
  }
}

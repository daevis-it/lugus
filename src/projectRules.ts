import * as vscode from 'vscode';

const RULES_FILENAME = '.lugusrc';
const MAX_RULES_LENGTH = 8000;

/**
 * Reads optional project-level translation rules from `.lugusrc`
 * in the workspace folder owning the active document.
 */
export async function loadProjectRules(document: vscode.TextDocument): Promise<string | null> {
  const folder =
    vscode.workspace.getWorkspaceFolder(document.uri) ??
    vscode.workspace.workspaceFolders?.[0];

  if (!folder) {
    return null;
  }

  const rulesUri = vscode.Uri.joinPath(folder.uri, RULES_FILENAME);

  try {
    const bytes = await vscode.workspace.fs.readFile(rulesUri);
    const content = new TextDecoder('utf-8').decode(bytes).trim();
    if (!content) {
      return null;
    }
    return content.slice(0, MAX_RULES_LENGTH);
  } catch {
    // No .lugusrc present in the workspace root; silently ignore.
    return null;
  }
}
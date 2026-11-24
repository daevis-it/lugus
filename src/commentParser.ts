import * as vscode from 'vscode';

export interface CommentBlock {
  range: vscode.Range;
  prompt: string;
  indent: string;
  commentToken: string;
  rawLines: string[];
}

const HASH_LANGUAGES = new Set([
  'python',
  'shellscript',
  'bash',
  'ruby',
  'yaml',
  'dockerfile',
  'powershell',
  'toml',
  'gdscript',
  'perl',
  'r'
]);

const DASH_LANGUAGES = new Set([
  'sql',
  'lua',
  'haskell',
  'ada'
]);

/**
 * Resolves the single-line comment prefix for the given VS Code language ID.
 */
export function getCommentToken(languageId: string): string {
  if (HASH_LANGUAGES.has(languageId)) {
    return '#';
  }
  if (DASH_LANGUAGES.has(languageId)) {
    return '--';
  }
  return '//';
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extracts a contiguous block of pseudocode comments (e.g. `//>`, `#>`, `-->`)
 * surrounding the current cursor line.
 */
export function extractCommentBlock(
  document: vscode.TextDocument,
  cursorLine: number
): CommentBlock | null {
  const token = getCommentToken(document.languageId);
  const pattern = new RegExp(`^(\\s*)${escapeRegex(token)}>\\s?(.*)$`);

  if (!pattern.test(document.lineAt(cursorLine).text)) {
    return null;
  }

  let startLine = cursorLine;
  while (startLine > 0 && pattern.test(document.lineAt(startLine - 1).text)) {
    startLine--;
  }

  let endLine = cursorLine;
  while (
    endLine < document.lineCount - 1 &&
    pattern.test(document.lineAt(endLine + 1).text)
  ) {
    endLine++;
  }

  const rawLines: string[] = [];
  let indent = '';

  for (let i = startLine; i <= endLine; i++) {
    const match = document.lineAt(i).text.match(pattern);
    if (match) {
      if (i === startLine) {
        indent = match[1];
      }
      rawLines.push(match[2].trim());
    }
  }

  const range = new vscode.Range(
    new vscode.Position(startLine, 0),
    document.lineAt(endLine).range.end
  );

  return {
    range,
    prompt: rawLines.join('\n'),
    indent,
    commentToken: token,
    rawLines
  };
}

/**
 * Captures a narrow window of surrounding lines so the model can match
 * local variable names and conventions without sending the entire codebase.
 */
export function extractLocalContext(
  document: vscode.TextDocument,
  blockRange: vscode.Range,
  contextLines: number
): { before: string; after: string } {
  if (contextLines <= 0) {
    return { before: '', after: '' };
  }

  const beforeStart = Math.max(0, blockRange.start.line - contextLines);
  const beforeRange = new vscode.Range(
    new vscode.Position(beforeStart, 0),
    new vscode.Position(blockRange.start.line, 0)
  );

  let after = '';
  if (blockRange.end.line < document.lineCount - 1) {
    const afterStart = blockRange.end.line + 1;
    const afterEnd = Math.min(document.lineCount - 1, blockRange.end.line + contextLines);
    const afterRange = new vscode.Range(
      new vscode.Position(afterStart, 0),
      document.lineAt(afterEnd).range.end
    );
    after = document.getText(afterRange);
  }

  return {
    before: document.getText(beforeRange),
    after
  };
}
import * as vscode from 'vscode';

export interface CommentBlock {
  commentRange: vscode.Range;
  replaceRange: vscode.Range;
  isLinked: boolean;
  endMarkerLine: number | null;
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

function buildPatterns(token: string): { promptPattern: RegExp; endMarkerPattern: RegExp } {
  const escaped = escapeRegex(token);
  return {
    promptPattern: new RegExp(`^(\\s*)${escaped}>\\s?(.*)$`),
    endMarkerPattern: new RegExp(`^\\s*${escaped}\\s*</lugus>\\s*$`)
  };
}

/**
 * Formats the closing marker line for a linked Lugus block.
 */
export function formatEndMarker(indent: string, commentToken: string): string {
  return `${indent}${commentToken} </lugus>`;
}

/**
 * Extracts the pseudocode block at the given line.
 * Works when the cursor is on a prompt line, inside linked generated code,
 * or on the closing marker line.
 */
export function extractCommentBlock(
  document: vscode.TextDocument,
  cursorLine: number
): CommentBlock | null {
  if (cursorLine < 0 || cursorLine >= document.lineCount) {
    return null;
  }

  const token = getCommentToken(document.languageId);
  const { promptPattern, endMarkerPattern } = buildPatterns(token);
  const currentText = document.lineAt(cursorLine).text;

  // Case 1: Cursor is directly on a pseudocode prompt line.
  if (promptPattern.test(currentText)) {
    return buildBlockFromPromptLine(document, cursorLine, token, promptPattern, endMarkerPattern);
  }

  // Case 2: Cursor is on the closing marker or inside linked generated code.
  let endMarkerLine: number | null = null;
  if (endMarkerPattern.test(currentText)) {
    endMarkerLine = cursorLine;
  } else {
    for (let i = cursorLine + 1; i < document.lineCount; i++) {
      const text = document.lineAt(i).text;
      if (promptPattern.test(text)) {
        break;
      }
      if (endMarkerPattern.test(text)) {
        endMarkerLine = i;
        break;
      }
    }
  }

  if (endMarkerLine === null) {
    return null;
  }

  // Scan upward to find the opening prompt block paired with this closing marker.
  let promptLine: number | null = null;
  for (let i = Math.min(cursorLine, endMarkerLine) - 1; i >= 0; i--) {
    const text = document.lineAt(i).text;
    if (endMarkerPattern.test(text)) {
      return null;
    }
    if (promptPattern.test(text)) {
      promptLine = i;
      break;
    }
  }

  if (promptLine === null) {
    return null;
  }

  return buildBlockFromPromptLine(document, promptLine, token, promptPattern, endMarkerPattern);
}

function buildBlockFromPromptLine(
  document: vscode.TextDocument,
  anchorLine: number,
  token: string,
  promptPattern: RegExp,
  endMarkerPattern: RegExp
): CommentBlock {
  let startLine = anchorLine;
  while (startLine > 0 && promptPattern.test(document.lineAt(startLine - 1).text)) {
    startLine--;
  }

  let endCommentLine = anchorLine;
  while (
    endCommentLine < document.lineCount - 1 &&
    promptPattern.test(document.lineAt(endCommentLine + 1).text)
  ) {
    endCommentLine++;
  }

  const rawLines: string[] = [];
  let indent = '';

  for (let i = startLine; i <= endCommentLine; i++) {
    const match = document.lineAt(i).text.match(promptPattern);
    if (match) {
      if (i === startLine) {
        indent = match[1];
      }
      rawLines.push(match[2].trim());
    }
  }

  // Scan downward to check if this prompt block already has a closing marker.
  let endMarkerLine: number | null = null;
  for (let i = endCommentLine + 1; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    if (promptPattern.test(text)) {
      break;
    }
    if (endMarkerPattern.test(text)) {
      endMarkerLine = i;
      break;
    }
  }

  const commentRange = new vscode.Range(
    new vscode.Position(startLine, 0),
    document.lineAt(endCommentLine).range.end
  );

  const replaceRange =
    endMarkerLine !== null
      ? new vscode.Range(
          new vscode.Position(startLine, 0),
          document.lineAt(endMarkerLine).range.end
        )
      : commentRange;

  return {
    commentRange,
    replaceRange,
    isLinked: endMarkerLine !== null,
    endMarkerLine,
    prompt: rawLines.join('\n'),
    indent,
    commentToken: token,
    rawLines
  };
}

/**
 * Scans the entire document for Lugus pseudocode blocks (used by CodeLens).
 */
export function findAllCommentBlocks(document: vscode.TextDocument): CommentBlock[] {
  const token = getCommentToken(document.languageId);
  const { promptPattern, endMarkerPattern } = buildPatterns(token);
  const blocks: CommentBlock[] = [];

  let line = 0;
  while (line < document.lineCount) {
    if (promptPattern.test(document.lineAt(line).text)) {
      const block = buildBlockFromPromptLine(document, line, token, promptPattern, endMarkerPattern);
      blocks.push(block);
      line = block.replaceRange.end.line + 1;
    } else {
      line++;
    }
  }

  return blocks;
}

/**
 * Captures a narrow window of surrounding lines outside the block itself
 * so previous generated code inside a linked block does not pollute context.
 */
export function extractLocalContext(
  document: vscode.TextDocument,
  block: CommentBlock,
  contextLines: number
): { before: string; after: string } {
  if (contextLines <= 0) {
    return { before: '', after: '' };
  }

  const beforeStart = Math.max(0, block.replaceRange.start.line - contextLines);
  const beforeRange = new vscode.Range(
    new vscode.Position(beforeStart, 0),
    new vscode.Position(block.replaceRange.start.line, 0)
  );

  let after = '';
  if (block.replaceRange.end.line < document.lineCount - 1) {
    const afterStart = block.replaceRange.end.line + 1;
    const afterEnd = Math.min(document.lineCount - 1, block.replaceRange.end.line + contextLines);
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
import * as vscode from 'vscode';
import {
  BlockInfo,
  BlockState,
  blockEnd,
  blockState,
  bodyLines,
  findBlocks,
  getCommentToken
} from './core/blocks';

/**
 * Editor-facing view of a Lugus block: the pure BlockInfo plus VS Code ranges.
 * All parsing lives in core/blocks.ts; this file only adapts it to TextDocument.
 */
export interface CommentBlock extends BlockInfo {
  token: string;
  state: BlockState;
  /** Implementation lines between the rule and the marker. */
  body: string[];
  /** Rule lines only. */
  ruleRange: vscode.Range;
  /** The whole block: rule lines, body and marker. */
  fullRange: vscode.Range;
  /** Exact current text of the whole block, used to detect concurrent edits. */
  snapshot: string;
}

export function documentLines(document: vscode.TextDocument): string[] {
  const lines: string[] = new Array(document.lineCount);
  for (let i = 0; i < document.lineCount; i++) {
    lines[i] = document.lineAt(i).text;
  }
  return lines;
}

function toCommentBlock(
  lines: string[],
  token: string,
  info: BlockInfo
): CommentBlock {
  const body = bodyLines(lines, info);
  const end = blockEnd(info);
  const fullRange = new vscode.Range(info.promptStart, 0, end, lines[end].length);
  return {
    ...info,
    token,
    body,
    state: blockState(info, body),
    ruleRange: new vscode.Range(info.promptStart, 0, info.promptEnd, lines[info.promptEnd].length),
    fullRange,
    snapshot: lines.slice(info.promptStart, end + 1).join('\n')
  };
}

export function getBlocks(document: vscode.TextDocument): CommentBlock[] {
  const lines = documentLines(document);
  const token = getCommentToken(document.languageId);
  return findBlocks(lines, token).map((info) => toCommentBlock(lines, token, info));
}

/** Block containing `line` (rule, body or marker), if any. */
export function getBlockAt(document: vscode.TextDocument, line: number): CommentBlock | null {
  if (line < 0 || line >= document.lineCount) {
    return null;
  }
  return getBlocks(document).find((b) => line >= b.promptStart && line <= blockEnd(b)) ?? null;
}

/**
 * Finds the block again after an async step (network call, diff review).
 * The block may have moved because the user edited lines above it, but its
 * own text must be exactly what we started from; otherwise we refuse to apply.
 */
export function relocateBlock(
  document: vscode.TextDocument,
  original: CommentBlock
): CommentBlock | null {
  if (document.isClosed) {
    return null;
  }
  const candidates = getBlocks(document).filter((b) => b.snapshot === original.snapshot);
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort(
    (a, b) => Math.abs(a.promptStart - original.promptStart) - Math.abs(b.promptStart - original.promptStart)
  );
  return candidates[0];
}

/**
 * Lines around the block (never inside it), so the current implementation is
 * sent once, explicitly, instead of leaking into the context.
 */
export function extractLocalContext(
  document: vscode.TextDocument,
  block: CommentBlock,
  contextLines: number
): { before: string; after: string } {
  if (contextLines <= 0) {
    return { before: '', after: '' };
  }
  const lines = documentLines(document);
  const start = Math.max(0, block.promptStart - contextLines);
  const end = blockEnd(block);
  return {
    before: lines.slice(start, block.promptStart).join('\n'),
    after: lines.slice(end + 1, Math.min(lines.length, end + 1 + contextLines)).join('\n')
  };
}

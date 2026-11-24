import { createHash } from 'crypto';
import { canonicalCode, canonicalRule } from './text';

/**
 * A Lugus block, as found in a document:
 *
 *     //> rule line 1            <- promptStart
 *     //> rule line 2            <- promptEnd
 *     ...implementation...       <- body (linked blocks only)
 *     // </lugus> code:… rule:…  <- markerLine
 *
 * An unlinked block is just the rule lines (pseudocode not yet translated).
 * Line numbers are zero-based and inclusive.
 */
export interface BlockInfo {
  promptStart: number;
  promptEnd: number;
  markerLine: number | null;
  /** Indentation of the first rule line. */
  indent: string;
  /** Rule text of each prompt line, without the `//>` prefix. */
  ruleLines: string[];
  marker: MarkerInfo | null;
}

export interface MarkerInfo {
  codeHash?: string;
  ruleHash?: string;
  /** `sha256:` fingerprint written by pre-release 0.2.0 builds (code only). */
  legacyCodeHash?: string;
}

/**
 * - `unlinked`: pseudocode that has never been translated.
 * - `aligned`: rule and code are both unchanged since Lugus last recorded them.
 * - `rule-changed`: the rule was edited; the code needs updating.
 * - `code-edited`: the code was edited by hand; accept it or re-align it.
 * - `both-changed`: rule and code were both edited.
 * - `unverified`: the marker carries no usable fingerprints (older format).
 */
export type BlockState =
  | 'unlinked'
  | 'aligned'
  | 'rule-changed'
  | 'code-edited'
  | 'both-changed'
  | 'unverified';

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
  'r',
  'makefile',
  'coffeescript',
  'julia',
  'elixir',
  'nim'
]);

const DASH_LANGUAGES = new Set(['sql', 'lua', 'haskell', 'ada', 'elm']);

/** Single-line comment prefix for a VS Code language ID. */
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

interface Patterns {
  prompt: RegExp;
  marker: RegExp;
}

const patternCache = new Map<string, Patterns>();

function patterns(token: string): Patterns {
  let cached = patternCache.get(token);
  if (!cached) {
    const t = escapeRegex(token);
    cached = {
      prompt: new RegExp(`^([\\t ]*)${t}>(?: ?)(.*)$`),
      marker: new RegExp(`^([\\t ]*)${t}[\\t ]*</lugus>(.*)$`)
    };
    patternCache.set(token, cached);
  }
  return cached;
}

export function isPromptLine(line: string, token: string): boolean {
  return patterns(token).prompt.test(line);
}

/** Parses a closing marker line. Returns null when the line is not a marker. */
export function parseMarker(line: string, token: string): MarkerInfo | null {
  const match = patterns(token).marker.exec(line);
  if (!match) {
    return null;
  }
  const info: MarkerInfo = {};
  for (const part of match[2].trim().split(/\s+/)) {
    const field = /^(code|rule|sha256):([a-f0-9]{16})$/.exec(part);
    if (!field) {
      continue;
    }
    if (field[1] === 'code') {
      info.codeHash = field[2];
    } else if (field[1] === 'rule') {
      info.ruleHash = field[2];
    } else {
      info.legacyCodeHash = field[2];
    }
  }
  return info;
}

export function isMarkerLine(line: string, token: string): boolean {
  return patterns(token).marker.test(line);
}

function sha16(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Fingerprint of an implementation. Insensitive to trailing whitespace,
 * blank lines, line endings and the block's base indentation, so moving or
 * re-indenting a block does not count as a change.
 */
export function hashCode(code: string): string {
  return sha16(canonicalCode(code));
}

/** Fingerprint of a rule. Insensitive to spacing and blank rule lines. */
export function hashRule(ruleLines: string[]): string {
  return sha16(canonicalRule(ruleLines));
}

export function formatMarker(indent: string, token: string, code: string, ruleLines: string[]): string {
  return `${indent}${token} </lugus> code:${hashCode(code)} rule:${hashRule(ruleLines)}`;
}

export function formatPromptLine(indent: string, token: string, rule: string): string {
  return rule ? `${indent}${token}> ${rule}` : `${indent}${token}>`;
}

/**
 * Finds every block in the document, top to bottom.
 * A marker belongs to the nearest rule block above it; scanning for a marker
 * stops at the next rule line, so blocks never overlap or nest.
 */
export function findBlocks(lines: string[], token: string): BlockInfo[] {
  const { prompt } = patterns(token);
  const blocks: BlockInfo[] = [];
  let i = 0;

  while (i < lines.length) {
    const first = prompt.exec(lines[i]);
    if (!first) {
      i++;
      continue;
    }

    const promptStart = i;
    const ruleLines: string[] = [];
    while (i < lines.length) {
      const match = prompt.exec(lines[i]);
      if (!match) {
        break;
      }
      ruleLines.push(match[2].trim());
      i++;
    }
    const promptEnd = i - 1;

    let markerLine: number | null = null;
    let marker: MarkerInfo | null = null;
    for (let j = promptEnd + 1; j < lines.length; j++) {
      if (prompt.test(lines[j])) {
        break;
      }
      const parsed = parseMarker(lines[j], token);
      if (parsed) {
        markerLine = j;
        marker = parsed;
        break;
      }
    }

    blocks.push({ promptStart, promptEnd, markerLine, indent: first[1], ruleLines, marker });
    i = markerLine !== null ? markerLine + 1 : promptEnd + 1;
  }

  return blocks;
}

/** Last line that belongs to the block (marker line, or last rule line). */
export function blockEnd(block: BlockInfo): number {
  return block.markerLine ?? block.promptEnd;
}

/** The block containing `line` (rule lines, body or marker), if any. */
export function findBlockAt(lines: string[], token: string, line: number): BlockInfo | null {
  for (const block of findBlocks(lines, token)) {
    if (line >= block.promptStart && line <= blockEnd(block)) {
      return block;
    }
    if (block.promptStart > line) {
      break;
    }
  }
  return null;
}

/** Implementation lines between the rule and the marker (empty for unlinked blocks). */
export function bodyLines(lines: string[], block: BlockInfo): string[] {
  if (block.markerLine === null) {
    return [];
  }
  return lines.slice(block.promptEnd + 1, block.markerLine);
}

export function blockState(block: BlockInfo, body: string[]): BlockState {
  if (block.markerLine === null || !block.marker) {
    return 'unlinked';
  }
  const { codeHash, ruleHash } = block.marker;
  if (!codeHash || !ruleHash) {
    // Pre-release markers (bare `</lugus>` or `sha256:` only) carry no rule
    // fingerprint: the user re-signs them once with "Accept".
    return 'unverified';
  }
  const codeOk = hashCode(body.join('\n')) === codeHash;
  const ruleOk = hashRule(block.ruleLines) === ruleHash;
  if (codeOk && ruleOk) {
    return 'aligned';
  }
  if (codeOk) {
    return 'rule-changed';
  }
  return ruleOk ? 'code-edited' : 'both-changed';
}

export type BlockMode = 'linked' | 'replace' | 'comment';

export interface ComposeInput {
  mode: BlockMode;
  /** Rule lines exactly as they appear in the document (kept verbatim). */
  headerLines: string[];
  indent: string;
  token: string;
  ruleLines: string[];
  /** Final, already indented implementation. */
  code: string;
}

/** Text that replaces a whole block after a translation or update. */
export function composeBlock(input: ComposeInput): string {
  if (input.mode === 'replace') {
    return input.code;
  }
  if (input.mode === 'comment') {
    const comments = input.ruleLines.map((rule) => `${input.indent}${input.token} ${rule}`.trimEnd());
    return [...comments, input.code].join('\n');
  }
  return [
    ...input.headerLines,
    input.code,
    formatMarker(input.indent, input.token, input.code, input.ruleLines)
  ].join('\n');
}

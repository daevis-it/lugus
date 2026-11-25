import { BlockState, hashCode, hashRule } from './blocks';
import { dedent, splitLines } from './text';

/**
 * Sidecar storage: rules live in `.lugus/rules/<source path>.json` instead of
 * in the source file, anchored to a symbol (function, method, class…).
 *
 * The symbol's range, as reported by the language's symbol provider, is the
 * code region. It stays exact when the code is edited, so updates and
 * restores always replace the right lines. Without a symbol provider (CLI,
 * language server still loading) the state is computed from the recorded
 * first line and fingerprint, but nothing is ever edited on that basis.
 */

export const SIDECAR_DIR = '.lugus/rules';

export interface SymbolInfo {
  /** Dotted path from the outermost container, e.g. `UserService.GetActiveUsers`. */
  path: string;
  kind: string;
  /** Zero-based, inclusive, whole lines. */
  startLine: number;
  endLine: number;
}

export interface Anchor {
  symbol: string;
  kind: string;
  /** Start line when last aligned (hint used to tell overloads apart). */
  line: number;
  /** First line of the region, trimmed, when last aligned. */
  firstLine: string;
  lineCount: number;
}

export interface SidecarEntry {
  id: string;
  rule: string[];
  anchor: Anchor;
  /** Fingerprint of the code region when last aligned. */
  code: string;
  /** Fingerprint of the rule when last aligned. */
  ruleHash: string;
}

export interface SidecarFile {
  version: 1;
  blocks: SidecarEntry[];
}

/** Symbol kinds a rule can be attached to (names of vscode.SymbolKind). */
export const LINKABLE_KINDS: ReadonlySet<string> = new Set([
  'Function',
  'Method',
  'Constructor',
  'Class',
  'Struct',
  'Interface',
  'Enum',
  'Property',
  'Module',
  'Namespace'
]);

/** Kind of a rule that covers a whole file. Its region is the file itself: no symbol provider needed. */
export const FILE_KIND = 'File';

export function isFileEntry(entry: SidecarEntry): boolean {
  return entry.anchor.kind === FILE_KIND;
}

/**
 * The whole file as a region: from the first line to the last non-blank one,
 * so the final newline (and trailing blank lines) are never part of an edit.
 */
export function fileSymbol(lines: string[]): SymbolInfo {
  let end = lines.length - 1;
  while (end > 0 && !lines[end].trim()) {
    end--;
  }
  return { path: '', kind: FILE_KIND, startLine: 0, endLine: Math.max(0, end) };
}

/** Callables are preferred over the containers around them when picking a symbol at the cursor. */
const CALLABLE_KINDS: ReadonlySet<string> = new Set(['Function', 'Method', 'Constructor', 'Property']);

export function emptySidecar(): SidecarFile {
  return { version: 1, blocks: [] };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

const HEX16 = /^[a-f0-9]{16}$/;

/** Parses and validates a sidecar file. Throws with a readable message when it is broken. */
export function parseSidecar(text: string): SidecarFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const file = data as Partial<SidecarFile>;
  if (!file || typeof file !== 'object' || file.version !== 1 || !Array.isArray(file.blocks)) {
    throw new Error('expected { "version": 1, "blocks": [...] }');
  }
  file.blocks.forEach((b, i) => {
    const a = b?.anchor;
    const ok =
      b &&
      typeof b.id === 'string' &&
      isStringArray(b.rule) &&
      typeof b.code === 'string' &&
      HEX16.test(b.code) &&
      typeof b.ruleHash === 'string' &&
      HEX16.test(b.ruleHash) &&
      a &&
      typeof a.symbol === 'string' &&
      typeof a.kind === 'string' &&
      Number.isInteger(a.line) &&
      typeof a.firstLine === 'string' &&
      Number.isInteger(a.lineCount) &&
      a.lineCount > 0;
    if (!ok) {
      throw new Error(`block ${i + 1} is malformed`);
    }
  });
  return { version: 1, blocks: file.blocks as SidecarEntry[] };
}

/** Stable, review-friendly JSON: fixed key order, blocks sorted by position. */
export function serializeSidecar(file: SidecarFile): string {
  const blocks = [...file.blocks]
    .sort((a, b) => a.anchor.line - b.anchor.line || a.id.localeCompare(b.id))
    .map((b) => ({
      id: b.id,
      rule: b.rule,
      anchor: {
        symbol: b.anchor.symbol,
        kind: b.anchor.kind,
        line: b.anchor.line,
        firstLine: b.anchor.firstLine,
        lineCount: b.anchor.lineCount
      },
      code: b.code,
      ruleHash: b.ruleHash
    }));
  return JSON.stringify({ version: 1, blocks }, null, 2) + '\n';
}

export function regionText(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(startLine, endLine + 1).join('\n');
}

/** Builds (or rebuilds, keeping the id) an entry recording `rule` and the current code of `symbol` as aligned. */
export function makeEntry(id: string, rule: string[], symbol: SymbolInfo, lines: string[]): SidecarEntry {
  return {
    id,
    rule: rule.map((r) => r.trim()).filter(Boolean),
    anchor: {
      symbol: symbol.path,
      kind: symbol.kind,
      line: symbol.startLine,
      firstLine: (lines[symbol.startLine] ?? '').trim(),
      lineCount: symbol.endLine - symbol.startLine + 1
    },
    code: hashCode(regionText(lines, symbol.startLine, symbol.endLine)),
    ruleHash: hashRule(rule)
  };
}

/**
 * Innermost linkable symbol containing `line`. A callable wins over the class
 * around it; among callables the innermost (shortest) wins.
 */
export function symbolAt(symbols: SymbolInfo[], line: number): SymbolInfo | undefined {
  const containing = symbols.filter(
    (s) => LINKABLE_KINDS.has(s.kind) && line >= s.startLine && line <= s.endLine
  );
  const span = (s: SymbolInfo) => s.endLine - s.startLine;
  const callables = containing.filter((s) => CALLABLE_KINDS.has(s.kind)).sort((a, b) => span(a) - span(b));
  if (callables.length) {
    return callables[0];
  }
  return containing.sort((a, b) => span(a) - span(b))[0];
}

/**
 * Finds the symbol an entry is attached to. Overloads share a path: the one
 * whose first line matches wins, then the one closest to the recorded line.
 */
export function resolveAnchor(entry: SidecarEntry, symbols: SymbolInfo[], lines: string[]): SymbolInfo | undefined {
  const candidates = symbols.filter((s) => s.path === entry.anchor.symbol);
  const score = (s: SymbolInfo) =>
    ((lines[s.startLine] ?? '').trim() === entry.anchor.firstLine ? 0 : 1_000_000) +
    Math.abs(s.startLine - entry.anchor.line);
  return candidates.sort((a, b) => score(a) - score(b))[0];
}

function combine(codeOk: boolean, ruleOk: boolean): BlockState {
  if (codeOk && ruleOk) {
    return 'aligned';
  }
  if (codeOk) {
    return 'rule-changed';
  }
  return ruleOk ? 'code-edited' : 'both-changed';
}

/** State of an entry whose symbol has been resolved. */
export function entryState(entry: SidecarEntry, lines: string[], symbol: SymbolInfo | undefined): BlockState {
  if (!symbol) {
    return 'orphaned';
  }
  return combine(
    hashCode(regionText(lines, symbol.startLine, symbol.endLine)) === entry.code,
    hashRule(entry.rule) === entry.ruleHash
  );
}

/**
 * Start line of a region with the recorded first line and fingerprint, if the
 * aligned code is present verbatim somewhere in `lines`. Window lengths around
 * the recorded line count are tried, since fingerprints ignore blank lines.
 */
export function findAlignedRegion(lines: string[], anchor: Anchor, codeHash: string): { start: number; end: number } | undefined {
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (line.trim() === anchor.firstLine) {
      starts.push(i);
    }
  });
  starts.sort((a, b) => Math.abs(a - anchor.line) - Math.abs(b - anchor.line));
  for (const start of starts) {
    for (let delta = 0; delta <= 3; delta++) {
      for (const length of delta === 0 ? [anchor.lineCount] : [anchor.lineCount - delta, anchor.lineCount + delta]) {
        const end = start + length - 1;
        if (length < 1 || end >= lines.length) {
          continue;
        }
        if (hashCode(regionText(lines, start, end)) === codeHash) {
          return { start, end };
        }
      }
    }
  }
  return undefined;
}

/**
 * State without a symbol provider (CLI, or language server not ready yet).
 * `code-edited` here means "the aligned code is no longer present as recorded":
 * edited, or its symbol renamed or removed.
 */
export function entryStateWithoutSymbols(entry: SidecarEntry, lines: string[] | null): { state: BlockState; line: number } {
  if (!lines) {
    return { state: 'orphaned', line: entry.anchor.line };
  }
  if (isFileEntry(entry)) {
    return { state: entryState(entry, lines, fileSymbol(lines)), line: 0 };
  }
  const ruleOk = hashRule(entry.rule) === entry.ruleHash;
  const found = findAlignedRegion(lines, entry.anchor, entry.code);
  if (found) {
    return { state: combine(true, ruleOk), line: found.start };
  }
  const firstLineAt = lines.findIndex((l) => l.trim() === entry.anchor.firstLine);
  return {
    state: combine(false, ruleOk),
    line: firstLineAt >= 0 ? firstLineAt : Math.min(entry.anchor.line, Math.max(0, lines.length - 1))
  };
}

/** The aligned code of `entry` inside another version of the file (e.g. the last commit), dedented. */
export function findEntryCodeIn(text: string, entry: SidecarEntry): string | undefined {
  const lines = splitLines(text);
  if (isFileEntry(entry)) {
    const whole = fileSymbol(lines);
    const code = regionText(lines, whole.startLine, whole.endLine);
    return hashCode(code) === entry.code ? code : undefined;
  }
  const found = findAlignedRegion(lines, entry.anchor, entry.code);
  return found ? dedent(regionText(lines, found.start, found.end)) : undefined;
}

/** Sidecar path (POSIX, relative to the workspace root) for a source path relative to the same root. */
export function sidecarPathFor(sourceRelativePath: string): string {
  return `${SIDECAR_DIR}/${sourceRelativePath.split('\\').join('/')}.json`;
}

/** Inverse of sidecarPathFor; undefined for paths outside the sidecar folder. */
export function sourcePathFor(sidecarRelativePath: string): string | undefined {
  const p = sidecarRelativePath.split('\\').join('/');
  if (!p.startsWith(`${SIDECAR_DIR}/`) || !p.endsWith('.json')) {
    return undefined;
  }
  return p.slice(SIDECAR_DIR.length + 1, -'.json'.length);
}

/** Random-enough id for a new entry (unique within one file). */
export function newEntryId(existing: SidecarEntry[], random: () => number = Math.random): string {
  for (;;) {
    const id = Math.floor(random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
    if (!existing.some((e) => e.id === id)) {
      return id;
    }
  }
}

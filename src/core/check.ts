import { BlockState, blockState, bodyLines, findBlocks, getCommentToken } from './blocks';
import { splitLines } from './text';

/**
 * Drift checking shared by the editor (diagnostics, workspace overview) and
 * the `lugus check` CLI. No VS Code imports.
 */

/** States where the rule and the code no longer match what Lugus recorded. */
export const DRIFT_STATES: ReadonlySet<BlockState> = new Set(['rule-changed', 'code-edited', 'both-changed']);

export function isDrift(state: BlockState): boolean {
  return DRIFT_STATES.has(state);
}

/** Short human label, used in diagnostics, quick picks and CLI output. */
export function describeState(state: BlockState): string {
  switch (state) {
    case 'aligned':
      return 'aligned';
    case 'rule-changed':
      return 'rule changed';
    case 'code-edited':
      return 'code edited by hand';
    case 'both-changed':
      return 'rule and code changed';
    case 'unverified':
      return 'not verified';
    case 'unlinked':
      return 'not translated yet';
  }
}

/** One-line explanation of what the user should do about a state. */
export function adviseState(state: BlockState): string {
  switch (state) {
    case 'rule-changed':
      return 'The rule was edited after the code was last aligned. Update the code or accept it as is.';
    case 'code-edited':
      return 'The code was edited by hand. Accept it if the rule still describes it, or re-align it to the rule.';
    case 'both-changed':
      return 'Both the rule and the code were edited. Update the code or accept both as aligned.';
    case 'unverified':
      return 'This marker has no fingerprints (older Lugus version). Accept it once to start tracking drift.';
    default:
      return '';
  }
}

export interface BlockReport {
  /** Zero-based line of the first rule line. */
  line: number;
  state: BlockState;
  /** Rule text, one line per rule line. */
  rule: string[];
}

/** Every linked block in the text with its state. Unlinked rules are skipped. */
export function checkText(text: string, token: string): BlockReport[] {
  const lines = splitLines(text);
  return findBlocks(lines, token)
    .filter((block) => block.markerLine !== null)
    .map((block) => ({
      line: block.promptStart,
      state: blockState(block, bodyLines(lines, block)),
      rule: block.ruleLines
    }));
}

// ------------------------------------------------------------ files outside VS Code

/** Extensions whose language does not use `//` comments. Everything else defaults to `//`. */
const EXTENSION_LANGUAGES: Record<string, string> = {
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  rb: 'ruby',
  yml: 'yaml',
  yaml: 'yaml',
  ps1: 'powershell',
  psm1: 'powershell',
  toml: 'toml',
  gd: 'gdscript',
  pl: 'perl',
  pm: 'perl',
  r: 'r',
  jl: 'julia',
  ex: 'elixir',
  exs: 'elixir',
  nim: 'nim',
  coffee: 'coffeescript',
  mk: 'makefile',
  sql: 'sql',
  lua: 'lua',
  hs: 'haskell',
  adb: 'ada',
  ads: 'ada',
  elm: 'elm'
};

const FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile'
};

const MARKER_TOKEN = /^[\t ]*(\/\/|#|--)[\t ]*<\/lugus>/m;

/**
 * Comment token for a file on disk, without VS Code's language detection.
 * Known extensions win; otherwise the token is read from the file's own
 * markers; `//` is the fallback.
 */
export function commentTokenForFile(path: string, text: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const byName = FILENAME_LANGUAGES[name];
  if (byName) {
    return getCommentToken(byName);
  }
  const dot = name.lastIndexOf('.');
  const byExtension = dot > 0 ? EXTENSION_LANGUAGES[name.slice(dot + 1)] : undefined;
  if (byExtension) {
    return getCommentToken(byExtension);
  }
  return MARKER_TOKEN.exec(text)?.[1] ?? '//';
}

/** Cheap pre-filter: only files containing a marker can hold linked blocks. */
export function mayContainBlocks(text: string): boolean {
  return text.includes('</lugus>');
}

/**
 * Pure text helpers shared by the parser, the prompt builder and the editor glue.
 * No VS Code imports: everything here is unit-tested with node:test.
 */

export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function splitLines(text: string): string[] {
  return normalizeEol(text).split('\n');
}

function leadingWhitespace(line: string): string {
  return line.match(/^[\t ]*/)?.[0] ?? '';
}

/**
 * Longest whitespace prefix shared by every non-blank line.
 * Compared character by character, so mixed tabs/spaces never get mangled.
 */
export function commonIndent(lines: string[]): string {
  let prefix: string | null = null;
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const lead = leadingWhitespace(line);
    if (prefix === null) {
      prefix = lead;
      continue;
    }
    let i = 0;
    while (i < prefix.length && i < lead.length && prefix[i] === lead[i]) {
      i++;
    }
    prefix = prefix.slice(0, i);
    if (!prefix) {
      break;
    }
  }
  return prefix ?? '';
}

/** Removes the shared indentation. Blank lines become empty. */
export function dedent(code: string): string {
  const lines = splitLines(code);
  const shared = commonIndent(lines);
  return lines.map((line) => (line.trim() ? line.slice(shared.length) : '')).join('\n');
}

/** Prefixes every non-blank line with `baseIndent`. Blank lines stay empty. */
export function applyIndentation(code: string, baseIndent: string): string {
  return splitLines(code)
    .map((line) => (line.trim() ? `${baseIndent}${line}` : ''))
    .join('\n');
}

/** Drops leading and trailing blank lines, keeping internal ones. */
export function trimBlankLines(code: string): string {
  const lines = splitLines(code);
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) {
    start++;
  }
  while (end > start && !lines[end - 1].trim()) {
    end--;
  }
  return lines.slice(start, end).join('\n');
}

/**
 * Turns a raw model reply into plain code: strips a surrounding markdown fence
 * (with or without a language tag, with or without a closing fence) and dedents.
 * Fences inside the code are left alone.
 */
export function cleanModelOutput(raw: string): string {
  // Only blank lines are trimmed here: trimming spaces would strip the first
  // line's indentation and break the dedent below.
  let text = trimBlankLines(raw);
  const open = text.trimStart().match(/^```[\w+#.-]*[ \t]*\n/);
  if (open) {
    text = text.trimStart().slice(open[0].length);
    const close = text.lastIndexOf('\n```');
    if (close !== -1 && !text.slice(close + 4).trim()) {
      text = text.slice(0, close);
    } else if (text.endsWith('```')) {
      text = text.slice(0, -3);
    }
  }
  return dedent(trimBlankLines(text));
}

/**
 * Comparison form used to tell whether the model actually changed anything:
 * ignores trailing whitespace, blank lines and the block's base indentation.
 */
export function canonicalCode(code: string): string {
  const lines = splitLines(code)
    .map((line) => line.replace(/[\t ]+$/, ''))
    .filter((line) => line.trim().length > 0);
  const shared = commonIndent(lines);
  return lines.map((line) => line.slice(shared.length)).join('\n');
}

/** Comparison form for rules: whitespace-insensitive, line structure kept. */
export function canonicalRule(lines: string[]): string {
  return lines
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line.length > 0)
    .join('\n');
}

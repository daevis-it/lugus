/**
 * Prompt construction. Two modes:
 *
 * - `generate`: a rule with no implementation yet. The model writes the code.
 * - `update`: a rule linked to existing code. The model edits that code as
 *   little as possible so it satisfies the (possibly changed) rule. It never
 *   rewrites from scratch: signatures, names and untouched logic must survive.
 */

export type TranslationMode = 'generate' | 'update';

export interface PromptInput {
  mode: TranslationMode;
  language: string;
  rule: string;
  /** Current implementation, dedented. Required in `update` mode. */
  currentCode?: string;
  contextBefore: string;
  contextAfter: string;
  projectRules?: string | null;
  /** Rule of the whole file this block lives in (sidecar file rule), sent as a constraint. */
  fileRule?: string;
}

export interface BuiltPrompt {
  system: string;
  user: string;
}

const SHARED_OUTPUT_RULES = (language: string): string[] => [
  `Output ONLY ${language} code. No markdown fences, no explanations, no prose before or after the code.`,
  'Start at column 0 (no shared base indentation); keep the internal indentation of nested blocks.',
  'The rule may be written in any human language. Follow its logic exactly; do not invent extra behaviour.'
];

export function buildPrompt(input: PromptInput): BuiltPrompt {
  const lang = input.language;
  const lines: string[] = [];

  if (input.mode === 'update') {
    if (input.currentCode === undefined) {
      throw new Error('update mode requires the current implementation');
    }
    lines.push(
      `You are Lugus. You maintain a block of ${lang} code that is linked to a natural-language rule.`,
      'The rule may have changed since the code was written. Edit the CURRENT CODE so it implements the RULE.',
      'Strict rules:',
      ...numbered([
        'Return the COMPLETE updated block, from its first line to its last line.',
        ...SHARED_OUTPUT_RULES(lang),
        'Make the smallest change that satisfies the rule. Everything the rule does not require you to change must stay identical: declarations, signatures, parameter and variable names, ordering, comments and formatting.',
        'Never rewrite the block from scratch and never drop declarations, function or class wrappers, or code unrelated to the rule.',
        'Do not add imports or new dependencies unless the rule explicitly asks for them.',
        'If the current code already implements the rule, return it exactly as it is.'
      ])
    );
  } else {
    lines.push(
      `You are Lugus, a deterministic translator from natural-language rules to ${lang} code.`,
      'Strict rules:',
      ...numbered([
        ...SHARED_OUTPUT_RULES(lang),
        'Do NOT add imports/using statements or outer class/function wrappers unless the rule asks for them.',
        'Match variable names and coding style from the surrounding context when provided.'
      ])
    );
  }

  if (input.fileRule) {
    lines.push(
      '',
      'The whole file this code belongs to follows this rule. Your code must not contradict it:',
      input.fileRule
    );
  }

  if (input.projectRules) {
    lines.push(
      '',
      'Project conventions from .lugusrc (follow them unless the rule contradicts them):',
      input.projectRules
    );
  }

  const sections: string[] = [];
  if (input.contextBefore.trim()) {
    sections.push(`--- CONTEXT BEFORE (read-only) ---\n${input.contextBefore}`);
  }
  sections.push(`--- RULE ---\n${input.rule}`);
  if (input.mode === 'update') {
    sections.push(`--- CURRENT CODE (${lang}) ---\n${input.currentCode}`);
  }
  if (input.contextAfter.trim()) {
    sections.push(`--- CONTEXT AFTER (read-only) ---\n${input.contextAfter}`);
  }
  sections.push(
    input.mode === 'update'
      ? `Return the complete updated ${lang} block.`
      : `Return the ${lang} code for the rule.`
  );

  return { system: lines.join('\n'), user: sections.join('\n\n') };
}

function numbered(items: string[]): string[] {
  return items.map((item, index) => `${index + 1}. ${item}`);
}

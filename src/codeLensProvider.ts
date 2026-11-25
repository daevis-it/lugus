import * as vscode from 'vscode';
import { BlockState } from './core/blocks';
import { describeState } from './core/check';
import { isFileEntry } from './core/sidecar';
import { getBlocks } from './commentParser';
import { Sidecar, SidecarBlock } from './sidecar';

interface LensSpec {
  title: string;
  tooltip: string;
  command?: string;
}

/** Inline blocks: what each state shows above the rule. The first lens is the status. */
const INLINE_LENSES: Record<Exclude<BlockState, 'orphaned'>, LensSpec[]> = {
  unlinked: [
    { title: '▶ Lugus: Translate', tooltip: 'Generate code for this rule', command: 'lugus.translate' }
  ],
  aligned: [
    { title: '✓ Lugus: aligned', tooltip: 'The code matches the rule Lugus last recorded. No action needed.' },
    { title: 'Detach', tooltip: 'Remove the rule and marker, keep the code', command: 'lugus.detach' }
  ],
  'rule-changed': [
    { title: '● Lugus: rule changed', tooltip: 'The rule was edited after the code was last aligned.' },
    { title: 'Update Code', tooltip: 'Edit the existing code to match the new rule (diff review)', command: 'lugus.translate' },
    { title: 'Accept As Is', tooltip: 'The code already matches the new rule: record it without calling the model', command: 'lugus.accept' },
    { title: 'Detach', tooltip: 'Remove the rule and marker, keep the code', command: 'lugus.detach' }
  ],
  'code-edited': [
    { title: '✎ Lugus: code edited by hand', tooltip: 'The code was changed after it was last aligned with the rule.' },
    { title: 'Accept Code', tooltip: 'The rule still describes this code: record it without calling the model', command: 'lugus.accept' },
    { title: 'Restore', tooltip: 'Go back to the code as it was when it last matched the rule. No model call (diff review)', command: 'lugus.restore' },
    { title: 'Re-align to Rule', tooltip: 'Ask the model to fix the current code where it contradicts the rule (diff review)', command: 'lugus.translate' },
    { title: 'Detach', tooltip: 'Remove the rule and marker, keep the code', command: 'lugus.detach' }
  ],
  'both-changed': [
    { title: '● Lugus: rule and code changed', tooltip: 'Both the rule and the code were edited since the last alignment.' },
    { title: 'Update Code', tooltip: 'Edit the current code to match the rule (diff review)', command: 'lugus.translate' },
    { title: 'Accept As Is', tooltip: 'Record the current rule and code as aligned, without calling the model', command: 'lugus.accept' },
    { title: 'Restore Code', tooltip: 'Undo the hand edits to the code (the rule stays as you wrote it). No model call (diff review)', command: 'lugus.restore' },
    { title: 'Detach', tooltip: 'Remove the rule and marker, keep the code', command: 'lugus.detach' }
  ],
  unverified: [
    { title: '? Lugus: not verified', tooltip: 'This marker was written by an older version and has no rule fingerprint.' },
    { title: 'Accept', tooltip: 'Record the current rule and code as aligned', command: 'lugus.accept' },
    { title: 'Update Code', tooltip: 'Edit the current code to match the rule (diff review)', command: 'lugus.translate' },
    { title: 'Detach', tooltip: 'Remove the rule and marker, keep the code', command: 'lugus.detach' }
  ]
};

const ICONS: Partial<Record<BlockState, string>> = {
  aligned: '✓',
  'rule-changed': '●',
  'code-edited': '✎',
  'both-changed': '●',
  orphaned: '⚠'
};

/** Sidecar rules: actions per state (status lens is built separately, with the rule text). */
const SIDECAR_ACTIONS: Partial<Record<BlockState, LensSpec[]>> = {
  aligned: [
    { title: 'Edit Rule', tooltip: 'Change the rule (the code is updated only when you ask)', command: 'lugus.sidecar.editRule' },
    { title: 'Detach', tooltip: 'Delete this rule, keep the code', command: 'lugus.sidecar.detach' }
  ],
  'rule-changed': [
    { title: 'Update Code', tooltip: 'Edit the existing code to match the new rule (diff review)', command: 'lugus.sidecar.update' },
    { title: 'Accept As Is', tooltip: 'The code already matches the new rule: record it without calling the model', command: 'lugus.sidecar.accept' },
    { title: 'Edit Rule', tooltip: 'Change the rule', command: 'lugus.sidecar.editRule' }
  ],
  'code-edited': [
    { title: 'Accept Code', tooltip: 'The rule still describes this code: record it without calling the model', command: 'lugus.sidecar.accept' },
    { title: 'Restore', tooltip: 'Go back to the code as it was when it last matched the rule. No model call (diff review)', command: 'lugus.sidecar.restore' },
    { title: 'Re-align to Rule', tooltip: 'Ask the model to fix the current code where it contradicts the rule (diff review)', command: 'lugus.sidecar.update' }
  ],
  'both-changed': [
    { title: 'Update Code', tooltip: 'Edit the current code to match the rule (diff review)', command: 'lugus.sidecar.update' },
    { title: 'Accept As Is', tooltip: 'Record the current rule and code as aligned, without calling the model', command: 'lugus.sidecar.accept' },
    { title: 'Restore Code', tooltip: 'Undo the hand edits to the code. No model call (diff review)', command: 'lugus.sidecar.restore' }
  ],
  orphaned: [
    { title: 'Re-attach', tooltip: 'Attach this rule to another function, method or class in this file', command: 'lugus.sidecar.reattach' },
    { title: 'Delete Rule', tooltip: 'Delete this rule', command: 'lugus.sidecar.detach' }
  ]
};

const RETRY_DELAYS_MS = [1000, 3000, 8000];

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class LugusCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly retries = new Map<string, number>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly sidecar: Sidecar) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public dispose(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.emitter.dispose();
  }

  public async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!vscode.workspace.getConfiguration('lugus').get<boolean>('enableCodeLens', true)) {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];

    for (const block of getBlocks(document)) {
      const range = new vscode.Range(block.promptStart, 0, block.promptStart, 0);
      for (const spec of INLINE_LENSES[block.state as Exclude<BlockState, 'orphaned'>] ?? []) {
        lenses.push(this.lens(range, spec, [document.uri, block.promptStart]));
      }
    }

    const sidecar = await this.sidecar.blocks(document);
    if (sidecar.error) {
      lenses.push(
        new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
          title: '⚠ Lugus: cannot read this file’s rules',
          tooltip: sidecar.error,
          command: 'lugus.sidecar.openRules',
          arguments: [document.uri]
        })
      );
    }
    for (const block of sidecar.blocks) {
      lenses.push(...this.sidecarLenses(document, block));
    }

    // Language servers often start after the first CodeLens request: ask again a few times.
    const key = document.uri.toString();
    if (sidecar.blocks.some((b) => !b.exact)) {
      const attempt = this.retries.get(key) ?? 0;
      if (attempt < RETRY_DELAYS_MS.length) {
        this.retries.set(key, attempt + 1);
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          this.refresh();
        }, RETRY_DELAYS_MS[attempt]);
        this.timers.add(timer);
      }
    } else {
      this.retries.delete(key);
    }
    return lenses;
  }

  private sidecarLenses(document: vscode.TextDocument, block: SidecarBlock): vscode.CodeLens[] {
    const range = new vscode.Range(block.line, 0, block.line, 0);
    const rule = block.entry.rule.join(' ');
    const scope = isFileEntry(block.entry) ? 'file rule' : '';
    const status =
      block.state === 'orphaned'
        ? `⚠ Lugus: rule for ${block.entry.anchor.symbol} lost its symbol — "${shorten(rule, 50)}"`
        : `${ICONS[block.state] ?? '?'} Lugus${scope ? ` ${scope}` : ''}: ${block.state === 'aligned' ? '' : `${describeState(block.state)} — `}"${shorten(rule, 60)}"`;
    const lenses = [
      this.lens(range, {
        title: block.exact ? status : `${status} (waiting for language support)`,
        tooltip: `${describeState(block.state)}\n\nRule:\n${block.entry.rule.join('\n')}\n\nStored in .lugus/rules (sidecar).`
      })
    ];
    if (block.exact) {
      for (const spec of SIDECAR_ACTIONS[block.state] ?? []) {
        lenses.push(this.lens(range, spec, [document.uri, block.entry.id]));
      }
    }
    return lenses;
  }

  private lens(range: vscode.Range, spec: LensSpec, args?: unknown[]): vscode.CodeLens {
    return new vscode.CodeLens(range, {
      title: spec.title,
      tooltip: spec.tooltip,
      // An empty command renders the lens as a plain, non-clickable label.
      command: spec.command ?? '',
      arguments: spec.command ? args : undefined
    });
  }
}

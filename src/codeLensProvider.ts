import * as vscode from 'vscode';
import { BlockState } from './core/blocks';
import { getBlocks } from './commentParser';

interface LensSpec {
  title: string;
  tooltip: string;
  command?: string;
}

/** What each block state shows above the rule. The first lens is the status. */
const LENSES: Record<BlockState, LensSpec[]> = {
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

export class LugusCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.emitter.event;

  public refresh(): void {
    this.emitter.fire();
  }

  public dispose(): void {
    this.emitter.dispose();
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('lugus').get<boolean>('enableCodeLens', true)) {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    for (const block of getBlocks(document)) {
      const range = new vscode.Range(block.promptStart, 0, block.promptStart, 0);
      for (const spec of LENSES[block.state]) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: spec.title,
            tooltip: spec.tooltip,
            // An empty command renders the lens as a plain, non-clickable label.
            command: spec.command ?? '',
            arguments: spec.command ? [document.uri, block.promptStart] : undefined
          })
        );
      }
    }
    return lenses;
  }
}

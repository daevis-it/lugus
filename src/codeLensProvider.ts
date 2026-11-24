import * as vscode from 'vscode';
import { findAllCommentBlocks } from './commentParser';

export class LugusCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.onDidChangeEmitter.event;

  public refresh(): void {
    this.onDidChangeEmitter.fire();
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const config = vscode.workspace.getConfiguration('lugus');
    if (!config.get<boolean>('enableCodeLens', true)) {
      return [];
    }

    const blocks = findAllCommentBlocks(document);
    const lenses: vscode.CodeLens[] = [];

    for (const block of blocks) {
      const topLine = block.commentRange.start.line;
      const lensRange = new vscode.Range(topLine, 0, topLine, 0);

      if (block.isLinked) {
        lenses.push(
          new vscode.CodeLens(lensRange, {
            title: '↻ Lugus: Recompile',
            tooltip: 'Re-translate pseudocode and update the linked code block',
            command: 'lugus.translate',
            arguments: [topLine]
          }),
          new vscode.CodeLens(lensRange, {
            title: 'Detach',
            tooltip: 'Remove Lugus markers and keep only the generated code',
            command: 'lugus.detach',
            arguments: [topLine]
          })
        );
      } else {
        lenses.push(
          new vscode.CodeLens(lensRange, {
            title: '▶ Lugus: Translate',
            tooltip: 'Translate pseudocode block into target language',
            command: 'lugus.translate',
            arguments: [topLine]
          })
        );
      }
    }

    return lenses;
  }
}
import * as vscode from 'vscode';
import * as path from 'path';
import { resolveSearchPaths } from './utils/envResolver';
import { ModuleResolver } from './parser/ModuleResolver';
import { GraphBuilder } from './parser/GraphBuilder';
import { DiagramPanel } from './diagram/webview';
import { DiagramOptions } from './types';

export function activate(context: vscode.ExtensionContext): void {

  const cmd = vscode.commands.registerCommand(
    'genero-app-diagram.generate',
    async (uri?: vscode.Uri) => {

      // Resolve the target file: from right-click URI, active editor, or user pick
      let targetUri = uri;
      if (!targetUri) {
        const active = vscode.window.activeTextEditor;
        if (active && active.document.fileName.toLowerCase().endsWith('.4gl')) {
          targetUri = active.document.uri;
        }
      }
      if (!targetUri) {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 'Genero BDL': ['4gl'] },
          title: 'Select the entry-point .4gl file',
        });
        if (!picked || picked.length === 0) { return; }
        targetUri = picked[0];
      }

      const filePath   = targetUri.fsPath;
      const entryDir   = path.dirname(filePath);   // current directory — searched first
      const entryLabel = path.basename(filePath, '.4gl');

      const cfg = vscode.workspace.getConfiguration('generoAppDiagram');
      const options: DiagramOptions = {
        maxDepth:            cfg.get<number>('maxDepth', 2),
        showPrivate:         cfg.get<boolean>('showPrivateFunctions', true),
        showFieldEvents:     cfg.get<boolean>('showFieldEvents', false),
        showExternalModules: cfg.get<boolean>('showExternalModules', false),
      };

      const panel = DiagramPanel.getOrCreate(context, entryLabel, options);

      const rebuild = async (opts: DiagramOptions): Promise<void> => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: `Building diagram for ${entryLabel}…` },
          async () => {
            try {
              // Pass entryDir so the resolver mirrors Genero''s own search order:
              // current directory is always tried before FGLLDPATH and workspace folders.
              const searchPaths = resolveSearchPaths(entryDir);
              const resolver    = new ModuleResolver(searchPaths);
              const builder     = new GraphBuilder(resolver);
              const graph       = builder.build(filePath, opts);
              panel.updateGraph(graph);
            } catch (err) {
              vscode.window.showErrorMessage(
                `Genero Diagram: failed to build graph — ${(err as Error).message}`,
              );
            }
          },
        );
      };

      panel.setRefreshCallback(rebuild);
      await rebuild(options);
    },
  );

  context.subscriptions.push(cmd);
}

export function deactivate(): void {}
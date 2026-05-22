import * as vscode from 'vscode';
import * as path from 'path';
import { resolveSearchPaths } from './utils/envResolver';
import { ModuleResolver } from './parser/ModuleResolver';
import { GraphBuilder } from './parser/GraphBuilder';
import { DiagramPanel } from './diagram/webview';
import { DiagramOptions } from './types';
import { initLogger, setProgressReporter, log } from './utils/logger';

export function activate(context: vscode.ExtensionContext): void {
  initLogger(context);

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
          { location: vscode.ProgressLocation.Window, title: 'Genero App Diagram' },
          async (progress) => {
            setProgressReporter(msg => progress.report({ message: msg }));
            try {
              log(`Building diagram for ${entryLabel}…`);
              log('Resolving search paths…');
              const searchPaths = resolveSearchPaths(entryDir);
              log('Indexing .4gl modules…');
              const resolver    = new ModuleResolver(searchPaths);
              log('Traversing call graph…');
              const builder     = new GraphBuilder(resolver);
              const graph       = builder.build(filePath, opts);
              log('Rendering diagram…');
              panel.updateGraph(graph);
              log(`Done — ${graph.nodes.size} nodes, ${graph.edges.length} edges.`);
            } catch (err) {
              const errMsg = (err as Error).message;
              log(`Error: ${errMsg}`);
              vscode.window.showErrorMessage(`Genero Diagram: failed to build graph — ${errMsg}`);
            } finally {
              setProgressReporter(undefined);
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
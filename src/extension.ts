import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { resolveSearchPaths } from './utils/envResolver';
import { ModuleResolver } from './parser/ModuleResolver';
import { GraphBuilder } from './parser/GraphBuilder';
import { DiagramPanel } from './diagram/webview';
import { DiagramOptions } from './types';
import { initLogger, setProgressReporter, log, showChannel } from './utils/logger';

/**
 * Heuristic check that a file actually contains Genero BDL source code.
 * Reads the first 64 KB and tests for characteristic keywords, so the
 * extension does not accidentally try to diagram binary or unrelated text files.
 *
 * @param filePath  Absolute path to the file to inspect.
 * @returns         `true` when the file looks like a `.4gl` source file.
 */
function looksLike4glSource(filePath: string): boolean {
  try {
    const buf = fs.readFileSync(filePath);
    const content = buf.subarray(0, 64 * 1024).toString('utf8');
    return /^\s*(MAIN\b|END\s+(MAIN|FUNCTION|RECORD)\b|(PUBLIC|PRIVATE)\s+FUNCTION\s+\w|FUNCTION\s+\w|IMPORT\s+(FGL|JAVA)\s+|DATABASE\s+\w|SCHEMA\s+\w|TYPE\s+\w|DEFINE\s+\w|CONSTANT\s+\w)/im.test(content);
  } catch {
    return false;
  }
}

/**
 * VS Code extension activation entry point.
 *
 * Registers the `module-diagram.generate` command, which:
 *   1. Resolves the target `.4gl` file (from right-click URI, active editor, or file picker).
 *   2. Validates that the file is a Genero BDL source.
 *   3. Reads diagram options from the `moduleDiagram.*` workspace settings.
 *   4. Opens (or reuses) the {@link DiagramPanel} webview.
 *   5. Builds the call graph and pushes the result to the webview.
 *
 * @param context  Extension context provided by VS Code.
 */
export function activate(context: vscode.ExtensionContext): void {
  initLogger(context);

  const cmd = vscode.commands.registerCommand(
    'module-diagram.generate',
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

      if (!looksLike4glSource(filePath)) {
        vscode.window.showErrorMessage(
          `Genero BDL Diagram: "${path.basename(filePath)}" does not appear to be a valid Genero BDL source file.`
        );
        return;
      }

      const entryDir   = path.dirname(filePath);
      const entryLabel = path.basename(filePath, '.4gl');

      const cfg = vscode.workspace.getConfiguration('moduleDiagram');
      const options: DiagramOptions = {
        maxDepth:            cfg.get<number>('maxDepth', 2),
        showPrivate:         cfg.get<boolean>('showPrivateFunctions', true),
        showFieldEvents:     cfg.get<boolean>('showFieldEvents', false),
        showExternalModules: cfg.get<boolean>('showExternalModules', false),
      };

      const panel = DiagramPanel.getOrCreate(context, entryLabel, options);

      let cancelFlag = false;
      panel.setCancelCallback(() => { cancelFlag = true; });

      const tick = () => new Promise<void>(resolve => setImmediate(resolve));

      /**
       * Full rebuild pipeline: resolve paths → index modules → build graph → render.
       * Called on first open and whenever the user clicks Refresh in the webview.
       *
       * @param opts  Diagram options (may differ from initial `options` after a Refresh).
       */
      const rebuild = async (opts: DiagramOptions): Promise<void> => {
        cancelFlag = false;
        panel.setCancelCallback(() => { cancelFlag = true; });
        showChannel();
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Genero BDL Diagram', cancellable: true },
          async (progress, token) => {
            token.onCancellationRequested(() => { cancelFlag = true; });
            setProgressReporter(msg => progress.report({ message: msg }));
            try {
              log(`Building diagram for ${entryLabel}...`);   await tick();
              log('Resolving search paths...');               await tick();
              const searchPaths = resolveSearchPaths(entryDir);
              log('Indexing .4gl modules...');                await tick();
              const resolver    = new ModuleResolver(searchPaths);
              log('Traversing call graph...');                await tick();
              const builder     = new GraphBuilder(resolver);
              const graph       = builder.build(filePath, opts, () => cancelFlag);
              const hasEntryPoints = graph.nodes.has('ENTRY_MAIN') ||
                [...graph.nodes.values()].some(n => n.type === 'function');
              if (!hasEntryPoints) {
                vscode.window.showErrorMessage('No entry points in this file');
                panel.dispose();
                return;
              }
              log('Rendering diagram...');                    await tick();
              panel.updateGraph(graph);
              log(`Done — ${graph.nodes.size} nodes, ${graph.edges.length} edges.`);
            } catch (err) {
              const errMsg = (err as Error).message;
              log(`Error: ${errMsg}`);
              vscode.window.showErrorMessage(`Genero BDL Diagram: failed to build graph — ${errMsg}`);
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

/** VS Code extension deactivation hook. No explicit cleanup required. */
export function deactivate(): void {}

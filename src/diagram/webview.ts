import * as vscode from 'vscode';
import * as path from 'path';
import { AppGraph, DiagramOptions } from '../types';
import { renderMermaid } from './MermaidRenderer';

const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';

export class DiagramPanel {
  private static instance: DiagramPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private currentGraph: AppGraph | undefined;
  private currentOptions: DiagramOptions;
  private onRefreshRequest: ((opts: DiagramOptions) => void) | undefined;

  private constructor(
    context: vscode.ExtensionContext,
    entryLabel: string,
    options: DiagramOptions,
  ) {
    this.currentOptions = options;
    this.panel = vscode.window.createWebviewPanel(
      'generoAppDiagram',
      `Diagram: ${entryLabel}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );

    this.panel.webview.html = this.buildHtml('');
    this.panel.onDidDispose(() => { DiagramPanel.instance = undefined; }, null, context.subscriptions);

    this.panel.webview.onDidReceiveMessage(msg => {
      switch (msg.type) {
        case 'navigate':
          this.navigateTo(msg.filePath as string, msg.lineNumber as number);
          break;
        case 'refresh':
          this.currentOptions = {
            maxDepth:          msg.depth      as number,
            showPrivate:       msg.showPrivate as boolean,
            showFieldEvents:   msg.showFieldEvents as boolean,
            showExternalModules: msg.showExternal as boolean,
          };
          this.onRefreshRequest?.(this.currentOptions);
          break;
        case 'export':
          this.exportSvg(msg.data as string, entryLabel);
          break;
      }
    }, undefined, context.subscriptions);
  }

  static getOrCreate(
    context: vscode.ExtensionContext,
    entryLabel: string,
    options: DiagramOptions,
  ): DiagramPanel {
    if (!DiagramPanel.instance) {
      DiagramPanel.instance = new DiagramPanel(context, entryLabel, options);
    } else {
      DiagramPanel.instance.panel.reveal(vscode.ViewColumn.Beside);
    }
    return DiagramPanel.instance;
  }

  setRefreshCallback(cb: (opts: DiagramOptions) => void): void {
    this.onRefreshRequest = cb;
  }

  updateGraph(graph: AppGraph): void {
    this.currentGraph = graph;
    const { mermaid, nodeCount, edgeCount } = renderMermaid(graph, this.currentOptions);
    this.panel.webview.postMessage({
      type:    'update',
      diagram: mermaid,
      stats:   `${nodeCount} nodes · ${edgeCount} edges`,
    });
  }

  private navigateTo(filePath: string, lineNumber: number): void {
    const uri = vscode.Uri.file(filePath);
    const pos = new vscode.Position(Math.max(0, lineNumber - 1), 0);
    vscode.window.showTextDocument(uri, {
      selection:   new vscode.Range(pos, pos),
      viewColumn:  vscode.ViewColumn.One,
      preserveFocus: false,
    });
  }

  private async exportSvg(svgData: string, label: string): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${label.replace(/\W+/g, '_')}_diagram.svg`),
      filters:    { 'SVG files': ['svg'] },
    });
    if (!uri) { return; }
    const enc = new TextEncoder();
    await vscode.workspace.fs.writeFile(uri, enc.encode(svgData));
    vscode.window.showInformationMessage(`Diagram exported to ${uri.fsPath}`);
  }

  private buildHtml(initialDiagram: string): string {
    const opts = this.currentOptions;
    const nonce = Math.random().toString(36).slice(2);

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;
           style-src  'nonce-${nonce}';
           img-src    data:;">
<style nonce="${nonce}">
  :root { color-scheme: dark light; }
  body  { margin:0; padding:0; background:var(--vscode-editor-background);
          color:var(--vscode-editor-foreground); font-family:var(--vscode-font-family); font-size:13px; }
  #toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center;
             padding:6px 12px; border-bottom:1px solid var(--vscode-panel-border);
             background:var(--vscode-sideBar-background); }
  #toolbar label  { display:flex; gap:4px; align-items:center; }
  #toolbar select { background:var(--vscode-input-background); color:var(--vscode-input-foreground);
                    border:1px solid var(--vscode-input-border); padding:2px 4px; border-radius:3px; }
  #toolbar button { background:var(--vscode-button-background); color:var(--vscode-button-foreground);
                    border:none; padding:4px 10px; cursor:pointer; border-radius:3px; }
  #toolbar button:hover { background:var(--vscode-button-hoverBackground); }
  #stats  { font-size:11px; color:var(--vscode-descriptionForeground); margin-left:auto; }
  #diagram-wrap { overflow:auto; padding:16px; min-height:calc(100vh - 52px); }
  .mermaid { font-family: var(--vscode-font-family); }
  #loading { padding:24px; color:var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div id="toolbar">
  <label>Depth:
    <select id="sel-depth">
      <option value="0">0 – entry only</option>
      <option value="1">1</option>
      <option value="2" ${opts.maxDepth === 2 ? 'selected' : ''}>2 (default)</option>
      <option value="3">3</option>
      <option value="4">4</option>
      <option value="5">5</option>
      <option value="-1" ${opts.maxDepth === -1 ? 'selected' : ''}>Unlimited</option>
    </select>
  </label>
  <label><input type="checkbox" id="chk-private"  ${opts.showPrivate       ? 'checked' : ''}> PRIVATE functions</label>
  <label><input type="checkbox" id="chk-fields"   ${opts.showFieldEvents   ? 'checked' : ''}> Field events</label>
  <label><input type="checkbox" id="chk-external" ${opts.showExternalModules ? 'checked' : ''}> External modules</label>
  <button id="btn-refresh">&#8635; Refresh</button>
  <button id="btn-export">&#8615; Export SVG</button>
  <span id="stats"></span>
</div>
<div id="diagram-wrap">
  <div id="loading">Generating diagram…</div>
  <div class="mermaid" id="diagram" style="display:none">${initialDiagram}</div>
</div>

<script nonce="${nonce}" src="${MERMAID_CDN}"></script>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();

mermaid.initialize({
  startOnLoad: false,
  theme: document.body.classList.contains('vscode-light') ? 'default' : 'dark',
  flowchart: { useMaxWidth: true, htmlLabels: true },
  securityLevel: 'loose',
});

// Called by Mermaid click directives
window.navigateTo = function(filePath, lineNumber) {
  vscode.postMessage({ type: 'navigate', filePath, lineNumber: parseInt(lineNumber, 10) || 1 });
};

async function renderDiagram(source) {
  const el = document.getElementById('diagram');
  const loading = document.getElementById('loading');
  if (!source) { return; }
  try {
    el.removeAttribute('data-processed');
    el.textContent = source;
    await mermaid.run({ querySelector: '#diagram' });
    el.style.display = '';
    loading.style.display = 'none';
  } catch (err) {
    loading.textContent = 'Render error: ' + err.message;
    loading.style.display = '';
    el.style.display = 'none';
  }
}

document.getElementById('btn-refresh').addEventListener('click', () => {
  vscode.postMessage({
    type:            'refresh',
    depth:           parseInt(document.getElementById('sel-depth').value, 10),
    showPrivate:     document.getElementById('chk-private').checked,
    showFieldEvents: document.getElementById('chk-fields').checked,
    showExternal:    document.getElementById('chk-external').checked,
  });
});

document.getElementById('btn-export').addEventListener('click', () => {
  const svg = document.querySelector('#diagram svg');
  if (svg) {
    vscode.postMessage({ type: 'export', data: new XMLSerializer().serializeToString(svg) });
  } else {
    vscode.postMessage({ type: 'export', data: '' });
  }
});

window.addEventListener('message', async event => {
  const msg = event.data;
  if (msg.type === 'update') {
    document.getElementById('stats').textContent = msg.stats ?? '';
    await renderDiagram(msg.diagram);
  }
});
</script>
</body>
</html>`;
  }
}

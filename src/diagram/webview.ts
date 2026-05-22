import * as vscode from 'vscode';
import * as path from 'path';
import { AppGraph, DiagramOptions } from '../types';
import { renderMermaid } from './MermaidRenderer';

const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
const WEBVIEW_VERSION = '0.09';
const LAST_FOLDER_KEY = 'lastDiagramFolder';

export class DiagramPanel {
  private static instance: DiagramPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly entryLabel: string;
  private currentOptions: DiagramOptions;
  private onRefreshRequest:  ((opts: DiagramOptions) => void) | undefined;
  private onCancelRequest:   (() => void) | undefined;

  private constructor(
    context: vscode.ExtensionContext,
    entryLabel: string,
    options: DiagramOptions,
  ) {
    this.context = context;
    this.entryLabel = entryLabel;
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

    this.panel.webview.html = this.buildHtml();
    this.panel.onDidDispose(() => { DiagramPanel.instance = undefined; }, null, context.subscriptions);

    this.panel.webview.onDidReceiveMessage(msg => {
      switch (msg.type) {
        case 'navigate':
          this.navigateTo(msg.filePath as string, msg.lineNumber as number);
          break;
        case 'refresh':
          this.currentOptions = {
            maxDepth:            msg.depth          as number,
            showPrivate:         msg.showPrivate     as boolean,
            showFieldEvents:     msg.showFieldEvents as boolean,
            showExternalModules: msg.showExternal    as boolean,
          };
          this.onRefreshRequest?.(this.currentOptions);
          break;
        case 'export':
          this.exportDiagram(msg.svg as string);
          break;
        case 'cancel':
          this.onCancelRequest?.();
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

  setCancelCallback(cb: (() => void) | undefined): void {
    this.onCancelRequest = cb;
  }

  updateGraph(graph: AppGraph): void {
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

  private async exportDiagram(svgData: string): Promise<void> {
    if (!svgData) {
      vscode.window.showWarningMessage('No diagram rendered yet.');
      return;
    }
    const lastFolder = this.context.globalState.get<string>(LAST_FOLDER_KEY);
    const safeName   = this.entryLabel.replace(/\W+/g, '_');
    const timestamp  = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const suggested  = lastFolder
      ? vscode.Uri.file(path.join(lastFolder, `${safeName}_${timestamp}.html`))
      : vscode.Uri.file(`${safeName}_${timestamp}.html`);

    const uri = await vscode.window.showSaveDialog({
      defaultUri: suggested,
      filters:    { 'HTML files': ['html'] },
    });
    if (!uri) { return; }
    await this.context.globalState.update(LAST_FOLDER_KEY, path.dirname(uri.fsPath));

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${this.entryLabel} Diagram</title>
<style>
  body { margin: 0; padding: 16px; background: #1e1e1e;
         display: flex; justify-content: center; align-items: flex-start; }
  svg  { max-width: 100%; height: auto; }
</style>
</head>
<body>
${svgData}
</body>
</html>`;

    await vscode.workspace.fs.writeFile(uri, Buffer.from(html));
    await vscode.env.openExternal(uri);
  }

  private buildHtml(): string {
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
  #diagram-text {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size:   var(--vscode-editor-font-size, 12px);
    white-space: pre; background: var(--vscode-textCodeBlock-background, #1e1e1e);
    color: var(--vscode-editor-foreground); padding: 12px; border-radius: 4px;
    border: 1px solid var(--vscode-panel-border); overflow: auto; tab-size: 4; margin: 0;
  }
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
  <button id="btn-export">&#8615; Export Diagram</button>
  <button id="btn-cancel">&#10005; Cancel</button>
  <span id="stats"></span>
  <span id="ver" style="font-size:10px;opacity:0.5;margin-left:6px">v${WEBVIEW_VERSION}</span>
</div>
<div id="diagram-wrap">
  <div id="loading">Generating diagram…</div>
  <pre id="diagram-text" style="display:none"></pre>
</div>
<div id="diagram-render" class="mermaid" style="position:absolute;left:-9999px;top:0;width:800px"></div>

<script nonce="${nonce}" src="${MERMAID_CDN}"></script>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let mermaidSource = '';

mermaid.initialize({
  startOnLoad: false,
  theme: document.body.classList.contains('vscode-light') ? 'default' : 'dark',
  flowchart: { useMaxWidth: false, htmlLabels: false },
  securityLevel: 'loose',
  maxTextSize: 500000,
  maxEdges: 1000,
});

window.navigateTo = function(filePath, lineNumber) {
  vscode.postMessage({ type: 'navigate', filePath, lineNumber: parseInt(lineNumber, 10) || 1 });
};

document.getElementById('btn-refresh').addEventListener('click', () => {
  vscode.postMessage({
    type:            'refresh',
    depth:           parseInt(document.getElementById('sel-depth').value, 10),
    showPrivate:     document.getElementById('chk-private').checked,
    showFieldEvents: document.getElementById('chk-fields').checked,
    showExternal:    document.getElementById('chk-external').checked,
  });
});

document.getElementById('btn-export').addEventListener('click', () => renderAndExport());

async function renderAndExport() {
  if (!mermaidSource) { return; }
  const renderEl = document.getElementById('diagram-render');
  try {
    renderEl.removeAttribute('data-processed');
    renderEl.textContent = mermaidSource;
    await mermaid.run({ querySelector: '#diagram-render' });
    const svgEl = renderEl.querySelector('svg');
    const svg   = svgEl ? new XMLSerializer().serializeToString(svgEl) : '';
    vscode.postMessage({ type: 'export', svg });
  } catch (err) {
    vscode.postMessage({ type: 'export', svg: '' });
  }
}

document.getElementById('btn-cancel').addEventListener('click', () => {
  vscode.postMessage({ type: 'cancel' });
});

window.addEventListener('message', async event => {
  const msg = event.data;
  if (msg.type === 'update') {
    mermaidSource = msg.diagram ?? '';
    document.getElementById('stats').textContent = msg.stats ?? '';
    const textEl  = document.getElementById('diagram-text');
    const loading = document.getElementById('loading');
    textEl.textContent    = mermaidSource;
    textEl.style.display  = mermaidSource ? '' : 'none';
    loading.style.display = mermaidSource ? 'none' : '';
    if (mermaidSource) { await renderAndExport(); }
  }
});
</script>
</body>
</html>`;
  }
}

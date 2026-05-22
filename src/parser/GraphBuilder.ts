import * as path from 'path';
import { log } from '../utils/logger';
import { FglParser } from './FglParser';
import { ModuleResolver } from './ModuleResolver';
import {
  AppGraph, GraphNode, GraphEdge, DiagramOptions,
  ParsedModule, FunctionSignature, AccessPoint, CallRef, NodeType,
} from '../types';

// ─── ID helpers ────────────────────────────────────────────────────────────

function safeId(s: string): string {
  // Mermaid node IDs: alphanumeric + underscore only
  return s.replace(/[^a-zA-Z0-9_]/g, '_');
}

function moduleId(moduleName: string): string {
  return `M_${safeId(moduleName)}`;
}

function funcId(moduleName: string, funcName: string): string {
  return `F_${safeId(moduleName)}_${safeId(funcName)}`;
}

function dialogId(moduleName: string, funcName: string, dialogType: string, idx: number): string {
  return `D_${safeId(moduleName)}_${safeId(funcName)}_${safeId(dialogType)}_${idx}`;
}

// ─── GraphBuilder ──────────────────────────────────────────────────────────

export class GraphBuilder {
  private parser = new FglParser();
  private parsedModules = new Map<string, ParsedModule>(); // filePath → parsed
  private dialogCounters = new Map<string, number>();      // funcId → counter

  constructor(private resolver: ModuleResolver) {}

  /**
   * Build a complete AppGraph starting from the given entry .4gl file.
   */
  build(entryFilePath: string, options: DiagramOptions): AppGraph {
    const graph: AppGraph = {
      nodes: new Map(),
      edges: [],
      entryFilePath,
      entryModuleName: path.basename(entryFilePath, '.4gl'),
    };

    this.parsedModules.clear();
    this.dialogCounters.clear();

    // BFS traversal of modules
    const visited = new Set<string>();
    const queue: Array<{ filePath: string; depth: number }> = [
      { filePath: entryFilePath, depth: 0 },
    ];

    while (queue.length > 0) {
      const item = queue.shift()!;
      if (visited.has(item.filePath)) { continue; }
      visited.add(item.filePath);

      log(`  Parsing ${path.basename(item.filePath)} (depth ${item.depth})…`);
      const parsed = this.parser.parse(item.filePath);
      this.parsedModules.set(item.filePath, parsed);

      this.addModuleNodes(graph, parsed, item.filePath === entryFilePath, options);

      // Enqueue imports if within depth limit
      if (options.maxDepth === -1 || item.depth < options.maxDepth) {
        for (const imp of parsed.imports) {
          const resolved = this.resolver.resolve(imp.rawPath);
          if (resolved && !visited.has(resolved)) {
            queue.push({ filePath: resolved, depth: item.depth + 1 });
          }
        }
      }
    }

    log(`Call graph: ${this.parsedModules.size} module${this.parsedModules.size !== 1 ? 's' : ''} parsed`);

    // Second pass: build edges now that all modules are parsed
    for (const [filePath, parsed] of this.parsedModules) {
      this.addModuleEdges(graph, parsed, options);
    }

    return graph;
  }

  // ── Node construction ───────────────────────────────────────────────────

  private addModuleNodes(
    graph: AppGraph,
    parsed: ParsedModule,
    isEntry: boolean,
    options: DiagramOptions,
  ): void {
    // Module node
    const mid = moduleId(parsed.moduleName);
    graph.nodes.set(mid, {
      id: mid,
      type: 'module',
      label: parsed.moduleName,
      filePath: parsed.filePath,
      moduleName: parsed.moduleName,
    });

    // MAIN entry node (separate from the module node)
    if (isEntry && parsed.hasMain) {
      const entryNodeId = 'ENTRY_MAIN';
      graph.nodes.set(entryNodeId, {
        id: entryNodeId,
        type: 'entry',
        label: 'MAIN',
        filePath: parsed.filePath,
        lineNumber: 1,
        moduleName: parsed.moduleName,
      });
      // Entry → module edge
      this.addEdge(graph, entryNodeId, mid, 'imports', parsed.moduleName);
    }

    // Function nodes
    for (const sig of parsed.functions) {
      if (!options.showPrivate && sig.visibility === 'PRIVATE') { continue; }
      const fid = funcId(parsed.moduleName, sig.name);
      const label = this.formatFuncLabel(sig);
      graph.nodes.set(fid, {
        id: fid,
        type: 'function',
        label,
        filePath: sig.filePath,
        lineNumber: sig.lineNumber,
        signature: sig,
        moduleName: parsed.moduleName,
      });
    }

    // Access point nodes (dialogs + handlers)
    const seenDialogs = new Map<string, string>(); // "funcName|dialogType|title" → dialog node id
    for (const ap of parsed.accessPoints) {
      if (!options.showFieldEvents && this.isFieldEvent(ap)) { continue; }

      // Create a dialog node if we haven't seen this dialog yet
      const dlgKey = `${ap.containingFunction}|${ap.dialogType}|${ap.dialogTitle ?? ''}`;
      if (!seenDialogs.has(dlgKey) && ap.dialogType !== 'NONE') {
        const fid = funcId(parsed.moduleName, ap.containingFunction);
        const counter = (this.dialogCounters.get(fid) ?? 0) + 1;
        this.dialogCounters.set(fid, counter);
        const did = dialogId(parsed.moduleName, ap.containingFunction, ap.dialogType, counter);
        const dlgLabel = ap.dialogTitle
          ? `${ap.dialogType} "${ap.dialogTitle}"`
          : ap.dialogType;
        graph.nodes.set(did, {
          id: did,
          type: ap.dialogType.toLowerCase().replace('_', '_') as NodeType,
          label: dlgLabel,
          filePath: parsed.filePath,
          moduleName: parsed.moduleName,
        });
        seenDialogs.set(dlgKey, did);
      }
    }
  }

  // ── Edge construction ───────────────────────────────────────────────────

  private addModuleEdges(graph: AppGraph, parsed: ParsedModule, options: DiagramOptions): void {
    const mid = moduleId(parsed.moduleName);

    // Import edges: module → imported module (or external node)
    for (const imp of parsed.imports) {
      const resolved = this.resolver.resolve(imp.rawPath);
      if (resolved) {
        const targetName = path.basename(resolved, '.4gl');
        const targetId = moduleId(targetName);
        if (graph.nodes.has(targetId)) {
          this.addEdge(graph, mid, targetId, 'imports');
        }
      } else if (options.showExternalModules) {
        const extId = `EXT_${safeId(imp.moduleName)}`;
        if (!graph.nodes.has(extId)) {
          graph.nodes.set(extId, {
            id: extId, type: 'external', label: imp.moduleName,
          });
        }
        this.addEdge(graph, mid, extId, 'imports');
      }
    }

    // Build alias → moduleName map for this file
    const aliasMap = new Map<string, string>();
    for (const imp of parsed.imports) {
      if (imp.alias) { aliasMap.set(imp.alias.toLowerCase(), imp.moduleName); }
      // Also register the bare module name → itself (unaliased cross-module calls)
      aliasMap.set(imp.moduleName.toLowerCase(), imp.moduleName);
    }

    // Function → function edges (direct calls in function body)
    for (const [callerName, calls] of parsed.directCalls) {
      if (!options.showPrivate) {
        const sig = parsed.functions.find(f => f.name === callerName);
        if (sig && sig.visibility === 'PRIVATE') { continue; }
      }
      const callerFid = funcId(parsed.moduleName, callerName);
      for (const call of calls) {
        if (call.isFunctionRef) { continue; }
        this.resolveCallEdge(graph, callerFid, call, parsed, aliasMap, options, 'calls');
      }
    }

    // Access point edges
    const seenDialogs = new Map<string, string>();
    for (const ap of parsed.accessPoints) {
      if (!options.showFieldEvents && this.isFieldEvent(ap)) { continue; }

      const containingFid = funcId(parsed.moduleName, ap.containingFunction);
      if (!graph.nodes.has(containingFid)) { continue; }

      // Ensure dialog node exists and create function→dialog edge
      const dlgKey = `${ap.containingFunction}|${ap.dialogType}|${ap.dialogTitle ?? ''}`;
      if (ap.dialogType !== 'NONE' && !seenDialogs.has(dlgKey)) {
        // Find the dialog node we created during addModuleNodes
        const dlgNode = [...graph.nodes.values()].find(n =>
          n.moduleName === parsed.moduleName &&
          this.isDialogNodeType(n.type) &&
          n.label === (ap.dialogTitle ? `${ap.dialogType} "${ap.dialogTitle}"` : ap.dialogType)
        );
        if (dlgNode) {
          seenDialogs.set(dlgKey, dlgNode.id);
          this.addEdge(graph, containingFid, dlgNode.id, 'opens');
        }
      }

      const dlgNodeId = seenDialogs.get(dlgKey);

      // Access point calls → target function edges
      for (const call of ap.calls) {
        if (call.isFunctionRef) { continue; }
        const edgeLabel = this.formatApLabel(ap);
        const fromId = dlgNodeId ?? containingFid;
        this.resolveCallEdge(graph, fromId, call, parsed, aliasMap, options, 'triggers', edgeLabel);
      }
    }
  }

  private resolveCallEdge(
    graph: AppGraph,
    fromId: string,
    call: CallRef,
    parsed: ParsedModule,
    aliasMap: Map<string, string>,
    options: DiagramOptions,
    edgeType: 'calls' | 'triggers',
    edgeLabel?: string,
  ): void {
    let targetModuleName: string | undefined;
    let targetFuncName = call.functionName;

    if (call.qualifier) {
      // Resolve qualifier: could be an alias or a direct module name
      targetModuleName =
        aliasMap.get(call.qualifier.toLowerCase()) ?? call.qualifier;
    }

    if (targetModuleName) {
      // Cross-module call
      const targetFid = funcId(targetModuleName, targetFuncName);
      const targetMid = moduleId(targetModuleName);
      // Only draw edge if the target module is in the graph
      if (graph.nodes.has(targetFid)) {
        this.addEdge(graph, fromId, targetFid, edgeType, edgeLabel);
      } else if (graph.nodes.has(targetMid) && options.showExternalModules) {
        this.addEdge(graph, fromId, targetMid, edgeType, edgeLabel);
      }
    } else {
      // Local call within the same module
      const targetFid = funcId(parsed.moduleName, targetFuncName);
      if (graph.nodes.has(targetFid)) {
        this.addEdge(graph, fromId, targetFid, edgeType, edgeLabel);
      }
    }
  }

  // ── Utilities ───────────────────────────────────────────────────────────

  private addEdge(
    graph: AppGraph,
    from: string,
    to: string,
    type: GraphEdge['type'],
    label?: string,
  ): void {
    // Avoid duplicate edges
    const exists = graph.edges.some(
      e => e.from === from && e.to === to && e.type === type && e.label === label,
    );
    if (!exists && from !== to) {
      graph.edges.push({ from, to, type, label });
    }
  }

  private formatFuncLabel(sig: FunctionSignature): string {
    const vis = sig.visibility === 'PUBLIC' ? '+' : '-';
    const params = sig.params.map(p => `${p.name}: ${p.type}`).join(', ');
    const ret = sig.returns.length > 0 ? ` → ${sig.returns.join(', ')}` : '';
    const typePrefix = sig.isTypeMethod ? `(${sig.typeName}) ` : '';
    return `${vis} ${typePrefix}${sig.name}(${params})${ret}`;
  }

  private formatApLabel(ap: AccessPoint): string {
    switch (ap.apType) {
      case 'ON_ACTION':     return `action: ${ap.name}`;
      case 'COMMAND':       return `cmd: ${ap.name}`;
      case 'ON_CHANGE':     return `change: ${ap.name}`;
      case 'BEFORE_FIELD':  return `before: ${ap.name}`;
      case 'AFTER_FIELD':   return `after: ${ap.name}`;
      case 'BEFORE_MENU':   return 'before menu';
      case 'BEFORE_INPUT':  return 'before input';
      case 'BEFORE_CONSTRUCT': return 'before construct';
      case 'BEFORE_ROW':    return 'before row';
      case 'AFTER_ROW':     return 'after row';
      case 'ON_CRUD':       return ap.name.toLowerCase();
      default:              return ap.name;
    }
  }

  private isFieldEvent(ap: AccessPoint): boolean {
    return ['ON_CHANGE', 'BEFORE_FIELD', 'AFTER_FIELD', 'BEFORE_ROW', 'AFTER_ROW'].includes(ap.apType);
  }

  private isDialogNodeType(type: NodeType): boolean {
    return ['menu', 'input', 'construct', 'display_array', 'dialog'].includes(type);
  }
}

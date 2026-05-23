import * as path from 'path';
import { log } from '../utils/logger';
import { FglParser } from './FglParser';
import { ModuleResolver } from './ModuleResolver';
import {
  AppGraph, GraphNode, GraphEdge, DiagramOptions,
  ParsedModule, FunctionSignature, AccessPoint, CallRef, NodeType,
} from '../types';

// ─── ID helpers ────────────────────────────────────────────────────────────

/**
 * Sanitise a string for use as a Mermaid node ID.
 *
 * @param s  Raw string (module name, function name, etc.).
 * @returns  String with only alphanumeric characters and underscores.
 */
function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Build the stable node ID for a module node.
 *
 * @param moduleName  Module stem (file name without `.4gl`).
 * @returns           Prefixed ID string, e.g. `"M_RegisterController"`.
 */
function moduleId(moduleName: string): string {
  return `M_${safeId(moduleName)}`;
}

/**
 * Build the stable node ID for a function node.
 *
 * @param moduleName  Module stem.
 * @param funcName    Function name as declared in source.
 * @returns           Prefixed ID string, e.g. `"F_RegisterController_regLoop"`.
 */
function funcId(moduleName: string, funcName: string): string {
  return `F_${safeId(moduleName)}_${safeId(funcName)}`;
}

/**
 * Build the stable node ID for a dialog block node.
 *
 * @param moduleName  Module stem.
 * @param funcName    Containing function name.
 * @param dialogType  Dialog type keyword (`"INPUT"`, `"MENU"`, etc.).
 * @param idx         1-based occurrence counter within the function (for multiple dialogs).
 * @returns           Prefixed ID string.
 */
function dialogId(moduleName: string, funcName: string, dialogType: string, idx: number): string {
  return `D_${safeId(moduleName)}_${safeId(funcName)}_${safeId(dialogType)}_${idx}`;
}

// ─── GraphBuilder ──────────────────────────────────────────────────────────

/**
 * Builds an {@link AppGraph} by parsing the entry `.4gl` file and all modules
 * reachable via `IMPORT FGL` declarations, up to the configured depth.
 *
 * The build is a two-pass process:
 *   1. **BFS traversal** — parse each module in breadth-first order, create all nodes.
 *   2. **Edge pass** — once every reachable module is parsed, resolve all call references
 *      and create edges between nodes.
 */
export class GraphBuilder {
  private parser = new FglParser();
  private parsedModules = new Map<string, ParsedModule>(); // filePath → parsed
  private dialogCounters = new Map<string, number>();      // funcId → counter

  /**
   * @param resolver  {@link ModuleResolver} used to locate imported `.4gl` files.
   */
  constructor(private resolver: ModuleResolver) {}

  /**
   * Build a complete {@link AppGraph} starting from the given entry `.4gl` file.
   *
   * @param entryFilePath  Absolute path to the entry (MAIN) source file.
   * @param options        Diagram options controlling depth, visibility, etc.
   * @param isCancelled    Optional cancellation probe — polling returns `true` when
   *                       the user has clicked Cancel in the progress notification.
   * @returns              Fully populated {@link AppGraph}.
   */
  build(entryFilePath: string, options: DiagramOptions, isCancelled?: () => boolean): AppGraph {
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
      if (isCancelled?.()) { break; }
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

  /**
   * Create all graph nodes for a single parsed module:
   *   - One module node.
   *   - An `ENTRY_MAIN` entry node for the top-level file (if it has a `MAIN` block).
   *   - One function node per public (and optionally private) function.
   *   - One dialog node per unique `MENU`/`INPUT`/`CONSTRUCT`/`DISPLAY ARRAY`/`DIALOG` block.
   *
   * @param graph    Graph being constructed.
   * @param parsed   Parse result for the module.
   * @param isEntry  `true` when this is the entry file passed to {@link build}.
   * @param options  Diagram options.
   */
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

  /**
   * Create all graph edges for a single parsed module:
   *   - Import edges (module → imported module or external stub).
   *   - Contains edges (module → each of its function nodes).
   *   - Calls edges (function → functions it calls directly).
   *   - Dialog/access-point edges (function → dialog node → triggered functions).
   *
   * @param graph    Graph being constructed (all module nodes already added).
   * @param parsed   Parse result for the module.
   * @param options  Diagram options.
   */
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

    // Module → function edges (makes functions reachable in the tree walk)
    for (const sig of parsed.functions) {
      const fid = funcId(parsed.moduleName, sig.name);
      if (graph.nodes.has(fid)) {
        this.addEdge(graph, mid, fid, 'contains');
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

  /**
   * Resolve a single {@link CallRef} to a target graph node and create an edge.
   *
   * Handles three call patterns:
   *   - `localFunction()` — same-module lookup.
   *   - `Module.function()` — cross-module lookup via alias or direct module name.
   *   - `Module.variable.method()` — type-method call with intermediate variable.
   *
   * If the target node is not present in the graph (e.g. depth-limited or
   * unresolvable), the edge is silently omitted.
   *
   * @param graph      Graph being constructed.
   * @param fromId     Source node ID.
   * @param call       Call reference to resolve.
   * @param parsed     Parse result for the module containing the call.
   * @param aliasMap   Maps lower-case import alias/name → canonical module name.
   * @param options    Diagram options.
   * @param edgeType   `'calls'` or `'triggers'`.
   * @param edgeLabel  Optional label to attach to the edge.
   */
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
      targetModuleName =
        aliasMap.get(call.qualifier.toLowerCase()) ?? call.qualifier;
    }

    if (targetModuleName) {
      // Cross-module call
      const targetFid = funcId(targetModuleName, targetFuncName);
      const targetMid = moduleId(targetModuleName);
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

  /**
   * Add a directed edge to the graph, silently ignoring self-loops and duplicates.
   *
   * @param graph  Graph being constructed.
   * @param from   Source node ID.
   * @param to     Target node ID.
   * @param type   Semantic edge type.
   * @param label  Optional display label.
   */
  private addEdge(
    graph: AppGraph,
    from: string,
    to: string,
    type: GraphEdge['type'],
    label?: string,
  ): void {
    const exists = graph.edges.some(
      e => e.from === from && e.to === to && e.type === type && e.label === label,
    );
    if (!exists && from !== to) {
      graph.edges.push({ from, to, type, label });
    }
  }

  /**
   * Format the display label for a function node, including visibility prefix,
   * parameter names/types, and return types.
   *
   * @param sig  Parsed function signature.
   * @returns    Label string, e.g. `"+ regLoop() → BOOLEAN"`.
   */
  private formatFuncLabel(sig: FunctionSignature): string {
    const vis = sig.visibility === 'PUBLIC' ? '+' : '-';
    const params = sig.params.map(p => `${p.name}: ${p.type}`).join(', ');
    const ret = sig.returns.length > 0 ? ` → ${sig.returns.join(', ')}` : '';
    const typePrefix = sig.isTypeMethod ? `(${sig.typeName}) ` : '';
    return `${vis} ${typePrefix}${sig.name}(${params})${ret}`;
  }

  /**
   * Format the edge label for an access-point handler.
   *
   * @param ap  Access point whose type and name determine the label.
   * @returns   Short label string, e.g. `"action: accept"` or `"after: qty"`.
   */
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

  /**
   * Return `true` when the access point is a field-level event that should be
   * hidden when `options.showFieldEvents` is `false`.
   *
   * @param ap  Access point to test.
   */
  private isFieldEvent(ap: AccessPoint): boolean {
    return ['ON_CHANGE', 'BEFORE_FIELD', 'AFTER_FIELD', 'BEFORE_ROW', 'AFTER_ROW'].includes(ap.apType);
  }

  /**
   * Return `true` when the node type represents a dialog block (not a handler).
   *
   * @param type  Node type to test.
   */
  private isDialogNodeType(type: NodeType): boolean {
    return ['menu', 'input', 'construct', 'display_array', 'dialog'].includes(type);
  }
}

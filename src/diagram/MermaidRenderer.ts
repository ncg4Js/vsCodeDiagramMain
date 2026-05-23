import { AppGraph, GraphNode, GraphEdge, DiagramOptions, NodeType } from '../types';

/** Characters that need escaping inside Mermaid node label strings. */
const MERMAID_ESCAPE: [RegExp, string][] = [
  [/"/g,  '#quot;'],
  [/</g,  '#lt;'],
  [/>/g,  '#gt;'],
  [/&/g,  '#amp;'],
  [/\(/g, '#lpar;'],
  [/\)/g, '#rpar;'],
];

/**
 * Escape a string so it is safe to embed inside a Mermaid node label.
 *
 * @param s  Raw label text.
 * @returns  Escaped label text.
 */
function escapeMermaid(s: string): string {
  let out = s;
  for (const [re, sub] of MERMAID_ESCAPE) { out = out.replace(re, sub); }
  return out;
}

/**
 * Sanitise a string for use as a Mermaid node ID (alphanumeric + underscore only).
 *
 * @param s  Raw identifier string.
 * @returns  Safe ID string.
 */
function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Return the Mermaid shape syntax (label + delimiters) for a graph node.
 *
 * @param node  Graph node whose type determines the shape.
 * @returns     Mermaid shape string, e.g. `("label")` or `["label"]`.
 */
function nodeShape(node: GraphNode): string {
  const lbl = escapeMermaid(node.label);
  switch (node.type as NodeType) {
    case 'entry':         return `{{${lbl}}}`;
    case 'module':        return `["${lbl}"]`;
    case 'function':      return `("${lbl}")`;
    case 'menu':
    case 'input':
    case 'construct':
    case 'display_array':
    case 'dialog':        return `[/"${lbl}"/]`;
    case 'external':      return `[["${lbl}"]]`;
    default:              return `["${lbl}"]`;
  }
}

/**
 * Return the Mermaid arrow syntax for a graph edge type.
 *
 * @param type  Edge type from the graph model.
 * @returns     Mermaid arrow string, e.g. `"-->"` or `"-.->"`.
 */
function edgeArrow(type: GraphEdge['type']): string {
  switch (type) {
    case 'imports':       return '-->';
    case 'contains':      return '-->';
    case 'calls':         return '-->';
    case 'opens':         return '-.->';
    case 'triggers':      return '-->';
    case 'function_ref':  return '-.->';
    case 'navigates':     return '==>';
    default:              return '-->';
  }
}

/**
 * Render a single graph edge as a Mermaid flowchart line.
 *
 * @param edge  Graph edge to serialise.
 * @returns     Indented Mermaid edge line, e.g. `"    A --> B"`.
 */
function edgeLine(edge: GraphEdge): string {
  const arrow = edgeArrow(edge.type);
  if (edge.label) {
    return `    ${edge.from} ${arrow}|"${escapeMermaid(edge.label)}"| ${edge.to}`;
  }
  return `    ${edge.from} ${arrow} ${edge.to}`;
}

/** Result produced by {@link renderMermaid}. */
export interface RenderResult {
  /** Complete Mermaid `flowchart TD` diagram text. */
  mermaid: string;
  /** Total number of nodes included. */
  nodeCount: number;
  /** Total number of edges included. */
  edgeCount: number;
}

/**
 * Render an {@link AppGraph} as a Mermaid `flowchart TD` diagram.
 *
 * Function nodes are grouped into `subgraph` blocks per module. All nodes
 * receive click handlers that post a `navigate` message back to the extension
 * host so VS Code can open the corresponding source file.
 *
 * @param graph    Application graph produced by {@link GraphBuilder.build}.
 * @param options  Diagram options (currently unused in the renderer itself but
 *                 kept for forward compatibility).
 * @returns        {@link RenderResult} with the Mermaid text and graph statistics.
 */
export function renderMermaid(graph: AppGraph, options: DiagramOptions): RenderResult {
  const lines: string[] = ['flowchart TD'];

  // Partition nodes into per-module groups (for subgraphs) and top-level
  const moduleGroups = new Map<string, GraphNode[]>();
  const topLevelNodes: GraphNode[] = [];

  for (const node of graph.nodes.values()) {
    if (node.type === 'function' && node.moduleName) {
      const list = moduleGroups.get(node.moduleName) ?? [];
      list.push(node);
      moduleGroups.set(node.moduleName, list);
    } else {
      topLevelNodes.push(node);
    }
  }

  // Top-level nodes (entry, module references, dialog nodes, external)
  for (const node of topLevelNodes) {
    lines.push(`    ${node.id}${nodeShape(node)}`);
  }

  // Subgraphs per module containing function nodes
  for (const [moduleName, funcs] of moduleGroups) {
    const subId = safeId(moduleName);
    lines.push(`    subgraph ${subId}["${escapeMermaid(moduleName)}"]`);
    for (const fn of funcs) {
      lines.push(`        ${fn.id}${nodeShape(fn)}`);
    }
    lines.push('    end');
  }

  // Edges (only between nodes present in the graph)
  for (const edge of graph.edges) {
    if (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) { continue; }
    lines.push(edgeLine(edge));
  }

  // Click handlers — call a global JS function that posts a message to the extension
  for (const node of graph.nodes.values()) {
    if (node.filePath) {
      const fp = node.filePath.replace(/\\/g, '/');
      const ln = node.lineNumber ?? 1;
      lines.push(`    click ${node.id} call navigateTo("${fp}","${ln}")`);
    }
  }

  // Style classes
  lines.push('');
  lines.push('    classDef entryStyle    fill:#7B2FBE,stroke:#5A1F8C,color:#fff,font-weight:bold');
  lines.push('    classDef moduleStyle   fill:#1E3A5F,stroke:#4A90C4,color:#cce4ff');
  lines.push('    classDef funcStyle     fill:#1A4731,stroke:#2D9C64,color:#b3f0d4');
  lines.push('    classDef dialogStyle   fill:#5C3A1E,stroke:#C47A30,color:#f5deba');
  lines.push('    classDef externalStyle fill:#2A2A2A,stroke:#555,color:#999,stroke-dasharray:5 5');

  for (const node of graph.nodes.values()) {
    const cls = nodeClass(node.type);
    if (cls) { lines.push(`    class ${node.id} ${cls}`); }
  }

  return {
    mermaid: lines.join('\n'),
    nodeCount: graph.nodes.size,
    edgeCount: graph.edges.length,
  };
}

/**
 * Map a {@link NodeType} to its Mermaid `classDef` name.
 *
 * @param type  Node type.
 * @returns     CSS class name string, or `null` if no style is defined for this type.
 */
function nodeClass(type: NodeType): string | null {
  switch (type) {
    case 'entry':                                      return 'entryStyle';
    case 'module':                                     return 'moduleStyle';
    case 'function':                                   return 'funcStyle';
    case 'menu': case 'input': case 'construct':
    case 'display_array': case 'dialog':               return 'dialogStyle';
    case 'external':                                   return 'externalStyle';
    default:                                           return null;
  }
}

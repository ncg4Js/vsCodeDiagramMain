import { AppGraph, GraphNode, NodeType } from '../types';

/** Result produced by {@link renderAscii}. */
export interface AsciiResult {
  /** The complete ASCII tree as a single multi-line string. */
  ascii:     string;
  /** Total number of nodes in the graph. */
  nodeCount: number;
  /** Total number of edges in the graph. */
  edgeCount: number;
}

/**
 * Return the Unicode symbol used to represent a node type in the ASCII tree.
 *
 * @param type  Node type from the graph model.
 * @returns     Single Unicode character.
 */
function sym(type: NodeType): string {
  switch (type) {
    case 'entry':                                          return '◆';
    case 'module':                                         return '▣';
    case 'function':                                       return '○';
    case 'menu': case 'input': case 'construct':
    case 'display_array': case 'dialog':                   return '◇';
    case 'external':                                       return '□';
    default:                                               return '·';
  }
}

/**
 * Format the file location suffix appended to each node label.
 *
 * @param node  Graph node that may carry a file path and line number.
 * @returns     `"  [file.4gl:42]"` string, or empty string if no path is set.
 */
function loc(node: GraphNode): string {
  if (!node.filePath) { return ''; }
  const file = node.filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  return node.lineNumber ? `  [${file}:${node.lineNumber}]` : `  [${file}]`;
}

/**
 * Render an {@link AppGraph} as a recursive ASCII tree.
 *
 * The tree is rooted at the `entry` node (if present) or the entry module node
 * (for libraries without a `MAIN` block). Already-visited nodes are marked with
 * `↺` to break cycles without omitting them entirely.
 *
 * @param graph  Application graph produced by {@link GraphBuilder.build}.
 * @returns      {@link AsciiResult} with the rendered text and graph statistics.
 */
export function renderAscii(graph: AppGraph): AsciiResult {
  // Build outgoing adjacency list (deduped)
  const out = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) { continue; }
    const list = out.get(edge.from) ?? [];
    if (!list.includes(edge.to)) { list.push(edge.to); }
    out.set(edge.from, list);
  }

  const lines: string[] = [];
  const visited = new Set<string>();

  /**
   * Recursively render a subtree rooted at `nodeId`.
   *
   * @param nodeId   ID of the node to render.
   * @param prefix   Indentation prefix accumulated by the parent call.
   * @param isLast   Whether this node is the last child of its parent.
   */
  function walk(nodeId: string, prefix: string, isLast: boolean): void {
    const node = graph.nodes.get(nodeId);
    if (!node) { return; }

    const conn      = isLast ? '└──► ' : '├──► ';
    const childPfx  = prefix + (isLast ? '     ' : '│    ');
    const cycled    = visited.has(nodeId);
    const cycleMark = cycled ? '  ↺' : '';

    lines.push(`${prefix}${conn}${sym(node.type)} ${node.label}${loc(node)}${cycleMark}`);

    if (!cycled) {
      visited.add(nodeId);
      const children = out.get(nodeId) ?? [];
      for (let i = 0; i < children.length; i++) {
        walk(children[i], childPfx, i === children.length - 1);
      }
    }
  }

  const entry = [...graph.nodes.values()].find(n => n.type === 'entry');

  if (entry) {
    lines.push('◆ ' + entry.label);
    lines.push('');
    visited.add(entry.id);
    const roots = out.get(entry.id) ?? [];
    for (let i = 0; i < roots.length; i++) {
      walk(roots[i], '', i === roots.length - 1);
    }
  } else {
    // No MAIN — use the entry module node as root so all functions are reachable
    const entryModule = [...graph.nodes.values()].find(
      n => n.type === 'module' && n.moduleName === graph.entryModuleName,
    );
    if (!entryModule) {
      return { ascii: '(nothing to render)', nodeCount: graph.nodes.size, edgeCount: graph.edges.length };
    }
    lines.push('▣ ' + entryModule.label + '  (no MAIN)');
    lines.push('');
    visited.add(entryModule.id);
    const roots = out.get(entryModule.id) ?? [];
    for (let i = 0; i < roots.length; i++) {
      walk(roots[i], '', i === roots.length - 1);
    }
  }

  lines.push('');
  lines.push('◆ entry  ▣ module  ○ function  ◇ dialog/menu/input  □ external  ↺ already shown above  + public  - private');

  return { ascii: lines.join('\n'), nodeCount: graph.nodes.size, edgeCount: graph.edges.length };
}

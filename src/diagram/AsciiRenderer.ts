import { AppGraph, GraphNode, NodeType } from '../types';

export interface AsciiResult {
  ascii:     string;
  nodeCount: number;
  edgeCount: number;
}

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

function loc(node: GraphNode): string {
  if (!node.filePath) { return ''; }
  const file = node.filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  return node.lineNumber ? `  [${file}:${node.lineNumber}]` : `  [${file}]`;
}

export function renderAscii(graph: AppGraph): AsciiResult {
  // Build outgoing adjacency (deduped)
  const out = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) { continue; }
    const list = out.get(edge.from) ?? [];
    if (!list.includes(edge.to)) { list.push(edge.to); }
    out.set(edge.from, list);
  }

  const entry = [...graph.nodes.values()].find(n => n.type === 'entry');
  if (!entry) {
    return { ascii: '(no entry node found)', nodeCount: 0, edgeCount: 0 };
  }

  const lines: string[] = [];
  const width = Math.max(entry.label.length + 6, 52);

  // Header box
  lines.push('┌' + '─'.repeat(width) + '┐');
  lines.push('│  ◆ ' + entry.label.padEnd(width - 3) + '│');
  lines.push('└' + '─'.repeat(width) + '┘');

  const visited = new Set<string>([entry.id]);

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

  const roots = out.get(entry.id) ?? [];
  for (let i = 0; i < roots.length; i++) {
    walk(roots[i], '', i === roots.length - 1);
  }

  lines.push('');
  lines.push('◆ entry  ▣ module  ○ function  ◇ dialog/menu/input  □ external  ↺ already shown above');

  return { ascii: lines.join('\n'), nodeCount: graph.nodes.size, edgeCount: graph.edges.length };
}

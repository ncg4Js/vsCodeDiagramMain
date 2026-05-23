/** Shared type definitions for the Genero Application Diagram extension. */

/** Identifies the visual and semantic role of a {@link GraphNode}. */
export type NodeType =
  | 'entry'          // MAIN block
  | 'module'         // .4gl source file
  | 'function'       // FUNCTION or type method
  | 'menu'           // MENU "title" block
  | 'input'          // INPUT ... FROM or INPUT BY NAME block
  | 'construct'      // CONSTRUCT ... ON ... block
  | 'display_array'  // DISPLAY ARRAY ... TO block
  | 'dialog'         // combined DIALOG block
  | 'action'         // ON ACTION handler
  | 'command'        // COMMAND "text" item
  | 'field_event'    // ON CHANGE / BEFORE FIELD / AFTER FIELD
  | 'external';      // module not found in any search path

/** Identifies the semantic relationship between two {@link GraphNode}s. */
export type EdgeType =
  | 'imports'       // IMPORT FGL
  | 'contains'      // module contains function
  | 'calls'         // direct CALL in function body
  | 'opens'         // function opens a dialog block
  | 'triggers'      // access point triggers a function call
  | 'function_ref'  // FUNCTION keyword reference (not a call)
  | 'navigates';    // state-machine tab navigation via setTab()

/** Access-point handler types that can appear inside Genero dialog blocks. */
export type AccessPointType =
  | 'ON_ACTION'
  | 'COMMAND'
  | 'ON_CHANGE'
  | 'BEFORE_FIELD'
  | 'AFTER_FIELD'
  | 'BEFORE_MENU'
  | 'BEFORE_INPUT'
  | 'BEFORE_CONSTRUCT'
  | 'BEFORE_ROW'
  | 'AFTER_ROW'
  | 'ON_CRUD';

// ─── Parsed module data ────────────────────────────────────────────────────

/** A single function parameter — its declared name and type string. */
export interface ParamDef {
  name: string;
  type: string;
}

/**
 * Parsed signature of a `FUNCTION` or type-method declaration.
 * Produced by {@link FglParser} and consumed by {@link GraphBuilder}.
 */
export interface FunctionSignature {
  name: string;
  /** Qualified display label: `"(TType) name"` for type methods, plain `name` otherwise. */
  displayName: string;
  visibility: 'PUBLIC' | 'PRIVATE';
  isTypeMethod: boolean;
  /** Name of the bound type for type methods, e.g. `TMyRecord`. */
  typeName?: string;
  params: ParamDef[];
  /** Return type strings (empty array = void). */
  returns: string[];
  filePath: string;
  lineNumber: number;
  moduleName: string;
}

/**
 * A parsed `IMPORT FGL` statement found in a source file.
 */
export interface ImportDef {
  /** Full path as written, e.g. `"com.myapp.core.RegisterController"`. */
  rawPath: string;
  /** Last segment — the actual module/file stem. */
  moduleName: string;
  alias?: string;
  lineNumber: number;
}

/**
 * A reference to a function invocation found in the source.
 * May be a live `CALL` or a `FUNCTION` keyword reference (not a real invocation).
 */
export interface CallRef {
  /** Module name or alias prefix for cross-module calls, e.g. `"InputHelper"`. */
  qualifier?: string;
  /** Intermediate variable name for type-method calls (`Module.var.method`). */
  intermediate?: string;
  functionName: string;
  /** `true` when the `FUNCTION` keyword is used to pass a reference rather than call it. */
  isFunctionRef: boolean;
  lineNumber: number;
}

/**
 * An access-point handler (`ON ACTION`, `BEFORE INPUT`, `AFTER FIELD`, …) inside
 * a dialog block, together with all `CALL` statements it contains.
 */
export interface AccessPoint {
  apType: AccessPointType;
  /** Action name / command text / field name(s). */
  name: string;
  containingFunction: string;
  dialogType: 'MENU' | 'INPUT' | 'CONSTRUCT' | 'DISPLAY_ARRAY' | 'DIALOG' | 'NONE';
  dialogTitle?: string;
  lineNumber: number;
  calls: CallRef[];
}

/**
 * All data extracted from a single `.4gl` source file by {@link FglParser}.
 */
export interface ParsedModule {
  filePath: string;
  moduleName: string;
  imports: ImportDef[];
  functions: FunctionSignature[];
  accessPoints: AccessPoint[];
  /** `CALL` statements made directly in function bodies (outside any access-point handler). */
  directCalls: Map<string, CallRef[]>;
  /** `true` when a `MAIN` block was found. */
  hasMain: boolean;
}

// ─── Graph model ───────────────────────────────────────────────────────────

/**
 * A node in the application graph, representing a module, function, dialog
 * block, or external dependency.
 */
export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  filePath?: string;
  lineNumber?: number;
  signature?: FunctionSignature;
  moduleName?: string;
}

/** A directed edge connecting two {@link GraphNode}s. */
export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  /** Short descriptive label shown on the edge in the diagram. */
  label?: string;
}

/** The complete call-graph produced by {@link GraphBuilder.build}. */
export interface AppGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  entryFilePath: string;
  entryModuleName: string;
}

// ─── Options ───────────────────────────────────────────────────────────────

/** User-facing options that control the depth and content of the generated diagram. */
export interface DiagramOptions {
  /** Module traversal depth. `-1` = unlimited. */
  maxDepth: number;
  showPrivate: boolean;
  showFieldEvents: boolean;
  showExternalModules: boolean;
}

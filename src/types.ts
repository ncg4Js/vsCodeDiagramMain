// Shared type definitions for the Genero Application Diagram extension.

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

export type EdgeType =
  | 'imports'       // IMPORT FGL
  | 'contains'      // module contains function
  | 'calls'         // direct CALL in function body
  | 'opens'         // function opens a dialog block
  | 'triggers'      // access point triggers a function call
  | 'function_ref'  // FUNCTION keyword reference (not a call)
  | 'navigates';    // state-machine tab navigation via setTab()

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

export interface ParamDef {
  name: string;
  type: string;
}

export interface FunctionSignature {
  name: string;
  /** Qualified display label: "Module.name" or "(TType) name" */
  displayName: string;
  visibility: 'PUBLIC' | 'PRIVATE';
  isTypeMethod: boolean;
  /** Name of the bound type for type methods */
  typeName?: string;
  params: ParamDef[];
  /** Return type strings (empty = void) */
  returns: string[];
  filePath: string;
  lineNumber: number;
  moduleName: string;
}

export interface ImportDef {
  /** Full path as written: e.g. "com.myapp.core.RegisterController" */
  rawPath: string;
  /** Last segment — the actual module/file name */
  moduleName: string;
  alias?: string;
  lineNumber: number;
}

export interface CallRef {
  /** Module name or alias prefix, if this is a cross-module call */
  qualifier?: string;
  /** Intermediate variable name for type-method calls (Module.var.method) */
  intermediate?: string;
  functionName: string;
  /** True when the FUNCTION keyword is used to pass a reference, not call it */
  isFunctionRef: boolean;
  lineNumber: number;
}

export interface AccessPoint {
  apType: AccessPointType;
  /** Action name / command text / field name(s) */
  name: string;
  containingFunction: string;
  dialogType: 'MENU' | 'INPUT' | 'CONSTRUCT' | 'DISPLAY_ARRAY' | 'DIALOG' | 'NONE';
  dialogTitle?: string;
  lineNumber: number;
  calls: CallRef[];
}

export interface ParsedModule {
  filePath: string;
  moduleName: string;
  imports: ImportDef[];
  functions: FunctionSignature[];
  accessPoints: AccessPoint[];
  /** CALL statements made directly in function bodies (outside any access-point handler) */
  directCalls: Map<string, CallRef[]>;
  /** Whether a MAIN block was found */
  hasMain: boolean;
}

// ─── Graph model ───────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  filePath?: string;
  lineNumber?: number;
  signature?: FunctionSignature;
  moduleName?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  /** Short descriptive label shown on the edge */
  label?: string;
}

export interface AppGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  entryFilePath: string;
  entryModuleName: string;
}

// ─── Options ───────────────────────────────────────────────────────────────

export interface DiagramOptions {
  /** Traversal depth. -1 = unlimited. */
  maxDepth: number;
  showPrivate: boolean;
  showFieldEvents: boolean;
  showExternalModules: boolean;
}

import * as fs from 'fs';
import * as path from 'path';
import {
  ParsedModule, ImportDef, FunctionSignature, AccessPoint, CallRef,
  AccessPointType, ParamDef,
} from '../types';

// ─── Context stack frames ──────────────────────────────────────────────────

type ContextKind =
  | 'ROOT'
  | 'FUNCTION'
  | 'MENU'
  | 'INPUT'
  | 'CONSTRUCT'
  | 'DISPLAY_ARRAY'
  | 'DIALOG'
  | 'HANDLER';

interface RootFrame    { kind: 'ROOT' }
interface FunctionFrame {
  kind: 'FUNCTION';
  name: string;
  visibility: 'PUBLIC' | 'PRIVATE';
  isTypeMethod: boolean;
  typeName?: string;
  params: ParamDef[];
  returns: string[];
  startLine: number;
  /** Direct CALL refs in the function body (outside any handler) */
  directCalls: CallRef[];
}
interface DialogFrame {
  kind: 'MENU' | 'INPUT' | 'CONSTRUCT' | 'DISPLAY_ARRAY' | 'DIALOG';
  title?: string;
  lineNumber: number;
}
interface HandlerFrame {
  kind: 'HANDLER';
  apType: AccessPointType;
  name: string;
  lineNumber: number;
  calls: CallRef[];
}

type ContextFrame = RootFrame | FunctionFrame | DialogFrame | HandlerFrame;

// ─── Regex library ─────────────────────────────────────────────────────────

// All patterns are case-insensitive because Genero identifiers are
// case-insensitive (except GAS resource names and presentation styles).
const R = {
  // IMPORT FGL path.to.Module [AS alias]
  importFgl: /^\s*IMPORT\s+FGL\s+([\w.]+)(?:\s+AS\s+(\w+))?\s*$/i,

  // PUBLIC|PRIVATE FUNCTION name(params) RETURNS(types)
  // e.g.  PUBLIC FUNCTION regLoop() RETURNS()
  //       PRIVATE FUNCTION inputReg(mode CHAR(1)) RETURNS(BOOLEAN)
  funcDecl: /^\s*(PUBLIC|PRIVATE)\s+FUNCTION\s+(\w+)\s*\((.*?)\)(?:\s+RETURNS\s*\((.*?)\))?\s*$/i,

  // Type-method: PUBLIC FUNCTION (self TTypeName) methodName(params) RETURNS(types)
  typeMethod: /^\s*(PUBLIC|PRIVATE)\s+FUNCTION\s*\(\s*\w+\s+(\w+)\s*\)\s+(\w+)\s*\((.*?)\)(?:\s+RETURNS\s*\((.*?)\))?\s*$/i,

  // MAIN block
  mainBlock:    /^\s*MAIN\s*$/i,
  // Bare FUNCTION (no PUBLIC/PRIVATE) — treated as PUBLIC; superset of funcMain
  funcDeclBare: /^\s*FUNCTION\s+(\w+)\s*\((.*?)\)(?:\s+RETURNS\s*\((.*?)\))?\s*$/i,

  endFunction: /^\s*END\s+FUNCTION\b/i,
  endMain:     /^\s*END\s+MAIN\b/i,

  // Dialog block openers
  menuOpen:        /^\s*MENU\s+"([^"]*)"/i,
  inputOpen:       /^\s*INPUT\s+(?:BY\s+NAME\s+)?(\S+)/i,
  constructOpen:   /^\s*CONSTRUCT\s+(?:BY\s+NAME\s+)?(\w+)/i,
  displayArrOpen:  /^\s*DISPLAY\s+ARRAY\s+(\w+)/i,
  dialogOpen:      /^\s*DIALOG\b/i,

  // Dialog block closers
  endMenu:        /^\s*END\s+MENU\b/i,
  endInput:       /^\s*END\s+INPUT\b/i,
  endConstruct:   /^\s*END\s+CONSTRUCT\b/i,
  endDisplay:     /^\s*END\s+DISPLAY\b/i,
  endDialog:      /^\s*END\s+DIALOG\b/i,

  // Handler openers (inside dialog blocks)
  onAction:       /^\s*ON\s+ACTION\s+(\w+)/i,
  command:        /^\s*COMMAND\s+"([^"]*)"/i,
  onChangeFlds:   /^\s*ON\s+CHANGE\s+(.+)$/i,
  beforeField:    /^\s*BEFORE\s+FIELD\s+(.+)$/i,
  afterField:     /^\s*AFTER\s+FIELD\s+(.+)$/i,
  beforeMenu:     /^\s*BEFORE\s+MENU\b/i,
  beforeInput:    /^\s*BEFORE\s+INPUT\b/i,
  beforeConstruct:/^\s*BEFORE\s+CONSTRUCT\b/i,
  beforeRow:      /^\s*BEFORE\s+ROW\b/i,
  afterRow:       /^\s*AFTER\s+ROW\b/i,
  onCrud:         /^\s*ON\s+(UPDATE|INSERT|APPEND|DELETE)\b/i,

  // CALL statement (handles RETURNING clause)
  // Captures: qualifier (optional), intermediate (optional), functionName
  callStmt: /^\s*CALL\s+((?:(\w+)\.)?((?:\w+\.)*)(\w+))\s*\(/i,

  // FUNCTION keyword used as value (not a call)
  funcRef: /\bFUNCTION\s+(\w+)/gi,

  // Line / block comments
  lineComment:  /--.*$/,
  hashComment:  /#.*$/,
};

// ─── Helper functions ──────────────────────────────────────────────────────

function stripComments(line: string, inBlockComment: boolean): [string, boolean] {
  let result = '';
  let i = 0;
  let inBlock = inBlockComment;

  while (i < line.length) {
    if (inBlock) {
      if (line[i] === '}') { inBlock = false; }
      i++;
    } else {
      if (line[i] === '{') {
        inBlock = true;
        i++;
      } else if (line[i] === '-' && line[i + 1] === '-') {
        break; // rest of line is a comment
      } else if (line[i] === '#') {
        break; // hash comment
      } else if (line[i] === '"') {
        // Skip string literal to avoid false matches inside strings
        result += line[i++];
        while (i < line.length && line[i] !== '"') {
          result += line[i++];
        }
        if (i < line.length) { result += line[i++]; } // closing quote
      } else {
        result += line[i++];
      }
    }
  }
  return [result.trimEnd(), inBlock];
}

function parseParams(raw: string): ParamDef[] {
  if (!raw.trim()) { return []; }
  return raw.split(',').map(p => {
    const parts = p.trim().split(/\s+/);
    if (parts.length >= 2) {
      return { name: parts[0], type: parts.slice(1).join(' ') };
    }
    return { name: parts[0] ?? '', type: '' };
  });
}

function parseReturns(raw: string): string[] {
  if (!raw.trim()) { return []; }
  return raw.split(',').map(r => r.trim()).filter(r => r.length > 0);
}

/**
 * Split a comma-separated field list, trimming each name.
 * Used for ON CHANGE / BEFORE FIELD / AFTER FIELD which can list multiple fields.
 */
function splitFields(raw: string): string[] {
  return raw.split(',').map(f => f.trim()).filter(f => f.length > 0);
}

// Extract CALL refs from a single (comment-stripped) line.
// Returns all found calls; sets isFunctionRef=true for FUNCTION keyword refs.
function extractCallsFromLine(line: string, lineNumber: number): CallRef[] {
  const refs: CallRef[] = [];

  // Collect positions of FUNCTION keyword refs so we can exclude them from CALL matches
  const funcRefPositions = new Set<number>();
  let fmatch: RegExpExecArray | null;
  const funcRefRe = /\bFUNCTION\s+(\w+)/gi;
  while ((fmatch = funcRefRe.exec(line)) !== null) {
    refs.push({ functionName: fmatch[1], isFunctionRef: true, lineNumber });
    // Mark the position where the function name starts
    funcRefPositions.add(fmatch.index);
  }

  // CALL Module.function(  or  CALL Module.var.method(  or  CALL localFunc(
  const callRe = /\bCALL\s+((\w+)(?:\.(\w+))?(?:\.(\w+))?)\s*\(/gi;
  let cmatch: RegExpExecArray | null;
  while ((cmatch = callRe.exec(line)) !== null) {
    // cmatch[2] = first segment, cmatch[3] = second, cmatch[4] = third (if any)
    const seg1 = cmatch[2];
    const seg2 = cmatch[3];
    const seg3 = cmatch[4];

    let qualifier: string | undefined;
    let intermediate: string | undefined;
    let functionName: string;

    if (seg3) {
      // Module.variable.method()
      qualifier = seg1;
      intermediate = seg2;
      functionName = seg3;
    } else if (seg2) {
      // Module.function()
      qualifier = seg1;
      functionName = seg2;
    } else {
      // localFunction()
      functionName = seg1;
    }

    refs.push({ qualifier, intermediate, functionName, isFunctionRef: false, lineNumber });
  }

  return refs;
}

// ─── Parser class ──────────────────────────────────────────────────────────

export class FglParser {
  parse(filePath: string): ParsedModule {
    const moduleName = path.basename(filePath, '.4gl');
    const result: ParsedModule = {
      filePath,
      moduleName,
      imports: [],
      functions: [],
      accessPoints: [],
      directCalls: new Map(),
      hasMain: false,
    };

    let rawContent: string;
    try {
      rawContent = fs.readFileSync(filePath, 'utf8');
    } catch {
      return result;
    }

    const lines = rawContent.split(/\r?\n/);
    const stack: ContextFrame[] = [{ kind: 'ROOT' }];
    let inBlockComment = false;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const lineNumber = lineIdx + 1;
      const [line, newBlockState] = stripComments(lines[lineIdx], inBlockComment);
      inBlockComment = newBlockState;
      if (!line.trim()) { continue; }

      const top = stack[stack.length - 1];

      // ── IMPORT FGL (only at ROOT level) ─────────────────────────────────
      if (top.kind === 'ROOT') {
        const imp = R.importFgl.exec(line);
        if (imp) {
          result.imports.push({
            rawPath: imp[1],
            moduleName: imp[1].split('.').pop() ?? imp[1],
            alias: imp[2] || undefined,
            lineNumber,
          });
          continue;
        }
      }

      // ── FUNCTION / MAIN declarations ─────────────────────────────────────
      if (top.kind === 'ROOT' || top.kind === 'FUNCTION') {
        // Type method
        const tm = R.typeMethod.exec(line);
        if (tm) {
          const frame: FunctionFrame = {
            kind: 'FUNCTION',
            name: tm[3],
            visibility: tm[1].toUpperCase() as 'PUBLIC' | 'PRIVATE',
            isTypeMethod: true,
            typeName: tm[2],
            params: parseParams(tm[4]),
            returns: parseReturns(tm[5] ?? ''),
            startLine: lineNumber,
            directCalls: [],
          };
          stack.push(frame);
          continue;
        }

        // Regular function
        const fn = R.funcDecl.exec(line);
        if (fn) {
          if (fn[2].toUpperCase() === 'MAIN') { result.hasMain = true; }
          const frame: FunctionFrame = {
            kind: 'FUNCTION',
            name: fn[2],
            visibility: fn[1].toUpperCase() as 'PUBLIC' | 'PRIVATE',
            isTypeMethod: false,
            params: parseParams(fn[3]),
            returns: parseReturns(fn[4] ?? ''),
            startLine: lineNumber,
            directCalls: [],
          };
          stack.push(frame);
          continue;
        }

        // Bare FUNCTION (no PUBLIC/PRIVATE) — treated as PUBLIC
        const bare = R.funcDeclBare.exec(line);
        if (bare) {
          if (bare[1].toUpperCase() === 'MAIN') { result.hasMain = true; }
          stack.push({
            kind: 'FUNCTION',
            name: bare[1],
            visibility: 'PUBLIC',
            isTypeMethod: false,
            params: parseParams(bare[2]),
            returns: parseReturns(bare[3] ?? ''),
            startLine: lineNumber,
            directCalls: [],
          });
          continue;
        }

        // MAIN block
        if (top.kind === 'ROOT' && R.mainBlock.test(line)) {
          result.hasMain = true;
          stack.push({
            kind: 'FUNCTION',
            name: 'MAIN',
            visibility: 'PUBLIC',
            isTypeMethod: false,
            params: [],
            returns: [],
            startLine: lineNumber,
            directCalls: [],
          });
          continue;
        }
      }

      // ── END FUNCTION / END MAIN ──────────────────────────────────────────
      if (R.endFunction.test(line) || R.endMain.test(line)) {
        // Commit any open handler first
        this.commitHandler(stack, result);
        // Pop dialog frames that may still be open (malformed code safety)
        while (stack.length > 1 && stack[stack.length - 1].kind !== 'FUNCTION') {
          stack.pop();
        }
        // Pop the FUNCTION frame itself -- guard so ROOT is never popped by an unmatched END FUNCTION
        if (stack.length > 0 && stack[stack.length - 1].kind === 'FUNCTION') {
          const funcFrame = stack.pop() as FunctionFrame;
          const sig: FunctionSignature = {
            name: funcFrame.name,
            displayName: funcFrame.isTypeMethod
              ? `(${funcFrame.typeName}) ${funcFrame.name}`
              : funcFrame.name,
            visibility: funcFrame.visibility,
            isTypeMethod: funcFrame.isTypeMethod,
            typeName: funcFrame.typeName,
            params: funcFrame.params,
            returns: funcFrame.returns,
            filePath,
            lineNumber: funcFrame.startLine,
            moduleName,
          };
          result.functions.push(sig);
          if (funcFrame.directCalls.length > 0) {
            result.directCalls.set(funcFrame.name, funcFrame.directCalls);
          }
        }
        continue;
      }

      // ── Dialog block openers ─────────────────────────────────────────────
      // These can appear inside FUNCTION or HANDLER contexts
      if (top.kind === 'FUNCTION' || top.kind === 'HANDLER' || this.isDialogKind(top.kind)) {
        // MENU
        const menu = R.menuOpen.exec(line);
        if (menu) {
          stack.push({ kind: 'MENU', title: menu[1], lineNumber });
          continue;
        }
        // INPUT (avoid matching INPUT ARRAY / INPUT BY NAME as different names)
        if (R.inputOpen.test(line) && !R.displayArrOpen.test(line)) {
          stack.push({ kind: 'INPUT', lineNumber });
          continue;
        }
        // CONSTRUCT
        if (R.constructOpen.test(line)) {
          stack.push({ kind: 'CONSTRUCT', lineNumber });
          continue;
        }
        // DISPLAY ARRAY
        if (R.displayArrOpen.test(line)) {
          stack.push({ kind: 'DISPLAY_ARRAY', lineNumber });
          continue;
        }
        // DIALOG combined
        if (R.dialogOpen.test(line)) {
          stack.push({ kind: 'DIALOG', lineNumber });
          continue;
        }
      }

      // ── Dialog block closers ─────────────────────────────────────────────
      if (R.endMenu.test(line)) {
        this.commitHandler(stack, result);
        this.popDialog(stack, 'MENU');
        continue;
      }
      if (R.endInput.test(line)) {
        this.commitHandler(stack, result);
        this.popDialog(stack, 'INPUT');
        continue;
      }
      if (R.endConstruct.test(line)) {
        this.commitHandler(stack, result);
        this.popDialog(stack, 'CONSTRUCT');
        continue;
      }
      if (R.endDisplay.test(line)) {
        this.commitHandler(stack, result);
        this.popDialog(stack, 'DISPLAY_ARRAY');
        continue;
      }
      if (R.endDialog.test(line)) {
        this.commitHandler(stack, result);
        this.popDialog(stack, 'DIALOG');
        continue;
      }

      // ── Handler openers (inside dialog blocks) ───────────────────────────
      const dlgTop = this.findDialogTop(stack);
      if (dlgTop) {
        let newHandler: HandlerFrame | null = null;

        // ON ACTION name
        const oa = R.onAction.exec(line);
        if (oa) {
          newHandler = { kind: 'HANDLER', apType: 'ON_ACTION', name: oa[1], lineNumber, calls: [] };
        }

        // COMMAND "text"
        else if (!newHandler) {
          const cmd = R.command.exec(line);
          if (cmd) {
            newHandler = { kind: 'HANDLER', apType: 'COMMAND', name: cmd[1], lineNumber, calls: [] };
          }
        }

        // ON CHANGE field[, field2, ...]
        else if (!newHandler) {
          const oc = R.onChangeFlds.exec(line);
          if (oc) {
            // Create one handler whose name is the comma-joined field list
            newHandler = { kind: 'HANDLER', apType: 'ON_CHANGE', name: splitFields(oc[1]).join(', '), lineNumber, calls: [] };
          }
        }

        if (!newHandler) {
          const bf = R.beforeField.exec(line);
          if (bf) {
            newHandler = { kind: 'HANDLER', apType: 'BEFORE_FIELD', name: splitFields(bf[1]).join(', '), lineNumber, calls: [] };
          }
        }
        if (!newHandler) {
          const af = R.afterField.exec(line);
          if (af) {
            newHandler = { kind: 'HANDLER', apType: 'AFTER_FIELD', name: splitFields(af[1]).join(', '), lineNumber, calls: [] };
          }
        }
        if (!newHandler && R.beforeMenu.test(line)) {
          newHandler = { kind: 'HANDLER', apType: 'BEFORE_MENU', name: 'BEFORE MENU', lineNumber, calls: [] };
        }
        if (!newHandler && R.beforeInput.test(line)) {
          newHandler = { kind: 'HANDLER', apType: 'BEFORE_INPUT', name: 'BEFORE INPUT', lineNumber, calls: [] };
        }
        if (!newHandler && R.beforeConstruct.test(line)) {
          newHandler = { kind: 'HANDLER', apType: 'BEFORE_CONSTRUCT', name: 'BEFORE CONSTRUCT', lineNumber, calls: [] };
        }
        if (!newHandler && R.beforeRow.test(line)) {
          newHandler = { kind: 'HANDLER', apType: 'BEFORE_ROW', name: 'BEFORE ROW', lineNumber, calls: [] };
        }
        if (!newHandler && R.afterRow.test(line)) {
          newHandler = { kind: 'HANDLER', apType: 'AFTER_ROW', name: 'AFTER ROW', lineNumber, calls: [] };
        }
        if (!newHandler) {
          const crud = R.onCrud.exec(line);
          if (crud) {
            newHandler = { kind: 'HANDLER', apType: 'ON_CRUD', name: `ON ${crud[1].toUpperCase()}`, lineNumber, calls: [] };
          }
        }

        if (newHandler) {
          // Commit the previous handler (if any) before pushing the new one
          this.commitHandler(stack, result);
          stack.push(newHandler);
          continue;
        }
      }

      // ── CALL statements (accumulate to current handler or function) ───────
      const calls = extractCallsFromLine(line, lineNumber);
      if (calls.length > 0) {
        const currentHandler = top.kind === 'HANDLER' ? top : null;
        const currentFunc = this.findFunctionFrame(stack);

        if (currentHandler) {
          currentHandler.calls.push(...calls);
        } else if (currentFunc) {
          currentFunc.directCalls.push(...calls);
        }
      }
    } // end line loop

    // Flush any unclosed frames (malformed or incomplete files)
    this.commitHandler(stack, result);

    return result;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private isDialogKind(kind: ContextKind): boolean {
    return ['MENU', 'INPUT', 'CONSTRUCT', 'DISPLAY_ARRAY', 'DIALOG'].includes(kind);
  }

  /** Find the innermost dialog frame on the stack (skip HANDLER on top). */
  private findDialogTop(stack: ContextFrame[]): DialogFrame | null {
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i];
      if (f.kind === 'HANDLER') { continue; }
      if (this.isDialogKind(f.kind)) { return f as DialogFrame; }
      break;
    }
    return null;
  }

  private findFunctionFrame(stack: ContextFrame[]): FunctionFrame | null {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].kind === 'FUNCTION') { return stack[i] as FunctionFrame; }
    }
    return null;
  }

  /**
   * If the top of the stack is a HANDLER, commit it as an AccessPoint
   * on the result and pop it.
   */
  private commitHandler(stack: ContextFrame[], result: ParsedModule): void {
    if (stack[stack.length - 1]?.kind !== 'HANDLER') { return; }
    const handler = stack.pop() as HandlerFrame;

    const funcFrame = this.findFunctionFrame(stack);
    const dlgFrame  = this.findDialogTop(stack);

    result.accessPoints.push({
      apType:            handler.apType,
      name:              handler.name,
      containingFunction: funcFrame?.name ?? 'UNKNOWN',
      dialogType:        (dlgFrame?.kind ?? 'NONE') as AccessPoint['dialogType'],
      dialogTitle:       dlgFrame?.title,
      lineNumber:        handler.lineNumber,
      calls:             handler.calls,
    });
  }

  /** Pop frames from the stack until the matching dialog frame is removed. */
  private popDialog(stack: ContextFrame[], kind: DialogFrame['kind']): void {
    while (stack.length > 1) {
      const top = stack[stack.length - 1];
      stack.pop();
      if (top.kind === kind) { break; }
    }
  }
}

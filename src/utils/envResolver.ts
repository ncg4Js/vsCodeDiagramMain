import * as vscode from 'vscode';

export interface SearchPaths {
  /** Directory containing the entry .4gl file — searched first, matching Genero runtime behaviour */
  currentDir: string;
  /** VS Code workspace folders */
  workspace: string[];
  /** From FGLLDPATH environment variable (or settings override) */
  fglldpath: string[];
  /** From FGLRESOURCEPATH environment variable (or settings override) */
  fglresourcepath: string[];
  /** From DBPATH environment variable */
  dbpath: string[];
  /** From PATH environment variable */
  systemPath: string[];
}

const IS_WINDOWS = process.platform === 'win32';
const PATH_SEP = IS_WINDOWS ? ';' : ':';

function splitVar(value: string | undefined): string[] {
  if (!value) { return []; }
  return value.split(PATH_SEP).map(p => p.trim()).filter(p => p.length > 0);
}

/**
 * Build the ordered list of directories to search for .4gl module files.
 *
 * Priority (first match wins):
 *   1. Directory of the entry .4gl file (current directory — Genero always searches here first)
 *   2. VS Code workspace folders (recursive)
 *   3. FGLLDPATH  (config override, then env)
 *   4. FGLRESOURCEPATH (config override, then env)
 *   5. DBPATH
 *   6. PATH
 *
 * @param entryFileDir  Absolute path to the directory containing the entry .4gl file.
 *                      Pass path.dirname(entryFilePath) from the command handler.
 */
export function resolveSearchPaths(entryFileDir: string): SearchPaths {
  const cfg = vscode.workspace.getConfiguration('moduleDiagram');

  const workspace = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);

  const fglldpathCfg = cfg.get<string>('fglldpath', '');
  const fglldpath = fglldpathCfg ? splitVar(fglldpathCfg) : splitVar(process.env['FGLLDPATH']);

  const fglresourcepathCfg = cfg.get<string>('fglresourcepath', '');
  const fglresourcepath = fglresourcepathCfg
    ? splitVar(fglresourcepathCfg)
    : splitVar(process.env['FGLRESOURCEPATH']);

  const dbpath = splitVar(process.env['DBPATH']);
  const systemPath = splitVar(process.env['PATH']);

  return { currentDir: entryFileDir, workspace, fglldpath, fglresourcepath, dbpath, systemPath };
}

/**
 * Flat ordered list of all directories to search, in priority order.
 * currentDir is always first so it mirrors Genero's own module resolution.
 */
export function allSearchDirs(paths: SearchPaths): string[] {
  return [
    paths.currentDir,
    ...paths.workspace,
    ...paths.fglldpath,
    ...paths.fglresourcepath,
    ...paths.dbpath,
    ...paths.systemPath,
  ];
}
import * as vscode from 'vscode';

/**
 * Ordered collection of directory lists used to locate `.4gl` module files,
 * mirroring Genero's own module-resolution strategy.
 */
export interface SearchPaths {
  /** Directory containing the entry `.4gl` file — searched first, matching Genero runtime behaviour. */
  currentDir: string;
  /** VS Code workspace folders. */
  workspace: string[];
  /** From the `FGLLDPATH` environment variable (or the `moduleDiagram.fglldpath` setting). */
  fglldpath: string[];
  /** From the `FGLRESOURCEPATH` environment variable (or the `moduleDiagram.fglresourcepath` setting). */
  fglresourcepath: string[];
  /** From the `DBPATH` environment variable. */
  dbpath: string[];
  /** From the `PATH` environment variable. */
  systemPath: string[];
}

const IS_WINDOWS = process.platform === 'win32';
const PATH_SEP = IS_WINDOWS ? ';' : ':';

/**
 * Split an OS path-list environment variable value into individual directory strings.
 *
 * @param value  Raw value of the environment variable (may be `undefined`).
 * @returns      Array of non-empty, trimmed directory paths.
 */
function splitVar(value: string | undefined): string[] {
  if (!value) { return []; }
  return value.split(PATH_SEP).map(p => p.trim()).filter(p => p.length > 0);
}

/**
 * Build the ordered collection of directories to search for `.4gl` module files.
 *
 * Priority (first match wins):
 *   1. Directory of the entry `.4gl` file — Genero always searches here first.
 *   2. VS Code workspace folders (recursive).
 *   3. `FGLLDPATH` (settings override, then environment).
 *   4. `FGLRESOURCEPATH` (settings override, then environment).
 *   5. `DBPATH`.
 *   6. `PATH`.
 *
 * @param entryFileDir  Absolute path to the directory containing the entry `.4gl` file.
 *                      Pass `path.dirname(entryFilePath)` from the command handler.
 * @returns             Populated {@link SearchPaths} object.
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
 * Flatten a {@link SearchPaths} object into an ordered list of directories to
 * search, with `currentDir` always first so it mirrors Genero's own resolution.
 *
 * @param paths  Populated search-paths object from {@link resolveSearchPaths}.
 * @returns      Flat ordered array of directory strings.
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

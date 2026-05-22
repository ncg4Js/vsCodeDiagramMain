import * as fs from 'fs';
import * as path from 'path';
import { SearchPaths, allSearchDirs } from '../utils/envResolver';
import { log } from '../utils/logger';

/**
 * Resolves "IMPORT FGL <path>" declarations to absolute .4gl file paths.
 *
 * Module name matching is case-insensitive at the language level (Genero
 * identifiers are case-insensitive outside of resource/style names). The
 * resolver prefers the entry file''s own directory over all other locations,
 * mirroring Genero''s own runtime resolution order.
 *
 * Search order:
 *   1. Directory of the entry .4gl file (current directory)
 *   2. VS Code workspace folders (recursive)
 *   3. FGLLDPATH entries
 *   4. FGLRESOURCEPATH entries
 *   5. DBPATH entries
 *   6. PATH entries
 */
export class ModuleResolver {
  /**
   * Maps lower-case module stem → list of full paths found (in priority order).
   * Built once at construction time from all search dirs.
   */
  private readonly index = new Map<string, string[]>();

  /** Resolution cache: rawImportPath → resolved absolute path (or null). */
  private readonly cache = new Map<string, string | null>();

  constructor(private readonly searchPaths: SearchPaths) {
    for (const dir of allSearchDirs(searchPaths)) {
      this.indexDirectory(dir, 0);
    }
    const total = this.getAllKnownFiles().length;
    log(`Module index: ${total} .4gl file${total !== 1 ? 's' : ''} indexed across all search paths`);
  }

  // ── Index building ────────────────────────────────────────────────────────

  private indexDirectory(dir: string, depth: number): void {
    // Guard against deep trees (e.g. node_modules inside PATH entries)
    if (depth > 8) { return; }
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          this.indexDirectory(path.join(dir, entry.name), depth + 1);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.4gl')) {
          const stem = path.basename(entry.name, '.4gl');
          const full = path.join(dir, entry.name);
          const key = stem.toLowerCase();
          const list = this.index.get(key) ?? [];
          // Avoid duplicates (same file via different path representations)
          if (!list.includes(full)) { list.push(full); }
          this.index.set(key, list);
        }
      }
    } catch {
      // Directory not accessible; skip silently.
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Resolve an import path to an absolute file path.
   *
   * @param importPath  The raw string from "IMPORT FGL <importPath>".
   *                    May be a simple name ("RegisterController") or a
   *                    package path ("com.myapp.core.RegisterController").
   * @returns Absolute path to the .4gl file, or null if not found.
   */
  resolve(importPath: string): string | null {
    if (this.cache.has(importPath)) {
      return this.cache.get(importPath) ?? null;
    }
    const result = this.doResolve(importPath);
    this.cache.set(importPath, result);
    return result;
  }

  private doResolve(importPath: string): string | null {
    const segments = importPath.split('.');
    const moduleNameRaw = segments[segments.length - 1];
    const moduleNameLower = moduleNameRaw.toLowerCase();

    // Strategy A: hierarchical package path (com/myapp/core/ModuleName.4gl)
    // Searched across all dirs in priority order, so currentDir is tried first.
    if (segments.length > 1) {
      const relParts = [...segments.slice(0, -1), moduleNameRaw + '.4gl'];
      const relPath = path.join(...relParts);
      for (const dir of allSearchDirs(this.searchPaths)) {
        const candidate = path.join(dir, relPath);
        if (fs.existsSync(candidate)) { return candidate; }
      }
    }

    // Strategy B: flat lookup via the pre-built index (case-insensitive primary).
    // Index was built in allSearchDirs priority order, so currentDir entries
    // appear first in each candidate list.
    const candidates = this.index.get(moduleNameLower);
    if (!candidates || candidates.length === 0) { return null; }

    // Prefer exact-case match on case-sensitive filesystems
    const exact = candidates.find(p => path.basename(p, '.4gl') === moduleNameRaw);
    return exact ?? candidates[0];
  }

  /**
   * Return all .4gl file paths discovered across all search directories.
   * Useful for listing all known project modules.
   */
  getAllKnownFiles(): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const list of this.index.values()) {
      for (const p of list) {
        if (!seen.has(p)) { seen.add(p); result.push(p); }
      }
    }
    return result;
  }

  /** Extract the plain module name (file stem) from a raw import path. */
  static moduleNameFrom(importPath: string): string {
    const segs = importPath.split('.');
    return segs[segs.length - 1];
  }
}
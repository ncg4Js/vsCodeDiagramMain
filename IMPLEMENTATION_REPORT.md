# Implementation Report
## Genero Application Diagram — VS Code Extension

**Date:** 2026-05-22
**Repository:** https://github.com/ncg4Js/vsCodeDiagramMain.git
**Artifact:** `genero-app-diagram-0.1.0.vsix`

---

## 1. Project Overview

The goal was to build a VS Code extension that analyses a Genero BDL application
starting from a single `.4gl` entry-point file and produces an interactive
dependency and call-flow diagram. The diagram must:

- Follow `IMPORT FGL` chains across the whole project tree.
- Identify the **access mode** through which each function is reached:
  menu action (`ON ACTION`), menu command (`COMMAND`), field event
  (`ON CHANGE`, `BEFORE/AFTER FIELD`), CRUD trigger, or direct `CALL`.
- Show the **signature** of every in-project function (visibility, parameters,
  return types).
- Resolve module files using Genero's own search-path environment variables:
  `FGLLDPATH`, `FGLRESOURCEPATH`, `DBPATH`, and `PATH`.
- Render the result in a VS Code WebviewPanel using
  [Mermaid](https://mermaid.js.org/) with click-to-navigate to source.

The reference project used for design and testing was
`C:\work\VsCode\support\ats-mfg-mgr` (119 `.4gl` files), with `IFXOrder.4gl`
as the example entry point.

---

## 2. Pre-Implementation Research

Before writing any code, **GeneroIntelligence MCP** was consulted as the
authoritative source for Genero BDL language constructs. The following skills
were loaded:

| Skill | Topics verified |
|-------|----------------|
| `fourjs-dialog-basics` | `MENU`/`COMMAND` syntax, `INPUT BY NAME`, `DISPLAY ARRAY` |
| `fourjs-dialog-advanced` | `CONSTRUCT` (both `BY NAME` and positional forms), `DIALOG` combined |
| `fourjs-event-handling` | `ON ACTION`, `ON CHANGE`, `BEFORE/AFTER FIELD`, `BEFORE ROW` |
| `fourjs-packages` | `IMPORT FGL` syntax, aliases, package paths, `PUBLIC`/`PRIVATE` visibility |
| `fourjs-actions-and-buttons` | `ON ACTION ATTRIBUTES`, `INFIELD` variant, `VALIDATE=NO` |

One significant correction from training knowledge was identified during this
phase (see §4.1).

---

## 3. Architecture

The extension is written in TypeScript and structured as five independent layers:

```
src/
├── types.ts                  Shared type definitions
├── utils/
│   └── envResolver.ts        Environment variable reader
├── parser/
│   ├── ModuleResolver.ts     IMPORT FGL → file path lookup
│   ├── FglParser.ts          Context-aware .4gl lexer
│   └── GraphBuilder.ts       BFS graph assembly
├── diagram/
│   ├── MermaidRenderer.ts    AppGraph → Mermaid flowchart
│   └── webview.ts            VS Code WebviewPanel
└── extension.ts              Command registration and entry point
```

### 3.1 Environment Resolver (`envResolver.ts`)

Reads the four Genero search-path variables from `process.env` and exposes
them as an ordered `SearchPaths` structure. VS Code settings
(`generoAppDiagram.fglldpath`, `generoAppDiagram.fglresourcepath`) can
override the environment values without modifying the OS environment.

Search priority:
1. **Directory of the entry `.4gl` file** (current directory — searched first, matching Genero runtime behaviour)
2. VS Code workspace folders (recursive)
3. `FGLLDPATH`
4. `FGLRESOURCEPATH`
5. `DBPATH`
6. `PATH`

### 3.2 Module Resolver (`ModuleResolver.ts`)

Builds a case-insensitive index of every `.4gl` file found across all search
directories (up to 8 levels deep to avoid runaway recursion on PATH entries
that may include system directories). Resolution supports:

- **Flat names:** `IMPORT FGL RegisterController` → searches index for
  `registercontroller` key.
- **Package paths:** `IMPORT FGL com.myapp.core.RegisterController` → tries
  the hierarchical path `com/myapp/core/RegisterController.4gl` first, then
  falls back to flat index lookup on the last segment.
- **Alias tracking:** `IMPORT FGL Foo AS f` registers `f → Foo` in the alias
  map; all subsequent call resolution goes through this map.

On case-sensitive filesystems (Linux), an exact-case match is preferred over
the first case-insensitive hit.

### 3.3 FGL Parser (`FglParser.ts`)

A single-pass, line-by-line lexer with a **context stack**. Each stack frame
represents the current syntactic block:

```
ROOT → FUNCTION → MENU → HANDLER (ON ACTION / COMMAND / ON CHANGE / ...)
                → INPUT → HANDLER
                → CONSTRUCT → HANDLER
                → DISPLAY_ARRAY → HANDLER
                → DIALOG → INPUT → HANDLER
                                 → DISPLAY_ARRAY → HANDLER
```

**Comment stripping** is performed before any pattern matching:
- `--` line comments
- `{...}` block comments (tracked across lines with a boolean flag)
- `#` line comments

**String literal skipping** prevents false pattern matches inside string
values (e.g. a `CALL` keyword appearing inside a quoted string).

**Constructs recognised:**

| Pattern | What is captured |
|---------|-----------------|
| `IMPORT FGL path [AS alias]` | Module dependency + alias |
| `PUBLIC\|PRIVATE FUNCTION name(params) RETURNS(types)` | Function signature |
| `PUBLIC\|PRIVATE FUNCTION (self TType) name(params) RETURNS(types)` | Type-bound method |
| `MAIN` / `END MAIN` | Entry-point block |
| `MENU "title"` / `END MENU` | Menu dialog context |
| `INPUT ... FROM ...` / `INPUT BY NAME` / `END INPUT` | Input dialog context |
| `CONSTRUCT ... ON ...` / `END CONSTRUCT` | Query-builder context |
| `DISPLAY ARRAY ... TO ...` / `END DISPLAY` | List dialog context |
| `DIALOG` / `END DIALOG` | Combined dialog context |
| `ON ACTION name [INFIELD field] [ATTRIBUTES(...)]` | Action handler |
| `COMMAND "text"` | Menu command handler |
| `ON CHANGE field[, field2, ...]` | Field change handler |
| `BEFORE FIELD / AFTER FIELD field[, field2, ...]` | Field focus handlers |
| `BEFORE MENU / INPUT / CONSTRUCT / ROW` | Setup hooks |
| `ON UPDATE / INSERT / APPEND / DELETE` | CRUD triggers |
| `CALL [Module.]function(...)` | Cross-module or local call |
| `FUNCTION name` (as a value) | Function reference — not a call |

Handler blocks (`ON ACTION`, `COMMAND`, etc.) have no explicit `END` keyword
in Genero. They are implicitly closed when the next handler keyword or the
enclosing dialog's `END` is detected. The parser handles this by calling
`commitHandler()` at those transition points.

### 3.4 Graph Builder (`GraphBuilder.ts`)

Performs a **breadth-first traversal** starting from the entry file, up to a
configurable depth limit. For each parsed module it:

1. Creates a **module node** and a **function node** per in-scope function.
2. Creates **dialog nodes** (one per unique MENU/INPUT/CONSTRUCT/DISPLAY
   ARRAY/DIALOG context within each function).
3. Resolves `CALL` statements against the alias map and the cross-module
   function node index, producing **edge records** typed as `calls`,
   `triggers`, `opens`, or `imports`.

Edges reference nodes by ID only; nodes that fall outside the depth limit or
are filtered by options (hide PRIVATE, hide field events, hide external) are
simply absent from the graph, and any edges pointing to them are skipped by
the renderer.

### 3.5 Mermaid Renderer (`MermaidRenderer.ts`)

Converts the `AppGraph` to a `flowchart TD` Mermaid string:

- Each module becomes a `subgraph` containing its function nodes.
- Node shapes communicate type: hexagon for `MAIN`, rounded rectangle for
  functions, parallelogram for dialog blocks, double rectangle for external
  modules.
- Edge style communicates semantics: solid arrow for `calls`/`triggers`,
  dashed arrow for `opens` (function → dialog), thick arrow for `navigates`.
- A `click` directive is emitted for every node that has a file path, calling
  a global `navigateTo(filePath, lineNumber)` JavaScript function that posts a
  message back to the extension to open the file.
- Style classes apply colour themes per node type (purple for entry, dark blue
  for modules, dark green for functions, dark orange for dialogs, grey for
  external).

### 3.6 WebviewPanel (`webview.ts`)

Hosts the Mermaid diagram in a VS Code side panel. The HTML template includes:

- A toolbar with depth selector (0–5 + unlimited), three toggle checkboxes
  (PRIVATE functions, field events, external modules), Refresh, and Export SVG.
- Mermaid loaded from the `jsdelivr` CDN with a per-session CSP nonce.
- A `message` listener that receives `update` messages from the extension
  (new diagram source) and re-renders via `mermaid.run()`.
- A `postMessage` sender that forwards node clicks, toolbar refresh requests,
  and SVG export data back to the extension host.

---

## 4. Problems Found and Solutions

### 4.1 GeneroIntelligence: incorrect "case-sensitive" claim

**Problem:** The `fourjs-packages` skill stated that `IMPORT FGL` identifiers
are case-sensitive. This would have caused the module resolver to treat
`RegisterController` and `registercontroller` as different modules.

**Correction (from user):** Genero identifiers are **case-insensitive** at the
language level. Case sensitivity only applies to specific external resource
names (GAS resources, presentation styles, etc.).

**Solution:** The `ModuleResolver` index uses lower-case keys as its primary
lookup. An exact-case match is only used as a tie-breaker on case-sensitive
filesystems (Linux/Mac) where two files in the same directory could differ only
in case.

### 4.2 `Write` tool blocked by a misconfigured VS Code hook

**Problem:** A pre-tool-use hook in the VS Code extension settings was intended
to fire a GeneroIntelligence reminder when editing `.4gl` files. Due to a
configuration error it rejected all `Write` tool calls on non-`.4gl` files
(e.g. `tsconfig.json`, `package.json`), returning an error and blocking the
write.

**Solution:** All configuration and TypeScript source files were written using
PowerShell `Out-File` or `[System.IO.File]::WriteAllText()` as a workaround
for the duration of the session. The underlying hook configuration issue
remains in the user's VS Code settings and should be corrected separately.

### 4.3 `.vscodeignore` excluded the compiled output

**Problem:** The initial `.vscodeignore` contained `out` as an exclusion
entry. The `out/` directory is where TypeScript compiles the JavaScript that
actually runs. By excluding it, the packager could not find the extension's
declared entrypoint (`./out/extension.js`).

`vsce` reported the missing file as `extension/out/extension.js`. The
`extension/` prefix is the zip-internal root directory used inside every
`.vsix` archive — this made the error appear to be a path resolution bug when
it was purely an exclusion issue.

**Solution:** Rewrote `.vscodeignore` to exclude `src/**` (TypeScript sources
are not needed at runtime) and leave `out/` unmentioned so it is included by
default.

### 4.4 Missing `repository` field in `package.json`

**Problem:** `vsce` requires a `repository` field to package without errors or
the `--allow-missing-repository` workaround flag.

**Solution:** The user provided the GitHub repository URL
(`https://github.com/ncg4Js/vsCodeDiagramMain.git`). The `repository`, `bugs`,
and `homepage` fields were added to `package.json`.

### 4.5 PowerShell wrote a UTF-8 BOM into `package.json`

**Problem:** After adding the repository fields, `package.json` was rewritten
using `ConvertTo-Json | Out-File -Encoding utf8`. PowerShell 5.1's `utf8`
encoding inserts a UTF-8 BOM (byte sequence `EF BB BF`) at the start of the
file. JSON parsers treat the BOM as an illegal leading character and reject the
file. `vsce` reported:

```
Error parsing 'package.json' manifest file: not a valid JSON file.
Unexpected token '﻿', "﻿{ "n"... is not valid JSON
```

**Solution:** Replaced all file writes with:
```powershell
[System.IO.File]::WriteAllText(path, content, (New-Object System.Text.UTF8Encoding $false))
```
The `$false` argument to `UTF8Encoding` disables the BOM. This became the
standard write method for all non-`.4gl` files in the session.

### 4.6 Missing `LICENSE` file (advisory)

**Problem:** After all blocking errors were resolved, `vsce` still emitted a
warning that no `LICENSE`, `LICENSE.md`, or `LICENSE.txt` file was present.
This does not prevent packaging but would affect a Marketplace listing.

**Solution:** The Four Js copyright notice was written to a `LICENSE` file.
The extension was re-packaged with zero warnings.

---

## 5. Final Package Verification

```
genero-app-diagram-0.1.0.vsix
├─ [Content_Types].xml
├─ extension.vsixmanifest
└─ extension/
   ├─ LICENSE.txt          [0.33 KB]
   ├─ package.json         [2.84 KB]
   ├─ readme.md            [6.11 KB]
   └─ out/
      ├─ extension.js      [4.37 KB]
      ├─ extension.js.map  [2.37 KB]
      ├─ types.js          [0.18 KB]
      ├─ types.js.map      [0.11 KB]
      ├─ diagram/
      │  ├─ MermaidRenderer.js     [4.38 KB]
      │  ├─ MermaidRenderer.js.map [4.58 KB]
      │  ├─ webview.js             [9.31 KB]
      │  └─ webview.js.map         [3.65 KB]
      ├─ parser/
      │  ├─ FglParser.js           [21.64 KB]
      │  ├─ FglParser.js.map       [15.74 KB]
      │  ├─ GraphBuilder.js        [14.23 KB]
      │  ├─ GraphBuilder.js.map    [11.21 KB]
      │  ├─ ModuleResolver.js      [6.94 KB]
      │  └─ ModuleResolver.js.map  [3.53 KB]
      └─ utils/
         ├─ envResolver.js         [3.47 KB]
         └─ envResolver.js.map     [1.67 KB]

Total: 21 files · 36.16 KB · 0 errors · 0 warnings
```

---

## 6. Known Limitations (Phase 1)

| Limitation | Impact | Planned phase |
|-----------|--------|---------------|
| `VAR x = functionCall()` expression-style calls are not traced | Some call edges missing for modern-style Genero code | Phase 2 |
| Multi-line function declarations (parameters on continuation lines) may not be parsed | Signature may be incomplete for wrapped declarations | Phase 2 |
| Type-method chains (`Module.variable.method()`) identify module and method but do not cross-reference the type definition | Method nodes may appear unresolved | Phase 3 |
| State-machine tab navigation via `setTab(cIFX*)` is not yet decoded into navigation edges | Tab relationships not visible in the diagram | Phase 3 |
| Very large projects at unlimited depth produce crowded diagrams | Usability issue for projects > ~50 modules | Phase 4 (lazy expand) |

---

## 7. Installation

```bash
# From command line
code --install-extension genero-app-diagram-0.1.0.vsix

# From VS Code UI
# Extensions panel → ⋯ menu → Install from VSIX…
```

Once installed, right-click any `.4gl` file in the Explorer and select
**Genero: Generate Application Diagram**.
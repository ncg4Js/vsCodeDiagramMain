# Genero Application Diagram

A VS Code extension that generates interactive dependency and call-flow diagrams for Genero BDL (`.4gl`) applications.

Starting from any `.4gl` file that contains a `MAIN` block (or any module you choose as the entry point), the extension:

- Resolves all `IMPORT FGL` dependencies found across the workspace and Genero search paths.
- Parses every resolved module for function signatures, dialog blocks (`MENU`, `INPUT`, `CONSTRUCT`, `DISPLAY ARRAY`, `DIALOG`), and access points (`ON ACTION`, `COMMAND`, `ON CHANGE`, `BEFORE/AFTER FIELD`).
- Renders a [Mermaid](https://mermaid.js.org/) `flowchart` diagram inside a VS Code WebviewPanel, with one subgraph per module.
- Lets you click any node to jump to the corresponding source line.

---

## Requirements

| Tool | Minimum version |
|------|----------------|
| Node.js | 18 |
| npm | 9 |
| VS Code | 1.85 |
| TypeScript (installed by `npm install`) | 5.3 |

---

## Building from source

```bash
# 1. Clone / copy the project
cd C:\work\VsCode\vs_code_app_diagram

# 2. Install dependencies (TypeScript + VS Code type definitions)
npm install

# 3. Compile TypeScript → JavaScript
npm run compile
```

The compiled output is written to `./out/`.

To compile in watch mode (recompiles automatically on every save):

```bash
npm run watch
```

---

## Running in development

1. Open the `vs_code_app_diagram` folder in VS Code.
2. Press **F5** (or **Run → Start Debugging**).  
   A new *Extension Development Host* window opens with the extension loaded.
3. In the Extension Development Host:
   - Right-click any `.4gl` file in the Explorer → **Genero: Generate Application Diagram**.
   - Or open a `.4gl` file and use the editor title-bar icon, or the Command Palette (`Ctrl+Shift+P`) → **Genero: Generate Application Diagram**.

---

## Packaging the extension

Packaging produces a `.vsix` file that can be installed in any VS Code instance without publishing to the Marketplace.

### 1. Install `vsce` (VS Code Extension Manager)

```bash
npm install --global @vscode/vsce
```

### 2. Compile before packaging

```bash
npm run compile
```

### 3. Package

```bash
vsce package
```

This produces `genero-app-diagram-0.1.0.vsix` in the current directory.

> **Note:** `vsce` requires the `publisher` field in `package.json` to be set.  
> It is currently set to `fourjs`. Change it to your own publisher ID if needed.

### 4. Install the `.vsix`

**From the command line:**

```bash
code --install-extension genero-app-diagram-0.1.0.vsix
```

**From the VS Code UI:**

1. Open the Extensions panel (`Ctrl+Shift+X`).
2. Click the **`…`** menu (top-right of the panel).
3. Choose **Install from VSIX…**.
4. Select the generated `.vsix` file.

---

## Extension settings

These settings can be configured in VS Code's `settings.json` (user or workspace level):

| Setting | Default | Description |
|---------|---------|-------------|
| `generoAppDiagram.fglldpath` | `""` | Override `FGLLDPATH` (semicolon-separated on Windows, colon-separated on Linux/Mac). Leave empty to use the environment variable. |
| `generoAppDiagram.fglresourcepath` | `""` | Override `FGLRESOURCEPATH`. Leave empty to use the environment variable. |
| `generoAppDiagram.maxDepth` | `2` | Default traversal depth. `0` = entry module only, `-1` = unlimited. |
| `generoAppDiagram.showPrivateFunctions` | `true` | Include `PRIVATE` functions in the diagram. |
| `generoAppDiagram.showFieldEvents` | `false` | Show `ON CHANGE` / `BEFORE FIELD` / `AFTER FIELD` event edges. |
| `generoAppDiagram.showExternalModules` | `false` | Show references to modules not found in any search path. |

### Module search order

The extension searches for `.4gl` files in this order (first match wins):

1. **Directory of the entry `.4gl` file** (the "current directory" — matches Genero runtime behaviour)
2. VS Code workspace folders (all subfolders)
3. `FGLLDPATH` directories
4. `FGLRESOURCEPATH` directories
5. `DBPATH` directories
6. `PATH` directories

Module name matching is **case-insensitive** (consistent with Genero language semantics).

---

## Diagram controls

| Control | Action |
|---------|--------|
| **Depth** selector | Change traversal depth and click **Refresh** |
| **PRIVATE functions** checkbox | Toggle visibility of private functions |
| **Field events** checkbox | Toggle `ON CHANGE` / `BEFORE/AFTER FIELD` edges |
| **External modules** checkbox | Toggle unresolved module stubs |
| **Refresh** button | Rebuild the diagram with current settings |
| **Export SVG** button | Save the rendered diagram as an `.svg` file |
| Click any node | Navigate to the corresponding `.4gl` source line |

---

## Project structure

```
vs_code_app_diagram/
├── src/
│   ├── extension.ts              VS Code entry point, command registration
│   ├── types.ts                  Shared TypeScript type definitions
│   ├── utils/
│   │   └── envResolver.ts        Reads FGLLDPATH / FGLRESOURCEPATH / DBPATH / PATH
│   ├── parser/
│   │   ├── ModuleResolver.ts     IMPORT FGL path → .4gl file lookup
│   │   ├── FglParser.ts          Context-aware .4gl lexer (functions, dialogs, events, calls)
│   │   └── GraphBuilder.ts       BFS graph assembly from parsed modules
│   └── diagram/
│       ├── MermaidRenderer.ts    AppGraph → Mermaid flowchart syntax
│       └── webview.ts            VS Code WebviewPanel with toolbar and click-navigation
├── out/                          Compiled JavaScript (generated by npm run compile)
├── FEASIBILITY.md                Design document and Genero language analysis
├── package.json
└── tsconfig.json
```

---

## Known limitations (Phase 1)

- `VAR x = functionCall()` expression-style calls are not traced; only explicit `CALL` statements are.
- Function declarations that span multiple lines (parameters on continuation lines) may not be parsed. Single-line declarations are handled correctly.
- Type-method resolution via intermediate variables (`Module.variable.method()`) identifies the module and method name but does not yet cross-reference the type definition.
- Very large projects (hundreds of modules) at unlimited depth may produce crowded diagrams; use depth limiting and module filtering to focus the view.

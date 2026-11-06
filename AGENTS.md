# Vibma Development Workflow

Development instructions for the independent AI Design Studio. The former Vibma
MCP-to-Figma bridge remains in the repository as legacy reference code only.

## Current Project State — Read This First

This repository contains **one active product direction and one legacy codebase**:

1. **AI Design Studio (active development target).** `packages/design-schema`,
   `packages/design-runtime`, and `packages/design-persistence` are early,
   host-independent foundations. The product is still in Phase 0 and is not yet a
   complete standalone application.
2. **Vibma MCP-to-Figma bridge (legacy; do not use).** `packages/core`,
   `packages/tunnel`, `packages/adapter-figma`, `schema`, `plugin`, and the related
   setup guides are retained only for source reference and controlled migration.

### Legacy Vibma Policy

- Do not start the relay, import the Figma plugin, configure the Vibma MCP server, or
  use Figma as the execution backend for new work.
- Do not add features to or extend the legacy bridge unless the user explicitly asks
  for legacy maintenance or migration work.
- Do not make new Studio packages depend on Vibma core, tunnel, Figma adapter, Figma
  APIs, or generated Figma tool contracts.
- Existing Vibma behavior may be read as a requirements sample, but its implementation
  is not the target architecture.
- Default build, test, and documentation guidance for new work must point to the
  independent Studio packages, not to Vibma commands.

The target architecture in `docs/ai-design-studio-architecture-analysis.md` is a
**draft roadmap, not a description of implemented functionality**. The Studio already
has a runnable web workbench, a host-independent layout and text-measurement engine,
a safe AI editing loop, and HTML/SVG/PNG export prototypes, but none of them are
production-grade yet: the canvas renders through the DOM, text measurement depends on
browser font metrics, and the AI path is still limited to a single OpenAI-compatible
provider.

Before planning or changing the project, read
`docs/current-project-status.md`. Do not infer that a package or feature exists merely
because it appears in the target directory tree or a future phase in the architecture
document. Verify the filesystem, tests, and exported APIs first.

### Studio Package Constraints

- `packages/studio-web` inherits the root tsconfig (`strict: false`), so discriminated-union
  narrowing on a literal discriminant (`ok: true | false`) does **not** apply there. Keep
  cross-package APIs narrow-friendly: return a value on success and throw a typed error on
  failure (for example `migrateDocument()` throws `MigrationError`).
- The root entry of `packages/design-persistence` must stay browser-safe (no `node:` builtins).
  The filesystem implementation is published as `@ufira/design-persistence/filesystem`.
- The document format version lives in `packages/design-schema/src/migrate.ts`
  (`CURRENT_SCHEMA_VERSION` plus the `MIGRATIONS` step table). Every read path for older
  documents — repository recovery and JSON import — must call `migrateDocument()` before
  validation.

## Legacy Vibma Reference

The remaining sections document the old bridge for migration and historical
maintenance. They are not the default development workflow.

## Design Philosophy

**Vibma helps designers focus on taste, not structure.** The MCP guardrails good Figma design structure — proper auto-layout, design tokens, component architecture — so designers don't have to fix structural mistakes left by agents.

The MCP emits warnings when it spots structural issues (hardcoded colors, missing auto-layout, unbound tokens). Following these warnings reduces noise from the MCP and produces well-structured design systems that designers enjoy working with.

## Architecture Overview

Three processes form the communication chain:

```
MCP Client (e.g. Claude Code)  ←stdio→  MCP Server (packages/core)  ←WebSocket→  Relay (packages/tunnel)  ←WebSocket→  Figma Plugin (packages/adapter-figma)
```

The relay runs on `localhost:3055` and bridges the MCP server to the Figma plugin via a named channel (default: `vibma`). Each channel allows exactly one MCP and one plugin connection.

## Architecture Rules

Package-specific rules live alongside the code they govern:

- **`schema/AGENTS.md`** — compiler pipeline, YAML authoring, tool description quality
- **`packages/core/AGENTS.md`** — endpoint contract, access tiers, response types & docs
- **`packages/adapter-figma/AGENTS.md`** — batch handler, response design, agent guidance, command dispatch

### Endpoint vs Standalone Tool

**Endpoint** (single tool with `method` dispatch): for **homogeneous resources** that share a consistent shape and support CRUD. Examples: `styles`, `variables`, `variable_collections`, `components`, `instances`.

**Standalone tool**: when operations are **heterogeneous** (different types need wildly different schemas), operate on a different resource than the endpoint, or are simple actions that don't fit CRUD.

**Don't create a tool that's a subset of another.** If `frames(method: "update")` already applies styles via `fill.styleName`, don't add a separate tool. If a fix can be done with existing primitives, don't add a dedicated tool.

### Shared Behavior Before Local Patches

When fixing validation, examples, response formatting, or batch behavior, first identify the shared layer that owns the concern:

- **Examples and parameter shapes** belong in `schema/tools/*.yaml` and must flow through the compiler to help/docs/descriptions.
- **MCP-side schema validation** belongs in `schema/compiler/` when it can be derived from YAML.
- **Figma adapter batch behavior** belongs in `batchHandler` when it affects every `items` batch.
- **Handler code** should only contain resource-specific validation that cannot be expressed by the schema or shared helpers.

Do not patch one endpoint or one discriminant branch for a structural issue until you have checked whether frames, components, styles, variables, and other `batchHandler` users share the same failure mode.

## Build Pipeline

`npm run build` (tsup) produces:
- `dist/mcp.js` — MCP server (Node.js)
- `plugin/code.js` — Figma plugin (IIFE bundle)
- `plugin/ui.html` — copied from plugin UI source via `tsup.config.ts` `onSuccess` hook

**Figma watches `plugin/` for file changes** — build auto-reloads the plugin and reconnects. No manual action needed in Figma.

**MCP server hot-reload**: use `dev_reload` MCP tool after building — it rebuilds and restarts the MCP server without restarting Claude Code. Then `connection(method: "create")` + `connection(method: "get")` to verify.

## Running the Relay

```bash
npm run socket          # or: cd packages/tunnel && node dist/index.js
lsof -ti :3055 | xargs kill -9   # kill stuck relay from previous session
```

After relay restart: plugin auto-reconnects. Use `dev_reload` to restart the MCP server.

## Testing Changes End-to-End

1. Make code changes
2. `npm run build` (plugin auto-reloads in Figma)
3. **If changes touch `packages/core`**: use `dev_reload` to rebuild and restart the MCP server. Plugin-only changes (`packages/adapter-figma`) take effect immediately after build.
4. `connection(method: "create")` → `connection(method: "get")` to verify chain
5. Test the tools you changed

## Checklist: Adding/Modifying/Removing a Tool

1. **YAML schema** (`schema/tools/*.yaml`): add/update/remove tool definition with params, methods, notes
2. **Figma handler** (`packages/adapter-figma/src/handlers/`): add/update/remove handler + register in `registry.ts`
3. **Response types** (`packages/core/src/tools/generated/response-types.ts`): add/update/remove interface + `toolResponseSchemas` entry
4. **SKIP_FOCUS** (`packages/adapter-figma/src/plugin/code.ts`): add read-only tools (non-node resources)
5. **String references**: search for old tool names in `helpers.ts`, `lint.ts`, prompts, and docs
6. **AGENTS.md files**: update if the change affects architecture rules or conventions — these files are a source of truth that agents and other docs reference
7. **Shared behavior audit**: if the change touches batches, discriminants, examples, validation, or response shaping, update the shared compiler/helper path rather than one handler
8. **Regenerate**: `npx tsx schema/compiler/index.ts` — updates `defs.ts`, `help.ts`, `prompts.ts`, and static docs site MDX pages. All are derived from the YAML and will go stale without this step.
9. **Build**: `npm run build`

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **design-ai** (3257 symbols, 7165 relationships, 282 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/design-ai/context` | Codebase overview, check index freshness |
| `gitnexus://repo/design-ai/clusters` | All functional areas |
| `gitnexus://repo/design-ai/processes` | All execution flows |
| `gitnexus://repo/design-ai/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

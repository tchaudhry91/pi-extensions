# AGENTS.md

This file is intended for AI coding agents working in this repository. It explains the structure, conventions, and patterns to follow when modifying or adding code.

## What this repo is

A personal **pi package** — a monorepo of extensions, skills, prompts, and themes for the [pi coding agent](https://github.com/earendil-works/pi). It is installed into pi with:

```bash
pi install /home/tchaudhry/Workspace/pi-extensions
```

The `package.json` `"pi"` section declares what pi loads:

```json
{
  "pi": {
    "extensions": [
      "./extensions/providers/ollama-cloud.ts",
      "./extensions/providers/qe93-ollama.ts",
      "./extensions/search/searxng.ts",
      "./extensions/fetch/web-read.ts",
      "./extensions/research/arxiv.ts",
      "./extensions/research/openalex.ts",
      "./extensions/pdf/pdf-read.ts"
    ],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Design context and roadmap live in `docs/`. Start with
`docs/research-workflow-improvement-plan.md` before adding research-tooling
features — it defines the phased plan, schema sketches, and design principles
(artifact-first, citation-preserving, chunkable, no-surprise-autonomy).

## Directory layout

```
pi-extensions/
├── docs/                # Design docs / roadmap
├── extensions/          # TypeScript extensions loaded by pi
│   ├── providers/       # Model provider registrations
│   │   ├── ollama-cloud.ts   # Ollama Cloud (loaded)
│   │   ├── qe93-ollama.ts    # Local QE93 Ollama (loaded)
│   │   └── zai-coding.ts      # Dormant — NOT in package.json (see below)
│   ├── search/          # Tool registrations
│   │   └── searxng.ts
│   ├── fetch/           # Web reading
│   │   └── web-read.ts       # registers the `web_read` tool
│   ├── research/        # Research / paper discovery tools
│   │   ├── arxiv.ts          # registers the `arxiv_search` tool
│   │   └── openalex.ts       # registers the `openalex_search` tool
│   └── pdf/             # PDF reading / OCR
│       └── pdf-read.ts      # registers `pdf_info` + `pdf_read`
├── skills/              # Skill markdown folders (SKILL.md)
│   └── deep-research/
├── prompts/             # Slash-command prompt templates
│   └── research.md
├── themes/              # Theme JSON files
├── package.json         # Package metadata + pi section
├── tsconfig.json        # TypeScript config (target: ES2022, module: NodeNext)
└── AGENTS.md            # This file
```

### Dormant / optional extensions

`extensions/providers/zai-coding.ts` exists but is **intentionally not loaded**
(it is absent from `package.json` → `"pi"` → `"extensions"`). It is kept as an
optional provider for if/when ZAI Coding is actively used. Do not re-add it to
the manifest unless that plan is revived; if you do, also document it here.

## TypeScript conventions

- **Module system**: ESNext / NodeNext (`"type": "module"` in package.json, `"module": "NodeNext"` in tsconfig)
- **Target**: ES2022
- **Strict mode**: enabled in tsconfig
- **Linting/checking**: `npm run check` runs `tsc --noEmit`
- **Runtime**: Extensions are loaded via [jiti](https://github.com/unjs/jiti) at runtime — TypeScript works without compilation. No build step needed.

## Extension patterns

Every extension file exports a **default function** (sync or async) that receives `ExtensionAPI` as its single argument. Use `import type` for pi types to avoid runtime import issues:

```typescript
import type { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  // ... extension logic
}
```

### Pattern: Provider registration

Provider extensions discover and register model providers. See
`extensions/providers/ollama-cloud.ts` (cloud, TTL-cached discovery) and
`extensions/providers/qe93-ollama.ts` (local Ollama, silent-on-startup discovery
with a cache fallback).

Key steps:
1. Fetch available models from the provider's API at startup (or use a cached fallback list)
2. Build `ProviderModelConfig[]` with at minimum: `id`, `name`, `api` (typically `"openai-completions"`), `reasoning`, `input`, `cost`, `contextWindow`, `maxTokens`
3. Call `pi.registerProvider(providerId, { name, baseUrl, apiKey, api, models })`
4. Optionally register commands for manual refresh or model listing

Provider API keys are read from environment variables (e.g., `OLLAMA_CLOUD_API_KEY`, `QE93_OLLAMA_API_KEY`). Never hardcode keys.

Caching: `ollama-cloud.ts` demonstrates a file-based cache in `getAgentDir()/cache/` with TTL-based staleness. `qe93-ollama.ts` demonstrates the same idea plus **silent startup**: when the local host is simply down (connection refused / timeout / DNS), discovery fails quietly and falls back to the cache rather than spamming warnings on every launch. Use the `isConnectionError` + `silent`-flag pattern there for any provider whose host is commonly offline.

### Pattern: Tool registration

Tool extensions register custom tools callable by the LLM. See
`extensions/search/searxng.ts`, `extensions/fetch/web-read.ts`,
`extensions/research/arxiv.ts`, `extensions/research/openalex.ts`, and
`extensions/pdf/pdf-read.ts`.

Key steps:
1. Define parameters using TypeBox schemas (`Type.Object`, `Type.String`, `Type.Integer`, `StringEnum`, etc.)
2. Call `pi.registerTool({ name, label, description, promptSnippet, promptGuidelines, parameters, execute, renderCall?, renderResult? })`
3. The `execute` signature is:
   ```ts
   async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>
   ```
   - `signal: AbortSignal | undefined` — pass this into long-running `fetch`/subprocess calls so the tool is cancellable.
   - `onUpdate?: AgentToolUpdateCallback<TDetails>` — stream progress (e.g. `onUpdate?.({ content: [...], details })`).
   - `ctx: ExtensionContext` — has `cwd` for resolving local paths.
   - Return `{ content: [...], details: {...} }`.
4. Use `renderCall` and `renderResult` for custom TUI rendering.
5. Optionally register a test command for the tool.

**Truncation convention** (see `pdf-read.ts` and `web-read.ts`): always extract
the *full* content locally; if the returned window is truncated, write the full
output to a temp file and return its path via `details.fullOutputPath` and an
inline `*[Content truncated: ... Full output saved to: ...]*` marker. For
chunkable sources, expose `offset`/`limit` and tell the model the next offset.
When caching, also expose `details.cachePath` so the model can `read` the full
cached content directly.

When registering a new extension, **add it to the `"pi.extensions"` array** in `package.json` so pi auto-discovers it.

### Pattern: Commands

Commands are registered via `pi.registerCommand(name, { description, handler, getArgumentCompletions? })`. The handler receives `(args: string, ctx: ExtensionCommandContext)`. Commands are invoked as `/command-name` inside pi.

## Key imports

| Import | Package | Use |
|--------|---------|-----|
| `ExtensionAPI` | `@earendil-works/pi-coding-agent` | Type for the `pi` parameter |
| `ExtensionCommandContext`, `ExtensionContext` | `@earendil-works/pi-coding-agent` | Types for command/tool handler context |
| `ProviderModelConfig` | `@earendil-works/pi-coding-agent` | Type for model configuration |
| `getAgentDir` | `@earendil-works/pi-coding-agent` | Pi's agent cache directory |
| `truncateHead`, `formatSize`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`, `TruncationResult` | `@earendil-works/pi-coding-agent` | Output formatting / truncation utilities |
| `withFileMutationQueue` | `@earendil-works/pi-coding-agent` | Serialize file mutations (use for capture tools that write into the research repo) |
| `Type`, `Static` | `typebox` | Schema definitions for tool parameters |
| `StringEnum` | `@earendil-works/pi-ai` | Enum-like string validation |
| `Text` | `@earendil-works/pi-tui` | TUI text rendering |

**Important**: `@earendil-works/pi-*` and `typebox` are **peerDependencies**. Pi provides its own copies at runtime. Do not add them to `dependencies`.

Runtime dependencies (like `linkedom` and `@mozilla/readability` used by `web-read.ts`, and `linkedom`'s `DOMParser` used by `arxiv.ts`) must be in `dependencies` — pi uses `npm install --omit=dev` for installed packages. Node built-ins (`node:crypto`, `node:fs/promises`, etc.) need no declaration.

## Adding new resources

### Adding a new extension

1. Create a `.ts` file in `extensions/` (or a subdirectory)
2. Export a default function that takes `ExtensionAPI`
3. Add the file path to `package.json` → `"pi"` → `"extensions"` array
4. Run `npm run check` to verify TypeScript correctness

### Adding a new skill

1. Create a directory under `skills/` with a `SKILL.md` file
2. The skill is auto-discovered (the `"skills"` entry in package.json points to `./skills` directory)
3. No code changes needed — pi picks it up on `/reload`

### Adding a new prompt template

1. Add a `.md` file under `prompts/`
2. Auto-discovered via the `"prompts"` entry in package.json

### Adding a new theme

1. Add a JSON file under `themes/`
2. Auto-discovered via the `"themes"` entry in package.json

## Development workflow

```bash
# Check TypeScript correctness
npm run check

# The repo must be installed into pi for testing. From inside pi:
/reload

# Or re-install:
pi install /home/tchaudhry/Workspace/pi-extensions
```

After changing installed resources, use `/reload` inside pi to pick them up without restarting.

## Environment variables

Extensions may read these environment variables:

| Variable | Used by | Purpose |
|----------|---------|---------|
| `OLLAMA_CLOUD_API_KEY` | ollama-cloud, pdf-read (OCR) | Ollama Cloud API key (primary) |
| `OLLAMA_API_KEY` | ollama-cloud, pdf-read (OCR) | Ollama Cloud API key (fallback) |
| `OLLAMA_CLOUD_BASE_URL` | ollama-cloud | Custom base URL (default: `https://ollama.com`) |
| `OLLAMA_API_BASE` | ollama-cloud | Custom base URL fallback |
| `QE93_OLLAMA_BASE_URL` | qe93-ollama | Local Ollama base URL (default: `http://127.0.0.1:11434`) |
| `QE93_OLLAMA_HOST` | qe93-ollama | Base URL fallback |
| `QE93_OLLAMA_API_KEY` | qe93-ollama | Auth for an Ollama proxy (optional) |
| `QE93_OLLAMA_REQUIRE_TOOLS` | qe93-ollama | `false` includes chat-only models (default requires tool support) |
| `PDF_OCR_MODEL` | pdf-read | OCR model override (default: `minimax-m3`) |
| `PDF_OCR_BASE_URL` | pdf-read | OCR endpoint override |
| `PDF_OCR_API_KEY` | pdf-read | Dedicated OCR API key (fallbacks: `OLLAMA_CLOUD_API_KEY`, `OLLAMA_API_KEY`) |
| `SEARXNG_URL` | searxng | SearXNG instance URL (default: `https://search.ts.tux-sudo.com`) |
| `OPENALEX_API_KEY` | openalex | Optional free OpenAlex API key for higher daily search budget |
| `OPENALEX_MAILTO` | openalex | Optional email passed to OpenAlex for polite API usage |
| `ZAI_CODING_API_KEY` | zai-coding (dormant) | ZAI Coding API key — only relevant if zai-coding is re-enabled |

## License

MIT — see [LICENSE](./LICENSE).
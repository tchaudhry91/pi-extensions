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
      "./extensions/providers/zai-coding.ts",
      "./extensions/search/searxng.ts",
      "./extensions/fetch/web-fetch.ts"
    ],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

## Directory layout

```
pi-extensions/
├── extensions/           # TypeScript extensions loaded by pi
│   ├── providers/        # Model provider registrations
│   │   ├── ollama-cloud.ts
│   │   └── zai-coding.ts
│   └── search/           # Tool registrations
│       └── searxng.ts
│   └── fetch/             # Web fetching
│       └── web-fetch.ts
├── skills/               # Skill markdown folders (SKILL.md)
├── prompts/              # Slash-command prompt templates
├── themes/               # Theme JSON files
├── package.json          # Package metadata + pi section
├── tsconfig.json         # TypeScript config (target: ES2022, module: NodeNext)
└── AGENTS.md             # This file
```

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

Provider extensions discover and register model providers. See `extensions/providers/ollama-cloud.ts` and `extensions/providers/zai-coding.ts`.

Key steps:
1. Fetch available models from the provider's API at startup (or use a hardcoded fallback list)
2. Build `ProviderModelConfig[]` with at minimum: `id`, `name`, `api` (typically `"openai-completions"`), `reasoning`, `input`, `cost`, `contextWindow`, `maxTokens`
3. Call `pi.registerProvider(providerId, { name, baseUrl, apiKey, api, models })`
4. Optionally register commands for manual refresh or model listing

Provider API keys are read from environment variables (e.g., `OLLAMA_CLOUD_API_KEY`, `ZAI_CODING_API_KEY`). Never hardcode keys.

Caching: `ollama-cloud.ts` demonstrates a file-based cache in `getAgentDir()/cache/` with TTL-based staleness. Use this pattern for expensive discovery.

### Pattern: Tool registration

Tool extensions register custom tools callable by the LLM. See `extensions/search/searxng.ts` and `extensions/fetch/web-fetch.ts`.

Key steps:
1. Define parameters using TypeBox schemas (`Type.Object`, `Type.String`, `Type.Integer`, `StringEnum`, etc.)
2. Call `pi.registerTool({ name, label, description, promptSnippet, promptGuidelines, parameters, execute, renderCall?, renderResult? })`
3. The `execute` function receives `(toolCallId, params, signal)`, returns `{ content: [...], details: {...} }`
4. Use `renderCall` and `renderResult` for custom TUI rendering
5. Optionally register a test command for the tool

When registering a new extension, **add it to the `"pi.extensions"` array** in `package.json` so pi auto-discovers it.

### Pattern: Commands

Commands are registered via `pi.registerCommand(name, { description, handler, getArgumentCompletions? })`. The handler receives `(args: string, ctx: ExtensionCommandContext)`. Commands are invoked as `/command-name` inside pi.

## Key imports

| Import | Package | Use |
|--------|---------|-----|
| `ExtensionAPI` | `@earendil-works/pi-coding-agent` | Type for the `pi` parameter |
| `ExtensionCommandContext` | `@earendil-works/pi-coding-agent` | Type for command handler context |
| `ProviderModelConfig` | `@earendil-works/pi-coding-agent` | Type for model configuration |
| `getAgentDir` | `@earendil-works/pi-coding-agent` | Pi's agent cache directory |
| `truncateHead`, `formatSize`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES` | `@earendil-works/pi-coding-agent` | Output formatting utilities |
| `Type`, `Static` | `typebox` | Schema definitions for tool parameters |
| `StringEnum` | `@earendil-works/pi-ai` | Enum-like string validation |
| `Text` | `@earendil-works/pi-tui` | TUI text rendering |

**Important**: `@earendil-works/pi-*` and `typebox` are **peerDependencies**. Pi provides its own copies at runtime. Do not add them to `dependencies`.

Runtime dependencies (like `linkedom` and `@mozilla/readability` used by `web-fetch.ts`) must be in `dependencies` — pi uses `npm install --omit=dev` for installed packages.

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
| `OLLAMA_CLOUD_API_KEY` | ollama-cloud | Ollama Cloud API key (primary) |
| `OLLAMA_API_KEY` | ollama-cloud | Ollama Cloud API key (fallback) |
| `OLLAMA_CLOUD_BASE_URL` | ollama-cloud | Custom base URL (default: `https://ollama.com`) |
| `OLLAMA_API_BASE` | ollama-cloud | Custom base URL fallback |
| `ZAI_CODING_API_KEY` | zai-coding | ZAI Coding API key |
| `SEARXNG_URL` | searxng | SearXNG instance URL (default: `https://search.ts.tux-sudo.com`) |

## License

MIT — see [LICENSE](./LICENSE).

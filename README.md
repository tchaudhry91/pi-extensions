# Personal Pi Extensions

Personal package/monorepo for Pi coding agent resources:

- `extensions/` - TypeScript extensions
  - `extensions/providers/ollama-cloud.ts` - discovers and registers Ollama Cloud models from `https://ollama.com`
- `skills/` - reusable skills (`SKILL.md` folders or top-level markdown)
- `prompts/` - slash-command prompt templates
- `themes/` - theme JSON files

## Use locally

Install this package globally into Pi:

```bash
pi install /home/tchaudhry/Workspace/pi-extensions
```

Or install project-local from a project repo:

```bash
pi install -l /home/tchaudhry/Workspace/pi-extensions
```

For quick testing of a single extension:

```bash
pi -e ./extensions/baseline.ts
```

After changing installed resources, use `/reload` inside Pi.

## Ollama Cloud

Set your Ollama Cloud API key before launching Pi:

```bash
export OLLAMA_CLOUD_API_KEY="your-key"
```

The extension also falls back to `OLLAMA_API_KEY` if `OLLAMA_CLOUD_API_KEY` is not set. It registers provider `ollama-cloud` using the OpenAI-compatible endpoint `https://ollama.com/v1`, discovers tool-capable models from `/v1/models` + `/api/show`, and caches metadata under Pi's agent cache directory.

Commands:

- `/ollama-cloud-refresh` - refresh model metadata and re-register the provider
- `/ollama-cloud-models` - show currently registered model IDs

## Development

```bash
npm install
npm run check
```

Pi provides its own runtime copies of `@mariozechner/pi-*` and `typebox`; they are declared as peer dependencies here.

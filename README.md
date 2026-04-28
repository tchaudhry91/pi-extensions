# Personal Pi Extensions

Personal package/monorepo for Pi coding agent resources:

- `extensions/` - TypeScript extensions
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

## Development

```bash
npm install
npm run check
```

Pi provides its own runtime copies of `@mariozechner/pi-*` and `typebox`; they are declared as peer dependencies here.

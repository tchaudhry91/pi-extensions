# Personal Pi Extensions

Personal package/monorepo for Pi coding agent resources:

- `extensions/` - TypeScript extensions
  - `extensions/providers/ollama-cloud.ts` - discovers and registers Ollama Cloud models from `https://ollama.com`
  - `extensions/providers/qe93-ollama.ts` - discovers and registers local Ollama models from the QE93 backend (silent when the host is down)
  - `extensions/providers/zai-coding.ts` - dormant ZAI Coding provider (not loaded by default)
  - `extensions/search/searxng.ts` - SearXNG web search tool
  - `extensions/fetch/web-read.ts` - `web_read` tool: fetches a URL and extracts content (readable/markdown/text/raw) with caching and chunking
  - `extensions/research/arxiv.ts` - `arxiv_search` tool: keyless arXiv paper/preprint discovery with PDF links
  - `extensions/pdf/pdf-read.ts` - `pdf_info` + `pdf_read` tools: `pdftotext` with optional Ollama Cloud OCR via `minimax-m3`
- `docs/` - design docs and roadmap (start with `docs/research-workflow-improvement-plan.md`)
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

## QE93 local Ollama

The QE93 provider registers local Ollama models under provider `qe93`. It discovers models from Ollama's `/api/tags` + `/api/show` endpoints and exposes completion models with tool support.

Discovery is **silent on startup** when the local host is simply down (connection refused / timeout / DNS) — it falls back to the cached model list instead of printing a warning on every launch. Use `/qe93-test` to diagnose connection issues explicitly. Override the host with `QE93_OLLAMA_BASE_URL` (or fallback `QE93_OLLAMA_HOST`):

```bash
export QE93_OLLAMA_BASE_URL="http://127.0.0.1:11434"
```

From another Tailscale-connected machine, point Pi at this host's Tailscale address instead:

```bash
export QE93_OLLAMA_BASE_URL="http://100.99.231.43:11434"
```

Optional configuration:

```bash
export QE93_OLLAMA_API_KEY="..."          # only needed if a proxy in front of Ollama requires auth
export QE93_OLLAMA_REQUIRE_TOOLS="false" # include completion models that do not advertise tool support
```

Commands:

- `/qe93-test` - test the configured Ollama connection
- `/qe93-refresh` - refresh model discovery and re-register provider `qe93`
- `/qe93-models` - show currently registered QE93 model IDs

## Web reading

The `web_read` tool fetches a URL and extracts content as markdown. It supersedes the older `web_fetch` behavior with research-grade semantics.

Parameters of note:

- `mode` - `readable` (default, Readability-first) | `markdown` (structured HTML→markdown, preserves code/tables better) | `text` (plain text) | `raw` (raw HTML)
- `offset` / `limit` - read later chunks of long pages (UTF-8 byte offset/limit into extracted content)
- `maxLength` - max bytes returned in one call (default ~150 KB; up to 1 MB)
- `cache` / `refresh` - local cache under Pi's agent cache dir, keyed by URL + mode (`refresh` ignores the cache and refetches)
- `includeLinks` / `includeMetadata` - append link list / extra metadata to the output

Behavior:

- Always extracts the **full** content locally; if the returned window is truncated, the full output is saved to a temp file and the path is returned (`details.fullOutputPath`). The cached full content path is also returned (`details.cachePath`) so it can be read directly.
- PDF responses are detected and rejected with a pointer to `pdf_read`.
- Non-HTML content (text, markdown, JSON) is returned as-is (JSON is pretty-printed in readable/markdown/text modes).

Command: `/web-read-test <url>`.

## arXiv paper search

The `arxiv_search` tool searches arXiv's public Atom API. It does **not** require a login, API key, or environment variable.

Parameters of note:

- `query` - plain text is converted to a stricter `all:term AND all:term` arXiv query; advanced arXiv syntax like `ti:`, `au:`, `abs:`, `cat:`, `AND`, `OR` is passed through
- `categories` - optional category filters such as `cs.DC`, `cs.OS`, `cs.SE`, `cs.NI`, `cs.PF`
- `sortBy` / `sortOrder` - `relevance`, `lastUpdatedDate`, or `submittedDate`; `ascending` or `descending`
- `start` / `maxResults` - pagination and result count (`maxResults` defaults to 10, capped at 50)

Behavior:

- Returns triage-friendly paper metadata: title, authors, arXiv ID, published/updated dates, categories, abstract summary, arXiv URL, and PDF URL.
- Adds a reminder that arXiv papers are preprints and are not necessarily peer reviewed.
- Use returned PDF URLs with `pdf_info` / `pdf_read` for deep reading.

Command: `/arxiv-search-test <query>`.

## PDF reading / OCR

The PDF extension registers:

- `pdf_info` - inspect PDF metadata and page count with `pdfinfo`
- `pdf_read` - extract PDF text with `pdftotext`; use `mode: "ocr"` or `mode: "both"` to render pages and OCR them with Ollama Cloud `minimax-m3`

OCR configuration:

```bash
export OLLAMA_CLOUD_API_KEY="your-key"     # or OLLAMA_API_KEY / PDF_OCR_API_KEY
export PDF_OCR_MODEL="minimax-m3"          # optional override
export PDF_OCR_BASE_URL="https://ollama.com/v1" # optional override
```

`pdftotext`, `pdfinfo`, and `pdftoppm` must be available on PATH.

## Development

```bash
npm install
npm run check
```

Pi provides its own runtime copies of `@earendil-works/pi-*` and `typebox`; they are declared as peer dependencies here.

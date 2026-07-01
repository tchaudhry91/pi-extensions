# Pi Research Workflow Improvement Plan

**Date:** 2026-07-01  
**Repo:** `~/Workspace/pi-extensions`  
**Status:** Planning document only — not yet implemented  
**Primary goal:** Evolve this Pi package from “custom tools + providers” into Tanmay’s research operating system for Starlit Labs, Axiom/Hawkeye/Saga/eBPF work, and optional future PhD preparation.

---

## 0. Context: why this plan exists

Tanmay’s current workflow is converging around independent systems research:

- publish under **Starlit Labs**;
- collaborate with the matched research network, especially Cristian Klein / Umeå ADS Lab;
- turn production infrastructure artifacts into papers;
- use Pi as the main research/coding assistant;
- preserve useful context into `brain` and `research` repos.

The current `pi-extensions` repo already provides useful foundations:

- model providers:
  - `ollama-cloud`
  - `qe93` local Ollama
  - dormant `zai-coding`
- web/search tools:
  - `searxng_search`
  - `web_fetch`
- PDF tools:
  - `pdf_info`
  - `pdf_read` with `pdftotext` + optional OCR
- one generic skill:
  - `deep-research`
- one prompt:
  - `research.md`

The next layer should make Pi better at:

1. ingesting long web/paper sources without losing data;
2. reading papers and writing standardized notes;
3. managing research sessions;
4. preserving key context through compaction;
5. helping with collaborator outreach;
6. gently enforcing repo hygiene without taking over.

---

## 1. Quick cleanup before feature work

### 1.1 Update `AGENTS.md`

`AGENTS.md` is currently slightly stale compared to `package.json`.

Current `package.json` loads:

```json
"extensions": [
  "./extensions/providers/ollama-cloud.ts",
  "./extensions/providers/qe93-ollama.ts",
  "./extensions/search/searxng.ts",
  "./extensions/fetch/web-fetch.ts",
  "./extensions/pdf/pdf-read.ts"
]
```

But `AGENTS.md` still describes `zai-coding.ts` as loaded and omits `qe93-ollama.ts` / `pdf-read.ts` in the manifest example.

**Action:** update `AGENTS.md` so future agents do not misread the active extension set.

### 1.2 Decide what to do with `zai-coding.ts`

`extensions/providers/zai-coding.ts` exists but is not loaded.

Options:

- **Keep dormant** and explicitly document it as unused/optional.
- **Add to `package.json`** if the ZAI Coding plan is actively used.
- **Move to `extensions/providers/disabled/`** if intentionally parked.

Recommendation: keep it but mark as optional in README/AGENTS unless you actively use that provider.

### 1.3 Add a lightweight `docs/` index

If this plan grows into multiple design docs, add:

```text
docs/
  README.md
  research-workflow-improvement-plan.md
  web-read-design.md
  paper-tools-design.md
  research-session-extension-design.md
```

---

## 2. Highest priority: replace/upgrade `web_fetch`

### 2.1 Problem

The current `web_fetch` is useful but not research-grade.

Current limitations:

- default output cap is 150 KB;
- hard maximum returned output is 500 KB;
- raw HTML is hard-capped at 3 MB before parsing;
- full extracted output is **not saved** when truncation occurs;
- no `offset` / chunking support;
- no extraction modes;
- Readability can lose code blocks, tables, footnotes, references, and docs structure;
- fetch does not currently accept/pass the tool `AbortSignal` into `fetchAndExtract`;
- hostile/SPAs/docs pages often extract poorly;
- PDF links are not auto-routed to `pdf_read`;
- no caching, so repeated source reading refetches everything.

This matters because research sessions often need full source content, not a preview.

### 2.2 Preferred design: keep `web_fetch`, add stronger semantics

Either upgrade the existing tool in-place or add a new tool named `web_read`.

I lean toward **upgrading `web_fetch` in-place** to avoid confusing the model with two near-duplicate tools. If adding `web_read`, mark `web_fetch` as legacy in descriptions/guidelines.

### 2.3 Proposed parameters

```ts
const WebFetchParams = Type.Object({
  url: Type.String({ description: "URL to fetch" }),

  mode: Type.Optional(StringEnum([
    "readable",  // current Readability-first behavior
    "markdown",  // preserve HTML structure more aggressively
    "text",      // plain text extraction
    "raw"        // raw HTML/text, truncated
  ] as const)),

  maxLength: Type.Optional(Type.Integer({ minimum: 100, maximum: 1_000_000 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 100, maximum: 1_000_000 })),

  cache: Type.Optional(Type.Boolean({ description: "Use/read local cache. Default true." })),
  refresh: Type.Optional(Type.Boolean({ description: "Ignore cache and refetch." })),

  includeLinks: Type.Optional(Type.Boolean({ description: "Include extracted links in details/output." })),
  includeMetadata: Type.Optional(Type.Boolean({ description: "Include title, author, site, canonical URL, etc." })),
});
```

### 2.4 Output behavior

Copy the `pdf_read` pattern:

- Always extract the **full content locally** if possible.
- If output is truncated, write full output to a temp/cache file.
- Return the path clearly:

```md
---
*[Content truncated: 8,000 of ~32,000 lines (150KB of 1.2MB). Full output saved to: /tmp/pi-web-fetch-.../content.md]*
```

Details should include:

```ts
type WebFetchDetails = {
  url: string;
  finalUrl: string;
  title?: string;
  siteName?: string;
  contentType?: string;
  statusCode: number;
  rawBytes: number;
  extractedBytes: number;
  truncated: boolean;
  fullOutputPath?: string;
  cachePath?: string;
  extractionMode: "readable" | "markdown" | "text" | "raw";
  warnings: string[];
  links?: Array<{ text: string; href: string }>;
};
```

### 2.5 Chunking support

For long pages, the model should be able to ask for later chunks:

```json
{
  "url": "https://example.com/long-doc",
  "offset": 150000,
  "limit": 150000
}
```

This mirrors `read`’s offset/limit behavior and avoids “fetch once, lose tail forever.”

### 2.6 Extraction backends

Potential extraction strategy:

1. Fetch with normal browser-ish headers.
2. If `content-type` is PDF, throw a helpful error or return guidance to use `pdf_read`.
3. If plain text / markdown / JSON, preserve as-is.
4. For HTML:
   - parse with `linkedom`;
   - remove scripts/styles/nav/ads if using fallback;
   - try Readability;
   - if Readability is sparse, fallback to structured HTML-to-markdown;
   - optionally use external tools if installed:
     - `pandoc -f html -t gfm`
     - `lynx -dump -nolist`
     - `w3m -dump`
5. Optional hostile-page fallback:
   - Jina reader endpoint: `https://r.jina.ai/http://r.jina.ai/http://...` style reader service.
   - Make this opt-in or fallback-only to avoid surprising external calls.

### 2.7 Cache design

Use Pi agent cache:

```ts
join(getAgentDir(), "cache", "web-fetch")
```

Cache by SHA-256 of final URL + mode:

```text
~/.pi/agent/cache/web-fetch/
  ab/cd/<hash>.json   # metadata
  ab/cd/<hash>.md     # extracted markdown
  ab/cd/<hash>.html   # optional raw HTML if not huge
```

Cache metadata:

```json
{
  "url": "...",
  "finalUrl": "...",
  "fetchedAt": 178...,
  "contentType": "text/html",
  "title": "...",
  "mode": "readable",
  "rawBytes": 123456,
  "extractedBytes": 54321
}
```

### 2.8 Prompt guidelines

Update tool prompt guidelines:

- Use `web_fetch` for readable web pages.
- If output is truncated, use the returned `fullOutputPath` or refetch with `offset`/`limit`.
- For PDFs, use `pdf_info`/`pdf_read` instead.
- For API/raw JSON, use `bash` + `curl` or `web_fetch` mode `raw`.
- Cite the final URL, not just the originally requested URL.

### 2.9 Tests / manual checks

Add `/web-fetch-test` cases for:

- normal article;
- docs page with code blocks;
- long page that truncates;
- plain text file;
- raw GitHub URL;
- PDF URL;
- non-HTML API endpoint;
- timeout/abort.

---

## 3. Add paper-native tools

The current research workflow uses generic web search + PDF read. That works, but paper discovery should be first-class.

### 3.1 `arxiv_search`

Tool: search arXiv API.

Parameters:

```ts
{
  query: string;
  maxResults?: number; // default 10, max 50
  sortBy?: "relevance" | "lastUpdatedDate" | "submittedDate";
  sortOrder?: "ascending" | "descending";
  categories?: string[]; // optional cs.DC, cs.OS, cs.SE, etc.
}
```

Output:

```md
arXiv results for: workload buoyancy kubernetes

1. Workload Buoyancy: Keeping Apps Afloat...
   arXiv: 2602.22852
   URL: https://arxiv.org/abs/2602.22852
   PDF: https://arxiv.org/pdf/2602.22852
   Authors: ...
   Published: ...
   Summary: ...
```

Details should include structured records.

Implementation notes:

- arXiv API returns Atom XML.
- Add `fast-xml-parser` as a direct dependency or use a tiny XML parser.
- Cache results lightly if needed.

### 3.2 `arxiv_read`

Given an arXiv ID:

- fetch metadata;
- fetch PDF;
- optionally run `pdf_info`/`pdf_read` internally or return PDF URL for model to call `pdf_read`.

Prefer initially:

```ts
arxiv_read({ id: "2602.22852", pages?: "1-3", mode?: "text|auto|ocr|both" })
```

It can reuse the PDF logic by factoring shared PDF functions out of `pdf-read.ts`, or simply download and call `pdftotext` directly.

### 3.3 `doi_lookup`

Lookup DOI via Crossref:

```ts
{
  doi: string;
}
```

Return:

- title;
- authors;
- year;
- venue;
- publisher;
- URL;
- abstract if available;
- license/open-access info if available;
- BibTeX if easy.

### 3.4 `openalex_search` or `semantic_scholar_search`

Useful for broader literature discovery and citation graph work.

I would start with **OpenAlex** because it is open and keyless.

Tool: `openalex_search`

Parameters:

```ts
{
  query: string;
  maxResults?: number;
  fromYear?: number;
  toYear?: number;
  openAccessOnly?: boolean;
  sort?: "relevance" | "cited_by_count" | "publication_date";
}
```

Output fields:

- title;
- authors;
- year;
- venue;
- DOI;
- OpenAlex ID;
- cited-by count;
- abstract if reconstructed;
- open access URL / PDF URL;
- concepts/topics.

### 3.5 `bibtex_fetch`

Given DOI/arXiv/title, return BibTeX.

Possible sources:

- Crossref `/works/{doi}/transform/application/x-bibtex`
- arXiv metadata to BibTeX template
- Semantic Scholar if available

This will matter once paper writing starts.

---

## 4. Add research capture tools

### 4.1 `paper_note_create`

Purpose: write standardized paper notes into `~/Workspace/research/papers/...`.

Parameters:

```ts
{
  topic: string;           // e.g. "multi-tenant-performance"
  slug?: string;           // optional override
  title: string;
  authors?: string;
  venue?: string;
  year?: string | number;
  link?: string;
  pdf?: string;
  tags?: string[];
  problem: string;
  approach: string;
  evaluation?: string;
  limitations?: string;
  relevance: string;
}
```

Writes:

```text
~/Workspace/research/papers/{topic}/{slug}.md
```

Format:

```md
# Paper Title

**Authors:** ...
**Venue:** ...
**Link:** ...
**PDF:** ...
**Topics:** `tag1`, `tag2`

## Problem
...

## Approach / Key Insight
...

## Evaluation
...

## Limitations
...

## Relevance to my work
...

---
*Read: YYYY-MM-DD*
```

Implementation requirements:

- Use `withFileMutationQueue`.
- Create directories recursively.
- Refuse overwrite unless `overwrite: true`.
- Normalize slug.
- Run from any cwd, but default research repo path to `/home/tchaudhry/Workspace/research`.
- Config env var: `RESEARCH_REPO_DIR`.

### 4.2 `research_log_append`

Append dated entries to `~/Workspace/research/log.md`.

Parameters:

```ts
{
  heading?: string;
  summary: string;
  bullets?: string[];
  next?: string[];
}
```

Output:

```md
---

## YYYY-MM-DD

### Heading

Summary...

- bullet

**Next:**
- ...
```

Use cases:

- end-of-session capture;
- after a paper reading;
- after a design decision.

### 4.3 `collaborator_note_update`

Update `notes/collaborator-targets.md` with status changes.

Parameters:

```ts
{
  name: string;
  status: "candidate" | "emailed" | "responded" | "active" | "parked";
  note: string;
  date?: string;
}
```

This can be a later tool; simple file edits may be enough for now.

---

## 5. Add a research-session extension

### 5.1 Purpose

When Pi runs inside `~/Workspace/research`, it should feel like a research assistant, not a generic coding agent.

### 5.2 New file

```text
extensions/research/research-session.ts
```

Add to `package.json` only when ready.

### 5.3 Behavior on session start

If `ctx.cwd` is inside `/home/tchaudhry/Workspace/research`:

- read last ~80 lines of `log.md`;
- detect current focus from `README.md` / `notes/starting-context.md`;
- set footer/status:

```text
Research: collaborator | Starlit Labs | PhD open
```

- optionally show a compact notification:

```text
Research context loaded: log.md tail + starting-context.md. Use /research-next or /paper-note.
```

Do not spam every reload; only on startup or first session entry.

### 5.4 Commands

#### `/research-next`

Show extracted next actions from `log.md`, `notes/collaborator-targets.md`, and perhaps `projects/*/README.md`.

#### `/research-log`

Open an editor prompt for a log entry, then append to `log.md`.

#### `/paper-note`

Launch a guided editor/template to create a paper note.

#### `/collab-email`

Generate a collaborator outreach email based on:

- target person;
- relevant paper;
- artifact;
- proposed contribution;
- Starlit Labs affiliation.

This command can prefill the editor, not send email.

#### `/research-status`

Show:

- current repo dirty status;
- latest log date;
- active paper/project notes;
- current model/tools.

### 5.5 Prompt injection

Use `before_agent_start` to append research-specific guidance **only in research repo**:

```md
## Research Mode Context

You are assisting Tanmay with independent systems research under Starlit Labs.
Current status: not enrolled in a PhD; formal PhD remains open as later structure.
Default persona: collaborator unless user asks for librarian.
Preserve citations, paper IDs, hypotheses, evaluation ideas, and collaborator actions.
When reading papers, capture notes in the repo format if asked.
```

This should be short. The detailed context stays in repo files and skills.

### 5.6 Status widget

Optional but useful:

```text
Research active
Next: Email Cristian | arXiv Axiom | buoyancy collector
```

Do not make it too noisy.

---

## 6. Custom research compaction

### 6.1 Why

Long research sessions have different preservation needs than coding sessions. Default compaction may lose:

- citations;
- paper IDs;
- exact claims;
- evaluation methodology;
- open questions;
- collaborator names;
- decisions about PhD/research strategy.

### 6.2 New extension

Could be part of:

```text
extensions/research/research-session.ts
```

or separate:

```text
extensions/research/research-compaction.ts
```

### 6.3 Behavior

Hook `session_before_compact` when inside research repo.

Use a cheap/fast model, e.g. `ollama-cloud/deepseek-v4-flash` or another configured model, to produce structured summaries.

### 6.4 Summary format

```md
## Research Goal
[What the session is trying to accomplish]

## Current Thesis / Hypotheses
- ...

## Sources Read
- [Title](url) — key point, relevance
- arXiv:xxxx.xxxxx — key point

## Claims & Evidence
- Claim: ...
  Evidence: ...
  Source: ...

## Methods / Evaluation Ideas
- ...

## Decisions Made
- **Decision:** rationale

## Open Questions / Skepticism
- ...

## Collaborator / Outreach Actions
- Person — next action

## Files Touched
<read-files>
...
</read-files>

<modified-files>
...
</modified-files>

## Next Steps
1. ...
```

### 6.5 Design note

The summary should be faithful and citation-preserving, not motivational. It should prefer exact IDs/URLs over prose.

---

## 7. Add systems-research skills

Current skill `deep-research` is generic and web-oriented. Keep it, but add narrower skills.

### 7.1 `skills/paper-reading/SKILL.md`

Use when reading a research paper.

Instructions:

1. Run `pdf_info` first for PDFs.
2. Read title/abstract/introduction/conclusion first.
3. Extract:
   - problem;
   - core insight;
   - system design;
   - assumptions;
   - evaluation setup;
   - baselines;
   - metrics;
   - threats;
   - what can be reused in Tanmay’s work.
4. Write a note if asked, using `paper_note_create` or direct file write.
5. Be skeptical: identify missing baselines, weak claims, external validity gaps.

Description:

```yaml
description: Deep reading workflow for systems research papers. Use when analyzing PDFs, arXiv papers, conference papers, or papers that may become notes in ~/Workspace/research.
```

### 7.2 `skills/systems-research/SKILL.md`

Use for designing research projects.

Should encode:

- contribution framing;
- related work mapping;
- artifact-first research;
- evaluation design;
- workshop vs conference scope;
- systems venue expectations;
- Tanmay’s current research narrative:
  - queryable;
  - safe;
  - temporally aware infrastructure.

Description:

```yaml
description: Systems research collaborator workflow for turning infrastructure artifacts into research questions, experiments, and papers. Use for Axiom, Hawkeye, Saga, eBPF, Kubernetes, observability, and Starlit Labs research planning.
```

### 7.3 `skills/collaborator-outreach/SKILL.md`

Use for emails to researchers.

Core rule:

> Propose a paper/artifact, not a chat.

Should include template:

```md
Subject: Extending <paper/system> to <production setting>

Hi <Name>,

I’m Tanmay, ...
I read <paper> and built/have <artifact>.
The concrete extension I see is <specific contribution>.
Would you be open to a short discussion about co-authoring / validating this direction?

Preprint/artifact: ...
```

Should include warnings:

- no generic “I admire your work” emails;
- keep short;
- lead with artifact;
- ask for specific feedback/intro.

### 7.4 `skills/research-synthesis/SKILL.md`

A stricter variant of `deep-research` for literature surveys.

Differences from web deep-research:

- prioritize papers over blogs;
- require BibTeX/DOI/arXiv IDs;
- classify sources by venue and contribution;
- output related-work map;
- produce “gap table.”

---

## 8. Add prompt templates

### 8.1 `/research-session`

File:

```text
prompts/research-session.md
```

Purpose: start a research session in `~/Workspace/research`.

Prompt should say:

```md
Read AGENTS.md, README.md, notes/starting-context.md, and the tail of log.md.
Then summarize:
1. current research focus;
2. open next actions;
3. what you need from me.
Default to collaborator persona.
```

### 8.2 `/paper`

```text
prompts/paper.md
```

Arguments:

```yaml
argument-hint: "<PDF path | URL | arXiv ID>"
```

Prompt:

```md
Use the paper-reading skill. Read this paper, produce a structured analysis, and ask whether to capture it as a note.
```

### 8.3 `/lit-review`

```text
prompts/lit-review.md
```

Prompt:

```md
Use systems-research + research-synthesis workflow to map literature for: $ARGUMENTS.
Prioritize papers, venues, citations, open-source artifacts, and gaps.
```

### 8.4 `/email-collaborator`

Prompt:

```md
Draft a concise collaborator outreach email for: $ARGUMENTS.
Use the collaborator-outreach skill. Lead with artifact + concrete paper idea. Do not send anything.
```

### 8.5 `/experiment-design`

Prompt:

```md
Design an experiment for: $ARGUMENTS.
Include hypothesis, independent/dependent variables, baselines, datasets, metrics, threats to validity, and smallest publishable version.
```

### 8.6 `/review-paper-draft`

Prompt:

```md
Review the paper draft or outline in $ARGUMENTS.
Be terse and honest. Focus on contribution clarity, related work gaps, methodology weakness, evaluation validity, and reviewer objections.
```

This matches Tanmay’s preferred direct-feedback style.

---

## 9. Add source bundling / research source tools

### 9.1 `source_bundle`

Tool that accepts multiple URLs and fetches them with caching/chunking.

Parameters:

```ts
{
  urls: string[];
  mode?: "readable" | "markdown" | "text";
  maxPerSource?: number;
  output?: "summary" | "full";
}
```

Output:

- source matrix;
- extracted titles;
- per-source paths to full cached content;
- warnings for failed/truncated pages.

Why useful:

- deep research often fetches 5–10 sources;
- model should not manually juggle many `web_fetch` calls;
- failed/truncated sources should be tracked centrally.

### 9.2 `source_matrix_create`

Given a set of sources and claims, create a markdown table:

```md
| Claim | Source | Evidence | Confidence | Notes |
|---|---|---|---|---|
```

This can be a prompt first, tool later.

---

## 10. Add subagents eventually, not first

Pi’s subagent example is powerful, but adding it too early may create complexity before ingestion/capture is fixed.

Recommended later structure:

```text
extensions/subagent/...
agents/
  librarian.md
  paper-reader.md
  methods-reviewer.md
  collaborator-scout.md
  artifact-planner.md
prompts/
  scout-papers.md
  read-and-note.md
  artifact-to-paper.md
```

### 10.1 `librarian` agent

Tools:

```yaml
tools: searxng_search, web_fetch, arxiv_search, openalex_search, pdf_info, pdf_read
```

Role:

- find relevant papers;
- return compact annotated bibliography;
- no file writes by default.

### 10.2 `paper-reader` agent

Tools:

```yaml
tools: pdf_info, pdf_read, web_fetch, read
```

Role:

- deep read a single paper;
- extract evaluation and limitations;
- produce structured note candidate.

### 10.3 `methods-reviewer` agent

Tools:

```yaml
tools: read, grep, find, ls
```

Role:

- attack methodology;
- identify missing baselines;
- state what would convince a skeptical reviewer.

### 10.4 `collaborator-scout` agent

Tools:

```yaml
tools: searxng_search, web_fetch, arxiv_search, openalex_search
```

Role:

- map labs/people;
- rank warm vs cold outreach;
- identify concrete read→extend→email path.

### 10.5 `artifact-planner` agent

Tools:

```yaml
tools: read, grep, find, ls, bash
```

Role:

- inspect existing code/artifacts;
- propose smallest prototype that supports a paper.

---

## 11. Add model/tool presets

A preset extension could make switching modes faster.

Possible presets:

### 11.1 `/preset research`

- model: best long-context reasoning model available;
- tools: read, bash, searxng_search, web_fetch, pdf_info, pdf_read;
- thinking: high;
- skills: paper-reading/systems-research if using prompts.

### 11.2 `/preset coding`

- tools: read, bash, edit, write;
- model: strongest coding model;
- thinking: medium/high.

### 11.3 `/preset cheap`

- model: local QE93 or cheaper cloud;
- tools: read, grep, find, ls, bash;
- thinking: low/medium.

### 11.4 `/preset paper`

- tools: searxng_search, web_fetch, pdf_info, pdf_read, arxiv_search, openalex_search, paper_note_create;
- thinking: high.

This can be built from Pi’s `preset.ts` example.

---

## 12. Add repo hygiene nudges

### 12.1 Research repo guard

When in `~/Workspace/research`:

- on session start:
  - optionally show dirty status;
  - show latest log date;
  - warn if branch behind remote? maybe too slow/noisy.
- on session shutdown:
  - if dirty, notify:

```text
Research repo has uncommitted changes. Consider committing or logging session outcomes.
```

Do **not** auto-commit by default.

### 12.2 Brain repo guard

When in `~/Workspace/brain`:

- remind to `git pull --rebase` before changes;
- warn if `topics/.hashes.json` was accidentally truncated;
- after changing topics, suggest overview regeneration;
- on shutdown, remind to capture/commit if dirty.

Do not auto-write to brain unless explicitly asked.

### 12.3 Pi-extensions repo guard

When in `~/Workspace/pi-extensions`:

- after changing extensions, remind:
  - `npm run check`
  - `/reload` inside Pi
  - `pi install /home/tchaudhry/Workspace/pi-extensions` if needed.

---

## 13. Improve `deep-research` skill

Current `deep-research` is solid but generic.

Suggested changes:

1. Mention `pdf_info` and `pdf_read` in tools used.
2. Add paper-specific branch:
   - if topic is academic/literature, prioritize arXiv/OpenAlex/DOI tools once implemented.
3. Add truncation handling:
   - if `web_fetch` truncates, read full output path or chunk.
4. Add “source quality labels”:
   - primary source;
   - peer-reviewed paper;
   - preprint;
   - blog;
   - vendor docs;
   - SEO/low trust.
5. Add “claim table” for technical research.
6. Add “do not over-cite obvious synthesis, but cite every factual claim.”

---

## 14. Suggested implementation sequence

### Phase 0 — housekeeping (small, safe)

- [ ] Update `AGENTS.md` to match `package.json`.
- [ ] Decide/document `zai-coding.ts` status.
- [ ] Add `docs/README.md` if docs grow.

### Phase 1 — fix source ingestion

- [ ] Upgrade `web_fetch`:
  - [ ] pass AbortSignal;
  - [ ] save full output on truncation;
  - [ ] add `fullOutputPath`;
  - [ ] add `offset`/`limit`;
  - [ ] add extraction modes;
  - [ ] detect PDFs;
  - [ ] add cache.
- [ ] Update README with new web fetch behavior.
- [ ] Add manual test command cases.

### Phase 2 — paper tools

- [ ] Add `extensions/research/arxiv.ts` with `arxiv_search`.
- [ ] Add `doi_lookup`.
- [ ] Add `openalex_search`.
- [ ] Update package manifest.
- [ ] Add README docs.

### Phase 3 — capture tools

- [ ] Add `paper_note_create`.
- [ ] Add `research_log_append`.
- [ ] Add commands `/paper-note` and `/research-log` if useful.

### Phase 4 — research session behavior

- [ ] Add `extensions/research/research-session.ts`.
- [ ] Inject concise research context in `~/Workspace/research` only.
- [ ] Add `/research-next`, `/research-status`, `/collab-email`.
- [ ] Add footer/status indicator.

### Phase 5 — skills/prompts

- [ ] Add `paper-reading` skill.
- [ ] Add `systems-research` skill.
- [ ] Add `collaborator-outreach` skill.
- [ ] Add prompt templates:
  - [ ] `research-session.md`
  - [ ] `paper.md`
  - [ ] `lit-review.md`
  - [ ] `email-collaborator.md`
  - [ ] `experiment-design.md`
  - [ ] `review-paper-draft.md`

### Phase 6 — research compaction

- [ ] Add custom compaction for research repo.
- [ ] Preserve citations, hypotheses, paper IDs, methods, next actions.
- [ ] Test with a long paper-reading session.

### Phase 7 — subagents

- [ ] Port/adapt Pi subagent example.
- [ ] Add user-level agents:
  - [ ] librarian
  - [ ] paper-reader
  - [ ] methods-reviewer
  - [ ] collaborator-scout
  - [ ] artifact-planner
- [ ] Add workflow prompts.

---

## 15. Strong recommendation: do not implement everything at once

Best first pick:

> Upgrade `web_fetch` into a real long-form `web_read`-quality tool.

Why:

- It fixes a pain already observed.
- It improves every other research workflow.
- It is contained and testable.
- It mirrors the already-good `pdf_read` truncation behavior.
- It avoids adding new complexity before ingestion is reliable.

Second pick:

> Add `paper_note_create` after paper search/read tools.

This turns research reading into durable repo artifacts.

Third pick:

> Add research-session extension + skills.

This turns Pi into the Starlit Labs research cockpit.

---

## 16. Design principles for this Pi package

1. **Artifact-first.** Tools should produce files/notes/logs, not just chat output.
2. **Citation-preserving.** Never lose URLs, DOIs, arXiv IDs, page numbers, or exact paper titles.
3. **Chunkable by default.** Long sources must support continuation.
4. **No surprise autonomy.** Nudge to commit/log/capture, but do not auto-commit or auto-email by default.
5. **Research starts now, PhD remains optional.** Prompt context should preserve this exact framing.
6. **Starlit Labs only.** No SagaLabs naming drift.
7. **Build small composable tools.** Prefer reliable ingestion/capture primitives over giant magical workflows.
8. **Use Pi extension hooks surgically.** Context injection and compaction are powerful; keep them repo-scoped and concise.

---

## 17. Appendix: possible file layout after implementation

```text
pi-extensions/
├── docs/
│   ├── README.md
│   ├── research-workflow-improvement-plan.md
│   ├── web-read-design.md
│   ├── paper-tools-design.md
│   └── research-session-extension-design.md
├── extensions/
│   ├── fetch/
│   │   └── web-fetch.ts              # upgraded
│   ├── pdf/
│   │   └── pdf-read.ts
│   ├── providers/
│   │   ├── ollama-cloud.ts
│   │   ├── qe93-ollama.ts
│   │   └── zai-coding.ts             # optional/dormant or loaded
│   ├── research/
│   │   ├── arxiv.ts
│   │   ├── openalex.ts
│   │   ├── doi.ts
│   │   ├── capture.ts
│   │   ├── research-session.ts
│   │   └── research-compaction.ts
│   └── search/
│       └── searxng.ts
├── skills/
│   ├── deep-research/
│   │   └── SKILL.md
│   ├── paper-reading/
│   │   └── SKILL.md
│   ├── systems-research/
│   │   └── SKILL.md
│   └── collaborator-outreach/
│       └── SKILL.md
├── prompts/
│   ├── research.md
│   ├── research-session.md
│   ├── paper.md
│   ├── lit-review.md
│   ├── email-collaborator.md
│   ├── experiment-design.md
│   └── review-paper-draft.md
└── themes/
```

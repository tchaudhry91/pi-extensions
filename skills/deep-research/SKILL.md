---
name: deep-research
description: Multi-round web research methodology. Searches from multiple angles, fetches full page contents, cross-references findings, identifies gaps, and produces a synthesized markdown document with inline citations. Use for deep topic exploration, literature surveys, technology comparisons, or any task requiring thorough web-sourced information synthesis.
metadata:
  tools: searxng_search, arxiv_search, openalex_search, web_read, pdf_info, pdf_read, write, read, bash
---

# Deep Research

Multi-round web research methodology. Goes deep: multiple search angles, full source extraction, cross-referencing, gap analysis, and synthesized output.

## Tools Used

- **`searxng_search`** — web search (supports categories, time ranges, languages)
- **`arxiv_search`** — academic preprint discovery with arXiv IDs, abstracts, categories, and PDF links (no login/API key)
- **`openalex_search`** — broader scholarly metadata search with citation counts, DOI/venue info, abstracts, topics, related-work IDs, and OA/PDF links (anonymous when budget is available; optional `OPENALEX_API_KEY` improves budget)
- **`web_read`** — extract readable content from URLs (modes, caching, `offset`/`limit` chunking)
- **`pdf_info` / `pdf_read`** — inspect and read PDFs from arXiv or other sources
- **`write`** — write the final document to disk
- **`read`** / **`bash`** — as needed for context (also use `read` on a truncated source's `fullOutputPath`/`cachePath` returned by `web_read`)

## Research Methodology

### Phase 1: Query Planning

Before searching, decompose the topic into **3-5 distinct angles**. Each angle should use different terminology, focus on different aspects, or target different source types. Examples for a topic:

| Angle | Query | Why |
|-------|-------|-----|
| Technical | "topic architecture internals" | Developer docs, RFCs |
| Practical | "topic real-world use cases 2025" | Case studies, blogs |
| Critical | "topic limitations drawbacks" | Balanced perspective |
| Comparative | "topic vs alternative comparison" | Context, trade-offs |
| News/Recent | "topic latest developments 2025" | Timeliness, trends |

Run all general-web queries in parallel with `searxng_search`, 5-8 results each. Use time ranges when recency matters. For academic/literature topics, also run `arxiv_search` using 2-4 vocabulary variants for recent preprints and `openalex_search` for broader citation-aware discovery. Start broad, then refine based on terms discovered in paper titles/abstracts. Remember that arXiv papers are preprints and OpenAlex is metadata aggregation; neither replaces reading the actual paper.

### Phase 2: Source Triage

From search results, select sources for deep reading. Prioritize:
1. **Primary sources**: official docs, research papers, specs, original announcements
2. **Authoritative secondary**: respected publications, well-known authors, .edu/.gov domains
3. **Diverse perspectives**: different viewpoints, contrarian takes, practical vs theoretical

For `arxiv_search` results, triage by title, abstract, date, categories, venue/comment field, and relevance to the user's question. For `openalex_search` results, triage by title, abstract, year, venue/source, citation count, DOI, open-access/PDF availability, and topic/concept fit. Do not treat arXiv presence, OpenAlex metadata, or citation count as validation; use `pdf_info`/`pdf_read` or `web_read` on promising papers before making detailed claims.

Skip: SEO spam, content farms, aggregators that just link elsewhere, sources older than relevance cutoff unless historical context is needed.

Mark which sources you're fetching and why. If a search returns poor results, note it and adjust queries.

### Phase 3: Deep Extraction

Fetch selected sources with `web_read` (use `mode: "markdown"` for docs/code-heavy pages). Extract:
- Key claims and findings
- Data points, numbers, statistics
- Methodologies described
- Agreements and contradictions with other sources
- Unanswered questions or acknowledged gaps

Fetch in parallel batches of 3-5 to manage throughput. If a fetch fails (timeout, paywall, error), note it and move on — don't retry more than once. If `web_read` truncates a long source, continue with the returned `fullOutputPath`/`cachePath` via `read`, or refetch with a larger `offset`/`limit`.

### Phase 4: Gap Analysis & Follow-up

After the first round, identify:
- Questions raised but not answered
- Areas where sources conflict (need more data to resolve)
- Topics mentioned but not explored
- Missing perspectives or source types

Generate 2-4 **targeted follow-up queries** addressing specific gaps. Run search → triage → extract for these. One follow-up round is typical; if substantial gaps remain after two rounds, flag them in the output as "areas for further research."

### Phase 5: Synthesis & Output

Synthesize all findings into a coherent document. Do NOT just list sources or summarize each one individually. The document should:

- **Integrate** information across sources — connect ideas, show relationships
- **Resolve conflicts** where possible — note when sources disagree and why
- **Prioritize** — lead with the most important findings, not the most detailed
- **Be self-contained** — someone should understand the topic without reading the sources

## Citation Convention

Use **inline markdown links** directly at the point of information:

```markdown
According to the specification, the protocol uses UDP by default [RFC 9000](https://www.rfc-editor.org/rfc/rfc9000). However, some implementations also support TCP fallback [Implementation Guide](https://example.com/guide).
```

Do NOT use footnotes or a separate "References" section as the primary citation method. A "Sources" section at the end listing all URLs with brief descriptions is useful as a supplement.

## Output Format

Write the document using the `write` tool. Structure is fluid — let the content drive the organization. A useful default:

```markdown
# Topic Title

> Brief 1-2 sentence summary of what this document covers.

## Context / Background
(if needed — what problem does this solve, why does it matter)

## Key Findings
(integrated synthesis; the bulk of the document)

## Perspectives & Debates
(if sources disagree, lay out the landscape)

## Gaps & Further Research
(what we don't know yet, what to investigate next)

## Sources
(bulleted list of all URLs with one-line descriptions)
```

But adapt freely — not every topic fits this structure.

## File Naming

Default output path: `research/<topic-slug>.md` in the workspace. Use lowercase, hyphens, keep it concise. Examples: `research/gdpr-compliance.md`, `research/rust-async-runtimes.md`, `research/gpt5-vs-claude4.md`.

## Interactive Mode

When running in interactive mode, pause between phases and present findings:

- **After Phase 1 (query planning)**: show the planned queries, ask for adjustments
- **After Phase 2 (source triage)**: show selected sources with reasons, ask for approval
- **After Phase 3 (deep extraction)**: show key findings summary, ask if depth is sufficient
- **After Phase 4 (gap analysis)**: show gaps and follow-up queries, ask whether to proceed
- **After Phase 5 (synthesis)**: present the final document, ask for edits

Keep interactive checkpoints efficient — one or two questions, not a full discussion.

## Error Handling

- **No search results**: flag in output, suggest alternative search terms
- **Fetch failures**: note the URL and reason, move on. Don't let one bad fetch stall the entire research.
- **Conflicting information**: document both sides with citations, note which source seems more authoritative and why.
- **Timeouts / rate limits**: back off, reduce parallelism, continue with what you have.

## Quality Checklist

Before writing the final document, verify:
- [ ] At least 3 distinct sources from at least 2 different domains
- [ ] At least one source presents a critical/contrarian view if one exists
- [ ] Citations are inline and every major claim has a source
- [ ] The document reads as an integrated synthesis, not a list of summaries
- [ ] Gaps and limitations are acknowledged
- [ ] No hallucinated facts without a source

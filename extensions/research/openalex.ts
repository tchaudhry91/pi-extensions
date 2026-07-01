import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const OPENALEX_BASE_URL = "https://api.openalex.org";
const OPENALEX_MAILTO_ENV = "OPENALEX_MAILTO";
const OPENALEX_API_KEY_ENV = "OPENALEX_API_KEY";
const MAX_RESULTS_LIMIT = 50;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_PAGE = 1;
const DEFAULT_SORT = "relevance";

const OpenAlexSearchParams = Type.Object({
  query: Type.String({ description: "Search query for OpenAlex works/papers." }),
  maxResults: Type.Optional(
    Type.Integer({
      description: `Maximum number of works to return. Defaults to ${DEFAULT_MAX_RESULTS}, capped at ${MAX_RESULTS_LIMIT}.`,
      minimum: 1,
      maximum: MAX_RESULTS_LIMIT,
    }),
  ),
  page: Type.Optional(Type.Integer({ description: "Result page for pagination. Defaults to 1.", minimum: 1 })),
  fromYear: Type.Optional(Type.Integer({ description: "Earliest publication year to include, e.g. 2020.", minimum: 1800, maximum: 3000 })),
  toYear: Type.Optional(Type.Integer({ description: "Latest publication year to include, e.g. 2026.", minimum: 1800, maximum: 3000 })),
  openAccessOnly: Type.Optional(Type.Boolean({ description: "Only include works OpenAlex marks as open access. Default false." })),
  sort: Type.Optional(
    StringEnum(["relevance", "cited_by_count", "publication_date"] as const, {
      description: "Sort results by relevance, citation count, or publication date. Defaults to relevance.",
    }),
  ),
});

type OpenAlexSearchInput = Static<typeof OpenAlexSearchParams>;
type OpenAlexSort = "relevance" | "cited_by_count" | "publication_date";

type OpenAlexAuthor = {
  author?: {
    display_name?: unknown;
    id?: unknown;
  };
  institutions?: unknown;
  countries?: unknown;
};

type OpenAlexLocation = {
  landing_page_url?: unknown;
  pdf_url?: unknown;
  source?: {
    display_name?: unknown;
    id?: unknown;
    host_organization_name?: unknown;
    type?: unknown;
  } | null;
};

type OpenAlexTopic = {
  display_name?: unknown;
  score?: unknown;
  subfield?: { display_name?: unknown } | null;
  field?: { display_name?: unknown } | null;
  domain?: { display_name?: unknown } | null;
};

type OpenAlexConcept = {
  display_name?: unknown;
  score?: unknown;
  level?: unknown;
};

type OpenAlexWork = {
  id?: unknown;
  doi?: unknown;
  title?: unknown;
  display_name?: unknown;
  publication_year?: unknown;
  publication_date?: unknown;
  type?: unknown;
  cited_by_count?: unknown;
  authorships?: unknown;
  primary_location?: OpenAlexLocation | null;
  best_oa_location?: OpenAlexLocation | null;
  open_access?: {
    is_oa?: unknown;
    oa_status?: unknown;
    oa_url?: unknown;
    any_repository_has_fulltext?: unknown;
  } | null;
  abstract_inverted_index?: unknown;
  topics?: unknown;
  concepts?: unknown;
  referenced_works_count?: unknown;
  referenced_works?: unknown;
  related_works?: unknown;
};

type OpenAlexResponse = {
  meta?: {
    count?: unknown;
    db_response_time_ms?: unknown;
    page?: unknown;
    per_page?: unknown;
    cost_usd?: unknown;
  };
  results?: unknown;
};

type PaperAuthor = {
  name: string;
  id?: string;
};

type PaperTopic = {
  name: string;
  score?: number;
  field?: string;
  subfield?: string;
  domain?: string;
};

type OpenAlexPaper = {
  id: string;
  title: string;
  doi?: string;
  doiUrl?: string;
  year?: number;
  publicationDate?: string;
  type?: string;
  authors: PaperAuthor[];
  venue?: string;
  venueType?: string;
  landingPageUrl?: string;
  pdfUrl?: string;
  openAccess: boolean;
  openAccessStatus?: string;
  openAccessUrl?: string;
  citedByCount?: number;
  referencedWorksCount?: number;
  abstract?: string;
  topics: PaperTopic[];
  concepts: string[];
  referencedWorks: string[];
  relatedWorks: string[];
};

type OpenAlexSearchDetails = {
  baseUrl: string;
  query: string;
  page: number;
  maxResults: number;
  fromYear?: number;
  toYear?: number;
  openAccessOnly: boolean;
  sort: OpenAlexSort;
  filter?: string;
  totalResults?: number;
  responseTimeMs?: number;
  costUsd?: number;
  apiKeyUsed: boolean;
  resultCount: number;
  results: OpenAlexPaper[];
  truncation?: TruncationResult;
  fullOutputPath?: string;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeDoi(raw: unknown): { doi?: string; doiUrl?: string } {
  const value = asString(raw);
  if (!value) return {};
  const stripped = value.replace(/^https?:\/\/doi\.org\//i, "").replace(/^doi:/i, "");
  return { doi: stripped, doiUrl: `https://doi.org/${stripped}` };
}

function reconstructAbstract(index: unknown): string | undefined {
  if (!index || typeof index !== "object") return undefined;
  const words: Array<{ word: string; position: number }> = [];
  for (const [word, positions] of Object.entries(index as Record<string, unknown>)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (typeof position === "number" && Number.isFinite(position)) words.push({ word, position });
    }
  }
  if (words.length === 0) return undefined;
  words.sort((a, b) => a.position - b.position);
  return words.map((item) => item.word).join(" ").replace(/\s+/g, " ").trim();
}

function normalizeLocation(location: OpenAlexLocation | null | undefined): {
  landingPageUrl?: string;
  pdfUrl?: string;
  venue?: string;
  venueType?: string;
} {
  if (!location) return {};
  return {
    landingPageUrl: asString(location.landing_page_url),
    pdfUrl: asString(location.pdf_url),
    venue: asString(location.source?.display_name) ?? asString(location.source?.host_organization_name),
    venueType: asString(location.source?.type),
  };
}

function normalizeAuthors(value: unknown): PaperAuthor[] {
  return asArray(value)
    .map((item): PaperAuthor | undefined => {
      const authorship = item as OpenAlexAuthor;
      const name = asString(authorship.author?.display_name);
      if (!name) return undefined;
      return { name, id: asString(authorship.author?.id) };
    })
    .filter((author): author is PaperAuthor => Boolean(author));
}

function normalizeTopics(value: unknown): PaperTopic[] {
  return asArray(value)
    .map((item): PaperTopic | undefined => {
      const topic = item as OpenAlexTopic;
      const name = asString(topic.display_name);
      if (!name) return undefined;
      return {
        name,
        score: asNumber(topic.score),
        field: asString(topic.field?.display_name),
        subfield: asString(topic.subfield?.display_name),
        domain: asString(topic.domain?.display_name),
      };
    })
    .filter((topic): topic is PaperTopic => Boolean(topic))
    .slice(0, 8);
}

function normalizeConcepts(value: unknown): string[] {
  return asArray(value)
    .map((item) => asString((item as OpenAlexConcept).display_name))
    .filter((concept): concept is string => Boolean(concept))
    .slice(0, 8);
}

function normalizeStringArray(value: unknown, max = 10): string[] {
  return asArray(value).map(asString).filter((item): item is string => Boolean(item)).slice(0, max);
}

function normalizePaper(work: OpenAlexWork): OpenAlexPaper | undefined {
  const id = asString(work.id);
  const title = asString(work.title) ?? asString(work.display_name);
  if (!id || !title) return undefined;

  const primary = normalizeLocation(work.primary_location);
  const bestOa = normalizeLocation(work.best_oa_location);
  const doi = normalizeDoi(work.doi);
  const openAccess = work.open_access ?? undefined;

  return {
    id,
    title,
    doi: doi.doi,
    doiUrl: doi.doiUrl,
    year: asNumber(work.publication_year),
    publicationDate: asString(work.publication_date),
    type: asString(work.type),
    authors: normalizeAuthors(work.authorships),
    venue: primary.venue ?? bestOa.venue,
    venueType: primary.venueType ?? bestOa.venueType,
    landingPageUrl: primary.landingPageUrl ?? bestOa.landingPageUrl ?? doi.doiUrl,
    pdfUrl: primary.pdfUrl ?? bestOa.pdfUrl,
    openAccess: asBoolean(openAccess?.is_oa) ?? false,
    openAccessStatus: asString(openAccess?.oa_status),
    openAccessUrl: asString(openAccess?.oa_url) ?? bestOa.landingPageUrl ?? bestOa.pdfUrl,
    citedByCount: asNumber(work.cited_by_count),
    referencedWorksCount: asNumber(work.referenced_works_count),
    abstract: reconstructAbstract(work.abstract_inverted_index),
    topics: normalizeTopics(work.topics),
    concepts: normalizeConcepts(work.concepts),
    referencedWorks: normalizeStringArray(work.referenced_works, 10),
    relatedWorks: normalizeStringArray(work.related_works, 10),
  };
}

function sortParam(sort: OpenAlexSort): string | undefined {
  switch (sort) {
    case "cited_by_count":
      return "cited_by_count:desc";
    case "publication_date":
      return "publication_date:desc";
    case "relevance":
      return "relevance_score:desc";
  }
}

function buildFilters(params: OpenAlexSearchInput): string | undefined {
  const filters: string[] = [];
  if (params.openAccessOnly) filters.push("is_oa:true");
  if (params.fromYear) filters.push(`from_publication_date:${params.fromYear}-01-01`);
  if (params.toYear) filters.push(`to_publication_date:${params.toYear}-12-31`);
  return filters.length > 0 ? filters.join(",") : undefined;
}

function buildSearchUrl(params: OpenAlexSearchInput): { url: URL; page: number; maxResults: number; sort: OpenAlexSort; filter?: string } {
  const page = Math.max(params.page ?? DEFAULT_PAGE, 1);
  const maxResults = Math.min(Math.max(params.maxResults ?? DEFAULT_MAX_RESULTS, 1), MAX_RESULTS_LIMIT);
  const sort = (params.sort ?? DEFAULT_SORT) as OpenAlexSort;
  const filter = buildFilters(params);
  const mailto = process.env[OPENALEX_MAILTO_ENV]?.trim();
  const apiKey = process.env[OPENALEX_API_KEY_ENV]?.trim();

  const url = new URL("/works", OPENALEX_BASE_URL);
  url.searchParams.set("search", params.query);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per-page", String(maxResults));
  const sortValue = sortParam(sort);
  if (sortValue) url.searchParams.set("sort", sortValue);
  if (filter) url.searchParams.set("filter", filter);
  if (mailto) url.searchParams.set("mailto", mailto);
  if (apiKey) url.searchParams.set("api_key", apiKey);

  return { url, page, maxResults, sort, filter };
}

async function fetchOpenAlex(url: URL, signal?: AbortSignal): Promise<OpenAlexResponse> {
  const mailto = process.env[OPENALEX_MAILTO_ENV]?.trim();
  const response = await fetch(url, {
    signal,
    headers: {
      Accept: "application/json",
      "User-Agent": mailto ? `pi-openalex-search/1.0 (mailto:${mailto})` : "pi-openalex-search/1.0",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const keyHint = response.status === 429 || response.status === 503 ? ` Set ${OPENALEX_API_KEY_ENV} for a free API key if anonymous search is rate-limited.` : "";
    throw new Error(`OpenAlex request failed: HTTP ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 500)}` : ""}${keyHint}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(`OpenAlex returned ${contentType || "an unknown content type"}, expected JSON`);
  }

  return (await response.json()) as OpenAlexResponse;
}

function parseOpenAlexResponse(payload: OpenAlexResponse, maxResults: number): Pick<OpenAlexSearchDetails, "results" | "totalResults" | "responseTimeMs" | "costUsd"> {
  const results = asArray(payload.results)
    .map((item) => normalizePaper(item as OpenAlexWork))
    .filter((paper): paper is OpenAlexPaper => Boolean(paper))
    .slice(0, maxResults);

  return {
    results,
    totalResults: asNumber(payload.meta?.count),
    responseTimeMs: asNumber(payload.meta?.db_response_time_ms),
    costUsd: asNumber(payload.meta?.cost_usd),
  };
}

function formatAuthors(authors: PaperAuthor[], maxAuthors = 6): string {
  if (authors.length === 0) return "unknown";
  if (authors.length <= maxAuthors) return authors.map((author) => author.name).join(", ");
  return `${authors.slice(0, maxAuthors).map((author) => author.name).join(", ")}, et al. (${authors.length} authors)`;
}

function truncateAbstract(abstract: string | undefined, maxChars = 900): string | undefined {
  if (!abstract) return undefined;
  const normalized = abstract.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function formatTopic(topic: PaperTopic): string {
  const lineage = [topic.domain, topic.field, topic.subfield].filter(Boolean).join(" / ");
  return lineage ? `${topic.name} (${lineage})` : topic.name;
}

function formatResults(details: OpenAlexSearchDetails): string {
  const lines: string[] = [];
  lines.push(`OpenAlex results for: ${details.query}`);
  lines.push(`Sort: ${details.sort}; page=${details.page}; maxResults=${details.maxResults}`);
  if (details.filter) lines.push(`Filter: ${details.filter}`);
  if (typeof details.totalResults === "number") lines.push(`Total matches reported by OpenAlex: ${details.totalResults}`);
  if (typeof details.responseTimeMs === "number") lines.push(`OpenAlex response time: ${details.responseTimeMs}ms`);
  if (typeof details.costUsd === "number") lines.push(`OpenAlex reported cost: $${details.costUsd}`);
  lines.push(`OpenAlex API key: ${details.apiKeyUsed ? "configured" : "not configured (anonymous budget)"}`);
  lines.push("Note: OpenAlex aggregates scholarly metadata; verify important claims against the paper text/venue.");

  if (details.results.length === 0) {
    lines.push("", "No OpenAlex results found.");
    return lines.join("\n");
  }

  lines.push("", "Results:");
  details.results.forEach((paper, index) => {
    lines.push(`${index + 1}. ${paper.title}`);
    lines.push(`   OpenAlex: ${paper.id}`);
    lines.push(`   Authors: ${formatAuthors(paper.authors)}`);
    const pub = [paper.year ? `year ${paper.year}` : undefined, paper.publicationDate ? `date ${paper.publicationDate}` : undefined, paper.type ? `type ${paper.type}` : undefined].filter(Boolean);
    if (pub.length > 0) lines.push(`   Publication: ${pub.join("; ")}`);
    if (paper.venue) lines.push(`   Venue/source: ${paper.venue}${paper.venueType ? ` (${paper.venueType})` : ""}`);
    if (paper.doi) lines.push(`   DOI: ${paper.doi}${paper.doiUrl ? ` (${paper.doiUrl})` : ""}`);
    if (paper.landingPageUrl) lines.push(`   Landing page: ${paper.landingPageUrl}`);
    if (paper.pdfUrl) lines.push(`   PDF: ${paper.pdfUrl}`);
    if (paper.openAccess || paper.openAccessStatus || paper.openAccessUrl) {
      const oa = [paper.openAccess ? "open access" : "not marked OA", paper.openAccessStatus, paper.openAccessUrl].filter(Boolean);
      lines.push(`   Open access: ${oa.join("; ")}`);
    }
    if (typeof paper.citedByCount === "number") lines.push(`   Cited by: ${paper.citedByCount}`);
    if (typeof paper.referencedWorksCount === "number") lines.push(`   References: ${paper.referencedWorksCount}`);
    if (paper.topics.length > 0) lines.push(`   Topics: ${paper.topics.map(formatTopic).join("; ")}`);
    else if (paper.concepts.length > 0) lines.push(`   Concepts: ${paper.concepts.join(", ")}`);
    const abstract = truncateAbstract(paper.abstract);
    if (abstract) lines.push(`   Abstract: ${abstract}`);
    if (paper.relatedWorks.length > 0) lines.push(`   Related works: ${paper.relatedWorks.slice(0, 5).join(", ")}`);
  });

  return lines.join("\n");
}

async function truncateResultText(text: string, details: OpenAlexSearchDetails): Promise<string> {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) return truncation.content;

  const tempDir = await mkdtemp(join(tmpdir(), "pi-openalex-"));
  const tempFile = join(tempDir, "results.txt");
  await writeFile(tempFile, text, "utf8");

  details.truncation = truncation;
  details.fullOutputPath = tempFile;

  return `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
    truncation.outputBytes,
  )} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tempFile}]`;
}

async function runSearch(params: OpenAlexSearchInput, signal?: AbortSignal): Promise<{ content: string; details: OpenAlexSearchDetails }> {
  const built = buildSearchUrl(params);
  const payload = await fetchOpenAlex(built.url, signal);
  const parsed = parseOpenAlexResponse(payload, built.maxResults);

  const details: OpenAlexSearchDetails = {
    baseUrl: OPENALEX_BASE_URL,
    query: params.query,
    page: built.page,
    maxResults: built.maxResults,
    fromYear: params.fromYear,
    toYear: params.toYear,
    openAccessOnly: params.openAccessOnly ?? false,
    sort: built.sort,
    filter: built.filter,
    totalResults: parsed.totalResults,
    responseTimeMs: parsed.responseTimeMs,
    costUsd: parsed.costUsd,
    apiKeyUsed: Boolean(process.env[OPENALEX_API_KEY_ENV]?.trim()),
    resultCount: parsed.results.length,
    results: parsed.results,
  };

  const formatted = formatResults(details);
  return { content: await truncateResultText(formatted, details), details };
}

export default function openAlexExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "openalex_search",
    label: "OpenAlex Search",
    description:
      "Search OpenAlex for scholarly works across journals, conferences, preprints, and repositories. Works anonymously when budget is available; optional OPENALEX_API_KEY increases the free daily budget. Returns metadata, citation counts, DOI/venue info, abstracts when available, and open-access/PDF links.",
    promptSnippet: "Search OpenAlex for scholarly works and return triage-friendly metadata, citation counts, DOI/venue info, and OA/PDF links.",
    promptGuidelines: [
      "Use openalex_search for broader literature discovery beyond arXiv: older/foundational papers, venues, citation counts, DOI lookup by search, and open-access links.",
      "OpenAlex is metadata aggregation, not paper reading. Verify important claims with pdf_read/web_read on the actual paper or publisher page.",
      "For recent preprints, pair with arxiv_search. For citation-network exploration, use relatedWorks/referencedWorks IDs as seeds for follow-up searches or future graph tools.",
      "High cited_by_count can indicate influence, but newer papers may be important with few citations.",
    ],
    parameters: OpenAlexSearchParams,

    async execute(_toolCallId, params, signal) {
      const result = await runSearch(params, signal);
      return {
        content: [{ type: "text", text: result.content }],
        details: result.details,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("openalex_search "));
      text += theme.fg("accent", `"${args.query ?? ""}"`);
      if (args.sort) text += theme.fg("dim", ` (${args.sort})`);
      if (args.openAccessOnly) text += theme.fg("muted", " OA");
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching OpenAlex..."), 0, 0);

      const details = result.details as OpenAlexSearchDetails | undefined;
      if (!details) return new Text(theme.fg("dim", "No OpenAlex details"), 0, 0);

      let text = details.resultCount === 0 ? theme.fg("dim", "No OpenAlex results") : theme.fg("success", `${details.resultCount} OpenAlex result${details.resultCount === 1 ? "" : "s"}`);
      if (typeof details.totalResults === "number") text += theme.fg("muted", ` (${details.totalResults} total)`);
      if (details.truncation?.truncated) text += theme.fg("warning", " (truncated)");

      if (expanded && details.results.length > 0) {
        for (const [index, paper] of details.results.slice(0, 10).entries()) {
          text += `\n${theme.fg("muted", `${index + 1}.`)} ${paper.title}`;
          const meta = [paper.year, typeof paper.citedByCount === "number" ? `${paper.citedByCount} cites` : undefined, paper.doi].filter(Boolean).join(" · ");
          if (meta) text += `\n   ${theme.fg("dim", meta)}`;
        }
        if (details.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
      }

      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("openalex-search-test", {
    description: "Test openalex_search with a query",
    handler: async (args, ctx) => {
      const query = args.trim() || "multi tenant cloud interference scheduling";
      try {
        const result = await runSearch({ query, maxResults: 3, sort: "relevance" }, ctx.signal);
        ctx.ui.notify(`OpenAlex OK: ${result.details.resultCount} result(s) for "${query}"`, "info");
      } catch (error) {
        ctx.ui.notify(`OpenAlex failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

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
import { DOMParser } from "linkedom";

const ARXIV_BASE_URL = "https://export.arxiv.org";
const MAX_RESULTS_LIMIT = 50;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_START = 0;
const DEFAULT_SORT_BY = "relevance";
const DEFAULT_SORT_ORDER = "descending";

const ArxivSearchParams = Type.Object({
  query: Type.String({
    description:
      "Search query. Plain text is automatically converted to an arXiv all:term AND all:term query. Advanced arXiv syntax (ti:, au:, abs:, cat:, AND/OR) is passed through.",
  }),
  maxResults: Type.Optional(
    Type.Integer({
      description: `Maximum number of results to return. Defaults to ${DEFAULT_MAX_RESULTS}, capped at ${MAX_RESULTS_LIMIT}.`,
      minimum: 1,
      maximum: MAX_RESULTS_LIMIT,
    }),
  ),
  start: Type.Optional(Type.Integer({ description: "Zero-based result offset for pagination. Defaults to 0.", minimum: 0 })),
  sortBy: Type.Optional(
    StringEnum(["relevance", "lastUpdatedDate", "submittedDate"] as const, {
      description: "arXiv sort field. Defaults to relevance.",
    }),
  ),
  sortOrder: Type.Optional(
    StringEnum(["ascending", "descending"] as const, {
      description: "Sort order. Defaults to descending.",
    }),
  ),
  categories: Type.Optional(
    Type.Array(Type.String({ description: "arXiv category such as cs.DC, cs.OS, cs.SE, cs.NI, or cs.PF" }), {
      description: "Optional arXiv categories to OR together and AND with the query, e.g. ['cs.DC', 'cs.OS'].",
      minItems: 1,
      maxItems: 10,
    }),
  ),
});

type ArxivSearchInput = Static<typeof ArxivSearchParams>;

type SortBy = "relevance" | "lastUpdatedDate" | "submittedDate";
type SortOrder = "ascending" | "descending";

type ArxivPaper = {
  id: string;
  arxivId: string;
  arxivIdVersioned: string;
  version?: string;
  title: string;
  authors: string[];
  published?: string;
  updated?: string;
  summary: string;
  categories: string[];
  primaryCategory?: string;
  comment?: string;
  journalRef?: string;
  doi?: string;
  absUrl: string;
  pdfUrl: string;
};

type ArxivSearchDetails = {
  baseUrl: string;
  query: string;
  arxivQuery: string;
  start: number;
  maxResults: number;
  sortBy: SortBy;
  sortOrder: SortOrder;
  categories: string[];
  totalResults?: number;
  resultCount: number;
  results: ArxivPaper[];
  truncation?: TruncationResult;
  fullOutputPath?: string;
};

function asSortBy(value: ArxivSearchInput["sortBy"]): SortBy {
  return (value ?? DEFAULT_SORT_BY) as SortBy;
}

function asSortOrder(value: ArxivSearchInput["sortOrder"]): SortOrder {
  return (value ?? DEFAULT_SORT_ORDER) as SortOrder;
}

function normalizeWhitespace(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized : undefined;
}

function normalizeCategories(categories: string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of categories ?? []) {
    const value = raw.trim().replace(/^cat:/i, "");
    if (!value || seen.has(value)) continue;
    if (!/^[A-Za-z0-9_.-]+$/.test(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function isAdvancedArxivQuery(query: string): boolean {
  return /\b(all|ti|au|abs|co|jr|cat|rn|id):/i.test(query) || /\b(AND|OR|ANDNOT)\b/.test(query);
}

function tokenizeSimpleQuery(query: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query)) !== null) {
    const token = normalizeWhitespace(match[1] ?? match[2] ?? match[3]);
    if (token) tokens.push(token);
  }
  return tokens;
}

function arxivTerm(token: string): string {
  const cleaned = token.replace(/"/g, "");
  if (/^[A-Za-z0-9_.-]+$/.test(cleaned)) return `all:${cleaned}`;
  return `all:"${cleaned}"`;
}

function buildArxivQuery(query: string, categories: string[]): string {
  const trimmed = query.trim();
  const baseQuery = isAdvancedArxivQuery(trimmed)
    ? trimmed
    : tokenizeSimpleQuery(trimmed).map(arxivTerm).join(" AND ");

  const effectiveBase = baseQuery || "all:*";
  if (categories.length === 0) return effectiveBase;

  const categoryQuery = categories.map((category) => `cat:${category}`).join(" OR ");
  return `(${effectiveBase}) AND (${categoryQuery})`;
}

function buildSearchUrl(params: ArxivSearchInput): { url: URL; arxivQuery: string; categories: string[]; maxResults: number; start: number; sortBy: SortBy; sortOrder: SortOrder } {
  const categories = normalizeCategories(params.categories);
  const arxivQuery = buildArxivQuery(params.query, categories);
  const maxResults = Math.min(Math.max(params.maxResults ?? DEFAULT_MAX_RESULTS, 1), MAX_RESULTS_LIMIT);
  const start = Math.max(params.start ?? DEFAULT_START, 0);
  const sortBy = asSortBy(params.sortBy);
  const sortOrder = asSortOrder(params.sortOrder);

  const url = new URL("/api/query", ARXIV_BASE_URL);
  url.searchParams.set("search_query", arxivQuery);
  url.searchParams.set("start", String(start));
  url.searchParams.set("max_results", String(maxResults));
  url.searchParams.set("sortBy", sortBy);
  url.searchParams.set("sortOrder", sortOrder);

  return { url, arxivQuery, categories, maxResults, start, sortBy, sortOrder };
}

function localName(element: Element): string {
  const raw = element.localName || element.tagName;
  return raw.toLowerCase().split(":").pop() ?? raw.toLowerCase();
}

function directChildren(parent: Element | Document, name: string): Element[] {
  return Array.from(parent.children).filter((child) => localName(child) === name);
}

function directChildText(parent: Element | Document, name: string): string | undefined {
  for (const child of directChildren(parent, name)) {
    const text = normalizeWhitespace(child.textContent ?? undefined);
    if (text) return text;
  }
  return undefined;
}

function firstDescendantText(parent: Element | Document, name: string): string | undefined {
  for (const element of Array.from(parent.querySelectorAll("*"))) {
    if (localName(element) !== name) continue;
    const text = normalizeWhitespace(element.textContent ?? undefined);
    if (text) return text;
  }
  return undefined;
}

function directChildByName(parent: Element, name: string): Element | undefined {
  return directChildren(parent, name)[0];
}

function extractArxivId(idUrl: string): { arxivId: string; arxivIdVersioned: string; version?: string } {
  const fallback = idUrl.trim();
  const match = fallback.match(/arxiv\.org\/abs\/(.+)$/i);
  const versioned = decodeURIComponent(match?.[1] ?? fallback).replace(/\/+$/, "");
  const versionMatch = versioned.match(/^(.*?)(v\d+)$/i);
  return {
    arxivId: versionMatch?.[1] ?? versioned,
    arxivIdVersioned: versioned,
    version: versionMatch?.[2],
  };
}

function extractLinks(entry: Element, idUrl: string, arxivIdVersioned: string): { absUrl: string; pdfUrl: string } {
  let absUrl = idUrl;
  let pdfUrl = `${ARXIV_BASE_URL}/pdf/${arxivIdVersioned}`;

  for (const link of directChildren(entry, "link")) {
    const href = link.getAttribute("href")?.trim();
    if (!href) continue;
    const rel = link.getAttribute("rel")?.trim().toLowerCase();
    const type = link.getAttribute("type")?.trim().toLowerCase();
    const title = link.getAttribute("title")?.trim().toLowerCase();

    if (rel === "alternate") absUrl = href;
    if (title === "pdf" || type === "application/pdf" || href.includes("/pdf/")) pdfUrl = href;
  }

  return { absUrl, pdfUrl };
}

function parseEntry(entry: Element): ArxivPaper | undefined {
  const id = directChildText(entry, "id");
  const title = directChildText(entry, "title");
  const summary = directChildText(entry, "summary");
  if (!id || !title || !summary) return undefined;

  const { arxivId, arxivIdVersioned, version } = extractArxivId(id);
  const links = extractLinks(entry, id, arxivIdVersioned);
  const authors = directChildren(entry, "author")
    .map((author) => directChildText(author, "name"))
    .filter((author): author is string => Boolean(author));

  const categories = directChildren(entry, "category")
    .map((category) => category.getAttribute("term")?.trim())
    .filter((category): category is string => Boolean(category));

  const primaryCategory = directChildByName(entry, "primary_category")?.getAttribute("term")?.trim() || categories[0];

  return {
    id,
    arxivId,
    arxivIdVersioned,
    version,
    title,
    authors,
    published: directChildText(entry, "published"),
    updated: directChildText(entry, "updated"),
    summary,
    categories,
    primaryCategory,
    comment: directChildText(entry, "comment"),
    journalRef: directChildText(entry, "journal_ref"),
    doi: directChildText(entry, "doi"),
    absUrl: links.absUrl,
    pdfUrl: links.pdfUrl,
  };
}

function parseArxivResponse(xml: string): { totalResults?: number; results: ArxivPaper[] } {
  const document = new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
  const totalRaw = firstDescendantText(document, "totalresults");
  const totalResults = totalRaw ? Number.parseInt(totalRaw, 10) : undefined;
  const entries = Array.from(document.querySelectorAll("entry")) as Element[];
  const results = entries.map(parseEntry).filter((entry): entry is ArxivPaper => Boolean(entry));
  return { totalResults: Number.isFinite(totalResults) ? totalResults : undefined, results };
}

async function fetchArxiv(url: URL, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    signal,
    headers: {
      Accept: "application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      "User-Agent": "pi-arxiv-search/1.0 (keyless research tool)",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`arXiv request failed: HTTP ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 500)}` : ""}`);
  }

  return response.text();
}

function formatDate(value: string | undefined): string | undefined {
  return value?.slice(0, 10);
}

function formatAuthors(authors: string[], maxAuthors = 6): string {
  if (authors.length === 0) return "unknown";
  if (authors.length <= maxAuthors) return authors.join(", ");
  return `${authors.slice(0, maxAuthors).join(", ")}, et al. (${authors.length} authors)`;
}

function truncateSummary(summary: string, maxChars = 900): string {
  const normalized = normalizeWhitespace(summary) ?? "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function formatResults(details: ArxivSearchDetails): string {
  const lines: string[] = [];
  lines.push(`arXiv results for: ${details.query}`);
  lines.push(`arXiv query: ${details.arxivQuery}`);
  lines.push(`Sort: ${details.sortBy} ${details.sortOrder}; start=${details.start}; maxResults=${details.maxResults}`);
  if (details.categories.length > 0) lines.push(`Categories: ${details.categories.join(", ")}`);
  if (typeof details.totalResults === "number") lines.push(`Total matches reported by arXiv: ${details.totalResults}`);
  lines.push("Note: arXiv papers are preprints and are not necessarily peer reviewed.");

  if (details.results.length === 0) {
    lines.push("", "No arXiv results found.");
    return lines.join("\n");
  }

  lines.push("", "Results:");
  details.results.forEach((paper, index) => {
    lines.push(`${index + 1}. ${paper.title}`);
    lines.push(`   arXiv: ${paper.arxivIdVersioned}${paper.version ? ` (${paper.version})` : ""}`);
    lines.push(`   Authors: ${formatAuthors(paper.authors)}`);
    const dates = [formatDate(paper.published) ? `published ${formatDate(paper.published)}` : undefined, formatDate(paper.updated) ? `updated ${formatDate(paper.updated)}` : undefined].filter(Boolean);
    if (dates.length > 0) lines.push(`   Dates: ${dates.join("; ")}`);
    if (paper.categories.length > 0) lines.push(`   Categories: ${paper.categories.join(", ")}${paper.primaryCategory ? ` (primary: ${paper.primaryCategory})` : ""}`);
    lines.push(`   URL: ${paper.absUrl}`);
    lines.push(`   PDF: ${paper.pdfUrl}`);
    if (paper.doi) lines.push(`   DOI: ${paper.doi}`);
    if (paper.journalRef) lines.push(`   Journal: ${paper.journalRef}`);
    if (paper.comment) lines.push(`   Comment: ${paper.comment}`);
    lines.push(`   Summary: ${truncateSummary(paper.summary)}`);
  });

  return lines.join("\n");
}

async function truncateResultText(text: string, details: ArxivSearchDetails): Promise<string> {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) return truncation.content;

  const tempDir = await mkdtemp(join(tmpdir(), "pi-arxiv-"));
  const tempFile = join(tempDir, "results.txt");
  await writeFile(tempFile, text, "utf8");

  details.truncation = truncation;
  details.fullOutputPath = tempFile;

  return `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
    truncation.outputBytes,
  )} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tempFile}]`;
}

async function runSearch(params: ArxivSearchInput, signal?: AbortSignal): Promise<{ content: string; details: ArxivSearchDetails }> {
  const built = buildSearchUrl(params);
  const xml = await fetchArxiv(built.url, signal);
  const parsed = parseArxivResponse(xml);
  const results = parsed.results.slice(0, built.maxResults);

  const details: ArxivSearchDetails = {
    baseUrl: ARXIV_BASE_URL,
    query: params.query,
    arxivQuery: built.arxivQuery,
    start: built.start,
    maxResults: built.maxResults,
    sortBy: built.sortBy,
    sortOrder: built.sortOrder,
    categories: built.categories,
    totalResults: parsed.totalResults,
    resultCount: results.length,
    results,
  };

  const formatted = formatResults(details);
  return { content: await truncateResultText(formatted, details), details };
}

export default function arxivExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "arxiv_search",
    label: "arXiv Search",
    description:
      "Search arXiv's public API for academic preprints. No login or API key required. Returns triage-friendly paper metadata, abstracts, arXiv IDs, and PDF links. arXiv papers are not necessarily peer reviewed.",
    promptSnippet: "Search arXiv for preprints/papers and return structured metadata with PDF links.",
    promptGuidelines: [
      "Use arxiv_search for academic paper discovery, especially recent preprints in CS/systems/ML topics.",
      "For systems research, useful categories include cs.DC, cs.OS, cs.SE, cs.NI, cs.PF, cs.DB, cs.LG, and cs.AI.",
      "Treat arXiv as discovery, not authority: preprints are not necessarily peer reviewed.",
      "After finding a promising paper, use the returned PDF URL with pdf_info/pdf_read before making detailed claims.",
      "Prefer specific follow-up searches using vocabulary discovered in titles/abstracts.",
    ],
    parameters: ArxivSearchParams,

    async execute(_toolCallId, params, signal) {
      const result = await runSearch(params, signal);
      return {
        content: [{ type: "text", text: result.content }],
        details: result.details,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("arxiv_search "));
      text += theme.fg("accent", `"${args.query ?? ""}"`);
      if (Array.isArray(args.categories) && args.categories.length > 0) text += theme.fg("muted", ` in ${args.categories.join(",")}`);
      if (args.sortBy) text += theme.fg("dim", ` (${args.sortBy})`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching arXiv..."), 0, 0);

      const details = result.details as ArxivSearchDetails | undefined;
      if (!details) return new Text(theme.fg("dim", "No arXiv details"), 0, 0);

      let text = details.resultCount === 0 ? theme.fg("dim", "No arXiv results") : theme.fg("success", `${details.resultCount} arXiv result${details.resultCount === 1 ? "" : "s"}`);
      if (typeof details.totalResults === "number") text += theme.fg("muted", ` (${details.totalResults} total)`);
      if (details.truncation?.truncated) text += theme.fg("warning", " (truncated)");

      if (expanded && details.results.length > 0) {
        for (const [index, paper] of details.results.slice(0, 10).entries()) {
          text += `\n${theme.fg("muted", `${index + 1}.`)} ${paper.title}`;
          text += `\n   ${theme.fg("dim", `${paper.arxivIdVersioned} — ${paper.pdfUrl}`)}`;
        }
        if (details.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
      }

      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("arxiv-search-test", {
    description: "Test arxiv_search with a query",
    handler: async (args, ctx) => {
      const query = args.trim() || "kubernetes resource scheduling";
      try {
        const result = await runSearch({ query, maxResults: 3, categories: ["cs.DC", "cs.OS"] }, ctx.signal);
        ctx.ui.notify(`arXiv OK: ${result.details.resultCount} result(s) for "${query}" (${result.details.arxivQuery})`, "info");
      } catch (error) {
        ctx.ui.notify(`arXiv failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
	type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "typebox";

const DEFAULT_SEARXNG_URL = "https://search.ts.tux-sudo.com";
const SEARXNG_URL_ENV = "SEARXNG_URL";
const MAX_RESULTS_LIMIT = 25;

const SearxngSearchParams = Type.Object({
	query: Type.String({ description: "Search query to send to SearXNG" }),
	maxResults: Type.Optional(
		Type.Integer({
			description: `Maximum number of results to return, capped at ${MAX_RESULTS_LIMIT}. Defaults to 10.`,
			minimum: 1,
			maximum: MAX_RESULTS_LIMIT,
		}),
	),
	page: Type.Optional(Type.Integer({ description: "Search result page number. Defaults to 1.", minimum: 1 })),
	categories: Type.Optional(
		Type.String({
			description:
				"Comma-separated SearXNG categories, for example: general, news, science, it, files, images, videos, map, music. Defaults to general.",
		}),
	),
	language: Type.Optional(
		Type.String({
			description: "SearXNG language code such as en, en-US, or all. Defaults to all.",
		}),
	),
	timeRange: Type.Optional(
		StringEnum(["day", "month", "year"] as const, {
			description: "Limit results to a time range, if supported by the selected engines.",
		}),
	),
	safesearch: Type.Optional(
		Type.Integer({
			description: "SearXNG safesearch level: 0 = off, 1 = moderate, 2 = strict. Defaults to 0.",
			minimum: 0,
			maximum: 2,
		}),
	),
});

type SearxngSearchInput = Static<typeof SearxngSearchParams>;

type SearxngResult = {
	title?: unknown;
	url?: unknown;
	content?: unknown;
	engine?: unknown;
	engines?: unknown;
	category?: unknown;
	publishedDate?: unknown;
	score?: unknown;
};

type SearxngResponse = {
	query?: unknown;
	number_of_results?: unknown;
	results?: unknown;
	answers?: unknown;
	infoboxes?: unknown;
	suggestions?: unknown;
};

type SearchResult = {
	title: string;
	url: string;
	content?: string;
	engines?: string[];
	category?: string;
	publishedDate?: string;
	score?: number;
};

type SearxngSearchDetails = {
	baseUrl: string;
	query: string;
	page: number;
	categories: string;
	language: string;
	timeRange?: string;
	safesearch: number;
	resultCount: number;
	reportedResultCount?: number;
	results: SearchResult[];
	answers: string[];
	suggestions: string[];
	truncation?: TruncationResult;
	fullOutputPath?: string;
};

function getBaseUrl(): string {
	const configured = process.env[SEARXNG_URL_ENV]?.trim() || DEFAULT_SEARXNG_URL;
	const withProtocol = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
	return withProtocol.replace(/\/+$/g, "");
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map(asString).filter((item): item is string => Boolean(item));
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeResult(result: SearxngResult): SearchResult | undefined {
	const title = asString(result.title);
	const url = asString(result.url);
	if (!title || !url) return undefined;

	const engines = asStringArray(result.engines);
	const singleEngine = asString(result.engine);

	return {
		title,
		url,
		content: asString(result.content),
		engines: engines.length > 0 ? engines : singleEngine ? [singleEngine] : undefined,
		category: asString(result.category),
		publishedDate: asString(result.publishedDate),
		score: asNumber(result.score),
	};
}

function buildSearchUrl(baseUrl: string, params: SearxngSearchInput): URL {
	const url = new URL("/search", baseUrl);
	url.searchParams.set("q", params.query);
	url.searchParams.set("format", "json");
	url.searchParams.set("categories", params.categories?.trim() || "general");
	url.searchParams.set("language", params.language?.trim() || "all");
	url.searchParams.set("safesearch", String(params.safesearch ?? 0));
	url.searchParams.set("pageno", String(params.page ?? 1));
	if (params.timeRange) url.searchParams.set("time_range", params.timeRange);
	return url;
}

async function fetchSearxng(url: URL, signal?: AbortSignal): Promise<SearxngResponse> {
	const response = await fetch(url, {
		headers: { Accept: "application/json" },
		signal,
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`SearXNG request failed: HTTP ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 500)}` : ""}`);
	}

	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) {
		throw new Error(`SearXNG returned ${contentType || "an unknown content type"}, expected JSON`);
	}

	return (await response.json()) as SearxngResponse;
}

function parseSearchResponse(payload: SearxngResponse, maxResults: number): Pick<SearxngSearchDetails, "results" | "answers" | "suggestions" | "reportedResultCount"> {
	const rawResults = Array.isArray(payload.results) ? (payload.results as SearxngResult[]) : [];
	const results = rawResults.map(normalizeResult).filter((item): item is SearchResult => Boolean(item)).slice(0, maxResults);

	return {
		results,
		answers: asStringArray(payload.answers),
		suggestions: asStringArray(payload.suggestions),
		reportedResultCount: asNumber(payload.number_of_results),
	};
}

function formatSearchResults(details: SearxngSearchDetails): string {
	const lines: string[] = [];
	lines.push(`SearXNG results for: ${details.query}`);

	if (details.answers.length > 0) {
		lines.push("", "Answers:");
		for (const answer of details.answers) lines.push(`- ${answer}`);
	}

	if (details.results.length === 0) {
		lines.push("", "No search results found.");
	} else {
		lines.push("", "Results:");
		details.results.forEach((result, index) => {
			lines.push(`${index + 1}. ${result.title}`);
			lines.push(`   URL: ${result.url}`);
			if (result.content) lines.push(`   Summary: ${result.content}`);
			const metadata = [
				result.engines && result.engines.length > 0 ? `engines: ${result.engines.join(", ")}` : undefined,
				result.category ? `category: ${result.category}` : undefined,
				result.publishedDate ? `published: ${result.publishedDate}` : undefined,
				typeof result.score === "number" ? `score: ${result.score}` : undefined,
			].filter(Boolean);
			if (metadata.length > 0) lines.push(`   ${metadata.join("; ")}`);
		});
	}

	if (details.suggestions.length > 0) {
		lines.push("", `Suggestions: ${details.suggestions.join(", ")}`);
	}

	return lines.join("\n");
}

async function truncateResultText(text: string, details: SearxngSearchDetails): Promise<string> {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	if (!truncation.truncated) return truncation.content;

	const tempDir = await mkdtemp(join(tmpdir(), "pi-searxng-"));
	const tempFile = join(tempDir, "results.txt");
	await writeFile(tempFile, text, "utf8");

	details.truncation = truncation;
	details.fullOutputPath = tempFile;

	return `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
		truncation.outputBytes,
	)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tempFile}]`;
}

async function runSearch(params: SearxngSearchInput, signal?: AbortSignal): Promise<{ content: string; details: SearxngSearchDetails }> {
	const maxResults = Math.min(Math.max(params.maxResults ?? 10, 1), MAX_RESULTS_LIMIT);
	const page = params.page ?? 1;
	const categories = params.categories?.trim() || "general";
	const language = params.language?.trim() || "all";
	const safesearch = params.safesearch ?? 0;
	const baseUrl = getBaseUrl();
	const url = buildSearchUrl(baseUrl, { ...params, maxResults, page, categories, language, safesearch });
	const payload = await fetchSearxng(url, signal);
	const parsed = parseSearchResponse(payload, maxResults);

	const details: SearxngSearchDetails = {
		baseUrl,
		query: params.query,
		page,
		categories,
		language,
		timeRange: params.timeRange,
		safesearch,
		resultCount: parsed.results.length,
		reportedResultCount: parsed.reportedResultCount,
		results: parsed.results,
		answers: parsed.answers,
		suggestions: parsed.suggestions,
	};

	const formatted = formatSearchResults(details);
	return { content: await truncateResultText(formatted, details), details };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "searxng_search",
		label: "SearXNG Search",
		description: `Search the web using the configured SearXNG instance (${SEARXNG_URL_ENV} or ${DEFAULT_SEARXNG_URL}). Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first).`,
		promptSnippet: "Search the web through the user's SearXNG instance and return sourced results.",
		promptGuidelines: [
			"Use searxng_search when current web information, external documentation, news, or source discovery would help answer the user's request.",
			"When using searxng_search, cite the result URLs you relied on in your answer.",
		],
		parameters: SearxngSearchParams,

		async execute(_toolCallId, params, signal) {
			const result = await runSearch(params, signal);
			return {
				content: [{ type: "text", text: result.content }],
				details: result.details,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("searxng_search "));
			text += theme.fg("accent", `"${args.query ?? ""}"`);
			if (args.categories) text += theme.fg("muted", ` in ${args.categories}`);
			if (args.timeRange) text += theme.fg("dim", ` (${args.timeRange})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Searching SearXNG..."), 0, 0);

			const details = result.details as SearxngSearchDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "No search details"), 0, 0);

			let text = details.resultCount === 0 ? theme.fg("dim", "No results") : theme.fg("success", `${details.resultCount} result${details.resultCount === 1 ? "" : "s"}`);
			if (details.truncation?.truncated) text += theme.fg("warning", " (truncated)");

			if (expanded && details.results.length > 0) {
				for (const [index, item] of details.results.slice(0, 10).entries()) {
					text += `\n${theme.fg("muted", `${index + 1}.`)} ${item.title}`;
					text += `\n   ${theme.fg("dim", item.url)}`;
				}
				if (details.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
			}

			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("searxng-test", {
		description: "Test the configured SearXNG connection",
		handler: async (args, ctx) => {
			const query = args.trim() || "test";
			try {
				const result = await runSearch({ query, maxResults: 3 }, ctx.signal);
				ctx.ui.notify(`SearXNG OK (${result.details.baseUrl}): ${result.details.resultCount} result(s) for "${query}"`, "info");
			} catch (error) {
				ctx.ui.notify(`SearXNG failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}

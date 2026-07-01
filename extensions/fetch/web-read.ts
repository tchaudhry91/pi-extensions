import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, TruncationResult } from "@earendil-works/pi-coding-agent";
import { formatSize, getAgentDir, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

const FETCH_TIMEOUT_MS = 30_000;
const MAX_RAW_BYTES = 10_000_000; // hard cap on raw HTML/text kept in memory before parsing (10 MB)

const DEFAULT_OUTPUT_BYTES = 150_000; // default max bytes of the *returned window* sent to the LLM
const DEFAULT_OUTPUT_LINES = 8_000; // default max lines of the returned window
const MAX_OUTPUT_BYTES = 1_000_000; // hard cap on maxLength / limit

const CACHE_DIR = join(getAgentDir(), "cache", "web-read");
const MAX_LINKS = 200;
const MAX_CACHE_RAW_BYTES = 5_000_000; // only persist raw HTML to cache if under this size

type ExtractionMode = "readable" | "markdown" | "text" | "raw";

const WebReadParams = Type.Object({
  url: Type.String({ description: "URL to fetch and extract content from" }),
  mode: Type.Optional(
    StringEnum(["readable", "markdown", "text", "raw"] as const, {
      description:
        "Extraction mode. readable (default): Readability-first clean article. markdown: structured HTML→markdown preserving code/tables/lists. text: plain text. raw: raw HTML/text, truncated.",
    }),
  ),
  maxLength: Type.Optional(
    Type.Integer({
      description: `Maximum bytes of the returned window. Defaults to ${DEFAULT_OUTPUT_BYTES} (${formatSize(DEFAULT_OUTPUT_BYTES)}). Hard cap ${MAX_OUTPUT_BYTES}.`,
      minimum: 100,
      maximum: MAX_OUTPUT_BYTES,
    }),
  ),
  offset: Type.Optional(
    Type.Integer({ description: "Byte offset into the full extracted content to start reading from (for chunking long pages). Defaults to 0.", minimum: 0 }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: `Maximum bytes to read from the full content starting at offset. Defaults to maxLength. Hard cap ${MAX_OUTPUT_BYTES}.`,
      minimum: 100,
      maximum: MAX_OUTPUT_BYTES,
    }),
  ),
  cache: Type.Optional(Type.Boolean({ description: "Use/read the local cache. Default true." })),
  refresh: Type.Optional(Type.Boolean({ description: "Ignore the cache and refetch (still writes back if cache is enabled). Default false." })),
  includeLinks: Type.Optional(Type.Boolean({ description: "Append an extracted links list to the output and include them in details. Default false." })),
  includeMetadata: Type.Optional(Type.Boolean({ description: "Include extended metadata (author, description, canonical URL, content type) in the output header. Default false." })),
});

type WebReadInput = Static<typeof WebReadParams>;

type Link = { text: string; href: string };

type WebReadDetails = {
  url: string;
  finalUrl: string;
  title?: string;
  siteName?: string;
  author?: string;
  description?: string;
  canonicalUrl?: string;
  contentType?: string;
  statusCode: number;
  rawBytes: number;
  extractedBytes: number;
  extractedChars: number;
  truncated: boolean;
  extractionMode: ExtractionMode;
  warnings: string[];
  fullOutputPath?: string;
  cachePath?: string;
  links?: Link[];
  truncation?: TruncationResult;
};

type CacheMeta = {
  url: string;
  finalUrl: string;
  fetchedAt: number;
  contentType?: string;
  statusCode: number;
  title?: string;
  siteName?: string;
  author?: string;
  description?: string;
  canonicalUrl?: string;
  mode: ExtractionMode;
  rawBytes: number;
  extractedBytes: number;
  links?: Link[];
  warnings?: string[];
};

type CacheRecord = {
  meta: CacheMeta;
  content: string;
};

const ENTITY_MAP: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: " ", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", hellip: "…", copy: "©", reg: "®",
  trade: "™", deg: "°", plusmn: "±", times: "×", divide: "÷",
};

function decodeEntities(text: string): string {
  return text.replace(/&([#\w]+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity.startsWith("#x") || entity.startsWith("#X")
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return ENTITY_MAP[entity] ?? match;
  });
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function sliceUtf8ByBytes(text: string, start: number, end: number): { content: string; bytes: number } {
  const buffer = Buffer.from(text, "utf8");
  if (start >= buffer.length) return { content: "", bytes: 0 };
  const slice = buffer.subarray(start, Math.min(end, buffer.length));
  return { content: slice.toString("utf8"), bytes: slice.length };
}

function htmlToMarkdown(html: string): string {
  let text = html.replace(/[\t ]+/g, " ").replace(/\n\s*\n/g, "\n\n");

  const blocks = [
    "div", "section", "article", "header", "footer", "main", "aside", "nav",
    "p", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "dl", "dt", "dd",
    "table", "tr", "blockquote", "pre", "figure", "figcaption",
    "hr", "br",
  ];
  for (const tag of blocks) {
    text = text.replace(new RegExp(`<${tag}[^>]*>`, "gi"), `\n<${tag}>`);
    text = text.replace(new RegExp(`</${tag}>`, "gi"), `</${tag}>\n`);
  }

  text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gis, (_, c) => `\n\n# ${stripTags(c).trim()}\n\n`);
  text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gis, (_, c) => `\n\n## ${stripTags(c).trim()}\n\n`);
  text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gis, (_, c) => `\n\n### ${stripTags(c).trim()}\n\n`);
  text = text.replace(/<h4[^>]*>(.*?)<\/h4>/gis, (_, c) => `\n\n#### ${stripTags(c).trim()}\n\n`);
  text = text.replace(/<h[56][^>]*>(.*?)<\/h[56]>/gis, (_, c) => `\n\n**${stripTags(c).trim()}**\n\n`);

  // Tables — preserve rows and cells as pipe tables
  text = text.replace(/<th[^>]*>(.*?)<\/th>/gis, (_, c) => ` ${stripTags(c).trim()} |`);
  text = text.replace(/<td[^>]*>(.*?)<\/td>/gis, (_, c) => ` ${stripTags(c).trim()} |`);
  text = text.replace(/<\/tr>/gis, "|\n");
  text = text.replace(/<tr[^>]*>/gis, "");

  text = text.replace(/<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gis, (_, __, c) => `**${stripTags(c)}**`);
  text = text.replace(/<(em|i)[^>]*>(.*?)<\/(em|i)>/gis, (_, __, c) => `*${stripTags(c)}*`);

  text = text.replace(/<code[^>]*>(.*?)<\/code>/gis, (_, c) => `\`${stripTags(c)}\``);
  text = text.replace(/<pre[^>]*>\s*<code[^>]*>(.*?)<\/code>\s*<\/pre>/gis, (_, c) => `\n\n\`\`\`\n${stripTags(c)}\n\`\`\`\n\n`);
  text = text.replace(/<pre[^>]*>(.*?)<\/pre>/gis, (_, c) => `\n\n\`\`\`\n${stripTags(c)}\n\`\`\`\n\n`);

  text = text.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis, (_, url, content) => {
    const label = stripTags(content).trim();
    return label ? `[${label}](${url})` : url;
  });

  text = text.replace(/<img[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi, (_, src, alt) => `![${alt || ""}](${src})`);
  text = text.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*>/gi, (_, alt, src) => `![${alt || ""}](${src})`);

  text = text.replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gis, (_, c) =>
    `\n\n${stripTags(c).trim().split("\n").map((l: string) => `> ${l}`).join("\n")}\n\n`);

  text = text.replace(/<li[^>]*>(.*?)<\/li>/gis, (_, c) => `- ${stripTags(c).trim()}`);

  text = stripTags(text);
  text = decodeEntities(text);
  text = text.replace(/\n{3,}/g, "\n\n").replace(/^[ \t]+/gm, "").trim();
  return text;
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  const abort = () => controller.abort(parent?.reason);
  if (parent) parent.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      if (parent) parent.removeEventListener("abort", abort);
    },
  };
}

function isPdfContentType(contentType: string): boolean {
  return /pdf/i.test(contentType);
}

function looksLikePdfUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return /\.pdf$/.test(path);
  } catch {
    return false;
  }
}

function isHtmlContentType(contentType: string): boolean {
  return contentType.includes("text/html") || contentType.includes("application/xhtml");
}

function isTextLike(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith("text/") ||
    ct.includes("json") ||
    ct.includes("xml") ||
    ct.includes("yaml") ||
    ct.includes("javascript") ||
    ct.includes("markdown")
  );
}

function metaContent(document: Document, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    const value = el?.getAttribute("content") ?? undefined;
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

function extractMetadata(document: Document, finalUrl: string): {
  title?: string;
  siteName?: string;
  author?: string;
  description?: string;
  canonicalUrl?: string;
} {
  const title =
    metaContent(document, ['meta[property="og:title"]', 'meta[name="twitter:title"]']) ??
    document.querySelector("title")?.textContent?.trim() ??
    undefined;

  const siteName = metaContent(document, ['meta[property="og:site_name"]', 'meta[name="application-name"]']);
  const author = metaContent(document, ['meta[property="article:author"]', 'meta[name="author"]', 'meta[name="twitter:creator"]']);
  const description = metaContent(document, ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']);

  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? undefined;
  const canonicalUrl = canonical ? safeResolveUrl(canonical, finalUrl) : undefined;

  return { title, siteName, author, description, canonicalUrl };
}

function safeResolveUrl(href: string, base: string): string | undefined {
  try {
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
}

function extractLinks(document: Document, finalUrl: string, max: number): Link[] {
  const anchors = document.querySelectorAll("a[href]");
  const links: Link[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors) {
    if (links.length >= max) break;
    const rawHref = anchor.getAttribute("href");
    if (!rawHref) continue;
    if (/^(javascript:|mailto:|tel:|#)/i.test(rawHref)) continue;
    const href = safeResolveUrl(rawHref, finalUrl);
    if (!href) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const text = (anchor.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    links.push({ text, href });
  }
  return links;
}

// Remove non-content elements from a document in place.
function cleanDocument(document: Document): void {
  const drop = ["script", "style", "noscript", "template", "iframe", "svg", "canvas", "nav", "footer", "aside", "form"];
  for (const selector of drop) {
    for (const el of document.querySelectorAll(selector)) el.remove();
  }
  for (const el of document.querySelectorAll("header, [role=banner]")) {
    // keep header only if it carries the page title; drop the rest
    el.remove();
  }
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function fetchResponse(url: string, signal: AbortSignal | undefined): Promise<Response> {
  const { signal: fetchSignal, cleanup } = timeoutSignal(signal, FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: fetchSignal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; pi-web-read/1.0)",
        Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
      },
    });
  } finally {
    cleanup();
  }
}

type ExtractionResult = {
  content: string;
  rawHtml?: string; // saved to cache separately if small enough
  details: Omit<WebReadDetails, "extractedChars" | "truncated" | "extractionMode" | "warnings" | "links">;
  links: Link[];
  warnings: string[];
};

async function fetchAndExtract(url: string, mode: ExtractionMode, signal: AbortSignal | undefined): Promise<ExtractionResult> {
  const response = await fetchResponse(url, signal);
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

  if (isPdfContentType(contentType) || (looksLikePdfUrl(url) && !isHtmlContentType(contentType) && !isTextLike(contentType))) {
    throw new Error(`URL returned a PDF (${contentType || "unknown content type"}). Use the pdf_info or pdf_read tool instead.`);
  }

  const finalUrl = response.url || url;

  // Non-HTML: text, markdown, JSON, XML, etc. — return as-is (JSON pretty-printed in non-raw modes).
  if (!isHtmlContentType(contentType)) {
    if (!isTextLike(contentType) && contentType) {
      throw new Error(`Unsupported content type: ${contentType}. For binary/non-text responses, use bash with curl.`);
    }
    const raw = await response.text();
    const rawBytes = byteLength(raw);
    const truncatedRaw = rawBytes > MAX_RAW_BYTES;
    const rawToUse = truncatedRaw ? sliceUtf8ByBytes(raw, 0, MAX_RAW_BYTES).content : raw;
    const warnings: string[] = [];
    if (truncatedRaw) warnings.push(`Raw response exceeded ${formatSize(MAX_RAW_BYTES)} and was truncated before processing; the tail is unavailable.`);

    let content = rawToUse;
    if (mode !== "raw" && /json/i.test(contentType)) {
      try {
        content = JSON.stringify(JSON.parse(rawToUse), null, 2);
      } catch {
        content = rawToUse;
      }
    }

    const returnedContent = mode === "raw" ? rawToUse : content;

    return {
      content: returnedContent,
      details: {
        url,
        finalUrl,
        contentType,
        statusCode: response.status,
        rawBytes,
        extractedBytes: byteLength(returnedContent),
      },
      links: [],
      warnings,
    };
  }

  const html = await response.text();
  const htmlBytes = byteLength(html);
  const truncatedHtml = htmlBytes > MAX_RAW_BYTES;
  const htmlToProcess = truncatedHtml ? sliceUtf8ByBytes(html, 0, MAX_RAW_BYTES).content : html;

  const { document } = parseHTML(htmlToProcess);
  const meta = extractMetadata(document, finalUrl);
  const links = extractLinks(document, finalUrl, MAX_LINKS);

  let content: string;

  if (mode === "raw") {
    content = htmlToProcess;
  } else if (mode === "text") {
    cleanDocument(document);
    content = normalizeText(document.body?.textContent ?? "");
  } else if (mode === "markdown") {
    cleanDocument(document);
    content = htmlToMarkdown(document.body?.innerHTML ?? "");
  } else {
    // readable
    const reader = new Readability(document as unknown as Document);
    const article = reader.parse();
    const articleHtml = article?.content;
    const articleText = article?.textContent;
    if (articleHtml && articleHtml.trim()) {
      content = htmlToMarkdown(articleHtml);
    } else if (articleText && articleText.trim()) {
      content = normalizeText(articleText);
    } else {
      // Readability failed (hostile/SPA/docs page) — fall back to structured markdown.
      const fallback = parseHTML(htmlToProcess);
      cleanDocument(fallback.document);
      content = htmlToMarkdown(fallback.document.body?.innerHTML ?? "");
    }
  }

  const warnings: string[] = [];
  if (truncatedHtml) warnings.push(`Raw HTML exceeded ${formatSize(MAX_RAW_BYTES)} and was truncated before extraction; the tail was not parsed.`);

  return {
    content,
    rawHtml: htmlBytes <= MAX_CACHE_RAW_BYTES ? html : undefined,
    details: {
      url,
      finalUrl,
      title: meta.title,
      siteName: meta.siteName,
      author: meta.author,
      description: meta.description,
      canonicalUrl: meta.canonicalUrl,
      contentType,
      statusCode: response.status,
      rawBytes: htmlBytes,
      extractedBytes: byteLength(content),
    },
    links,
    warnings,
  };
}

function cachePaths(hash: string): { dir: string; md: string; json: string; raw: string } {
  const dir = join(CACHE_DIR, hash.slice(0, 2), hash.slice(2, 4));
  return { dir, md: join(dir, `${hash}.md`), json: join(dir, `${hash}.json`), raw: join(dir, `${hash}.raw`) };
}

function cacheHash(url: string, mode: ExtractionMode): string {
  return createHash("sha256").update(`${url}\n${mode}`).digest("hex");
}

async function readCache(paths: { md: string; json: string }): Promise<CacheRecord | undefined> {
  try {
    const [metaRaw, content] = await Promise.all([readFile(paths.json, "utf8"), readFile(paths.md, "utf8")]);
    const meta = JSON.parse(metaRaw) as CacheMeta;
    if (!meta || typeof meta !== "object" || typeof content !== "string") return undefined;
    return { meta, content };
  } catch {
    return undefined;
  }
}

async function writeCache(paths: { dir: string; md: string; json: string; raw: string }, record: CacheRecord, rawHtml?: string): Promise<void> {
  try {
    await mkdir(paths.dir, { recursive: true });
    await Promise.all([
      writeFile(paths.md, record.content, "utf8"),
      writeFile(paths.json, JSON.stringify(record.meta, null, 2), "utf8"),
      ...(rawHtml ? [writeFile(paths.raw, rawHtml, "utf8")] : []),
    ]);
  } catch (error) {
    console.warn("[web-read] Failed to write cache:", error);
  }
}

function buildHeader(meta: CacheMeta, params: WebReadInput, includeMetadata: boolean): string {
  const lines: string[] = [];
  if (meta.title) lines.push(`# ${meta.title}`);
  else lines.push(`# ${meta.finalUrl}`);
  lines.push(`*Source: ${meta.finalUrl}*`);
  if (meta.siteName) lines.push(`*Site: ${meta.siteName}*`);
  if (meta.finalUrl !== meta.url) lines.push(`*Requested: ${meta.url}*`);
  if (includeMetadata) {
    if (meta.author) lines.push(`*Author: ${meta.author}*`);
    if (meta.description) lines.push(`*Description: ${meta.description}*`);
    if (meta.canonicalUrl && meta.canonicalUrl !== meta.finalUrl) lines.push(`*Canonical: ${meta.canonicalUrl}*`);
    if (meta.contentType) lines.push(`*Content-Type: ${meta.contentType}*`);
    lines.push(`*Extracted: ${formatSize(meta.extractedBytes)} (raw ${formatSize(meta.rawBytes)}), mode ${meta.mode}*`);
  }
  return lines.join("\n");
}

function formatLinks(links: Link[]): string {
  const lines = ["", "## Links", ""];
  for (const link of links) lines.push(link.text ? `- [${link.text}](${link.href})` : `- ${link.href}`);
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_read",
    label: "Web Read",
    description:
      "Fetch a URL and extract readable content as markdown. Strips navigation, ads, and boilerplate. " +
      `Supports modes (readable/markdown/text/raw), offset/limit chunking, and a local cache. ` +
      `PDFs are rejected with a pointer to pdf_read. Output is truncated to ${DEFAULT_OUTPUT_LINES} lines / ${formatSize(DEFAULT_OUTPUT_BYTES)} by default; full content is cached and its path returned when truncated.`,
    promptSnippet: "Fetch a URL and return extracted readable content as markdown.",
    promptGuidelines: [
      "Use web_read for readable web pages. Pass mode='markdown' for docs pages with code blocks/tables, mode='text' for plain text, mode='raw' for raw HTML.",
      "If output is truncated, use the returned fullOutputPath/cachePath with the read tool, or refetch with a larger offset/limit.",
      "For PDFs, use pdf_info/pdf_read instead.",
      "For API endpoints or raw JSON, use bash with curl, or web_read mode='raw'.",
      "Cite the finalUrl in details, not just the originally requested URL.",
    ],
    parameters: WebReadParams,

    async execute(_toolCallId, params, signal) {
      const mode = (params.mode ?? "readable") as ExtractionMode;
      const useCache = params.cache ?? true;
      const refresh = params.refresh ?? false;
      const includeLinks = params.includeLinks ?? false;
      const includeMetadata = params.includeMetadata ?? false;

      const hash = cacheHash(params.url, mode);
      const paths = cachePaths(hash);

      let fullContent: string | undefined;
      let meta: CacheMeta | undefined;
      let cachePath: string | undefined;

      if (useCache && !refresh) {
        const cached = await readCache(paths);
        if (cached && !(includeLinks && !Array.isArray(cached.meta.links))) {
          fullContent = cached.content;
          meta = cached.meta;
          cachePath = paths.md;
        }
      }

      let details: WebReadDetails;
      let links: Link[] = [];

      if (fullContent && meta) {
        const warnings = [...(meta.warnings ?? [])];
        if (refresh) warnings.push("Refresh requested but served from cache unexpectedly."); // shouldn't happen
        details = {
          url: meta.url,
          finalUrl: meta.finalUrl,
          title: meta.title,
          siteName: meta.siteName,
          author: meta.author,
          description: meta.description,
          canonicalUrl: meta.canonicalUrl,
          contentType: meta.contentType,
          statusCode: meta.statusCode,
          rawBytes: meta.rawBytes,
          extractedBytes: byteLength(fullContent),
          extractedChars: fullContent.length,
          truncated: false,
          extractionMode: mode,
          warnings,
          cachePath,
        };
        links = meta.links ?? [];
      } else {
        const extracted = await fetchAndExtract(params.url, mode, signal);
        fullContent = extracted.content;
        meta = {
          url: params.url,
          finalUrl: extracted.details.finalUrl,
          fetchedAt: Date.now(),
          contentType: extracted.details.contentType,
          statusCode: extracted.details.statusCode,
          title: extracted.details.title,
          siteName: extracted.details.siteName,
          author: extracted.details.author,
          description: extracted.details.description,
          canonicalUrl: extracted.details.canonicalUrl,
          mode,
          rawBytes: extracted.details.rawBytes,
          extractedBytes: extracted.details.extractedBytes,
          links: extracted.links,
          warnings: extracted.warnings,
        };
        links = extracted.links;

        if (useCache) {
          await writeCache(paths, { meta, content: fullContent }, extracted.rawHtml);
          cachePath = paths.md;
        }

        details = {
          url: extracted.details.url,
          finalUrl: extracted.details.finalUrl,
          title: extracted.details.title,
          siteName: extracted.details.siteName,
          author: extracted.details.author,
          description: extracted.details.description,
          canonicalUrl: extracted.details.canonicalUrl,
          contentType: extracted.details.contentType,
          statusCode: extracted.details.statusCode,
          rawBytes: extracted.details.rawBytes,
          extractedBytes: extracted.details.extractedBytes,
          extractedChars: fullContent.length,
          truncated: false,
          extractionMode: mode,
          warnings: [...extracted.warnings],
          cachePath,
        };
      }

      // Chunk + truncate. Offsets are UTF-8 byte offsets into fullContent, matching truncateHead's byte accounting.
      const start = params.offset ?? 0;
      const fullBytes = byteLength(fullContent);
      if (start > fullBytes) {
        details.warnings.push(`offset ${start} is beyond extracted content length ${formatSize(fullBytes)}; nothing to read.`);
      }
      const maxBytes = Math.min(params.maxLength ?? DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
      const limitBytes = Math.min(params.limit ?? maxBytes, MAX_OUTPUT_BYTES);
      const { content: window, bytes: windowBytes } = sliceUtf8ByBytes(fullContent, start, start + limitBytes);

      const truncation = truncateHead(window, { maxLines: DEFAULT_OUTPUT_LINES, maxBytes });
      let finalContent = truncation.content;

      if (truncation.firstLineExceedsLimit && finalContent.length === 0 && windowBytes > 0) {
        const partial = sliceUtf8ByBytes(window, 0, maxBytes);
        finalContent = partial.content;
        details.warnings.push("The first line exceeded maxLength; returned a partial line so offset chunking can progress.");
      }

      const consumedBytes = truncation.truncated ? byteLength(finalContent) : windowBytes;
      const nextOffset = start + consumedBytes;
      const moreAvailable = nextOffset < fullBytes;
      const truncated = truncation.truncated || moreAvailable;
      details.truncated = truncated;
      if (truncation.truncated) details.truncation = truncation;

      if (moreAvailable) {
        details.warnings.push(`More content available starting at offset ${nextOffset} (${formatSize(fullBytes - nextOffset)} remaining).`);
      }

      let fullOutputPath: string | undefined;
      if (truncated) {
        const tempDir = await mkdtemp(join(tmpdir(), "pi-web-read-"));
        fullOutputPath = join(tempDir, "content.md");
        await writeFile(fullOutputPath, fullContent, "utf8");
        details.fullOutputPath = fullOutputPath;

        const moreNote = moreAvailable ? ` Next chunk at offset=${nextOffset}.` : "";
        finalContent =
          finalContent +
          `\n\n---\n*[Content truncated: ${truncation.outputLines} of ~${truncation.totalLines} lines in window (${formatSize(byteLength(finalContent))} of ${formatSize(windowBytes)}; full extracted ${formatSize(fullBytes)}). Full output saved to: ${fullOutputPath}${moreNote}]*`;
      }

      // Build the returned output: header (only at offset 0) + window + optional links.
      const parts: string[] = [];
      if (start === 0) parts.push(buildHeader(meta, params, includeMetadata));
      parts.push(finalContent);
      if (includeLinks && links.length > 0 && start === 0) parts.push(formatLinks(links));

      if (includeLinks) details.links = links;

      return {
        content: [{ type: "text", text: parts.join("\n\n") }],
        details,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("web_read "));
      text += theme.fg("accent", `${args.url ?? ""}`);
      const mode = args.mode ?? "readable";
      text += theme.fg("dim", ` (${mode})`);
      if (args.offset) text += theme.fg("muted", ` offset=${args.offset}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);

      const details = result.details as WebReadDetails | undefined;
      if (!details) return new Text(theme.fg("dim", "No fetch details"), 0, 0);

      let text = "";
      if (details.title) text += theme.fg("accent", theme.bold(details.title));
      else text += theme.fg("accent", details.finalUrl ?? details.url);
      text += ` ${theme.fg("muted", `(${formatSize(details.extractedBytes)}${details.truncated ? ", truncated" : ""})`)}`;

      if (expanded) {
        if (details.siteName) text += `\n${theme.fg("dim", `site: ${details.siteName}`)}`;
        if (details.cachePath) text += `\n${theme.fg("dim", `cache: ${details.cachePath}`)}`;
        if (details.fullOutputPath) text += `\n${theme.fg("dim", `full: ${details.fullOutputPath}`)}`;
        if (details.warnings.length > 0) {
          for (const warning of details.warnings) text += `\n${theme.fg("warning", `- ${warning}`)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("web-read-test", {
    description: "Test web_read on a URL",
    handler: async (args, ctx) => {
      const url = args.trim() || "https://example.com";
      try {
        // Bypass cache for a fresh test.
        const result = await fetchAndExtract(url, "readable", ctx.signal);
        ctx.ui.notify(
          `OK (${result.details.statusCode}): "${result.details.title ?? "no title"}" — ${formatSize(result.details.extractedBytes)} extracted, ${formatSize(result.details.rawBytes)} raw, ${result.links.length} links`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Fetch failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("web-read-cache-clear", {
    description: "Clear the web_read cache",
    handler: async (_args, ctx) => {
      try {
        await stat(CACHE_DIR);
        await rm(CACHE_DIR, { recursive: true, force: true });
        ctx.ui.notify("Cleared web_read cache.", "info");
      } catch {
        ctx.ui.notify("No web_read cache directory found.", "info");
      }
    },
  });
}
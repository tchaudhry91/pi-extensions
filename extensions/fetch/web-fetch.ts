import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "typebox";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONTENT_BYTES = 500_000; // hard cap before parsing

const WebFetchParams = Type.Object({
  url: Type.String({ description: "URL to fetch and extract content from" }),
  maxLength: Type.Optional(
    Type.Integer({
      description: `Maximum characters of extracted content to return. Defaults to ${DEFAULT_MAX_BYTES} bytes (truncated by lines too).`,
      minimum: 100,
      maximum: 100_000,
    }),
  ),
});

type WebFetchInput = Static<typeof WebFetchParams>;

type WebFetchDetails = {
  url: string;
  finalUrl: string;
  title?: string;
  siteName?: string;
  contentLength: number;
  truncated: boolean;
  contentType?: string;
  statusCode: number;
};

const ENTITY_MAP: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: " ", ndash: "–", mdash: "—", lsquo: "'", rsquo: "'",
  ldquo: '"', rdquo: '"', hellip: "…", copy: "©", reg: "®",
  trade: "™", deg: "°", plusmn: "±", times: "×", divide: "÷",
};

function decodeEntities(text: string): string {
  return text.replace(/&([#\w]+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity.startsWith("#x") || entity.startsWith("#X")
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return isNaN(code) ? match : String.fromCodePoint(code);
    }
    return ENTITY_MAP[entity] ?? match;
  });
}

function htmlToMarkdown(html: string): string {
  // Normalize whitespace first
  let text = html
    .replace(/[\t ]+/g, " ")
    .replace(/\n\s*\n/g, "\n\n");

  // Block-level elements — add newlines around them
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

  // Headings
  text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, (_, c) => `\n\n# ${stripTags(c).trim()}\n\n`);
  text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, (_, c) => `\n\n## ${stripTags(c).trim()}\n\n`);
  text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gi, (_, c) => `\n\n### ${stripTags(c).trim()}\n\n`);
  text = text.replace(/<h4[^>]*>(.*?)<\/h4>/gi, (_, c) => `\n\n#### ${stripTags(c).trim()}\n\n`);
  text = text.replace(/<h[56][^>]*>(.*?)<\/h[56]>/gi, (_, c) => `\n\n**${stripTags(c).trim()}**\n\n`);

  // Bold / italic
  text = text.replace(/<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gi, (_, __, c) => `**${stripTags(c)}**`);
  text = text.replace(/<(em|i)[^>]*>(.*?)<\/(em|i)>/gi, (_, __, c) => `*${stripTags(c)}*`);

  // Code (inline and block)
  text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, (_, c) => `\`${stripTags(c)}\``);
  text = text.replace(/<pre[^>]*>\s*<code[^>]*>(.*?)<\/code>\s*<\/pre>/gi, (_, c) => `\n\n\`\`\`\n${stripTags(c)}\n\`\`\`\n\n`);
  text = text.replace(/<pre[^>]*>(.*?)<\/pre>/gi, (_, c) => `\n\n\`\`\`\n${stripTags(c)}\n\`\`\`\n\n`);

  // Links
  text = text.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, (_, url, content) => {
    const label = stripTags(content).trim();
    return label ? `[${label}](${url})` : url;
  });

  // Images
  text = text.replace(/<img[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi, (_, src, alt) => `![${alt || ""}](${src})`);
  text = text.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*>/gi, (_, alt, src) => `![${alt || ""}](${src})`);

  // Blockquotes
  text = text.replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gi, (_, c) =>
    `\n\n${stripTags(c).trim().split("\n").map((l: string) => `> ${l}`).join("\n")}\n\n`);

  // List items
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, (_, c) => `- ${stripTags(c).trim()}`);

  // Strip remaining tags
  text = stripTags(text);

  // Decode entities
  text = decodeEntities(text);

  // Collapse whitespace
  text = text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \t]+/gm, "")
    .trim();

  return text;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

async function fetchAndExtract(url: string): Promise<{ content: string; details: WebFetchDetails }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; pi-web-fetch/1.0)",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });
  } finally {
    clearTimeout(timeout);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml");

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  if (!isHtml) {
    // For plain text content, return as-is
    const text = await response.text();
    const truncated = text.length > MAX_CONTENT_BYTES;
    const content = truncated ? text.slice(0, MAX_CONTENT_BYTES) : text;

    return {
      content,
      details: {
        url,
        finalUrl: response.url,
        contentType,
        statusCode: response.status,
        contentLength: text.length,
        truncated,
      },
    };
  }

  const html = await response.text();
  const htmlToProcess = html.length > MAX_CONTENT_BYTES ? html.slice(0, MAX_CONTENT_BYTES) : html;

  // Parse with linkedom and extract with Readability
  const doc = parseHTML(htmlToProcess);
  const reader = new Readability(doc.document as unknown as Document);
  const article = reader.parse();

  let content: string;
  let title: string | undefined;
  let siteName: string | undefined;

  if (article) {
    title = article.title ?? undefined;
    siteName = article.siteName ?? undefined;
    content = article.textContent ?? "";

    // If readability gave us HTML content instead of text, convert it
    if (article.content && !content) {
      content = htmlToMarkdown(article.content);
    }
  } else {
    // Fallback: strip tags from body
    content = htmlToMarkdown(htmlToProcess);
  }

  // Build a header with metadata
  const header: string[] = [];
  if (title) header.push(`# ${title}`);
  if (siteName) header.push(`*Source: ${siteName}*`);
  if (url !== response.url) header.push(`*Redirected to: ${response.url}*`);
  if (html.length > MAX_CONTENT_BYTES) header.push(`*(Content truncated at ${formatSize(MAX_CONTENT_BYTES)} during fetch)*`);

  const fullContent = header.length > 0 ? `${header.join("\n")}\n\n${content}` : content;

  return {
    content: fullContent,
    details: {
      url,
      finalUrl: response.url,
      title,
      siteName,
      contentType,
      statusCode: response.status,
      contentLength: html.length,
      truncated: html.length > MAX_CONTENT_BYTES || content.length > (article?.textContent?.length ?? MAX_CONTENT_BYTES),
    },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and extract readable content as markdown. Strips navigation, ads, and boilerplate. Returns clean article text.",
    promptSnippet: "Fetch a URL and return extracted readable content as markdown.",
    promptGuidelines: [
      "Use web_fetch when you need to read the contents of a URL the user provided, or when search results suggest a specific page has relevant information.",
      "When using web_fetch results, cite the source URL in your answer.",
      "web_fetch works best on article/news/blog pages. For API endpoints or raw data, use bash with curl instead.",
    ],
    parameters: WebFetchParams,

    async execute(_toolCallId, params, signal) {
      const result = await fetchAndExtract(params.url);

      // Truncate with pi's built-in truncation
      const maxBytes = params.maxLength ?? DEFAULT_MAX_BYTES;
      const head = truncateHead(result.content, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes,
      });

      let finalContent: string;
      if (head.truncated) {
        result.details.truncated = true;
        finalContent = `${head.content}\n\n---\n*[Content truncated: ${head.outputLines} of ~${head.totalLines} lines (${formatSize(head.outputBytes)} of ${formatSize(head.totalBytes)})]*`;
      } else {
        finalContent = head.content;
      }

      return {
        content: [{ type: "text", text: finalContent }],
        details: result.details,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("web_fetch "));
      text += theme.fg("accent", `${args.url ?? ""}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);

      const details = result.details as WebFetchDetails | undefined;
      if (!details) return new Text(theme.fg("dim", "No fetch details"), 0, 0);

      let text = "";
      if (details.title) {
        text += theme.fg("accent", theme.bold(details.title));
      } else {
        text += theme.fg("accent", details.url);
      }
      text += ` ${theme.fg("muted", `(${formatSize(details.contentLength)}${details.truncated ? ", truncated" : ""})`)}`;

      if (expanded) {
        const content = result.content;
        if (Array.isArray(content)) {
          const textBlock = content.find((b): b is { type: "text"; text: string } => b.type === "text");
          if (textBlock) {
            const preview = textBlock.text.slice(0, 300);
            text += `\n${theme.fg("dim", preview)}${textBlock.text.length > 300 ? "..." : ""}`;
          }
        }
      }

      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("web-fetch-test", {
    description: "Test web_fetch on a URL",
    handler: async (args, ctx) => {
      const url = args.trim() || "https://example.com";
      try {
        const result = await fetchAndExtract(url);
        ctx.ui.notify(
          `OK (${result.details.statusCode}): "${result.details.title ?? "no title"}" — ${formatSize(result.details.contentLength)}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Fetch failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

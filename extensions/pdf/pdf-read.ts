import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, TruncationResult } from "@earendil-works/pi-coding-agent";
import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const DEFAULT_OUTPUT_BYTES = 150_000;
const DEFAULT_OUTPUT_LINES = 8_000;
const MAX_OUTPUT_BYTES = 500_000;

const DEFAULT_OCR_MODEL = "minimax-m3";
const DEFAULT_OCR_DPI = 180;
const DEFAULT_MAX_OCR_PAGES = 5;
const MAX_OCR_PAGES = 20;

const MAX_PDF_BYTES = 75 * 1024 * 1024;
const PDF_FETCH_TIMEOUT_MS = 30_000;
const PDFINFO_TIMEOUT_MS = 15_000;
const PDFTOTEXT_TIMEOUT_MS = 60_000;
const PDF_RENDER_TIMEOUT_MS = 60_000;
const OCR_TIMEOUT_MS = 120_000;

const PDF_OCR_MODEL_ENV = "PDF_OCR_MODEL";
const PDF_OCR_BASE_URL_ENV = "PDF_OCR_BASE_URL";
const PDF_OCR_API_KEY_ENV = "PDF_OCR_API_KEY";
const OLLAMA_CLOUD_API_KEY_ENV = "OLLAMA_CLOUD_API_KEY";
const OLLAMA_API_KEY_ENV = "OLLAMA_API_KEY";

const DEFAULT_OCR_PROMPT = [
  "OCR this PDF page.",
  "Preserve reading order, headings, lists, tables, forms, and visible figure text.",
  "Return markdown only. Do not summarize. If text is unclear, mark it as [unclear].",
].join(" ");

const SourceParams = {
  path: Type.Optional(Type.String({ description: "Local PDF path. Paths are resolved relative to the current working directory. A leading @ is ignored." })),
  url: Type.Optional(Type.String({ description: "HTTP(S) URL of a PDF to download and read" })),
};

const PdfInfoParams = Type.Object(SourceParams);

const PdfReadParams = Type.Object({
  ...SourceParams,
  pages: Type.Optional(
    Type.String({
      description: "Optional pages to read, e.g. '1', '1-3', or '1-3,7,10-12'. If omitted, pdftotext reads the whole PDF; OCR is capped by maxOcrPages.",
    }),
  ),
  mode: Type.Optional(
    StringEnum(["auto", "text", "ocr", "both"] as const, {
      description: "auto: pdftotext first, OCR only if extracted text is sparse. text: pdftotext only. ocr: OCR selected pages only. both: run both pdftotext and OCR.",
    }),
  ),
  maxLength: Type.Optional(
    Type.Integer({
      description: `Maximum characters of output to return. Defaults to ${DEFAULT_OUTPUT_BYTES} bytes (${(DEFAULT_OUTPUT_BYTES / 1024).toFixed(0)} KB).`,
      minimum: 100,
      maximum: MAX_OUTPUT_BYTES,
    }),
  ),
  maxOcrPages: Type.Optional(
    Type.Integer({
      description: `Maximum pages to send to the OCR model when OCR is used. Defaults to ${DEFAULT_MAX_OCR_PAGES}; hard cap ${MAX_OCR_PAGES}.`,
      minimum: 1,
      maximum: MAX_OCR_PAGES,
    }),
  ),
  dpi: Type.Optional(
    Type.Integer({
      description: `DPI for rendering PDF pages before OCR. Defaults to ${DEFAULT_OCR_DPI}.`,
      minimum: 72,
      maximum: 300,
    }),
  ),
  ocrModel: Type.Optional(Type.String({ description: `Ollama Cloud multimodal model for OCR. Defaults to ${PDF_OCR_MODEL_ENV} or ${DEFAULT_OCR_MODEL}.` })),
  ocrPrompt: Type.Optional(Type.String({ description: "Custom OCR prompt. Defaults to a markdown transcription prompt." })),
});

type PdfInfoInput = Static<typeof PdfInfoParams>;
type PdfReadInput = Static<typeof PdfReadParams>;
type PdfReadMode = NonNullable<PdfReadInput["mode"]>;

type PreparedPdf = {
  sourceType: "path" | "url";
  source: string;
  displayName: string;
  filePath: string;
  tempDir?: string;
  finalUrl?: string;
  contentType?: string;
  downloadBytes?: number;
};

type ParsedPdfInfo = {
  raw: string;
  fields: Record<string, string>;
  pages?: number;
  title?: string;
  author?: string;
  creator?: string;
  producer?: string;
  encrypted?: string;
  pageSize?: string;
};

type OcrPageResult = {
  page: number;
  text: string;
  imagePath: string;
};

type PdfReadDetails = {
  sourceType: "path" | "url";
  source: string;
  finalUrl?: string;
  contentType?: string;
  downloadBytes?: number;
  mode: PdfReadMode;
  pageCount?: number;
  requestedPages?: string;
  textPages?: number[];
  textChars: number;
  ocrUsed: boolean;
  ocrModel?: string;
  ocrPages?: number[];
  dpi?: number;
  warnings: string[];
  truncated: boolean;
  truncation?: TruncationResult;
  fullOutputPath?: string;
};

function stripAtPrefix(path: string): string {
  return path.trim().replace(/^@/, "");
}

function normalizeLocalPath(rawPath: string, cwd: string): string {
  return resolve(cwd, stripAtPrefix(rawPath));
}

function validateSource(params: { path?: string; url?: string }): { type: "path"; value: string } | { type: "url"; value: string } {
  const path = params.path?.trim();
  const url = params.url?.trim();
  if (path && url) throw new Error("Provide either path or url, not both.");
  if (!path && !url) throw new Error("Provide a PDF path or URL.");

  if (url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("PDF URL must use http or https.");
    return { type: "url", value: url };
  }

  return { type: "path", value: path! };
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

async function downloadPdf(url: string, signal?: AbortSignal): Promise<PreparedPdf> {
  const { signal: fetchSignal, cleanup } = timeoutSignal(signal, PDF_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: fetchSignal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; pi-pdf-read/1.0)",
        Accept: "application/pdf,*/*;q=0.8",
      },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_PDF_BYTES) {
      throw new Error(`PDF is too large (${formatSize(contentLength)}; limit ${formatSize(MAX_PDF_BYTES)})`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PDF_BYTES) {
      throw new Error(`PDF is too large (${formatSize(bytes.byteLength)}; limit ${formatSize(MAX_PDF_BYTES)})`);
    }

    const tempDir = await mkdtemp(join(tmpdir(), "pi-pdf-"));
    const filePath = join(tempDir, "download.pdf");
    await writeFile(filePath, bytes);

    return {
      sourceType: "url",
      source: url,
      displayName: response.url,
      filePath,
      tempDir,
      finalUrl: response.url,
      contentType: response.headers.get("content-type") ?? undefined,
      downloadBytes: bytes.byteLength,
    };
  } finally {
    cleanup();
  }
}

async function preparePdf(params: { path?: string; url?: string }, cwd: string, signal?: AbortSignal): Promise<PreparedPdf> {
  const source = validateSource(params);
  if (source.type === "url") return downloadPdf(source.value, signal);

  const filePath = normalizeLocalPath(source.value, cwd);
  return {
    sourceType: "path",
    source: source.value,
    displayName: source.value,
    filePath,
  };
}

function parsePdfInfo(raw: string): ParsedPdfInfo {
  const fields: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/g)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    fields[match[1]!.trim()] = match[2]!.trim();
  }

  const pages = Number(fields.Pages);
  return {
    raw,
    fields,
    pages: Number.isInteger(pages) && pages > 0 ? pages : undefined,
    title: fields.Title,
    author: fields.Author,
    creator: fields.Creator,
    producer: fields.Producer,
    encrypted: fields.Encrypted,
    pageSize: fields["Page size"],
  };
}

async function runPdfInfo(pi: ExtensionAPI, pdfPath: string, signal?: AbortSignal): Promise<ParsedPdfInfo> {
  const result = await pi.exec("pdfinfo", [pdfPath], { signal, timeout: PDFINFO_TIMEOUT_MS });
  if (result.code !== 0) {
    throw new Error(`pdfinfo failed (${result.code}): ${result.stderr || result.stdout || "unknown error"}`);
  }
  return parsePdfInfo(result.stdout);
}

function parsePageSpec(spec: string | undefined, totalPages: number | undefined): number[] | undefined {
  if (!spec?.trim()) return undefined;

  const pages = new Set<number>();
  for (const rawPart of spec.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;

    const match = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error(`Invalid page range: ${part}`);

    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (start < 1 || end < 1 || end < start) throw new Error(`Invalid page range: ${part}`);
    if (totalPages && end > totalPages) throw new Error(`Page range ${part} exceeds PDF page count (${totalPages})`);

    for (let page = start; page <= end; page += 1) pages.add(page);
  }

  const sorted = [...pages].sort((a, b) => a - b);
  if (sorted.length === 0) throw new Error(`Invalid empty page range: ${spec}`);
  return sorted;
}

function groupContiguousPages(pages: number[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const page of pages) {
    const last = ranges[ranges.length - 1];
    if (last && page === last.end + 1) {
      last.end = page;
    } else {
      ranges.push({ start: page, end: page });
    }
  }
  return ranges;
}

function pageLabel(start: number, end: number): string {
  return start === end ? `Page ${start}` : `Pages ${start}-${end}`;
}

function normalizePdfText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\f+/g, "\n\n---\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

async function runPdftotext(pi: ExtensionAPI, pdfPath: string, pages: number[] | undefined, signal?: AbortSignal): Promise<string> {
  if (!pages) {
    const result = await pi.exec("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, "-"], { signal, timeout: PDFTOTEXT_TIMEOUT_MS });
    if (result.code !== 0) throw new Error(`pdftotext failed (${result.code}): ${result.stderr || result.stdout || "unknown error"}`);
    return normalizePdfText(result.stdout);
  }

  const chunks: string[] = [];
  for (const range of groupContiguousPages(pages)) {
    const result = await pi.exec(
      "pdftotext",
      ["-layout", "-enc", "UTF-8", "-f", String(range.start), "-l", String(range.end), pdfPath, "-"],
      { signal, timeout: PDFTOTEXT_TIMEOUT_MS },
    );
    if (result.code !== 0) throw new Error(`pdftotext failed for ${pageLabel(range.start, range.end)} (${result.code}): ${result.stderr || result.stdout || "unknown error"}`);

    const text = normalizePdfText(result.stdout);
    chunks.push(`## ${pageLabel(range.start, range.end)}\n\n${text || "[No extractable text found]"}`);
  }

  return chunks.join("\n\n").trim();
}

function isSparseText(text: string, pageCount: number | undefined): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 100) return true;
  if (pageCount && compact.length / pageCount < 50) return true;
  return false;
}

function getOcrModel(params: PdfReadInput): string {
  return params.ocrModel?.trim() || process.env[PDF_OCR_MODEL_ENV]?.trim() || DEFAULT_OCR_MODEL;
}

function getOcrApiKey(): string | undefined {
  return process.env[PDF_OCR_API_KEY_ENV] || process.env[OLLAMA_CLOUD_API_KEY_ENV] || process.env[OLLAMA_API_KEY_ENV];
}

function getOcrBaseUrl(): string {
  const configured = process.env[PDF_OCR_BASE_URL_ENV]?.trim() || process.env.OLLAMA_CLOUD_BASE_URL?.trim() || process.env.OLLAMA_API_BASE?.trim() || "https://ollama.com";
  const withProtocol = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
  const trimmed = withProtocol.replace(/\/+$/g, "");
  if (/\/v1$/i.test(trimmed)) return trimmed;
  return `${trimmed.replace(/\/api$/i, "")}/v1`;
}

async function renderPageToPng(pi: ExtensionAPI, pdfPath: string, page: number, dpi: number, tempDir: string, signal?: AbortSignal): Promise<string> {
  const prefix = join(tempDir, "page");
  const result = await pi.exec("pdftoppm", ["-r", String(dpi), "-png", "-f", String(page), "-l", String(page), pdfPath, prefix], {
    signal,
    timeout: PDF_RENDER_TIMEOUT_MS,
  });
  if (result.code !== 0) throw new Error(`pdftoppm failed for page ${page} (${result.code}): ${result.stderr || result.stdout || "unknown error"}`);
  return join(tempDir, `page-${page}.png`);
}

function extractChatText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;

  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return undefined;
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : undefined;
      })
      .filter((part): part is string => Boolean(part))
      .join("\n")
      .trim();
  }
  return "";
}

async function callOcrModel(imagePath: string, model: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const apiKey = getOcrApiKey();
  if (!apiKey) {
    throw new Error(`No OCR API key found. Set ${PDF_OCR_API_KEY_ENV}, ${OLLAMA_CLOUD_API_KEY_ENV}, or ${OLLAMA_API_KEY_ENV}.`);
  }

  const image = await readFile(imagePath);
  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/png;base64,${image.toString("base64")}` } },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 4096,
    stream: false,
  };

  const { signal: fetchSignal, cleanup } = timeoutSignal(signal, OCR_TIMEOUT_MS);
  try {
    const response = await fetch(`${getOcrBaseUrl()}/chat/completions`, {
      method: "POST",
      signal: fetchSignal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const message = payload && typeof payload === "object" && "error" in payload ? JSON.stringify((payload as { error?: unknown }).error) : responseText.slice(0, 500);
      throw new Error(`OCR model request failed: HTTP ${response.status} ${response.statusText}${message ? ` - ${message}` : ""}`);
    }

    const text = extractChatText(payload);
    if (!text) throw new Error(`OCR model ${model} returned no text`);
    return text;
  } finally {
    cleanup();
  }
}

function selectOcrPages(pages: number[] | undefined, totalPages: number | undefined, maxOcrPages: number, warnings: string[]): number[] {
  const requested = pages ?? Array.from({ length: Math.min(totalPages ?? maxOcrPages, maxOcrPages) }, (_, index) => index + 1);
  if (requested.length <= maxOcrPages) return requested;

  const selected = requested.slice(0, maxOcrPages);
  warnings.push(`OCR limited to ${selected.length} of ${requested.length} requested page(s). Pass pages/maxOcrPages to control this.`);
  return selected;
}

async function runOcr(
  pi: ExtensionAPI,
  pdf: PreparedPdf,
  pages: number[],
  dpi: number,
  model: string,
  prompt: string,
  signal: AbortSignal | undefined,
  onUpdate: ((text: string) => void) | undefined,
): Promise<OcrPageResult[]> {
  const tempDir = pdf.tempDir ?? (await mkdtemp(join(tmpdir(), "pi-pdf-ocr-")));
  const results: OcrPageResult[] = [];

  for (const [index, page] of pages.entries()) {
    onUpdate?.(`Rendering page ${page} for OCR (${index + 1}/${pages.length})...`);
    const imagePath = await renderPageToPng(pi, pdf.filePath, page, dpi, tempDir, signal);

    onUpdate?.(`OCR page ${page} with ${model} (${index + 1}/${pages.length})...`);
    const text = await callOcrModel(imagePath, model, prompt, signal);
    results.push({ page, text, imagePath });
  }

  return results;
}

function formatPdfInfo(pdf: PreparedPdf, info: ParsedPdfInfo): string {
  const lines: string[] = [];
  lines.push(`PDF info: ${pdf.displayName}`);
  if (pdf.finalUrl && pdf.finalUrl !== pdf.source) lines.push(`Final URL: ${pdf.finalUrl}`);
  if (pdf.contentType) lines.push(`Content-Type: ${pdf.contentType}`);
  if (pdf.downloadBytes !== undefined) lines.push(`Downloaded: ${formatSize(pdf.downloadBytes)}`);
  lines.push("");
  lines.push(info.raw.trim() || "No pdfinfo output.");
  return lines.join("\n").trim();
}

function formatReadOutput(
  pdf: PreparedPdf,
  info: ParsedPdfInfo | undefined,
  mode: PdfReadMode,
  text: string | undefined,
  ocrResults: OcrPageResult[],
  model: string | undefined,
  warnings: string[],
): string {
  const lines: string[] = [];
  lines.push(`# PDF: ${pdf.displayName}`);
  if (pdf.finalUrl && pdf.finalUrl !== pdf.source) lines.push(`*Redirected to: ${pdf.finalUrl}*`);
  if (info?.title) lines.push(`*Title: ${info.title}*`);
  if (info?.author) lines.push(`*Author: ${info.author}*`);
  if (info?.pages) lines.push(`*Pages: ${info.pages}*`);
  lines.push(`*Mode: ${mode}${ocrResults.length > 0 ? ` + OCR (${model})` : ""}*`);

  if (warnings.length > 0) {
    lines.push("", "## Warnings");
    for (const warning of warnings) lines.push(`- ${warning}`);
  }

  if (text !== undefined) {
    lines.push("", "## Text extracted by pdftotext", "", text || "[No extractable text found]");
  }

  if (ocrResults.length > 0) {
    lines.push("", `## OCR via ${model}`);
    for (const result of ocrResults) {
      lines.push("", `### Page ${result.page}`, "", result.text.trim() || "[No OCR text returned]");
    }
  }

  return lines.join("\n").trim();
}

async function truncateOutput(content: string, maxBytes: number, details: PdfReadDetails): Promise<string> {
  const truncation = truncateHead(content, {
    maxLines: DEFAULT_OUTPUT_LINES,
    maxBytes,
  });

  if (!truncation.truncated) return truncation.content;

  const tempDir = await mkdtemp(join(tmpdir(), "pi-pdf-output-"));
  const fullOutputPath = join(tempDir, "pdf-read.md");
  await writeFile(fullOutputPath, content, "utf8");

  details.truncated = true;
  details.truncation = truncation;
  details.fullOutputPath = fullOutputPath;

  return `${truncation.content}\n\n---\n*[PDF output truncated: ${truncation.outputLines} of ~${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(
    truncation.totalBytes,
  )}). Full output saved to: ${fullOutputPath}]*`;
}

function detailsFor(pdf: PreparedPdf, mode: PdfReadMode, info: ParsedPdfInfo | undefined, params: PdfReadInput): PdfReadDetails {
  return {
    sourceType: pdf.sourceType,
    source: pdf.source,
    finalUrl: pdf.finalUrl,
    contentType: pdf.contentType,
    downloadBytes: pdf.downloadBytes,
    mode,
    pageCount: info?.pages,
    requestedPages: params.pages,
    textChars: 0,
    ocrUsed: false,
    warnings: [],
    truncated: false,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "pdf_info",
    label: "PDF Info",
    description: "Read PDF metadata/page count using pdfinfo. Accepts a local PDF path or HTTP(S) PDF URL.",
    promptSnippet: "Inspect PDF metadata and page counts before extracting large PDFs.",
    promptGuidelines: [
      "Use pdf_info to inspect PDF page counts and metadata before reading or OCRing large PDFs.",
    ],
    parameters: PdfInfoParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const pdf = await preparePdf(params, ctx.cwd, signal);
      const info = await runPdfInfo(pi, pdf.filePath, signal);
      return {
        content: [{ type: "text", text: formatPdfInfo(pdf, info) }],
        details: { ...pdf, info },
      };
    },

    renderCall(args, theme) {
      const target = typeof args.path === "string" ? args.path : typeof args.url === "string" ? args.url : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("pdf_info "))}${theme.fg("accent", target)}`, 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Reading PDF info..."), 0, 0);
      const details = result.details as { displayName?: string; info?: ParsedPdfInfo } | undefined;
      const name = details?.displayName ?? "PDF";
      const pages = details?.info?.pages ? ` (${details.info.pages} pages)` : "";
      return new Text(theme.fg("accent", `${name}${pages}`), 0, 0);
    },
  });

  pi.registerTool({
    name: "pdf_read",
    label: "PDF Read",
    description:
      `Extract text from PDFs with pdftotext, optionally OCRing rendered pages via Ollama Cloud ${DEFAULT_OCR_MODEL}. ` +
      `Accepts a local PDF path or URL. Output is truncated to ${DEFAULT_OUTPUT_LINES} lines or ${formatSize(DEFAULT_OUTPUT_BYTES)} by default.`,
    promptSnippet: "Read local or remote PDFs using pdftotext with optional Ollama Cloud OCR for scanned/image-heavy pages.",
    promptGuidelines: [
      "Use pdf_read for .pdf files or PDF URLs; built-in read does not parse PDF contents.",
      "Use pdf_read mode 'auto' first for PDFs. Use mode 'ocr' or 'both' when pdftotext output is empty, scanned, image-heavy, table-heavy, or layout-critical.",
      "When OCRing with pdf_read, pass a narrow pages range when possible because OCR sends rendered pages to an online model.",
    ],
    parameters: PdfReadParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const mode = params.mode ?? "auto";
      const maxOcrPages = Math.min(params.maxOcrPages ?? DEFAULT_MAX_OCR_PAGES, MAX_OCR_PAGES);
      const dpi = params.dpi ?? DEFAULT_OCR_DPI;
      const pdf = await preparePdf(params, ctx.cwd, signal);

      onUpdate?.({ content: [{ type: "text", text: "Inspecting PDF..." }], details: { source: pdf.source } });

      let info: ParsedPdfInfo | undefined;
      const warnings: string[] = [];
      try {
        info = await runPdfInfo(pi, pdf.filePath, signal);
      } catch (error) {
        warnings.push(`pdfinfo failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      const pages = parsePageSpec(params.pages, info?.pages);
      const details = detailsFor(pdf, mode, info, params);
      details.warnings = warnings;

      let text: string | undefined;
      let textError: Error | undefined;
      if (mode !== "ocr") {
        onUpdate?.({ content: [{ type: "text", text: "Extracting text with pdftotext..." }], details });
        try {
          text = await runPdftotext(pi, pdf.filePath, pages, signal);
          details.textChars = text.length;
          details.textPages = pages;
        } catch (error) {
          textError = error instanceof Error ? error : new Error(String(error));
          if (mode === "text") throw textError;
          warnings.push(`pdftotext failed; falling back to OCR: ${textError.message}`);
        }
      }

      const selectedTextPageCount = pages?.length ?? info?.pages;
      const shouldOcr = mode === "ocr" || mode === "both" || (mode === "auto" && (!text || isSparseText(text, selectedTextPageCount)));

      let ocrResults: OcrPageResult[] = [];
      let ocrModel: string | undefined;
      if (shouldOcr) {
        ocrModel = getOcrModel(params);
        const ocrPages = selectOcrPages(pages, info?.pages, maxOcrPages, warnings);
        details.ocrUsed = true;
        details.ocrModel = ocrModel;
        details.ocrPages = ocrPages;
        details.dpi = dpi;

        const prompt = params.ocrPrompt?.trim() || DEFAULT_OCR_PROMPT;
        ocrResults = await runOcr(
          pi,
          pdf,
          ocrPages,
          dpi,
          ocrModel,
          prompt,
          signal,
          (message) => onUpdate?.({ content: [{ type: "text", text: message }], details }),
        );
      }

      if (mode === "auto" && text && !shouldOcr) {
        warnings.push("OCR was not used because pdftotext extracted enough text. Re-run with mode 'ocr' or 'both' for OCR.");
      }

      const output = formatReadOutput(pdf, info, mode, text, ocrResults, ocrModel, warnings);
      const finalContent = await truncateOutput(output, params.maxLength ?? DEFAULT_OUTPUT_BYTES, details);

      return {
        content: [{ type: "text", text: finalContent }],
        details,
      };
    },

    renderCall(args, theme) {
      const target = typeof args.path === "string" ? args.path : typeof args.url === "string" ? args.url : "";
      const mode = typeof args.mode === "string" ? args.mode : "auto";
      let text = theme.fg("toolTitle", theme.bold("pdf_read "));
      text += theme.fg("accent", target);
      if (args.pages) text += theme.fg("muted", ` pages ${args.pages}`);
      text += theme.fg("dim", ` (${mode})`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        const content = Array.isArray(result.content) ? result.content.find((block): block is { type: "text"; text: string } => block.type === "text") : undefined;
        return new Text(theme.fg("warning", content?.text ?? "Reading PDF..."), 0, 0);
      }

      const details = result.details as PdfReadDetails | undefined;
      if (!details) return new Text(theme.fg("dim", "No PDF details"), 0, 0);

      const label = details.sourceType === "path" ? basename(details.source) : details.finalUrl ?? details.source;
      let text = theme.fg("accent", label);
      if (details.pageCount) text += theme.fg("muted", ` (${details.pageCount} pages)`);
      text += details.ocrUsed ? theme.fg("success", ` OCR:${details.ocrModel}`) : theme.fg("muted", " pdftotext");
      if (details.truncated) text += theme.fg("warning", " truncated");
      if (details.warnings.length > 0) text += theme.fg("warning", ` ${details.warnings.length} warning(s)`);

      if (expanded) {
        text += `\n${theme.fg("dim", `chars: ${details.textChars}; mode: ${details.mode}`)}`;
        if (details.ocrPages?.length) text += `\n${theme.fg("dim", `OCR pages: ${details.ocrPages.join(", ")}`)}`;
        if (details.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
        for (const warning of details.warnings) text += `\n${theme.fg("warning", `- ${warning}`)}`;
      }

      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("pdf-ocr-test", {
    description: `Test Ollama Cloud PDF OCR with ${DEFAULT_OCR_MODEL}`,
    handler: async (_args, ctx) => {
      const key = getOcrApiKey();
      if (!key) {
        ctx.ui.notify(`No OCR API key found. Set ${PDF_OCR_API_KEY_ENV}, ${OLLAMA_CLOUD_API_KEY_ENV}, or ${OLLAMA_API_KEY_ENV}.`, "error");
        return;
      }
      ctx.ui.notify(`PDF OCR configured: ${getOcrBaseUrl()} with model ${process.env[PDF_OCR_MODEL_ENV] ?? DEFAULT_OCR_MODEL}`, "info");
    },
  });
}

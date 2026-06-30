import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PROVIDER = "qe93";
const PROVIDER_NAME = "QE93 Local Ollama";
const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const BASE_URL_ENV_PRIMARY = "QE93_OLLAMA_BASE_URL";
const BASE_URL_ENV_FALLBACK = "QE93_OLLAMA_HOST";
const API_KEY_ENV = "QE93_OLLAMA_API_KEY";
const REQUIRE_TOOLS_ENV = "QE93_OLLAMA_REQUIRE_TOOLS";
const DISCOVERY_TIMEOUT_MS = 5_000;
const CACHE_FILE = join(getAgentDir(), "cache", "qe93-ollama-models.json");

const QE93_COMPAT: NonNullable<ProviderModelConfig["compat"]> = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  maxTokensField: "max_tokens",
  supportsStrictMode: false,
  supportsLongCacheRetention: false,
};

const OLLAMA_THINKING_LEVELS: NonNullable<ProviderModelConfig["thinkingLevelMap"]> = {
  off: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

type OllamaTagsResponse = {
  models?: Array<{
    name?: unknown;
    model?: unknown;
    details?: OllamaModelDetails;
    capabilities?: unknown;
  }>;
};

type OllamaModelDetails = {
  family?: unknown;
  families?: unknown;
  parameter_size?: unknown;
  quantization_level?: unknown;
  context_length?: unknown;
};

type OllamaShowResponse = {
  details?: OllamaModelDetails;
  model_info?: Record<string, unknown>;
  capabilities?: unknown;
};

type CachedModels = {
  baseUrl: string;
  timestamp: number;
  models: Record<string, OllamaShowResponse>;
};

function normalizeBaseUrl(url: string): string {
  const withProtocol = /^https?:\/\//i.test(url) ? url : `http://${url}`;
  return withProtocol.replace(/\/+$/, "").replace(/\/(api|v1)$/i, "");
}

function configuredBaseUrl(): string {
  return normalizeBaseUrl(process.env[BASE_URL_ENV_PRIMARY]?.trim() || process.env[BASE_URL_ENV_FALLBACK]?.trim() || DEFAULT_BASE_URL);
}

function providerApiKeyValue(): string {
  return process.env[API_KEY_ENV] ? `$${API_KEY_ENV}` : "ollama";
}

function discoveryHeaders(): Record<string, string> {
  const key = process.env[API_KEY_ENV];
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function requireTools(): boolean {
  const configured = process.env[REQUIRE_TOOLS_ENV]?.trim().toLowerCase();
  return configured !== "0" && configured !== "false" && configured !== "no";
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getCapabilities(data: OllamaShowResponse): string[] {
  return Array.isArray(data.capabilities) ? data.capabilities.filter((item): item is string => typeof item === "string") : [];
}

function getContextWindow(data: OllamaShowResponse): number {
  const detailsContext = data.details?.context_length;
  if (typeof detailsContext === "number" && Number.isFinite(detailsContext)) return detailsContext;

  for (const [key, value] of Object.entries(data.model_info ?? {})) {
    if (key.endsWith(".context_length") && typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return 128_000;
}

function displayName(id: string, data: OllamaShowResponse): string {
  const parameterSize = asString(data.details?.parameter_size);
  const quantization = asString(data.details?.quantization_level);
  const suffix = [parameterSize, quantization].filter(Boolean).join(" ");
  const prefix = id
    .replace(/:latest$/i, "")
    .replace(/[-_:]+/g, " ")
    .replace(/\bgpt\b/gi, "GPT")
    .replace(/\bglm\b/gi, "GLM")
    .replace(/\bqwen\b/gi, "Qwen")
    .replace(/\bvl\b/gi, "VL")
    .replace(/\b\w/g, (char) => char.toUpperCase());

  return suffix ? `${prefix} QE93 (${suffix})` : `${prefix} QE93`;
}

function modelConfig(id: string, data: OllamaShowResponse): ProviderModelConfig {
  const capabilities = getCapabilities(data);
  const reasoning = capabilities.includes("thinking");

  return {
    id,
    name: displayName(id, data),
    api: "openai-completions",
    reasoning,
    thinkingLevelMap: reasoning ? OLLAMA_THINKING_LEVELS : undefined,
    input: capabilities.includes("vision") ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: getContextWindow(data),
    maxTokens: 32_768,
    compat: QE93_COMPAT,
  };
}

function isUsableModel(data: OllamaShowResponse): boolean {
  const capabilities = getCapabilities(data);
  if (capabilities.includes("embedding") && !capabilities.includes("completion")) return false;
  if (capabilities.length === 0) return true;
  if (!capabilities.includes("completion")) return false;
  return !requireTools() || capabilities.includes("tools");
}

function assembleModels(raw: Record<string, OllamaShowResponse>): ProviderModelConfig[] {
  return Object.entries(raw)
    .filter(([, data]) => isUsableModel(data))
    .map(([id, data]) => modelConfig(id, data))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function readCache(baseUrl: string): ProviderModelConfig[] | undefined {
  try {
    if (!existsSync(CACHE_FILE)) return undefined;

    const cached = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as CachedModels;
    if (cached.baseUrl !== baseUrl) return undefined;
    if (!cached.models || Object.keys(cached.models).length === 0) return undefined;

    const models = assembleModels(cached.models);
    return models.length > 0 ? models : undefined;
  } catch {
    return undefined;
  }
}

function writeCache(baseUrl: string, models: Record<string, OllamaShowResponse>): void {
  try {
    mkdirSync(join(getAgentDir(), "cache"), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ baseUrl, timestamp: Date.now(), models } satisfies CachedModels, null, 2));
  } catch (error) {
    console.warn(`[${PROVIDER}] Failed to write model cache:`, error);
  }
}

function tagFallbackDetails(tag: NonNullable<OllamaTagsResponse["models"]>[number]): OllamaShowResponse {
  return {
    details: tag.details,
    capabilities: tag.capabilities,
  };
}

async function fetchModelDetails(baseUrl: string, tags: NonNullable<OllamaTagsResponse["models"]>): Promise<Record<string, OllamaShowResponse>> {
  const headers = { ...discoveryHeaders(), "Content-Type": "application/json" };
  const results = await Promise.allSettled(
    tags.map(async (tag) => {
      const id = asString(tag.model) ?? asString(tag.name);
      if (!id) return undefined;

      try {
        const data = await fetchJson<OllamaShowResponse>(`${baseUrl}/api/show`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: id }),
        });
        return [id, data] as const;
      } catch (error) {
        console.warn(`[${PROVIDER}] Failed to inspect ${id}; using /api/tags metadata:`, error);
        return [id, tagFallbackDetails(tag)] as const;
      }
    }),
  );

  const models: Record<string, OllamaShowResponse> = {};
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      models[result.value[0]] = result.value[1];
    }
  }
  return models;
}

async function discoverModels(baseUrl: string): Promise<ProviderModelConfig[]> {
  try {
    const tags = await fetchJson<OllamaTagsResponse>(`${baseUrl}/api/tags`, { headers: discoveryHeaders() });
    const rawTags = Array.isArray(tags.models) ? tags.models : [];
    if (rawTags.length === 0) throw new Error("Ollama returned no local models");

    const rawDetails = await fetchModelDetails(baseUrl, rawTags);
    const models = assembleModels(rawDetails);
    if (models.length === 0) {
      const toolsMessage = requireTools() ? ` with tool support; set ${REQUIRE_TOOLS_ENV}=false to include chat-only models` : "";
      throw new Error(`Ollama returned no completion models${toolsMessage}`);
    }

    writeCache(baseUrl, rawDetails);
    return models;
  } catch (error) {
    console.warn(`[${PROVIDER}] Model discovery failed for ${baseUrl}:`, error);
    return readCache(baseUrl) ?? [];
  }
}

async function fetchVersion(baseUrl: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch(`${baseUrl}/api/version`, { headers: discoveryHeaders(), signal });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { version?: unknown };
    return asString(payload.version);
  } catch {
    return undefined;
  }
}

function registerProvider(pi: ExtensionAPI, baseUrl: string, models: ProviderModelConfig[]): void {
  pi.registerProvider(PROVIDER, {
    name: PROVIDER_NAME,
    baseUrl: `${baseUrl}/v1`,
    apiKey: providerApiKeyValue(),
    api: "openai-completions",
    models,
  });
}

export default async function qe93OllamaExtension(pi: ExtensionAPI) {
  const baseUrl = configuredBaseUrl();
  let models = await discoverModels(baseUrl);
  registerProvider(pi, baseUrl, models);

  pi.registerCommand("qe93-refresh", {
    description: "Refresh QE93 local Ollama models",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.setWorkingMessage("Refreshing QE93 local Ollama models...");
      try {
        models = await discoverModels(baseUrl);
        registerProvider(pi, baseUrl, models);
        ctx.ui.notify(`Registered ${models.length} QE93 model(s) from ${baseUrl}`, "info");
      } finally {
        ctx.ui.setWorkingMessage();
      }
    },
  });

  pi.registerCommand("qe93-models", {
    description: "Show registered QE93 local Ollama models",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const version = await fetchVersion(baseUrl, ctx.signal);
      const lines = [`${PROVIDER_NAME}: ${baseUrl}${version ? ` (Ollama ${version})` : ""}`];
      if (models.length === 0) {
        lines.push("No models registered. Check the host or run /qe93-refresh.");
      } else {
        lines.push(...models.map((model) => `${PROVIDER}/${model.id} — ${model.name}`));
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("qe93-test", {
    description: "Test the configured QE93 local Ollama connection",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        const version = await fetchVersion(baseUrl, ctx.signal);
        if (!version) throw new Error("/api/version returned no version");
        const discovered = await discoverModels(baseUrl);
        ctx.ui.notify(`QE93 OK: ${baseUrl} (Ollama ${version}), ${discovered.length} model(s)`, "info");
      } catch (error) {
        ctx.ui.notify(`QE93 failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

const PROVIDER = "ollama-cloud";
const API_KEY_ENV_PRIMARY = "OLLAMA_CLOUD_API_KEY";
const API_KEY_ENV_FALLBACK = "OLLAMA_API_KEY";
const DISCOVERY_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = join(getAgentDir(), "cache", "ollama-cloud-models.json");

const OLLAMA_BASE = normalizeBaseUrl(process.env.OLLAMA_CLOUD_BASE_URL ?? process.env.OLLAMA_API_BASE ?? "https://ollama.com");

const OLLAMA_COMPAT: NonNullable<ProviderModelConfig["compat"]> = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  maxTokensField: "max_tokens",
  supportsStrictMode: false,
};

const OLLAMA_THINKING_LEVELS: NonNullable<ProviderModelConfig["thinkingLevelMap"]> = {
  off: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
};

type OpenAIModelsResponse = {
  data?: Array<{ id?: unknown }>;
};

type OllamaShowResponse = {
  details?: {
    family?: unknown;
    parameter_size?: unknown;
  };
  model_info?: Record<string, unknown>;
  capabilities?: unknown;
};

type CachedModels = {
  timestamp: number;
  models: Record<string, OllamaShowResponse>;
};

const FALLBACK_MODELS: ProviderModelConfig[] = [
  modelConfig("glm-5.1", {
    capabilities: ["thinking", "completion", "tools"],
    model_info: { "glm5.1.context_length": 202_752 },
  }),
  modelConfig("qwen3-coder:480b", {
    capabilities: ["completion", "tools"],
    model_info: { "qwen3.context_length": 262_144 },
  }),
  modelConfig("gpt-oss:120b", {
    capabilities: ["thinking", "completion", "tools"],
    model_info: { "gptoss.context_length": 131_072 },
  }),
];

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/(api|v1)$/i, "");
}

function providerApiKeyValue(): string {
  return process.env[API_KEY_ENV_PRIMARY] ? API_KEY_ENV_PRIMARY : API_KEY_ENV_FALLBACK;
}

function discoveryHeaders(): Record<string, string> {
  const key = process.env[API_KEY_ENV_PRIMARY] ?? process.env[API_KEY_ENV_FALLBACK];
  return key ? { Authorization: `Bearer ${key}` } : {};
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

function getCapabilities(data: OllamaShowResponse): string[] {
  return Array.isArray(data.capabilities) ? data.capabilities.filter((item): item is string => typeof item === "string") : [];
}

function getContextWindow(data: OllamaShowResponse): number {
  for (const [key, value] of Object.entries(data.model_info ?? {})) {
    if (key.endsWith(".context_length") && typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return 128_000;
}

function displayName(id: string, data: OllamaShowResponse): string {
  const parameterSize = typeof data.details?.parameter_size === "string" ? data.details.parameter_size : undefined;
  const prefix = id
    .replace(/[-_:]+/g, " ")
    .replace(/\bglm\b/gi, "GLM")
    .replace(/\bgpt\b/gi, "GPT")
    .replace(/\bqwen\b/gi, "Qwen")
    .replace(/\bvl\b/gi, "VL")
    .replace(/\b\w/g, (char) => char.toUpperCase());
  return parameterSize ? `${prefix} (${parameterSize})` : prefix;
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
    compat: OLLAMA_COMPAT,
  };
}

function assembleModels(raw: Record<string, OllamaShowResponse>): ProviderModelConfig[] {
  return Object.entries(raw)
    .filter(([, data]) => {
      const capabilities = getCapabilities(data);
      return capabilities.includes("completion") && capabilities.includes("tools");
    })
    .map(([id, data]) => modelConfig(id, data))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function readCache(allowStale: boolean): ProviderModelConfig[] | undefined {
  try {
    if (!existsSync(CACHE_FILE)) return undefined;

    const cached = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as CachedModels;
    if (!cached.models || Object.keys(cached.models).length === 0) return undefined;
    if (!allowStale && Date.now() - cached.timestamp > CACHE_TTL_MS) return undefined;

    const models = assembleModels(cached.models);
    return models.length > 0 ? models : undefined;
  } catch {
    return undefined;
  }
}

function writeCache(models: Record<string, OllamaShowResponse>): void {
  try {
    mkdirSync(join(getAgentDir(), "cache"), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ timestamp: Date.now(), models } satisfies CachedModels, null, 2));
  } catch (error) {
    console.warn(`[${PROVIDER}] Failed to write model cache:`, error);
  }
}

async function fetchModelDetails(modelIds: string[]): Promise<Record<string, OllamaShowResponse>> {
  const headers = { ...discoveryHeaders(), "Content-Type": "application/json" };
  const results = await Promise.allSettled(
    modelIds.map(async (id) => {
      const data = await fetchJson<OllamaShowResponse>(`${OLLAMA_BASE}/api/show`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: id }),
      });
      return [id, data] as const;
    }),
  );

  const models: Record<string, OllamaShowResponse> = {};
  for (const result of results) {
    if (result.status === "fulfilled") {
      models[result.value[0]] = result.value[1];
    }
  }
  return models;
}

async function discoverModels(): Promise<ProviderModelConfig[]> {
  try {
    const list = await fetchJson<OpenAIModelsResponse>(`${OLLAMA_BASE}/v1/models`, { headers: discoveryHeaders() });
    const modelIds = (list.data ?? [])
      .map((model) => (typeof model.id === "string" ? model.id : undefined))
      .filter((id): id is string => !!id);

    if (modelIds.length === 0) throw new Error("Ollama Cloud returned no models");

    const rawDetails = await fetchModelDetails(modelIds);
    const models = assembleModels(rawDetails);
    if (models.length === 0) throw new Error("Ollama Cloud returned no tool-capable models");

    writeCache(rawDetails);
    return models;
  } catch (error) {
    console.warn(`[${PROVIDER}] Model discovery failed:`, error);
    return readCache(true) ?? FALLBACK_MODELS;
  }
}

function registerProvider(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
  pi.registerProvider(PROVIDER, {
    name: "Ollama Cloud",
    baseUrl: `${OLLAMA_BASE}/v1`,
    apiKey: providerApiKeyValue(),
    api: "openai-completions",
    models,
  });
}

export default async function ollamaCloudExtension(pi: ExtensionAPI) {
  let models = readCache(false) ?? (await discoverModels());
  registerProvider(pi, models);

  pi.registerCommand("ollama-cloud-refresh", {
    description: "Refresh Ollama Cloud models from ollama.com",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.setWorkingMessage("Refreshing Ollama Cloud models...");
      try {
        models = await discoverModels();
        registerProvider(pi, models);
        ctx.ui.notify(`Registered ${models.length} Ollama Cloud models`, "info");
      } finally {
        ctx.ui.setWorkingMessage();
      }
    },
  });

  pi.registerCommand("ollama-cloud-models", {
    description: "Show registered Ollama Cloud models",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.notify(models.map((model) => `${PROVIDER}/${model.id}`).join("\n"), "info");
    },
  });
}

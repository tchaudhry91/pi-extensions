import type { ExtensionAPI, ProviderModelConfig } from "@mariozechner/pi-coding-agent";

const PROVIDER = "zai-coding";
const BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const API_KEY_ENV = "ZAI_CODING_API_KEY";

const KNOWN_MODEL_LIMITS: Record<string, Pick<ProviderModelConfig, "contextWindow" | "maxTokens">> = {
  "glm-4.5-air": { contextWindow: 131_072, maxTokens: 98_304 },
  "glm-4.7": { contextWindow: 204_800, maxTokens: 131_072 },
  "glm-5-turbo": { contextWindow: 200_000, maxTokens: 131_072 },
  "glm-5.1": { contextWindow: 200_000, maxTokens: 131_072 },
};

const FALLBACK_MODEL_IDS = Object.keys(KNOWN_MODEL_LIMITS);

type OpenAIModelsResponse = {
  data?: Array<{
    id?: unknown;
    name?: unknown;
  }>;
};

function titleCaseModelId(id: string): string {
  return id
    .split(/[-_]/g)
    .map((part) => {
      if (/^glm$/i.test(part)) return "GLM";
      return part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1);
    })
    .join("-");
}

function toModelConfig(id: string, name?: string): ProviderModelConfig {
  const limits = KNOWN_MODEL_LIMITS[id] ?? { contextWindow: 200_000, maxTokens: 131_072 };

  return {
    id,
    name: name ?? titleCaseModelId(id),
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
    compat: {
      supportsDeveloperRole: false,
      thinkingFormat: "zai",
      zaiToolStream: id !== "glm-4.5-air",
    },
  };
}

async function discoverModels(): Promise<ProviderModelConfig[]> {
  const key = process.env[API_KEY_ENV];
  if (!key) return FALLBACK_MODEL_IDS.map((id) => toModelConfig(id));

  try {
    const response = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as OpenAIModelsResponse;
    const models = (payload.data ?? [])
      .map((model) => ({
        id: typeof model.id === "string" ? model.id : undefined,
        name: typeof model.name === "string" ? model.name : undefined,
      }))
      .filter((model): model is { id: string; name?: string } => Boolean(model.id))
      .map((model) => toModelConfig(model.id, model.name));

    return models.length > 0 ? models : FALLBACK_MODEL_IDS.map((id) => toModelConfig(id));
  } catch (error) {
    console.warn(`[${PROVIDER}] Failed to discover models from ${BASE_URL}/models:`, error);
    return FALLBACK_MODEL_IDS.map((id) => toModelConfig(id));
  }
}

export default async function (pi: ExtensionAPI) {
  const models = await discoverModels();

  pi.registerProvider(PROVIDER, {
    baseUrl: BASE_URL,
    apiKey: API_KEY_ENV,
    api: "openai-completions",
    models,
  });

  pi.registerCommand("zai-coding-models", {
    description: "Show detected ZAI Coding provider models",
    handler: async (_args, ctx) => {
      const names = models.map((model) => `${PROVIDER}/${model.id}`).join("\n");
      ctx.ui.notify(`ZAI Coding models:\n${names}`, "info");
    },
  });
}

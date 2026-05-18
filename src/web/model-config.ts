import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getProvider,
  getRegisteredProviderTypes,
  switchProvider,
  createProvider,
  getProviderInstallationStatus,
} from "../providers/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || process.env.CODEX_DATA_DIR || path.resolve(__dirname, "../../.data");
const CONFIG_PATH = path.join(dataDir, "model-config.json");

export interface ModelEntry {
  id: string;
  name: string;
  description: string;
}

export interface ModelConfig {
  provider: string;
  currentModel: string;
  models: ModelEntry[];
  lastSelected: Record<string, string>;
}

function buildDefaultConfig(): ModelConfig {
  const provider = getProvider();
  const models = provider.listModels();
  return {
    provider: provider.type,
    currentModel: models[0]?.id ?? "",
    models,
    lastSelected: { [provider.type]: models[0]?.id ?? "" },
  };
}

function ensureConfig(): void {
  mkdirSync(dataDir, { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(buildDefaultConfig(), null, 2), "utf-8");
  }
}

export function readPersistedProviderType(): string | null {
  if (!existsSync(CONFIG_PATH)) {
    return null;
  }

  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const providerType = (JSON.parse(raw) as Partial<ModelConfig>).provider;
    if (!providerType) {
      return null;
    }

    const normalizedType = providerType === "claude-agent" ? "claude-code" : providerType;
    return getRegisteredProviderTypes().includes(normalizedType) ? normalizedType : null;
  } catch {
    return null;
  }
}

function areSameModels(a: ModelEntry[] | undefined, b: ModelEntry[]): boolean {
  return (
    !!a &&
    a.length === b.length &&
    a.every((model, index) => {
      const next = b[index];
      return (
        !!next &&
        model.id === next.id &&
        model.name === next.name &&
        model.description === next.description
      );
    })
  );
}

function selectCurrentModel(
  config: ModelConfig,
  providerType: string,
  models: ModelEntry[],
): string {
  const validIds = new Set(models.map((model) => model.id));
  const candidates = [
    config.provider === providerType ? config.currentModel : undefined,
    config.lastSelected[providerType],
    models[0]?.id,
  ];

  return candidates.find((modelId) => modelId && validIds.has(modelId)) ?? "";
}

export function readModelConfig(): ModelConfig {
  ensureConfig();
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const config = JSON.parse(raw) as ModelConfig;

  if (!config.lastSelected) {
    config.lastSelected = {};
  }

  const provider = getProvider();
  const providerModels = provider.listModels();
  const needsRefresh =
    config.provider !== provider.type ||
    !config.models ||
    config.models.length === 0 ||
    (config.models.length === 1 && config.models[0].id === "auto") ||
    !areSameModels(config.models, providerModels);

  if (needsRefresh) {
    const currentModel = selectCurrentModel(config, provider.type, providerModels);
    config.provider = provider.type;
    config.models = providerModels;
    config.currentModel = currentModel;
    config.lastSelected[provider.type] = currentModel;
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  }

  return config;
}

export function writeModelConfig(config: ModelConfig): ModelConfig {
  ensureConfig();
  const next: ModelConfig = {
    provider: config.provider,
    currentModel: config.currentModel || "",
    models: Array.isArray(config.models) ? config.models : [],
    lastSelected: config.lastSelected || {},
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

export function getCurrentModel(): string {
  return readModelConfig().currentModel;
}

export function getCurrentProviderType(): string {
  return readModelConfig().provider;
}

export function getModelForProvider(providerType: string): string {
  return readModelConfigForProvider(providerType).currentModel;
}

export function readModelConfigForProvider(providerType: string): ModelConfig {
  ensureConfig();
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const config = JSON.parse(raw) as ModelConfig;
  if (!config.lastSelected) {
    config.lastSelected = {};
  }

  const provider = createProvider(providerType);
  const models = provider.listModels();
  const model = selectCurrentModel(config, provider.type, models);
  if (!config.lastSelected[provider.type]) {
    config.lastSelected[provider.type] = model;
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  }
  return {
    ...config,
    provider: provider.type,
    currentModel: model,
    models,
  };
}

export function setCurrentModel(modelId: string): ModelConfig {
  const config = readModelConfig();
  const valid = config.models.some((m) => m.id === modelId);
  if (!valid) {
    throw new Error(`不支持的模型: ${modelId}`);
  }
  config.currentModel = modelId;
  config.lastSelected[config.provider] = modelId;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  return config;
}

export function setModelForProvider(providerType: string, modelId: string): ModelConfig {
  const provider = createProvider(providerType);
  const models = provider.listModels();
  const valid = models.some((m) => m.id === modelId);
  if (!valid) {
    throw new Error(`不支持的模型: ${modelId}`);
  }

  const config = readModelConfig();
  config.lastSelected[provider.type] = modelId;
  if (config.provider === provider.type) {
    config.currentModel = modelId;
    config.models = models;
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");

  return {
    ...config,
    provider: provider.type,
    currentModel: modelId,
    models,
  };
}

export function setCurrentProvider(
  providerType: string,
  providerConfig?: Record<string, unknown>,
): ModelConfig {
  const registered = getRegisteredProviderTypes();
  if (!registered.includes(providerType)) {
    throw new Error(`不支持的 Provider: ${providerType}。可用: ${registered.join(", ")}`);
  }

  const installation = getProviderInstallationStatus(providerType);
  if (!installation.installed) {
    throw new Error(
      `${providerType} 未安装，无法切换。请先安装 ${installation.bin}：${installation.installHint}`,
    );
  }

  const config = readModelConfig();
  config.lastSelected[config.provider] = config.currentModel;
  config.provider = providerType;

  const newProvider = switchProvider(providerType, providerConfig);
  config.models = newProvider.listModels();
  config.currentModel = config.lastSelected[providerType] || config.models[0]?.id || "";

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  return config;
}

export function getProviderTypes(): Array<{
  type: string;
  displayName: string;
  capabilities: Record<string, boolean>;
  installed: boolean;
  bin: string;
  executablePath: string | null;
  installHint: string;
}> {
  return getRegisteredProviderTypes().map((type) => {
    const p = createProvider(type);
    const installation = getProviderInstallationStatus(type);
    return {
      type: p.type,
      displayName: p.displayName,
      capabilities: { ...p.capabilities },
      installed: installation.installed,
      bin: installation.bin,
      executablePath: installation.executablePath,
      installHint: installation.installHint,
    };
  });
}

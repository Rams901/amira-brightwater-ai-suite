import fs from "node:fs";
import path from "node:path";
import { IS_SERVERLESS } from "../dataFiles.js";

export interface ServerAiConfig {
  typesafeApiKey: string;
  typesafeBaseUrl: string;
  typesafeModel: string;
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  allowSandboxWhenUnconfigured: boolean;
}

function parseEnvFile(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const rawVal = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, "");
      if (rawVal) {
        process.env[key] = rawVal;
      }
    }
  } catch {
    // Ignore unreadable files in restricted serverless sandboxes
  }
}

function getWritableEnvLocalPath(): string {
  return IS_SERVERLESS
    ? path.join("/tmp", ".env.local")
    : path.resolve(process.cwd(), ".env.local");
}

function loadEnvFiles(): void {
  parseEnvFile(path.resolve(process.cwd(), ".env"));
  parseEnvFile(path.resolve(process.cwd(), ".env.local"));
  if (IS_SERVERLESS) {
    parseEnvFile(path.join("/tmp", ".env.local"));
  }
}

loadEnvFiles();

const runtimeOverrides: Partial<ServerAiConfig> = {};

export function getAiConfig(): ServerAiConfig {
  const inUnitTest =
    process.env.VITEST === "true" && process.env.RUN_LIVE_TESTS !== "true";

  return {
    typesafeApiKey: inUnitTest
      ? ""
      : runtimeOverrides.typesafeApiKey ?? process.env.TYPESAFE_API_KEY?.trim() ?? "",
    typesafeBaseUrl:
      runtimeOverrides.typesafeBaseUrl ??
      process.env.TYPESAFE_BASE_URL?.trim() ??
      "https://api.typesafe.ai",
    typesafeModel:
      runtimeOverrides.typesafeModel ??
      process.env.TYPESAFE_MODEL?.trim() ??
      "jev-1.14.0",
    deepseekApiKey: inUnitTest
      ? ""
      : runtimeOverrides.deepseekApiKey ?? process.env.DEEPSEEK_API_KEY?.trim() ?? "",
    deepseekBaseUrl:
      runtimeOverrides.deepseekBaseUrl ??
      process.env.DEEPSEEK_BASE_URL?.trim() ??
      "https://api.deepseek.com",
    deepseekModel:
      runtimeOverrides.deepseekModel ??
      process.env.DEEPSEEK_MODEL?.trim() ??
      "deepseek-flash",
    allowSandboxWhenUnconfigured:
      runtimeOverrides.allowSandboxWhenUnconfigured ?? true,
  };
}

function persistEnvLocal(cfg: ServerAiConfig): void {
  try {
    const envLocalPath = getWritableEnvLocalPath();
    const lines = [
      "# Server-persisted API credentials (gitignored)",
      `TYPESAFE_API_KEY=${cfg.typesafeApiKey}`,
      `TYPESAFE_MODEL=${cfg.typesafeModel}`,
      `DEEPSEEK_API_KEY=${cfg.deepseekApiKey}`,
      `DEEPSEEK_MODEL=${cfg.deepseekModel}`,
    ];
    fs.writeFileSync(envLocalPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Keep runtimeOverrides in memory if filesystem is read-only
  }
}

export function updateRuntimeAiConfig(patch: Partial<ServerAiConfig>): void {
  if (typeof patch.typesafeApiKey === "string") {
    runtimeOverrides.typesafeApiKey = patch.typesafeApiKey.trim();
  }
  if (typeof patch.deepseekApiKey === "string") {
    runtimeOverrides.deepseekApiKey = patch.deepseekApiKey.trim();
  }
  if (typeof patch.typesafeModel === "string" && patch.typesafeModel.trim()) {
    runtimeOverrides.typesafeModel = patch.typesafeModel.trim();
  }
  if (typeof patch.deepseekModel === "string" && patch.deepseekModel.trim()) {
    runtimeOverrides.deepseekModel = patch.deepseekModel.trim();
  }
  if (typeof patch.allowSandboxWhenUnconfigured === "boolean") {
    runtimeOverrides.allowSandboxWhenUnconfigured = patch.allowSandboxWhenUnconfigured;
  }
  persistEnvLocal(getAiConfig());
}

export function clearRuntimeAiKeys(): void {
  runtimeOverrides.typesafeApiKey = "";
  runtimeOverrides.deepseekApiKey = "";
  process.env.TYPESAFE_API_KEY = "";
  process.env.DEEPSEEK_API_KEY = "";
  try {
    const envLocalPath = getWritableEnvLocalPath();
    if (fs.existsSync(envLocalPath)) {
      fs.unlinkSync(envLocalPath);
    }
  } catch {
    // Ignore on read-only fs
  }
}

export function getRedactedAiStatus() {
  const cfg = getAiConfig();
  return {
    typesafeConfigured: Boolean(cfg.typesafeApiKey),
    typesafeModel: cfg.typesafeModel,
    typesafeKeyHint: cfg.typesafeApiKey
      ? `...${cfg.typesafeApiKey.slice(-4)}`
      : null,
    deepseekConfigured: Boolean(cfg.deepseekApiKey),
    deepseekModel: cfg.deepseekModel,
    deepseekKeyHint: cfg.deepseekApiKey
      ? `...${cfg.deepseekApiKey.slice(-4)}`
      : null,
    effectiveMode:
      cfg.typesafeApiKey && cfg.deepseekApiKey
        ? ("live" as const)
        : ("sandbox" as const),
    allowSandboxWhenUnconfigured: cfg.allowSandboxWhenUnconfigured,
  };
}

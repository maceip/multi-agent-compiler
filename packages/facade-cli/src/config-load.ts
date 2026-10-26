import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderConfig, ProviderPort, ZfacadeConfig } from "@zfacade/contracts";
import { validateConfig, ZfacadeError } from "@zfacade/contracts";
import { stateRoot } from "@zfacade/core";
import { DeterministicProvider, OpenAICompatibleProvider, TinkerProvider } from "@zfacade/agent";

/** Trusted user config only (never workspace files): ~/.zfacade/config.json or --config path. */
export function loadConfig(explicitPath?: string, env: NodeJS.ProcessEnv = process.env): ZfacadeConfig {
  const path = explicitPath ?? join(stateRoot(env), "config.json");
  if (!existsSync(path)) {
    if (explicitPath) throw new ZfacadeError("ConfigInvalid", `config file not found: ${explicitPath}`);
    return {};
  }
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch (e) { throw new ZfacadeError("ConfigInvalid", `cannot parse ${path}: ${e instanceof Error ? e.message : String(e)}`); }
  return validateConfig(raw);
}

const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

function resolveApiKey(keyName: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (!keyName) return undefined;
  if (env[keyName]) return env[keyName];
  for (const candidate of ["/Users/mac/zfacade/.env", "/Users/mac/zfacade-tinker/.env"]) {
    const parsed = loadDotEnv(candidate, env);
    if (parsed[keyName]) return parsed[keyName];
  }
  return undefined;
}

export function buildProviderFromSpec(p: ProviderConfig, env: NodeJS.ProcessEnv = process.env): ProviderPort {
  if (p.kind === "deterministic-test") return DeterministicProvider.fromFile(p.deterministicScriptPath!);
  if (p.kind === "tinker") {
    const apiKeyEnv = p.apiKeyEnv ?? "TINKER_API_KEY";
    const apiKey = resolveApiKey(apiKeyEnv, env);
    return new TinkerProvider(p.modelId!, p.checkpointPath, p.renderer ?? "qwen3_5_disable_thinking", apiKey);
  }
  const apiKeyEnv = p.apiKeyEnv ?? (p.kind === "openai" ? "OPENAI_API_KEY" : undefined);
  const apiKey = resolveApiKey(apiKeyEnv, env);
  if (p.kind === "openai") {
    return new OpenAICompatibleProvider(p.baseUrl ?? OPENAI_DEFAULT_BASE, p.modelId!, apiKey);
  }
  return new OpenAICompatibleProvider(p.baseUrl!, p.modelId!, apiKey);
}

export function buildProvider(cfg: ZfacadeConfig, env: NodeJS.ProcessEnv = process.env): ProviderPort {
  const p = cfg.provider;
  if (!p) {
    throw new ZfacadeError("ProviderNotConfigured",
      "no provider configured. For live OpenAI testing set provider.kind=\"openai\" in ~/.zfacade/config.json (or --config) and OPENAI_API_KEY in the environment. deterministic-test is for offline tests only.");
  }
  return buildProviderFromSpec(p, env);
}

export function buildOrchestratorProvider(cfg: ZfacadeConfig, env: NodeJS.ProcessEnv = process.env): ProviderPort {
  if (cfg.orchestratorProvider) {
    return buildProviderFromSpec(cfg.orchestratorProvider, env);
  }
  return buildProvider(cfg, env);
}

/**
 * Load KEY=value pairs from a .env file into a plain object.
 * Does not override keys already present in `env`. Used by live canaries only.
 */
export function loadDotEnv(path: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && value && env[key] === undefined) out[key] = value;
  }
  return out;
}

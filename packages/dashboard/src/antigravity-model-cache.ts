/**
 * Antigravity CLI discovery → model-picker mapping, behind a short-TTL,
 * single-flight cache so `/api/models` never spawns `agy` per request.
 *
 * FNXC:AntigravityCli 2026-07-18-17:05:
 * Mirrors grok-model-cache.ts. Toggle gate (`useAntigravityCli`) lives in register-model-routes.ts.
 */

import { discoverAntigravityCliModels } from "./runtime-provider-probes.js";

export interface AntigravityPickerModel {
  provider: "antigravity-cli";
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
}

export const ANTIGRAVITY_PICKER_PROVIDER_ID = "antigravity-cli" as const;

const DEFAULT_TTL_MS = 60_000;
const EMPTY_RESULT_TTL_MS = 5_000;

export function antigravityDiscoveryToModels(
  models: ReadonlyArray<{ id: string; label?: string; reasoning?: boolean; contextWindow?: number }>,
): AntigravityPickerModel[] {
  const seen = new Set<string>();
  const result: AntigravityPickerModel[] = [];

  for (const model of models) {
    const id = model.id?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({
      provider: ANTIGRAVITY_PICKER_PROVIDER_ID,
      id,
      name: model.label?.trim() || id,
      reasoning: model.reasoning ?? false,
      contextWindow: model.contextWindow ?? 0,
    });
  }

  return result;
}

interface CacheEntry {
  fetchedAt: number;
  models: AntigravityPickerModel[];
  ttlMs: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<AntigravityPickerModel[]>>();

export function __resetAntigravityPickerModelsCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

export interface GetAntigravityPickerModelsOptions {
  binaryPath?: string;
  ttlMs?: number;
  now?: () => number;
}

function resolveBinaryPath(explicit?: string): string {
  return explicit ?? "agy";
}

export async function getAntigravityPickerModels(
  opts?: GetAntigravityPickerModelsOptions,
): Promise<AntigravityPickerModel[]> {
  const binaryPath = resolveBinaryPath(opts?.binaryPath);
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts?.now ?? Date.now;
  const nowMs = now();

  const cached = cache.get(binaryPath);
  if (cached && nowMs - cached.fetchedAt < cached.ttlMs) {
    return cached.models;
  }

  const existingInFlight = inFlight.get(binaryPath);
  if (existingInFlight) {
    return existingInFlight;
  }

  const fetchPromise = (async (): Promise<AntigravityPickerModel[]> => {
    try {
      const result = await discoverAntigravityCliModels({ binaryPath });
      if (!result || result.models.length === 0) {
        return [];
      }
      return antigravityDiscoveryToModels(result.models);
    } catch {
      return [];
    }
  })();

  inFlight.set(binaryPath, fetchPromise);

  try {
    const models = await fetchPromise;
    const effectiveTtlMs = models.length === 0 ? EMPTY_RESULT_TTL_MS : ttlMs;
    cache.set(binaryPath, { fetchedAt: now(), models, ttlMs: effectiveTtlMs });
    return models;
  } finally {
    inFlight.delete(binaryPath);
  }
}

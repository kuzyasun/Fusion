import { discoverAntigravityModels } from "./process-manager.js";
import { probeAntigravityBinary } from "./probe.js";

function normalizeDiscoveryOptions(options?: unknown): { binaryPath?: string; timeoutMs?: number } {
  if (!options || typeof options !== "object") return {};
  const record = options as Record<string, unknown>;
  return {
    binaryPath: typeof record.binaryPath === "string" ? record.binaryPath : undefined,
    timeoutMs: typeof record.timeoutMs === "number" ? record.timeoutMs : undefined,
  };
}

/**
 * Discover Antigravity models for the CLI-provider contribution.
 *
 * FNXC:AntigravityCli 2026-07-18-17:05:
 * Uses the override-aware probe to resolve the effective binary before running
 * `agy models`, so a configured `binaryPath` is honored and an unavailable
 * binary short-circuits with the probe's diagnostics instead of a spawn crash.
 */
export async function discoverAntigravityProviderModels(options?: unknown): Promise<{
  models: Array<{ id: string; label?: string }>;
  source: string;
  fallbackUsed: boolean;
  reason?: string;
}> {
  const probe = await probeAntigravityBinary(normalizeDiscoveryOptions(options));
  if (!probe.available || !probe.binaryName) {
    return { models: [], source: "probe", fallbackUsed: true, reason: probe.reason ?? "binary unavailable" };
  }
  const result = await discoverAntigravityModels(probe.binaryPath ?? probe.binaryName);
  return {
    /*
    FNXC:AntigravityCli 2026-09-11-00:44:
    Pair machine ids with human labels from agy 1.2.0 `id\\tlabel` discovery so
    pickers show the friendly name while `--model` receives the bare id.
    */
    models: result.models.map((id, index) => ({
      id,
      label: result.labels[index] ?? id,
    })),
    source: result.source,
    fallbackUsed: result.fallbackUsed,
    reason: result.reason,
  };
}

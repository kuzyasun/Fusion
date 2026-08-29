/**
 * Antigravity Runtime Plugin
 *
 * Provides an executable Antigravity runtime adapter that drives the local `agy`
 * CLI as a subprocess, plus an `antigravity-cli` CLI-provider contribution
 * (probe + model discovery) modeled on the Grok CLI plugin.
 */

import { definePlugin } from "@fusion/plugin-sdk";
import { resolveCliSettings } from "./cli-spawn.js";
import { probeAntigravityBinary } from "./probe.js";
import { discoverAntigravityProviderModels } from "./provider.js";
import { AntigravityRuntimeAdapter } from "./runtime-adapter.js";
import type {
  FusionPlugin,
  PluginContext,
  PluginRuntimeFactory,
  PluginRuntimeManifestMetadata,
} from "@fusion/plugin-sdk";

// ── Antigravity Runtime Metadata ────────────────────────────────────────────────

const ANTIGRAVITY_RUNTIME_ID = "antigravity";
const ANTIGRAVITY_RUNTIME_VERSION = "0.1.0";

const antigravityRuntimeMetadata: PluginRuntimeManifestMetadata = {
  runtimeId: ANTIGRAVITY_RUNTIME_ID,
  name: "Antigravity Runtime",
  description: "Drives the local `agy` CLI (Antigravity subscription) in headless print mode over a PTY",
  version: ANTIGRAVITY_RUNTIME_VERSION,
};

const antigravityRuntimeFactory: PluginRuntimeFactory = async (ctx) => {
  return new AntigravityRuntimeAdapter(ctx.settings as Record<string, unknown> | undefined);
};

/*
FNXC:AntigravityRuntime 2026-07-18-17:05:
Antigravity is a subscription product; its CLI (`agy`) owns all credentials.
This plugin orchestrates that subscription through the CLI on purpose — it avoids
wiring a banned OAuth provider into Fusion, and (like the Grok/Hermes example
runtimes) receives no reference to AuthStorage/ModelRegistry/global settings via
PluginContext, so it is structurally incapable of mutating those stores. It only
resolves its own CLI settings, probes the `agy` binary, and drives print-mode
turns. Do not widen PluginContext access without re-auditing this invariant.

FNXC:AntigravityCli 2026-07-18-17:05:
Provider contribution mirrors the Grok CLI plugin: providerId `antigravity-cli`,
binary `agy`, readiness = binary available (CLI owns auth so `authenticated`
tracks availability), model discovery via `agy models` text parsing. No auth
subcommand is invented.
*/
const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-antigravity-runtime",
    name: "Antigravity Runtime Plugin",
    version: ANTIGRAVITY_RUNTIME_VERSION,
    description:
      "Drives the local `agy` CLI (Google Antigravity subscription) for Fusion agents in headless print mode over a PTY.",
    author: "Fusion Team",
    homepage: "https://antigravity.google",
    runtime: antigravityRuntimeMetadata,
  },
  state: "installed",
  hooks: {
    onLoad: (ctx: PluginContext) => {
      const settings = resolveCliSettings(ctx.settings);
      ctx.logger.info(
        `Antigravity Runtime Plugin loaded — binary=${settings.binaryPath} model=${settings.model ?? "(default)"} transport=PTY print mode`,
      );
      ctx.emitEvent("antigravity-runtime:loaded", {
        runtimeId: ANTIGRAVITY_RUNTIME_ID,
        version: ANTIGRAVITY_RUNTIME_VERSION,
      });
    },
    onUnload: () => {
      // No persistent state — each prompt spawns a fresh `agy` subprocess.
    },
  },
  runtime: {
    metadata: antigravityRuntimeMetadata,
    factory: antigravityRuntimeFactory,
  },
  cliProviders: [
    {
      providerId: "antigravity-cli",
      displayName: "Antigravity CLI",
      binaryName: "agy",
      providerType: "cli",
      statusRoute: "/providers/antigravity-cli/status",
      authRoute: "/auth/antigravity-cli",
      actions: [
        { actionId: "enable", label: "Enable", actionType: "enable", method: "POST", route: "/auth/antigravity-cli" },
        { actionId: "disable", label: "Disable", actionType: "disable", method: "POST", route: "/auth/antigravity-cli" },
        { actionId: "test", label: "Test", actionType: "test", method: "GET", route: "/providers/antigravity-cli/status" },
      ],
      probe: async () => {
        const status = await probeAntigravityBinary();
        return {
          available: status.available,
          authenticated: status.authenticated,
          binaryPath: status.binaryPath,
          binaryName: status.binaryName,
          version: status.version,
          reason: status.reason,
        };
      },
      discoverModels: discoverAntigravityProviderModels,
      runtime: {
        runtimeId: ANTIGRAVITY_RUNTIME_ID,
        createAdapter: antigravityRuntimeFactory,
      },
    },
  ],
});

export default plugin;

// ── Public exports ──────────────────────────────────────────────────────────────

export { antigravityRuntimeMetadata, antigravityRuntimeFactory, ANTIGRAVITY_RUNTIME_ID };
export { AntigravityRuntimeAdapter } from "./runtime-adapter.js";
export { probeAntigravityBinary } from "./probe.js";
export { discoverAntigravityProviderModels } from "./provider.js";
export { discoverAntigravityModels, parseAgyModelLines } from "./process-manager.js";
export {
  resolveCliSettings,
  resolveBinaryForSpawn,
  formatWin32ShellSpawnFile,
  quoteWin32CmdArg,
  resolveWin32SpawnInvocation,
  runAgyCommand,
  buildAgyPrintArgs,
  buildAgyPromptFilePointer,
  prepareAgyPrintPrompt,
  AGY_ARGV_PROMPT_SOFT_LIMIT,
  invokeAgyPrint,
  parseAgyPrintOutput,
  stripAnsi,
  stripTrailingIncompleteCsi,
  stripAntigravityModelPrefix,
} from "./cli-spawn.js";
export type {
  AntigravityCliSettings,
  AntigravityPermissionMode,
  AgyPrintResult,
  InvokeAgyPrintOptions,
  PreparedAgyPrintPrompt,
} from "./cli-spawn.js";
export type { AntigravityModelDiscoveryResult } from "./process-manager.js";
export type {
  AntigravityBinaryStatus,
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSession,
  AgentSessionResult,
  AntigravityStreamSession,
  AntigravityCallbacks,
  AntigravityRuntimeContext,
} from "./types.js";

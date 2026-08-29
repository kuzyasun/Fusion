/*
FNXC:AntigravityCli 2026-07-18-18:20:
Thin entry for dashboard runtime-provider-probes and vitest source aliases.
Importing the full plugin index pulls the PTY/runtime-adapter (node-pty) which is
not required for binary probe / model discovery and fails dashboard-api-quality
resolution when dist/ is absent.
*/
export { probeAntigravityBinary } from "./probe.js";
export type { AntigravityBinaryStatus } from "./types.js";
export { discoverAntigravityProviderModels } from "./provider.js";

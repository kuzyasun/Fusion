/**
 * Antigravity binary probe helper.
 *
 * FNXC:AntigravityCli 2026-07-18-17:05:
 * Readiness = binary available, exactly like the Cursor/Grok CLI providers.
 * `authenticated: true` whenever `agy --version` succeeds, because the CLI owns
 * its own Antigravity subscription credentials — Fusion cannot and must not
 * inspect them, so there is no auth subcommand to invent (AGENTS.md "Do NOT
 * invent"). Never throws: all failures degrade to `available: false` + reason.
 */

import { runAgyCommand } from "./cli-spawn.js";
import type { AntigravityBinaryStatus } from "./types.js";

const CANDIDATES = ["agy"] as const;
const MAX_FAILURE_DETAIL_LENGTH = 180;

function buildCandidates(binaryPath?: string): { candidates: string[]; configuredBinaryPath?: string } {
  /*
  FNXC:AntigravityCli 2026-07-18-17:05:
  A manually-configured operator path is tried before PATH candidates without
  deleting the fallback order (mirrors the Grok/Cursor probes). Deduping keeps an
  `agy` override from probing the same shim twice.
  */
  const configuredBinaryPath = binaryPath?.trim() || undefined;
  const ordered = configuredBinaryPath ? [configuredBinaryPath, ...CANDIDATES] : [...CANDIDATES];
  return { candidates: Array.from(new Set(ordered)), configuredBinaryPath };
}

function summarizeFailure(binary: string, stdout: string, stderr: string): string | undefined {
  const detail = `${stderr || stdout}`.replace(/\s+/g, " ").trim();
  if (!detail) return undefined;
  const truncated =
    detail.length > MAX_FAILURE_DETAIL_LENGTH ? `${detail.slice(0, MAX_FAILURE_DETAIL_LENGTH - 1)}…` : detail;
  return `${binary}: ${truncated}`;
}

export async function probeAntigravityBinary(options?: {
  timeoutMs?: number;
  binaryPath?: string;
}): Promise<AntigravityBinaryStatus> {
  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? 3000;
  const { candidates, configuredBinaryPath } = buildCandidates(options?.binaryPath);
  const failureDetails: string[] = [];

  for (const binary of candidates) {
    const version = await runAgyCommand(binary, ["--version"], timeoutMs);
    const failureDetail = summarizeFailure(binary, version.stdout, version.stderr);
    if (failureDetail) failureDetails.push(failureDetail);
    const common = {
      binaryName: binary,
      binaryPath: binary,
      configuredBinaryPath,
      usingConfiguredBinaryPath: configuredBinaryPath === binary,
      diagnostics: failureDetails.length > 0 ? [...failureDetails] : undefined,
      probeDurationMs: Date.now() - startedAt,
    };
    if (version.code === 0) {
      // FNXC:AntigravityCli 2026-07-18-17:05: readiness = binary available; the CLI owns auth.
      return {
        available: true,
        authenticated: true,
        ...common,
        version: version.stdout.trim() || undefined,
        reason: undefined,
      };
    }
  }

  const baseReason = configuredBinaryPath
    ? `Configured Antigravity CLI binary '${configuredBinaryPath}' failed; PATH fallback agy also failed`
    : "agy not found on PATH";
  return {
    available: false,
    authenticated: false,
    configuredBinaryPath,
    usingConfiguredBinaryPath: false,
    diagnostics: failureDetails.length > 0 ? failureDetails : undefined,
    reason: failureDetails.length > 0 ? `${baseReason} (${failureDetails.join("; ")})` : baseReason,
    probeDurationMs: Date.now() - startedAt,
  };
}

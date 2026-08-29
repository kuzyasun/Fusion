import { runAgyCommand } from "./cli-spawn.js";

/*
FNXC:AntigravityCli 2026-07-18-18:10:
`agy models` emits human labels with spaces and thinking-tier parentheses, e.g.
`Gemini 3.5 Flash (Medium)`, `Claude Opus 4.6 (Thinking)`. Keep the full line as
the model id (after stripping bullets / default markers) so `--model` round-trips
the same string operators see in `agy models`. Do not truncate on the first space.
*/
export function parseAgyModelLines(raw: string): string[] {
  const ids = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^available models:?$/i.test(line))
    .filter((line) => !/^you are logged in\b/i.test(line))
    .filter((line) => !/^default model:?/i.test(line))
    .filter((line) => !/^models?:?$/i.test(line))
    .filter((line) => !/^no models? available/i.test(line))
    .filter((line) => !/^tip:/i.test(line))
    .filter((line) => !/^usage/i.test(line))
    .map((line) => line.replace(/^[*-]\s+/, ""))
    .map((line) => line.replace(/\s*\(default\)\s*$/i, ""))
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^-+$/.test(line))
    .filter(Boolean);

  return Array.from(new Set(ids));
}

export interface AntigravityModelDiscoveryResult {
  models: string[];
  source: string;
  fallbackUsed: boolean;
  reason?: string;
}

export async function discoverAntigravityModels(
  binary: string,
  timeoutMs = 5000,
): Promise<AntigravityModelDiscoveryResult> {
  const res = await runAgyCommand(binary, ["models"], timeoutMs);
  if (res.code !== 0) {
    return { models: [], source: "none", fallbackUsed: true, reason: "model discovery command unavailable" };
  }

  const output = (res.stdout || "").trim();
  if (!output) {
    return { models: [], source: "none", fallbackUsed: true, reason: "model discovery command returned no output" };
  }

  if (/^no models? available/i.test(output)) {
    return { models: [], source: "models-text", fallbackUsed: false, reason: "no models available for this account" };
  }

  // Defensive fast path: tolerate JSON output even though the CLI is not known
  // to support a --json flag today.
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      const ids: string[] = [];
      for (const entry of parsed) {
        const id = typeof entry === "string" ? entry : typeof entry?.id === "string" ? entry.id : undefined;
        if (id) ids.push(id);
      }
      if (ids.length > 0) {
        return { models: Array.from(new Set(ids)), source: "models-json", fallbackUsed: false };
      }
    }
  } catch {
    // output is not JSON; fall through to line-based parsing
  }

  const ids = parseAgyModelLines(output);
  if (ids.length > 0) {
    return { models: ids, source: "models-text", fallbackUsed: false };
  }

  return { models: [], source: "none", fallbackUsed: true, reason: "model discovery command unavailable" };
}

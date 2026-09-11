import { runAgyCommand } from "./cli-spawn.js";

export interface AgyModelEntry {
  /** Value passed to `agy --model` (machine id when tab-separated, else full label). */
  id: string;
  /** Human label for pickers; equals `id` for legacy single-column `agy models` output. */
  label: string;
}

/*
FNXC:AntigravityCli 2026-07-18-18:10:
`agy models` emits human labels with spaces and thinking-tier parentheses, e.g.
`Gemini 3.5 Flash (Medium)`, `Claude Opus 4.6 (Thinking)`. Keep the full line as
the model id (after stripping bullets / default markers) so `--model` round-trips
the same string operators see in `agy models`. Do not truncate on the first space.

FNXC:AntigravityCli 2026-09-11-00:44:
agy 1.2.0 prints `machine-id\\tHuman Label` rows. Storing the raw line made Fusion
persist tab-joined picker ids that `agy --model` rejects. Prefer the machine id as
`id` and the right-hand label for display; legacy single-column label lines stay
unchanged (id === label).
*/
export function parseAgyModelEntries(raw: string): AgyModelEntry[] {
  const entries = raw
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
    .filter((line) => !/^fetching\b/i.test(line))
    .map((line) => line.replace(/^[*-]\s+/, ""))
    .map((line) => line.replace(/\s*\(default\)\s*$/i, ""))
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^-+$/.test(line))
    .map((line) => {
      const tab = line.indexOf("\t");
      if (tab <= 0) {
        return { id: line, label: line };
      }
      const id = line.slice(0, tab).trim();
      const label = line.slice(tab + 1).trim() || id;
      return id ? { id, label } : null;
    })
    .filter((entry): entry is AgyModelEntry => Boolean(entry?.id));

  const seen = new Set<string>();
  const deduped: AgyModelEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    deduped.push(entry);
  }
  return deduped;
}

export function parseAgyModelLines(raw: string): string[] {
  return parseAgyModelEntries(raw).map((entry) => entry.id);
}

export interface AntigravityModelDiscoveryResult {
  models: string[];
  /** Parallel labels for `models` (same length); used by provider picker rows. */
  labels: string[];
  source: string;
  fallbackUsed: boolean;
  reason?: string;
}

export async function discoverAntigravityModels(
  binary: string,
  timeoutMs = 5000,
): Promise<AntigravityModelDiscoveryResult> {
  const empty = (source: string, fallbackUsed: boolean, reason?: string): AntigravityModelDiscoveryResult => ({
    models: [],
    labels: [],
    source,
    fallbackUsed,
    reason,
  });

  const res = await runAgyCommand(binary, ["models"], timeoutMs);
  if (res.code !== 0) {
    return empty("none", true, "model discovery command unavailable");
  }

  const output = (res.stdout || "").trim();
  if (!output) {
    return empty("none", true, "model discovery command returned no output");
  }

  if (/^no models? available/i.test(output)) {
    return empty("models-text", false, "no models available for this account");
  }

  // Defensive fast path: tolerate JSON output even though the CLI is not known
  // to support a --json flag today.
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      const entries: AgyModelEntry[] = [];
      for (const entry of parsed) {
        if (typeof entry === "string") {
          entries.push({ id: entry, label: entry });
          continue;
        }
        const id = typeof entry?.id === "string" ? entry.id : undefined;
        if (!id) continue;
        const label = typeof entry?.label === "string" && entry.label.trim() ? entry.label.trim() : id;
        entries.push({ id, label });
      }
      if (entries.length > 0) {
        const deduped = parseAgyModelEntries(entries.map((e) => `${e.id}\t${e.label}`).join("\n"));
        return {
          models: deduped.map((e) => e.id),
          labels: deduped.map((e) => e.label),
          source: "models-json",
          fallbackUsed: false,
        };
      }
    }
  } catch {
    // output is not JSON; fall through to line-based parsing
  }

  const entries = parseAgyModelEntries(output);
  if (entries.length > 0) {
    return {
      models: entries.map((e) => e.id),
      labels: entries.map((e) => e.label),
      source: "models-text",
      fallbackUsed: false,
    };
  }

  return empty("none", true, "model discovery command unavailable");
}

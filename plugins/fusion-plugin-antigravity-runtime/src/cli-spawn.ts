/**
 * Antigravity CLI spawn module.
 *
 * Two distinct spawn surfaces:
 *  1. `runAgyCommand` — short, non-interactive commands for probe/model discovery
 *     (`agy --version`, `agy models`). Uses `child_process.spawn` with a shell on
 *     win32 so `.cmd`/`.bat` shims resolve.
 *  2. `invokeAgyPrint` — the prompt turn (`agy … -p`). Runs inside a PTY via
 *     `node-pty` because `agy` hangs when spawned without a TTY in headless print mode.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep as PATH_SEP } from "node:path";

/*
FNXC:AntigravityCli 2026-07-18-18:10:
On Windows, `spawn("agy", ...)` won't find `agy.cmd`/`.bat` shims — Node does not
honor PATHEXT for the program name. Resolve via `where` and spawn the absolute path.
Cached per process. node-pty especially needs a concrete executable.
*/
const resolvedBinaryCache = new Map<string, string>();

export function resolveBinaryForSpawn(binary: string): string {
  if (process.platform !== "win32") return binary;
  if (binary.includes(PATH_SEP) || binary.includes("/") || /\.[a-z]{2,4}$/i.test(binary)) {
    return binary;
  }
  const cached = resolvedBinaryCache.get(binary);
  if (cached) return cached;
  try {
    const result = spawnSync("where", [binary], { encoding: "utf-8" });
    if (result.status === 0) {
      const first = (result.stdout ?? "").trim().split(/\r?\n/)[0];
      if (first?.length) {
        resolvedBinaryCache.set(binary, first);
        return first;
      }
    }
  } catch {
    // fall through
  }
  return binary;
}

/*
FNXC:AntigravityCli 2026-07-18-18:55:
cmd.exe (shell:true) splits unquoted absolute paths on spaces, so
`C:\Users\A User\...\agy.exe` becomes `C:\Users\A` and auth probe/enable fails.
Quote the file when spawning under a shell on win32. Bare PATH names still use shell
so `.cmd`/`.bat` shims resolve.

FNXC:AntigravityCli 2026-07-19-01:40:
shell:true also concatenates argv without escaping (Node DEP0190). Spaced `--model`
labels (e.g. `Gemini 3.5 Flash (Medium)`) and multi-word `-p` prompts split under
cmd.exe. Prefer CreateProcess without a shell for resolved `.exe`; otherwise quote
both the file and every arg that needs it.
*/
export function quoteWin32CmdArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"&<>|^]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

export function formatWin32ShellSpawnFile(binary: string): string {
  const resolved = resolveBinaryForSpawn(binary);
  return /\s/.test(resolved) ? `"${resolved}"` : resolved;
}

export function resolveWin32SpawnInvocation(
  binary: string,
  args: string[],
): { file: string; args: string[]; shell: boolean } {
  const resolved = resolveBinaryForSpawn(binary);
  if (/\.exe$/i.test(resolved)) {
    return { file: resolved, args, shell: false };
  }
  return {
    file: /\s/.test(resolved) ? `"${resolved}"` : resolved,
    args: args.map(quoteWin32CmdArg),
    shell: true,
  };
}

// eslint-disable-next-line no-control-regex -- ANSI escapes are control chars by definition
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/** Incomplete CSI at buffer end — must match the intermediate-byte class used by ANSI_RE. */
// eslint-disable-next-line no-control-regex -- CSI holdback is control-char matching by definition
const INCOMPLETE_CSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*)?$/;

export function stripTrailingIncompleteCsi(raw: string): string {
  return raw.replace(INCOMPLETE_CSI_RE, "");
}

export function stripAnsi(raw: string): string {
  return raw.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function parseAgyPrintOutput(raw: string): string {
  /*
  FNXC:AntigravityCli 2026-07-18-18:55:
  Drop a trailing incomplete CSI before stripAnsi so exit mid-escape cannot leave ESC
  crumbs in the final body (which would force adapter onText re-emit of dirty text).
  */
  return stripAnsi(stripTrailingIncompleteCsi(raw)).trim();
}

/**
 * Strip Fusion provider prefixes so picker ids become bare `agy --model` values.
 *
 * FNXC:AntigravityCli 2026-07-18-18:10:
 * Lane pickers store `antigravity-cli/<label>`; the CLI expects the discovered
 * label (e.g. `Gemini 3.5 Flash (Medium)`), not the Fusion provider-qualified id.
 *
 * FNXC:AntigravityCli 2026-09-11-00:44:
 * Also drop a trailing `\\tHuman Label` suffix left by pre-fix discovery of
 * agy 1.2.0 tab-separated `models` rows — otherwise `--model` rejects the id.
 */
export function stripAntigravityModelPrefix(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  let trimmed = modelId.trim();
  if (!trimmed) return undefined;
  for (const prefix of ["antigravity-cli/", "antigravity/"]) {
    if (trimmed.startsWith(prefix)) {
      const rest = trimmed.slice(prefix.length).trim();
      trimmed = rest;
      break;
    }
  }
  if (!trimmed) return undefined;
  const tab = trimmed.indexOf("\t");
  if (tab >= 0) {
    trimmed = trimmed.slice(0, tab).trim();
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

export type AntigravityPermissionMode = "skip" | "sandbox" | "prompt";


/*
FNXC:AntigravityCli 2026-09-11-01:21:
HIVE-001 timed out at Fusion's 300s wall clock while agy was still writing worktree
artifacts (and chrome-devtools MCP kept the PTY alive after the turn). agy 1.2.0
`--print-timeout` requires a Go duration unit (bare ms is rejected), defaults to 5m,
and emits a definitive `event:result` on `--output-format stream-json`. Always pass a
unitized `--print-timeout` aligned to cliTimeoutMs, default the Fusion kill to 30m for
executor-scale turns, and settle the print promise on stream-json `result` (then kill)
so MCP grandchildren cannot hold the turn open until the wall clock.
*/
/** Default Fusion-side print wall clock (executor-scale research/coding turns). */
export const DEFAULT_AGY_CLI_TIMEOUT_MS = 1_800_000;

/** Format milliseconds as a Go duration string accepted by `agy --print-timeout`. */
export function formatAgyDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "5m";
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${Math.ceil(ms)}ms`;
}

/** Ensure operator/env print-timeout values carry a duration unit for agy 1.2.0+. */
export function normalizeAgyPrintTimeout(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return `${trimmed}ms`;
  return trimmed;
}

export interface AgyStreamJsonResult {
  status: string;
  response?: string;
  error?: string;
}

export interface AgyStreamJsonUpdate {
  textDelta?: string;
  result?: AgyStreamJsonResult;
}

/** Parse one NDJSON line from `agy --output-format stream-json`. */
export function parseAgyStreamJsonLine(line: string): AgyStreamJsonUpdate | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (obj.event === "result" && obj.result && typeof obj.result === "object") {
      const result = obj.result as Record<string, unknown>;
      const status = typeof result.status === "string" ? result.status : "UNKNOWN";
      return {
        result: {
          status,
          response: typeof result.response === "string" ? result.response : undefined,
          error: typeof result.error === "string" ? result.error : undefined,
        },
      };
    }
    if (obj.event === "step_update" && obj.step_update && typeof obj.step_update === "object") {
      const step = obj.step_update as Record<string, unknown>;
      if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
        return { textDelta: step.text_delta };
      }
      return {};
    }
    // `--output-format json` single envelope (no event wrapper).
    if (typeof obj.status === "string" && obj.event === undefined) {
      return {
        result: {
          status: obj.status,
          response: typeof obj.response === "string" ? obj.response : undefined,
          error: typeof obj.error === "string" ? obj.error : undefined,
        },
      };
    }
    return {};
  } catch {
    return null;
  }
}

/*
FNXC:AntigravityCli 2026-09-11-07:32:
When MCP keeps the PTY open after the turn, `event:result` may sit in the hold
buffer without a trailing newline. Detect a brace-balanced, parseable JSON object
at the buffer head so early settle can fire without waiting for `\n` or process exit.
*/
/** Return end index (exclusive) of a complete `{...}` object at `text` start, or -1. */
export function findCompleteJsonObjectEnd(text: string): number {
  const start = text.search(/\S/);
  if (start < 0 || text[start] !== "{") return -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** Incremental NDJSON reader for agy stream-json print mode. */
export class AgyStreamJsonReader {
  private buffer = "";
  private assembledText = "";
  /** True once any valid stream-json NDJSON line has been parsed. */
  sawStreamEvent = false;
  result?: AgyStreamJsonResult;

  private applyUpdate(update: AgyStreamJsonUpdate | null, deltas: string[]): void {
    if (update) {
      this.sawStreamEvent = true;
    }
    if (update?.textDelta) {
      this.assembledText += update.textDelta;
      deltas.push(update.textDelta);
    }
    if (update?.result) {
      this.result = update.result;
    }
  }

  /**
   * After newline-delimited parse, try a trailing complete JSON object that
   * arrived without `\n` (MCP-held PTY / partial flush).
   */
  private tryParseHeldCompleteObject(deltas: string[]): void {
    if (this.result) return;
    const end = findCompleteJsonObjectEnd(this.buffer);
    if (end < 0) return;
    const candidate = this.buffer.slice(0, end);
    const update = parseAgyStreamJsonLine(candidate);
    if (!update) return;
    this.buffer = this.buffer.slice(end);
    this.applyUpdate(update, deltas);
  }

  push(chunk: string): string[] {
    this.buffer += chunk;
    const deltas: string[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.applyUpdate(parseAgyStreamJsonLine(line), deltas);
      newline = this.buffer.indexOf("\n");
    }
    /*
    FNXC:AntigravityCli 2026-09-11-07:32:
    Harden early settle: if the held buffer is a complete JSON object, parse it
    without waiting for a trailing newline or process exit. Preserve settle-once
    by only setting `result` when parse succeeds (callers still gate on it once).
    */
    this.tryParseHeldCompleteObject(deltas);
    return deltas;
  }

  flush(): void {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return;
    }
    const update = parseAgyStreamJsonLine(this.buffer);
    this.buffer = "";
    const deltas: string[] = [];
    this.applyUpdate(update, deltas);
  }

  bodyFromResultOrText(): string {
    if (typeof this.result?.response === "string") {
      return this.result.response.trim();
    }
    return this.assembledText.trim();
  }
}

/** Settings resolved from plugin ctx.settings + env-var fallbacks. */
export interface AntigravityCliSettings {
  binaryPath: string;
  model?: string;
  /** Value passed as `--print-timeout` (Go duration with unit, e.g. `30m` / `45000ms`). Always set by resolveCliSettings. */
  printTimeout?: string;
  cliTimeoutMs: number;
  /**
   * FNXC:AntigravityCli 2026-07-18-18:10:
   * `skip` → `--dangerously-skip-permissions` (default for non-interactive Fusion tasks).
   * `sandbox` → `--sandbox` (restricted terminal; safer for untrusted prompts).
   * `prompt` → neither flag (CLI may block waiting for permission — avoid for headless).
   */
  permissionMode: AntigravityPermissionMode;
}

export function resolveCliSettings(settings?: Record<string, unknown>): AntigravityCliSettings {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

  const num = (v: unknown, envKey: string, fallback: number): number => {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    const raw = str(v) ?? str(process.env[envKey]);
    if (raw !== undefined) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return fallback;
  };

  /*
  FNXC:AntigravityCli 2026-07-18-18:20:
  Accept both plugin-local keys (`binaryPath` / `permissionMode`) and global Settings aliases
  (`antigravityCliBinaryPath` / `antigravityCliPermissionMode`) so host merge + auth-card saves
  both reach print-mode spawn without a second settings surface.
  */
  const permissionRaw =
    str(settings?.permissionMode) ??
    str(settings?.antigravityCliPermissionMode) ??
    str(process.env.AGY_PERMISSION_MODE) ??
    (settings?.skipPermissions === false || process.env.AGY_SKIP_PERMISSIONS === "0"
      ? "prompt"
      : settings?.sandbox === true || process.env.AGY_SANDBOX === "1"
        ? "sandbox"
        : "skip");

  const permissionMode: AntigravityPermissionMode =
    permissionRaw === "sandbox" || permissionRaw === "prompt" || permissionRaw === "skip"
      ? permissionRaw
      : "skip";

  const printTimeoutMs = num(settings?.printTimeoutMs, "AGY_PRINT_TIMEOUT_MS", 0);
  const cliTimeoutMs = num(settings?.cliTimeoutMs, "AGY_CLI_TIMEOUT_MS", DEFAULT_AGY_CLI_TIMEOUT_MS);
  /*
  FNXC:AntigravityCli 2026-09-11-01:21:
  Always supply `--print-timeout` with a Go duration unit. Prefer explicit operator/
  env values; otherwise mirror cliTimeoutMs so agy's internal wait and Fusion's kill
  stay aligned (bare ms strings are invalid on agy 1.2.0).
  */
  const explicitPrintTimeout =
    str(settings?.printTimeout) ??
    str(process.env.AGY_PRINT_TIMEOUT) ??
    (printTimeoutMs > 0 ? formatAgyDurationMs(printTimeoutMs) : undefined);
  const printTimeout = normalizeAgyPrintTimeout(
    explicitPrintTimeout ?? formatAgyDurationMs(cliTimeoutMs),
  );

  return {
    binaryPath:
      str(settings?.binaryPath) ??
      str(settings?.antigravityCliBinaryPath) ??
      str(process.env.AGY_BIN) ??
      "agy",
    model: stripAntigravityModelPrefix(str(settings?.model) ?? str(process.env.AGY_MODEL_ID)),
    printTimeout,
    cliTimeoutMs,
    permissionMode,
  };
}

function formatSpawnError(error: Error & { code?: unknown }): string {
  const code = typeof error.code === "string" ? `${error.code}: ` : "";
  return `spawn error: ${code}${error.message}`.trim();
}

/*
FNXC:AntigravityCli 2026-09-11-07:32:
On Windows, `child.kill("SIGKILL")` before `taskkill /T /F` can orphan MCP
grandchildren (the direct child dies while the tree stays). Run taskkill first
when pid is known, then kill the child handle. On Unix, try process-group kill
(`process.kill(-pid)`) when pid is known — safe no-op if the child is not a
group leader — then fall back to child.kill. Missing pid stays best-effort kill only.
*/
export function killProcessTree(child: { pid?: number; kill?: (...args: any[]) => void | boolean }): void {
  const pid = typeof child.pid === "number" && child.pid > 0 ? child.pid : undefined;

  if (process.platform === "win32") {
    if (pid !== undefined) {
      try {
        spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // best effort
      }
    }
    try {
      child.kill?.("SIGKILL");
    } catch {
      // best effort
    }
    return;
  }

  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Not a process-group leader, or already gone — fall through to child.kill.
    }
  }
  try {
    child.kill?.("SIGKILL");
  } catch {
    // best effort
  }
}

export async function runAgyCommand(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: { code: number | null; stdout: string; stderr: string }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const invocation =
      process.platform === "win32"
        ? resolveWin32SpawnInvocation(binary, args)
        : { file: resolveBinaryForSpawn(binary), args, shell: false };
    const child = spawn(invocation.file, invocation.args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: invocation.shell,
    });

    timer = setTimeout(() => {
      killProcessTree(child);
      finish({ code: 124, stdout, stderr });
    }, timeoutMs);

    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf-8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf-8");
    });
    child.once("error", (error: Error & { code?: unknown }) => {
      const diagnostic = formatSpawnError(error);
      stderr = stderr ? `${stderr}\n${diagnostic}` : diagnostic;
      finish({ code: 127, stdout, stderr });
    });
    child.once("close", (code) => {
      finish({ code, stdout, stderr });
    });
  });
}

/**
 * Build argv for a single `agy` print-mode turn.
 *
 * FNXC:AntigravityCli 2026-07-18-18:10:
 * Permission flags are mutually exclusive: skip uses --dangerously-skip-permissions;
 * sandbox uses --sandbox; prompt emits neither (headless may hang on tool asks).
 *
 * FNXC:AntigravityCli 2026-07-19-13:45:
 * `prompt` must already be argv-safe (short literal or pointer to a prompt file).
 * Callers use `prepareAgyPrintPrompt` so Windows CreateProcess never sees multi-10k
 * Fusion executor prompts that throw spawn ENAMETOOLONG (same class as Cursor FN-3396 print-mode).
 */
export function buildAgyPrintArgs(
  prompt: string,
  settings: AntigravityCliSettings,
  opts?: { continue?: boolean },
): string[] {
  const args: string[] = [];

  if (settings.permissionMode === "skip") {
    args.push("--dangerously-skip-permissions");
  } else if (settings.permissionMode === "sandbox") {
    args.push("--sandbox");
  }

  if (opts?.continue) {
    args.push("--continue");
  }
  if (settings.model) {
    args.push("--model", settings.model);
  }
  /*
  FNXC:AntigravityCli 2026-09-11-01:21:
  stream-json yields `event:result` when the agent turn completes. Fusion settles on
  that event and kills the PTY so stdio MCP children (e.g. chrome-devtools) cannot
  hold print-mode open past completion.
  */
  args.push("--output-format", "stream-json");
  if (settings.printTimeout) {
    args.push("--print-timeout", settings.printTimeout);
  }

  args.push("-p", prompt);
  return args;
}

/*
FNXC:AntigravityCli 2026-07-19-13:45:
Windows CreateProcess rejects oversized argv (ENAMETOOLONG). `agy` has no --prompt-file;
for large prompts write the body to a temp file and pass a short pointer instruction as `-p`
so the agent reads the file with its tools (mirrors fusion-plugin-cursor-runtime).
*/
export const AGY_ARGV_PROMPT_SOFT_LIMIT = 2_000;

export interface PreparedAgyPrintPrompt {
  argvPrompt: string;
  usedPromptFile: boolean;
  promptFilePath?: string;
  cleanup: () => void;
}

export function buildAgyPromptFilePointer(promptFilePath: string): string {
  return [
    "Open and follow the instructions in this file exactly (absolute path):",
    promptFilePath,
    "",
    "Treat the file contents as your complete user request for this turn.",
    "Do not ask clarifying questions; complete the work using your tools.",
  ].join("\n");
}

export function prepareAgyPrintPrompt(prompt: string): PreparedAgyPrintPrompt {
  if (prompt.length <= AGY_ARGV_PROMPT_SOFT_LIMIT) {
    return {
      argvPrompt: prompt,
      usedPromptFile: false,
      cleanup: () => undefined,
    };
  }

  const dir = mkdtempSync(join(tmpdir(), "fusion-agy-prompt-"));
  const promptFilePath = join(dir, "prompt.md");
  writeFileSync(promptFilePath, prompt, "utf8");
  return {
    argvPrompt: buildAgyPromptFilePointer(promptFilePath),
    usedPromptFile: true,
    promptFilePath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

interface PtyProcessLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: { exitCode: number; signal?: number }) => void): void;
  kill(signal?: string): void;
}

interface PtyModuleLike {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    },
  ): PtyProcessLike;
}

async function defaultLoadPtyModule(): Promise<PtyModuleLike> {
  const specifier = "node-pty";
  const mod = (await import(/* @vite-ignore */ specifier)) as unknown as PtyModuleLike | { default: PtyModuleLike };
  const resolved = (mod as { default?: PtyModuleLike }).default ?? (mod as PtyModuleLike);
  if (!resolved || typeof resolved.spawn !== "function") {
    throw new Error("node-pty module did not expose a spawn() function");
  }
  return resolved;
}

export interface AgyPrintResult {
  body: string;
  exitCode: number;
  usedFallback: boolean;
}

export interface InvokeAgyPrintOptions {
  cwd?: string;
  continue?: boolean;
  signal?: AbortSignal;
  /**
   * FNXC:AntigravityCli 2026-07-18-18:10:
   * Optional incremental callback for raw PTY chunks (still ANSI-stripped per chunk)
   * so Fusion can surface progress before process exit. Final body is still delivered
   * once via the returned result / adapter onText dedupe.
   */
  onChunk?: (text: string) => void;
  loadPtyModule?: () => Promise<PtyModuleLike>;
  spawnFallback?: typeof spawn;
}


function isAgyStreamSuccess(status: string): boolean {
  return status.toUpperCase() === "SUCCESS";
}

function settleFromAgyStreamResult(
  reader: AgyStreamJsonReader,
  exitCode: number,
  usedFallback: boolean,
): AgyPrintResult {
  reader.flush();
  const body = reader.bodyFromResultOrText();
  if (reader.result && !isAgyStreamSuccess(reader.result.status)) {
    const detail = reader.result.error?.trim() || body || reader.result.status;
    throw new Error(`agy: print-mode stream-json result status ${reader.result.status}: ${detail}`);
  }
  return { body, exitCode, usedFallback };
}

export async function invokeAgyPrint(
  prompt: string,
  settings: AntigravityCliSettings,
  opts?: InvokeAgyPrintOptions,
): Promise<AgyPrintResult> {
  const prepared = prepareAgyPrintPrompt(prompt);
  const args = buildAgyPrintArgs(prepared.argvPrompt, settings, { continue: opts?.continue });
  const binary = resolveBinaryForSpawn(settings.binaryPath);
  const cwd = opts?.cwd ?? process.cwd();
  const timeoutMs = settings.cliTimeoutMs;
  const loadPty = opts?.loadPtyModule ?? defaultLoadPtyModule;

  let ptyModule: PtyModuleLike;
  try {
    ptyModule = await loadPty();
  } catch (importErr) {
    const detail = importErr instanceof Error ? importErr.message : String(importErr);
    try {
      return await invokeAgyPrintViaSpawn(binary, args, {
        cwd,
        timeoutMs,
        signal: opts?.signal,
        onChunk: opts?.onChunk,
        spawnImpl: opts?.spawnFallback ?? spawn,
        ptyLoadError: detail,
      });
    } finally {
      prepared.cleanup();
    }
  }

  return new Promise<AgyPrintResult>((resolve, reject) => {
    let output = "";
    let settled = false;
    let child: PtyProcessLike;

    const cleanup = (): void => {
      clearTimeout(timer);
      if (opts?.signal) opts.signal.removeEventListener("abort", onAbort);
      prepared.cleanup();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      killProcessTree(child);
      reject(new Error(`agy: print-mode process timed out after ${timeoutMs}ms (PTY)`));
    }, timeoutMs);

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      killProcessTree(child);
      reject(new Error("agy: invocation aborted"));
    };

    try {
      let ptyFile = binary;
      let ptyArgs = args;
      if (process.platform === "win32" && /\.(cmd|bat)$/i.test(binary)) {
        /*
        FNXC:AntigravityCli 2026-07-19-01:40:
        Use /d /c for cmd.exe invocation: disables AutoRun registry commands (/d)
        without /s so cmd.exe preserves inner quotes across array-joined arguments.
        */
        ptyFile = process.env.ComSpec || "cmd.exe";
        ptyArgs = ["/d", "/c", binary, ...args];
      }
      child = ptyModule.spawn(ptyFile, ptyArgs, {
        name: "xterm-color",
        cols: 120,
        rows: 40,
        cwd,
        env: { ...process.env, TERM: "xterm-256color" },
      });
    } catch (spawnErr) {
      settled = true;
      cleanup();
      const detail = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      const hint = /ENAMETOOLONG/i.test(detail)
        ? " (prompt still exceeded the OS argv limit after file offload — report this)"
        : "";
      reject(new Error(`agy: failed to spawn under PTY — ${detail}${hint}`));
      return;
    }

    if (opts?.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    /*
    FNXC:AntigravityCli 2026-07-18-18:25:
    Incremental ANSI strip: only process the new raw data since the last emission,
    keeping a small holdback buffer for incomplete CSI sequences at chunk boundaries.
    Previous approach re-ran stripAnsi on the entire accumulated output per chunk,
    which was O(N²) for large responses.

    FNXC:AntigravityCli 2026-09-11-01:21:
    After ANSI strip, feed cleaned bytes into AgyStreamJsonReader. Surface text_delta
    via onChunk (not raw NDJSON) and complete as soon as `event:result` arrives so
    stdio MCP grandchildren cannot hold the PTY open past turn completion.
    */
    let pendingRaw = "";
    const streamReader = new AgyStreamJsonReader();

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const settleFromStreamResult = (): void => {
      settle(() => {
        try {
          const result = settleFromAgyStreamResult(streamReader, 0, false);
          killProcessTree(child);
          resolve(result);
        } catch (err) {
          killProcessTree(child);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    };

    child.onData((data: string) => {
      output += data;
      pendingRaw += data;
      // Hold back a trailing incomplete CSI so a split escape sequence cannot
      // leak ESC crumbs into the stream-json reader / onChunk.
      const holdMatch = pendingRaw.match(INCOMPLETE_CSI_RE);
      const stable = holdMatch ? pendingRaw.slice(0, -holdMatch[0].length) : pendingRaw;
      if (stable.length === 0) return;
      const cleaned = stripAnsi(stable);
      pendingRaw = holdMatch ? holdMatch[0] : "";
      if (!cleaned) return;
      const deltas = streamReader.push(cleaned);
      if (opts?.onChunk) {
        if (deltas.length > 0) {
          for (const delta of deltas) opts.onChunk(delta);
        } else if (!streamReader.sawStreamEvent && !/^\s*\{/.test(cleaned)) {
          // Legacy text print-mode: surface ANSI-cleaned PTY bytes directly.
          opts.onChunk(cleaned);
        }
      }
      if (streamReader.result) {
        settleFromStreamResult();
      }
    });

    child.onExit(({ exitCode }: { exitCode: number }) => {
      if (settled) return;
      settle(() => {
        if (pendingRaw) {
          const cleaned = stripAnsi(pendingRaw);
          pendingRaw = "";
          if (cleaned) {
            const deltas = streamReader.push(cleaned);
            if (opts?.onChunk) {
              if (deltas.length > 0) {
                for (const delta of deltas) opts.onChunk(delta);
              } else if (!streamReader.sawStreamEvent && !/^\s*\{/.test(cleaned)) {
                opts.onChunk(cleaned);
              }
            }
          }
        }
        streamReader.flush();
        if (streamReader.result) {
          try {
            resolve(settleFromAgyStreamResult(streamReader, exitCode, false));
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
          return;
        }
        if (exitCode !== 0) {
          reject(
            new Error(
              `agy: print-mode process exited with code ${String(exitCode)} (PTY).\n${parseAgyPrintOutput(output)}`,
            ),
          );
          return;
        }
        // Fallback for older agy builds / unexpected non-stream-json output.
        resolve({ body: parseAgyPrintOutput(output), exitCode, usedFallback: false });
      });
    });
  });
}

async function invokeAgyPrintViaSpawn(
  binary: string,
  args: string[],
  ctx: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    onChunk?: (text: string) => void;
    spawnImpl: typeof spawn;
    ptyLoadError: string;
  },
): Promise<AgyPrintResult> {
  return new Promise<AgyPrintResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const streamReader = new AgyStreamJsonReader();

    const ptyNote = `node-pty unavailable (${ctx.ptyLoadError}); used plain spawn without a TTY — agy may hang or truncate in print mode`;

    const invocation =
      process.platform === "win32"
        ? resolveWin32SpawnInvocation(binary, args)
        : { file: binary, args, shell: false };
    const child = ctx.spawnImpl(invocation.file, invocation.args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: ctx.cwd,
      shell: invocation.shell,
      env: { ...process.env },
    });

    const cleanup = (): void => {
      clearTimeout(timer);
      if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      killProcessTree(child);
      reject(new Error(`agy: print-mode process timed out after ${ctx.timeoutMs}ms. ${ptyNote}`));
    }, ctx.timeoutMs);

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      killProcessTree(child);
      reject(new Error("agy: invocation aborted"));
    };

    if (ctx.signal) {
      if (ctx.signal.aborted) {
        onAbort();
        return;
      }
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    let pendingRaw = "";
    const handleStdoutChunk = (raw: string): void => {
      pendingRaw += raw;
      const holdMatch = pendingRaw.match(INCOMPLETE_CSI_RE);
      const stable = holdMatch ? pendingRaw.slice(0, -holdMatch[0].length) : pendingRaw;
      if (stable.length === 0) return;
      const cleaned = stripAnsi(stable);
      pendingRaw = holdMatch ? holdMatch[0] : "";
      if (!cleaned) return;
      const deltas = streamReader.push(cleaned);
      if (ctx.onChunk) {
        if (deltas.length > 0) {
          for (const delta of deltas) ctx.onChunk(delta);
        } else if (!streamReader.sawStreamEvent && !/^\s*\{/.test(cleaned)) {
          ctx.onChunk(cleaned);
        }
      }
      /*
      FNXC:AntigravityCli 2026-09-11-01:21:
      Same stream-json early-complete path as PTY — kill once result arrives so MCP
      children cannot keep the fallback spawn open after the turn finishes.
      */
      if (streamReader.result && !settled) {
        settled = true;
        cleanup();
        try {
          const result = settleFromAgyStreamResult(streamReader, 0, true);
          killProcessTree(child);
          resolve(result);
        } catch (err) {
          killProcessTree(child);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      const textChunk = chunk.toString("utf-8");
      stdout += textChunk;
      /*
      FNXC:AntigravityCli 2026-07-18-18:25:
      Same incremental ANSI strip + incomplete-CSI holdback as the PTY path.
      */
      handleStdoutChunk(textChunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      const isNotFound = err.code === "ENOENT";
      reject(
        new Error(
          isNotFound
            ? `agy: binary not found at "${binary}". Install agy or set binaryPath/AGY_BIN. ${ptyNote}`
            : `agy: spawn error — ${err.message}. ${ptyNote}`,
        ),
      );
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      /*
      FNXC:AntigravityCli 2026-09-11-07:32:
      Clear holdback before re-entry. Passing `pendingRaw` into handleStdoutChunk
      while it still holds the same string would double-append (`pendingRaw += raw`).
      */
      if (pendingRaw) {
        const leftover = pendingRaw;
        pendingRaw = "";
        handleStdoutChunk(leftover);
      }
      streamReader.flush();
      if (streamReader.result) {
        try {
          resolve(settleFromAgyStreamResult(streamReader, code ?? 0, true));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }
      if (code !== 0) {
        const combined = [stdout, stderr].filter(Boolean).join("\n");
        reject(
          new Error(
            `agy: print-mode process exited with code ${String(code)}. ${ptyNote}\n${parseAgyPrintOutput(combined)}`,
          ),
        );
        return;
      }
      resolve({ body: parseAgyPrintOutput(stdout), exitCode: code ?? 0, usedFallback: true });
    });
  });
}

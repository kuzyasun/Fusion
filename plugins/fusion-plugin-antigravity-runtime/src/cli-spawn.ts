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
 */
export function stripAntigravityModelPrefix(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  const trimmed = modelId.trim();
  if (!trimmed) return undefined;
  for (const prefix of ["antigravity-cli/", "antigravity/"]) {
    if (trimmed.startsWith(prefix)) {
      const rest = trimmed.slice(prefix.length).trim();
      return rest.length > 0 ? rest : undefined;
    }
  }
  return trimmed;
}

export type AntigravityPermissionMode = "skip" | "sandbox" | "prompt";

/** Settings resolved from plugin ctx.settings + env-var fallbacks. */
export interface AntigravityCliSettings {
  binaryPath: string;
  model?: string;
  /** Value passed as `--print-timeout` (CLI accepts duration like `5m` or ms). */
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
  const printTimeout =
    str(settings?.printTimeout) ??
    str(process.env.AGY_PRINT_TIMEOUT) ??
    (printTimeoutMs > 0 ? String(printTimeoutMs) : undefined);

  return {
    binaryPath:
      str(settings?.binaryPath) ??
      str(settings?.antigravityCliBinaryPath) ??
      str(process.env.AGY_BIN) ??
      "agy",
    model: stripAntigravityModelPrefix(str(settings?.model) ?? str(process.env.AGY_MODEL_ID)),
    printTimeout,
    cliTimeoutMs: num(settings?.cliTimeoutMs, "AGY_CLI_TIMEOUT_MS", 300_000),
    permissionMode,
  };
}

function formatSpawnError(error: Error & { code?: unknown }): string {
  const code = typeof error.code === "string" ? `${error.code}: ` : "";
  return `spawn error: ${code}${error.message}`.trim();
}

export function killProcessTree(child: { pid?: number; kill?: (...args: any[]) => void | boolean }): void {
  try {
    child.kill?.("SIGKILL");
  } catch {
    // best effort
  }
  if (process.platform === "win32" && typeof child.pid === "number" && child.pid > 0) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // best effort
    }
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
        ptyFile = process.env.ComSpec || "cmd.exe";
        ptyArgs = ["/c", binary, ...args];
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
    Strip ANSI on the cumulative PTY buffer, then emit only the cleaned delta.
    Hold back a trailing incomplete CSI (`ESC[`…) so a split escape sequence cannot
    leak ESC crumbs into onChunk — that used to make adapter dedupe re-emit the full body.
    */
    let emittedCleanLen = 0;
    child.onData((data: string) => {
      output += data;
      if (opts?.onChunk) {
        const holdMatch = output.match(INCOMPLETE_CSI_RE);
        const stable = holdMatch ? output.slice(0, -holdMatch[0].length) : output;
        const cleaned = stripAnsi(stable);
        if (cleaned.length > emittedCleanLen) {
          const delta = cleaned.slice(emittedCleanLen);
          emittedCleanLen = cleaned.length;
          if (delta) opts.onChunk(delta);
        }
      }
    });

    child.onExit(({ exitCode }: { exitCode: number }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (exitCode !== 0) {
        reject(
          new Error(
            `agy: print-mode process exited with code ${String(exitCode)} (PTY).\n${parseAgyPrintOutput(output)}`,
          ),
        );
        return;
      }
      resolve({ body: parseAgyPrintOutput(output), exitCode, usedFallback: false });
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

    let emittedCleanLen = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stdout += text;
      if (ctx.onChunk) {
        /*
        FNXC:AntigravityCli 2026-07-18-18:25:
        Same cumulative ANSI strip + incomplete-CSI holdback as the PTY path.
        */
        const holdMatch = stdout.match(INCOMPLETE_CSI_RE);
        const stable = holdMatch ? stdout.slice(0, -holdMatch[0].length) : stdout;
        const cleaned = stripAnsi(stable);
        if (cleaned.length > emittedCleanLen) {
          const delta = cleaned.slice(emittedCleanLen);
          emittedCleanLen = cleaned.length;
          if (delta) ctx.onChunk(delta);
        }
      }
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

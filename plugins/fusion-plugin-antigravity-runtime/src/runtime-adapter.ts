/**
 * Antigravity Runtime Adapter — drives the local `agy` CLI in headless print mode.
 *
 * FNXC:AntigravityRuntime 2026-07-18-18:10:
 * Each `promptWithFallback` runs `agy` print-mode inside a PTY. Session model ids
 * from the Fusion picker (`antigravity-cli/<label>`) are stripped and passed as
 * `--model`. AbortSignal cancels the live PTY/process. Partial PTY chunks may
 * stream via onText during the turn; the final cleaned body is always emitted
 * once at exit (deduped when chunks already delivered the same text).
 *
 * Known limitation: print-mode has no ACP tool-call stream and no Fusion `fn_*`
 * MCP bridge — treat this runtime as best for small non-interactive tasks that
 * the Antigravity agent can complete with its own tools under the subscription.
 */

import {
  invokeAgyPrint,
  resolveCliSettings,
  stripAntigravityModelPrefix,
} from "./cli-spawn.js";
import type { AntigravityCliSettings } from "./cli-spawn.js";
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSession,
  AgentSessionResult,
  AntigravityStreamSession,
} from "./types.js";

export type InvokeAgyPrintFn = typeof invokeAgyPrint;

function buildRuntimeContextSection(options: AgentRuntimeOptions): string {
  const skillNames = Array.isArray(options.skills)
    ? options.skills.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const skillSelection = options.skillSelection as { requestedSkillNames?: unknown } | undefined;
  const selectionSkillNames = Array.isArray(skillSelection?.requestedSkillNames)
    ? skillSelection.requestedSkillNames.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  const mergedSkills = skillNames.length > 0 ? skillNames : selectionSkillNames;

  const lines: string[] = [
    "Fusion runtime context:",
    `- Tool mode: ${options.tools ?? "coding"}`,
    "- You are running via Antigravity CLI print-mode under a Fusion host.",
    "- Prefer completing the request without asking interactive questions.",
    "- Fusion fn_* coordination tools are NOT available in this print-mode bridge; use Antigravity built-in tools only.",
  ];
  if (mergedSkills.length > 0) {
    lines.push(`- Requested skills (informational): ${mergedSkills.join(", ")}`);
  }
  return lines.join("\n");
}

function extractAbortSignal(options: unknown): AbortSignal | undefined {
  if (!options || typeof options !== "object") return undefined;
  const signal = (options as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

export class AntigravityRuntimeAdapter implements AgentRuntime {
  readonly id = "antigravity";
  readonly name = "Antigravity Runtime";

  private readonly settings: AntigravityCliSettings;
  private readonly invoke: InvokeAgyPrintFn;
  private readonly abortControllers = new Set<AbortController>();

  constructor(
    settings?: Record<string, unknown> | AntigravityCliSettings,
    deps?: { invokeAgyPrint?: InvokeAgyPrintFn },
  ) {
    this.settings = resolveCliSettings(settings as Record<string, unknown> | undefined);
    this.invoke = deps?.invokeAgyPrint ?? invokeAgyPrint;
  }

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    const systemPrompt = options.systemPrompt ?? "";
    const messages: unknown[] = [];
    const model =
      stripAntigravityModelPrefix(
        typeof options.defaultModelId === "string" ? options.defaultModelId : undefined,
      ) ?? this.settings.model;
    /*
    FNXC:AntigravityCli 2026-07-19-03:25:
    Fusion hard-cancel / move-to-todo / executor teardown call session.dispose(), not
    AntigravityRuntimeAdapter.dispose(). Wire session.dispose to abort in-flight print-mode
    turns so agy is killed instead of hanging until CLI exit or the print timeout.
    */
    const sessionAbortControllers = new Set<AbortController>();
    const session: AntigravityStreamSession = {
      model,
      systemPrompt,
      messages,
      state: { messages },
      cwd: options.cwd ?? process.cwd(),
      started: false,
      lastModelDescription: model ? `antigravity/${model}` : "antigravity",
      callbacks: {
        onText: options.onText,
        onThinking: options.onThinking,
        onToolStart: options.onToolStart,
        onToolEnd: options.onToolEnd,
      },
      runtimeContext: options.runtimeContext,
      fusedSystemPrompt: [systemPrompt.trim(), buildRuntimeContextSection(options).trim()]
        .filter((part) => part.length > 0)
        .join("\n\n"),
      sessionAbortControllers,
      dispose: () => {
        for (const controller of sessionAbortControllers) {
          try {
            controller.abort();
          } catch {
            // best effort
          }
        }
        sessionAbortControllers.clear();
      },
    };

    return { session, sessionFile: undefined };
  }

  async promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void> {
    const isFirstTurn = !session.started;
    const promptWithContext =
      isFirstTurn && session.fusedSystemPrompt
        ? `${session.fusedSystemPrompt}\n\nUser request:\n${prompt}`
        : prompt;

    const userMessage = { role: "user", content: prompt };
    session.messages.push(userMessage);

    const model =
      stripAntigravityModelPrefix(typeof session.model === "string" ? session.model : undefined) ??
      this.settings.model;

    const turnSettings: AntigravityCliSettings = {
      ...this.settings,
      model,
    };

    const externalSignal = extractAbortSignal(options);
    const localController = new AbortController();
    session.sessionAbortControllers?.add(localController);
    this.abortControllers.add(localController);

    const onExternalAbort = (): void => {
      localController.abort();
    };
    if (externalSignal) {
      if (externalSignal.aborted) {
        localController.abort();
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    let streamed = "";
    let result: Awaited<ReturnType<InvokeAgyPrintFn>>;
    try {
      result = await this.invoke(promptWithContext, turnSettings, {
        cwd: session.cwd,
        continue: !isFirstTurn,
        signal: localController.signal,
        onChunk: (chunk) => {
          streamed += chunk;
          session.callbacks.onText?.(chunk);
        },
      });
      session.state.errorMessage = undefined;
    } catch (err) {
      session.messages.pop();
      session.state.errorMessage = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      session.sessionAbortControllers?.delete(localController);
      this.abortControllers.delete(localController);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }

    session.started = true;
    session.lastModelDescription = model ? `antigravity/${model}` : "antigravity";
    session.messages.push({ role: "assistant", content: result.body });

    /*
    FNXC:AntigravityCli 2026-07-18-18:10:
    If no incremental chunks arrived (or chunks were empty after ANSI strip), emit the
    final body once. If chunks already delivered the full text, skip duplicate onText.

    FNXC:AntigravityCli 2026-07-18-18:55:
    Compare trimmed forms only. parseAgyPrintOutput already drops trailing incomplete CSI,
    so streamed (holdback-clean) and body should match when the turn completed mid-escape.
    */
    const streamedTrimmed = streamed.trim();
    const bodyTrimmed = result.body.trim();
    if (bodyTrimmed && streamedTrimmed !== bodyTrimmed) {
      if (bodyTrimmed.startsWith(streamedTrimmed) && streamedTrimmed.length > 0) {
        session.callbacks.onText?.(bodyTrimmed.slice(streamedTrimmed.length));
      } else {
        session.callbacks.onText?.(result.body);
      }
    } else if (bodyTrimmed && !streamedTrimmed) {
      session.callbacks.onText?.(result.body);
    }
  }

  describeModel(session: AgentSession): string {
    return session.lastModelDescription || this.describeFromSettings();
  }

  async dispose(_session: AgentSession): Promise<void> {
    this.abortInFlightTurns();
  }

  private abortInFlightTurns(): void {
    /*
    FNXC:AntigravityCli 2026-07-19-03:25:
    Shared abort path for session.dispose() (Fusion host cancel) and adapter.dispose().
    */
    for (const controller of this.abortControllers) {
      try {
        controller.abort();
      } catch {
        // best effort
      }
    }
    this.abortControllers.clear();
  }

  private describeFromSettings(): string {
    const model = this.settings.model;
    return model ? `antigravity/${model}` : "antigravity";
  }
}

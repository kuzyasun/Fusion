import { describe, expect, it, vi } from "vitest";
import { AntigravityRuntimeAdapter, type InvokeAgyPrintFn } from "../runtime-adapter.js";

function makeAdapter(invoke: InvokeAgyPrintFn, settings?: Record<string, unknown>) {
  return new AntigravityRuntimeAdapter(settings ?? { binaryPath: "agy", model: "gemini-antigravity" }, {
    invokeAgyPrint: invoke,
  });
}

describe("AntigravityRuntimeAdapter", () => {
  it("creates a session carrying the fused system prompt, cwd, and not-yet-started flag", async () => {
    const invoke = vi.fn<InvokeAgyPrintFn>(async () => ({ body: "", exitCode: 0, usedFallback: false }));
    const adapter = makeAdapter(invoke);

    const { session } = await adapter.createSession({
      systemPrompt: "You are a helper.",
      cwd: "/repo",
      tools: "coding",
      skills: ["fusion"],
    });

    expect(session.cwd).toBe("/repo");
    expect(session.started).toBe(false);
    expect(session.fusedSystemPrompt).toContain("You are a helper.");
    expect(session.fusedSystemPrompt).toContain("Fusion runtime context");
    expect(session.fusedSystemPrompt).toContain("Requested skills (informational): fusion");
    expect(session.fusedSystemPrompt).toContain("fn_* coordination tools are NOT available");
  });

  it("strips antigravity-cli/ prefix and passes model into invoke settings", async () => {
    const invoke = vi.fn<InvokeAgyPrintFn>(async () => ({ body: "ok", exitCode: 0, usedFallback: false }));
    const adapter = makeAdapter(invoke, { binaryPath: "agy" });
    const { session } = await adapter.createSession({
      systemPrompt: "SYS",
      cwd: "/repo",
      defaultModelId: "antigravity-cli/Gemini 3.5 Flash (Medium)",
    });
    expect(session.model).toBe("Gemini 3.5 Flash (Medium)");
    await adapter.promptWithFallback(session, "hi");
    const settingsArg = (invoke.mock.calls[0] as unknown as [string, { model?: string }])[1];
    expect(settingsArg.model).toBe("Gemini 3.5 Flash (Medium)");
  });

  it("prepends the fused system prompt on the FIRST turn and streams the body once", async () => {
    const invoke = vi.fn<InvokeAgyPrintFn>(async () => ({ body: "hello from agy", exitCode: 0, usedFallback: false }));
    const adapter = makeAdapter(invoke);
    const onText = vi.fn();

    const { session } = await adapter.createSession({ systemPrompt: "SYS", cwd: "/repo", onText });
    await adapter.promptWithFallback(session, "do the thing");

    expect(invoke).toHaveBeenCalled();
    const firstCall = invoke.mock.calls[0] as unknown as [string, unknown, { cwd?: string; continue?: boolean }];
    expect(firstCall[0]).toContain("SYS");
    expect(firstCall[0]).toContain("User request:\ndo the thing");
    expect(firstCall[2]).toMatchObject({ cwd: "/repo", continue: false });

    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith("hello from agy");
    expect(session.started).toBe(true);
  });

  it("does not re-emit onText when onChunk already delivered the cleaned body", async () => {
    const invoke = vi.fn<InvokeAgyPrintFn>(async (_prompt, _settings, opts) => {
      opts?.onChunk?.("Answer text");
      return { body: "Answer text", exitCode: 0, usedFallback: false };
    });
    const adapter = makeAdapter(invoke);
    const onText = vi.fn();
    const { session } = await adapter.createSession({ systemPrompt: "SYS", onText });
    await adapter.promptWithFallback(session, "hi");
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith("Answer text");
  });

  it("forwards AbortSignal and aborts in-flight turns on session.dispose (Fusion host cancel)", async () => {
    let seenSignal: AbortSignal | undefined;
    const invoke = vi.fn<InvokeAgyPrintFn>(async (_prompt, _settings, opts) => {
      seenSignal = opts?.signal;
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (opts?.signal?.aborted) throw new Error("agy: invocation aborted");
      return { body: "late", exitCode: 0, usedFallback: false };
    });
    const adapter = makeAdapter(invoke);
    const { session } = await adapter.createSession({ systemPrompt: "SYS", cwd: "/repo" });
    const pending = adapter.promptWithFallback(session, "slow");
    session.dispose();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(seenSignal?.aborted).toBe(true);
  });

  it("aborts in-flight turns on adapter.dispose as well", async () => {
    let seenSignal: AbortSignal | undefined;
    const invoke = vi.fn<InvokeAgyPrintFn>(async (_prompt, _settings, opts) => {
      seenSignal = opts?.signal;
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (opts?.signal?.aborted) throw new Error("agy: invocation aborted");
      return { body: "late", exitCode: 0, usedFallback: false };
    });
    const adapter = makeAdapter(invoke);
    const { session } = await adapter.createSession({ systemPrompt: "SYS", cwd: "/repo" });
    const pending = adapter.promptWithFallback(session, "slow");
    await adapter.dispose(session);
    await expect(pending).rejects.toThrow(/aborted/);
    expect(seenSignal?.aborted).toBe(true);
  });

  it("isolates session disposal so disposing session A does not abort concurrent session B", async () => {
    const invoke = vi.fn<InvokeAgyPrintFn>(async (prompt, _settings, opts) => {
      if (prompt === "session-a") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (opts?.signal?.aborted) throw new Error("agy: invocation aborted");
        return { body: "a-done", exitCode: 0, usedFallback: false };
      }
      // session-b finishes successfully after session-a is disposed
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (opts?.signal?.aborted) throw new Error("agy: invocation aborted");
      return { body: "b-done", exitCode: 0, usedFallback: false };
    });
    const adapter = makeAdapter(invoke);
    const { session: sessionA } = await adapter.createSession({ systemPrompt: "SYS A" });
    const { session: sessionB } = await adapter.createSession({ systemPrompt: "SYS B" });

    const turnA = adapter.promptWithFallback(sessionA, "session-a");
    const turnB = adapter.promptWithFallback(sessionB, "session-b");

    // Dispose session A while both are in-flight
    sessionA.dispose();

    await expect(turnA).rejects.toThrow(/aborted/);
    await expect(turnB).resolves.toBeUndefined();
    expect(sessionB.messages).toContainEqual({ role: "assistant", content: "b-done" });
  });

  it("uses --continue and re-sends a context-light prompt on later turns", async () => {
    const invoke = vi.fn<InvokeAgyPrintFn>(async () => ({ body: "ok", exitCode: 0, usedFallback: false }));
    const adapter = makeAdapter(invoke);

    const { session } = await adapter.createSession({ systemPrompt: "SYS" });
    await adapter.promptWithFallback(session, "first");
    await adapter.promptWithFallback(session, "second");

    expect(invoke).toHaveBeenCalledTimes(2);
    const secondCall = invoke.mock.calls[1] as unknown as [string, unknown, { continue?: boolean }];
    expect(secondCall[0]).toBe("second");
    expect(secondCall[0]).not.toContain("SYS");
    expect(secondCall[2]).toMatchObject({ continue: true });
  });

  it("pops the user turn, records the error, and rethrows on invoke failure", async () => {
    const invoke = vi.fn<InvokeAgyPrintFn>(async () => {
      throw new Error("agy: print-mode process timed out after 300000ms (PTY)");
    });
    const adapter = makeAdapter(invoke);
    const { session } = await adapter.createSession({ systemPrompt: "SYS" });

    await expect(adapter.promptWithFallback(session, "boom")).rejects.toThrow(/timed out/);
    expect(session.state.errorMessage).toContain("timed out");
    expect(session.messages).not.toContainEqual({ role: "user", content: "boom" });
    expect(session.started).toBe(false);
  });

  it("describeModel reflects the configured model", async () => {
    const invoke = vi.fn(async () => ({ body: "", exitCode: 0, usedFallback: false }));
    const adapter = makeAdapter(invoke, { binaryPath: "agy", model: "gemini-antigravity" });
    const { session } = await adapter.createSession({ systemPrompt: "SYS" });
    expect(adapter.describeModel(session)).toBe("antigravity/gemini-antigravity");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createResolvedAgentSession } from "../agents/agent-session-helpers.js";

const mockCreateFnAgent = vi.hoisted(() => vi.fn());

vi.mock("../pi.js", () => ({
  createFnAgent: mockCreateFnAgent,
  promptWithFallback: vi.fn().mockResolvedValue(undefined),
  describeModel: vi.fn().mockReturnValue("pi/default"),
  wrapToolsWithActionGate: vi.fn((tools) => tools),
  wrapToolsWithPermanentAgentGating: vi.fn((tools) => tools),
  wrapToolsWithRtkRewrite: vi.fn((tools) => tools),
}));

/*
FNXC:AntigravityCli 2026-07-18-18:25:
antigravity-cli selections must never fall through to pi's model registry — route to the
bundled Antigravity print-mode runtime, strip picker prefixes, and remediate when missing.
*/
function makeAntigravityPluginRunnerStub(options?: { includeAntigravity?: boolean }) {
  const createSession = vi.fn().mockResolvedValue({
    session: { model: "Gemini 3.5 Flash (Medium)", messages: [], dispose: vi.fn() },
  });
  const antigravityRegistration = {
    pluginId: "fusion-plugin-antigravity-runtime",
    runtime: {
      metadata: { runtimeId: "antigravity", name: "Antigravity Runtime" },
      factory: vi.fn().mockResolvedValue({
        id: "antigravity",
        name: "Antigravity Runtime",
        createSession,
        promptWithFallback: vi.fn(),
        describeModel: vi.fn(() => "antigravity/Gemini 3.5 Flash (Medium)"),
      }),
    },
  };
  const getRuntimeById = vi.fn((runtimeId: string) => {
    if (runtimeId === "antigravity" && options?.includeAntigravity !== false) {
      return antigravityRegistration;
    }
    return undefined;
  });
  return {
    pluginRunner: {
      getRuntimeById,
      createRuntimeContext: vi.fn().mockResolvedValue({
        pluginId: "fusion-plugin-antigravity-runtime",
        taskStore: {},
        settings: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        emitEvent: vi.fn(),
      }),
    },
    getRuntimeById,
    createSession,
  };
}

function sessionOptions(overrides: Record<string, unknown> = {}) {
  return {
    sessionPurpose: "executor" as const,
    cwd: "/tmp/project",
    systemPrompt: "system",
    ...overrides,
  };
}

describe("createResolvedAgentSession Antigravity runtime routing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockCreateFnAgent.mockReset().mockResolvedValue({
      session: { model: "pi/default", messages: [], dispose: vi.fn() },
    });
  });

  it.each(["Gemini 3.5 Flash (Medium)", "antigravity-cli/Gemini 3.5 Flash (Medium)", "antigravity/Gemini 3.5 Flash (Medium)"])(
    "routes primary antigravity-cli model %s through Antigravity runtime instead of pi",
    async (defaultModelId) => {
      const { pluginRunner, getRuntimeById, createSession } = makeAntigravityPluginRunnerStub();
      const audit = { database: vi.fn().mockResolvedValue(undefined) };

      const result = await createResolvedAgentSession(
        sessionOptions({
          pluginRunner: pluginRunner as never,
          runAuditor: audit as never,
          defaultProvider: "antigravity-cli",
          defaultModelId,
        }),
      );

      expect(result.runtimeId).toBe("antigravity");
      expect(getRuntimeById).toHaveBeenCalledWith("antigravity");
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProvider: "antigravity-cli",
          defaultModelId: "Gemini 3.5 Flash (Medium)",
        }),
      );
      expect(mockCreateFnAgent).not.toHaveBeenCalled();
      expect(audit.database).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "session:runtime-resolved",
          target: "antigravity",
          metadata: expect.objectContaining({ provider: "antigravity-cli", runtimeId: "antigravity" }),
        }),
      );
    },
  );

  it("arms a deferred antigravity-cli fallback for a foreign primary", async () => {
    const { pluginRunner } = makeAntigravityPluginRunnerStub();
    const audit = { database: vi.fn().mockResolvedValue(undefined) };

    const result = await createResolvedAgentSession(
      sessionOptions({
        pluginRunner: pluginRunner as never,
        runAuditor: audit as never,
        defaultProvider: "openai",
        defaultModelId: "gpt-5",
        fallbackProvider: "antigravity-cli",
        fallbackModelId: "antigravity-cli/Gemini 3.5 Flash (Medium)",
        fallbackThinkingLevel: "high",
      }),
    );

    expect(result.runtimeId).toBe("pi");
    expect(audit.database).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session:runtime-resolved",
        metadata: expect.objectContaining({ crossRuntimeFallbackDeferred: true }),
      }),
    );
  });

  it.each([
    ["an absent runtime registration", makeAntigravityPluginRunnerStub({ includeAntigravity: false }).pluginRunner],
    ["no pluginRunner", undefined],
  ])("reports Antigravity plugin remediation for %s", async (_label, pluginRunner) => {
    const promise = createResolvedAgentSession(
      sessionOptions({
        pluginRunner: pluginRunner as never,
        defaultProvider: "antigravity-cli",
        defaultModelId: "Gemini 3.5 Flash (Medium)",
      }),
    );

    await expect(promise).rejects.toThrow(/fusion-plugin-antigravity-runtime/);
    expect(mockCreateFnAgent).not.toHaveBeenCalled();
  });
});

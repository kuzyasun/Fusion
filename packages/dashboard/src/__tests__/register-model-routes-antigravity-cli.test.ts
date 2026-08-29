import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined),
    // FNXC:AntigravityCli 2026-07-18-18:10:
    // Intentionally omits an "antigravity-cli" key so the toggle path
    // (useAntigravityCli -> configuredProviders.add) is proven on its own,
    // not masked by an auth.json entry — mirrors the Grok CLI fixture.
    readFile: vi.fn().mockResolvedValue('{"anthropic":{},"openai":{}}'),
  };
});

vi.mock("../antigravity-model-cache.js", () => ({
  getAntigravityPickerModels: vi.fn(),
  ANTIGRAVITY_PICKER_PROVIDER_ID: "antigravity-cli",
}));

/*
FNXC:AntigravityCli 2026-07-18-18:15:
Mock sibling CLI picker caches as empty no-ops so this suite does not pull
`runtime-provider-probes` (and thus `@fusion-plugin-examples/antigravity-runtime`
dist entry) through unmocked grok/cursor/hermes/claude/omp caches. Grok's
fixture only mocks grok; here the antigravity plugin dist may be absent in a
partial worktree install, so the sibling mocks keep the suite self-contained.
*/
vi.mock("../grok-model-cache.js", () => ({
  getGrokPickerModels: vi.fn().mockResolvedValue([]),
  GROK_PICKER_PROVIDER_ID: "grok-cli",
}));
vi.mock("../cursor-model-cache.js", () => ({
  getCursorPickerModels: vi.fn().mockResolvedValue([]),
  CURSOR_PICKER_PROVIDER_ID: "cursor-cli",
}));
vi.mock("../hermes-model-cache.js", () => ({
  getHermesPickerModels: vi.fn().mockResolvedValue([]),
  HERMES_PICKER_PROVIDER_ID: "hermes-cli",
}));
vi.mock("../claude-model-cache.js", () => ({
  getClaudePickerModels: vi.fn().mockResolvedValue([]),
  CLAUDE_PICKER_PROVIDER_ID: "claude-cli",
}));
vi.mock("../omp-model-cache.js", () => ({
  getOmpPickerModels: vi.fn().mockResolvedValue([]),
  OMP_PICKER_PROVIDER_ID: "omp-cli",
}));

import type { Router } from "express";
import { getAntigravityPickerModels } from "../antigravity-model-cache.js";
import { registerModelRoutes } from "../routes/register-model-routes.js";

const mockedGetAntigravityPickerModels = vi.mocked(getAntigravityPickerModels);

function setup(
  useAntigravityCli?: boolean,
  registryModels?: Array<{ provider: string; id: string; name: string; reasoning: boolean; contextWindow: number }>,
  antigravityCliBinaryPath?: unknown,
) {
  const getHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const postHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      getHandlers.set(path, handler);
    }),
    post: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      postHandlers.set(path, handler);
    }),
  } as unknown as Router;

  const store = {
    getGlobalSettingsStore: () => ({
      getSettings: vi.fn().mockResolvedValue({ useAntigravityCli, antigravityCliBinaryPath }),
    }),
    getSettingsFast: vi.fn().mockResolvedValue({}),
  };

  const runtimeLogger = {
    child: vi.fn(() => ({ warn: vi.fn() })),
  };

  const modelRegistry = {
    refresh: vi.fn().mockResolvedValue(undefined),
    getAvailable: vi.fn(
      () =>
        registryModels ?? [{ provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 128000 }],
    ),
  };

  registerModelRoutes({
    router,
    store: store as never,
    runtimeLogger: runtimeLogger as never,
    options: { modelRegistry } as never,
  } as never);

  return getHandlers.get("/models")!;
}

async function invoke(handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) {
  const json = vi.fn();
  await handler({}, { json });
  return json.mock.calls[0][0] as { models: Array<{ provider: string; id: string; name: string }> };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("registerModelRoutes antigravity-cli merge and filter", () => {
  it("filters antigravity-cli models when useAntigravityCli is false, even when discovery would return some", async () => {
    mockedGetAntigravityPickerModels.mockResolvedValue([
      { provider: "antigravity-cli", id: "gemini-3-flash", name: "Gemini 3 Flash", reasoning: false, contextWindow: 0 },
    ]);
    const handler = setup(false);
    const response = await invoke(handler);
    expect(response.models.some((model) => model.provider === "antigravity-cli")).toBe(false);
    // Discovery must not even be attempted when the toggle is off.
    expect(mockedGetAntigravityPickerModels).not.toHaveBeenCalled();
  });

  it("includes discovered antigravity-cli models when useAntigravityCli is true, via the toggle alone (no auth.json entry needed)", async () => {
    mockedGetAntigravityPickerModels.mockResolvedValue([
      { provider: "antigravity-cli", id: "gemini-3-flash", name: "Gemini 3 Flash", reasoning: false, contextWindow: 0 },
      { provider: "antigravity-cli", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: false, contextWindow: 0 },
    ]);
    const handler = setup(true);
    const response = await invoke(handler);
    const antigravityRows = response.models.filter((m) => m.provider === "antigravity-cli");
    expect(antigravityRows.map((m) => m.id).sort()).toEqual(["claude-sonnet-4-5", "gemini-3-flash"]);
  });

  it("preserves all pre-existing rows (openai, droid-cli-style) alongside newly-surfaced antigravity-cli rows", async () => {
    mockedGetAntigravityPickerModels.mockResolvedValue([
      { provider: "antigravity-cli", id: "gemini-3-flash", name: "Gemini 3 Flash", reasoning: false, contextWindow: 0 },
    ]);
    const registryModels = [
      { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 128000 },
      { provider: "droid-cli", id: "droid-1", name: "Droid 1", reasoning: false, contextWindow: 0 },
    ];
    const handler = setup(true, registryModels);
    const response = await invoke(handler);
    expect(response.models.some((m) => m.provider === "openai" && m.id === "gpt-5")).toBe(true);
    expect(response.models.some((m) => m.provider === "antigravity-cli" && m.id === "gemini-3-flash")).toBe(true);
  });

  it("dedupes by provider/id when a discovered id collides with an existing registry row — existing row wins", async () => {
    const registryModels = [
      {
        provider: "antigravity-cli",
        id: "gemini-3-flash",
        name: "Registry Gemini 3 Flash (pre-existing)",
        reasoning: true,
        contextWindow: 128000,
      },
    ];
    mockedGetAntigravityPickerModels.mockResolvedValue([
      {
        provider: "antigravity-cli",
        id: "gemini-3-flash",
        name: "Discovered Gemini 3 Flash (should be dropped)",
        reasoning: false,
        contextWindow: 0,
      },
    ]);
    const handler = setup(true, registryModels);
    const response = await invoke(handler);
    const antigravityRows = response.models.filter(
      (m) => m.provider === "antigravity-cli" && m.id === "gemini-3-flash",
    );
    expect(antigravityRows).toHaveLength(1);
    expect(antigravityRows[0]?.name).toBe("Registry Gemini 3 Flash (pre-existing)");
  });

  it("degrades to zero antigravity-cli rows (HTTP 200, existing rows intact) when discovery returns empty", async () => {
    mockedGetAntigravityPickerModels.mockResolvedValue([]);
    const handler = setup(true);
    const response = await invoke(handler);
    expect(response.models.some((m) => m.provider === "antigravity-cli")).toBe(false);
    expect(response.models.some((m) => m.provider === "openai" && m.id === "gpt-5")).toBe(true);
  });

  it("degrades to zero antigravity-cli rows (never rejects the handler) when discovery throws", async () => {
    mockedGetAntigravityPickerModels.mockRejectedValue(new Error("agy unavailable"));
    const handler = setup(true);
    const response = await invoke(handler);
    expect(response.models.some((m) => m.provider === "antigravity-cli")).toBe(false);
    expect(response.models.some((m) => m.provider === "openai" && m.id === "gpt-5")).toBe(true);
  });

  it("surfaces a single discovered model", async () => {
    mockedGetAntigravityPickerModels.mockResolvedValue([
      { provider: "antigravity-cli", id: "agy-only", name: "Only", reasoning: false, contextWindow: 0 },
    ]);
    const handler = setup(true);
    const response = await invoke(handler);
    expect(response.models.filter((m) => m.provider === "antigravity-cli")).toHaveLength(1);
  });

  it("final response is deduped by provider/id across all merged sources", async () => {
    mockedGetAntigravityPickerModels.mockResolvedValue([
      { provider: "antigravity-cli", id: "agy-dup", name: "A", reasoning: false, contextWindow: 0 },
    ]);
    const registryModels = [
      { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 128000 },
      { provider: "openai", id: "gpt-5", name: "GPT-5 dup", reasoning: true, contextWindow: 128000 },
    ];
    const handler = setup(true, registryModels);
    const response = await invoke(handler);
    const keys = response.models.map((m) => `${m.provider}/${m.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/*
FNXC:AntigravityCli 2026-07-18-18:10:
Mirrors Grok CLI binaryPath threading coverage so the machine-local
antigravityCliBinaryPath operator override also applies to model-picker discovery.
*/
describe("registerModelRoutes antigravityCliBinaryPath threading", () => {
  it("threads a set antigravityCliBinaryPath override into getAntigravityPickerModels verbatim", async () => {
    mockedGetAntigravityPickerModels.mockResolvedValue([
      { provider: "antigravity-cli", id: "gemini-3-flash", name: "Gemini 3 Flash", reasoning: false, contextWindow: 0 },
    ]);
    const handler = setup(true, undefined, "/opt/Antigravity/agy");
    const response = await invoke(handler);
    expect(mockedGetAntigravityPickerModels).toHaveBeenCalledWith({ binaryPath: "/opt/Antigravity/agy" });
    expect(response.models.some((m) => m.provider === "antigravity-cli" && m.id === "gemini-3-flash")).toBe(true);
  });

  it("threads a Windows-shim-style override path verbatim, with no mangling", async () => {
    mockedGetAntigravityPickerModels.mockResolvedValue([]);
    const winPath = "C:\\Users\\A User\\AppData\\Roaming\\npm\\agy.cmd";
    const handler = setup(true, undefined, winPath);
    await invoke(handler);
    expect(mockedGetAntigravityPickerModels).toHaveBeenCalledWith({ binaryPath: winPath });
  });

  it("passes binaryPath: undefined when antigravityCliBinaryPath is absent (PATH auto-detection preserved)", async () => {
    mockedGetAntigravityPickerModels.mockResolvedValue([]);
    const handler = setup(true, undefined, undefined);
    await invoke(handler);
    expect(mockedGetAntigravityPickerModels).toHaveBeenCalledWith({ binaryPath: undefined });
  });

  it("passes binaryPath: undefined when antigravityCliBinaryPath is blank/whitespace-only", async () => {
    mockedGetAntigravityPickerModels.mockResolvedValue([]);
    const handler = setup(true, undefined, "   ");
    await invoke(handler);
    expect(mockedGetAntigravityPickerModels).toHaveBeenCalledWith({ binaryPath: undefined });
  });

  it("does not surface antigravity-cli rows or call getAntigravityPickerModels when useAntigravityCli is false, regardless of antigravityCliBinaryPath", async () => {
    const handler = setup(false, undefined, "/opt/Antigravity/agy");
    const response = await invoke(handler);
    expect(mockedGetAntigravityPickerModels).not.toHaveBeenCalled();
    expect(response.models.some((m) => m.provider === "antigravity-cli")).toBe(false);
  });
});

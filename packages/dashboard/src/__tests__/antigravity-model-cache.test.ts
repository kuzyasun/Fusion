import { afterEach, describe, expect, it, vi } from "vitest";
import type { AntigravityModelDiscoveryResult } from "../runtime-provider-probes.js";

vi.mock("../runtime-provider-probes.js", () => ({
  discoverAntigravityCliModels: vi.fn(),
}));

import { discoverAntigravityCliModels } from "../runtime-provider-probes.js";
import {
  __resetAntigravityPickerModelsCacheForTests,
  antigravityDiscoveryToModels,
  getAntigravityPickerModels,
} from "../antigravity-model-cache.js";

const mockedDiscover = vi.mocked(discoverAntigravityCliModels);

afterEach(() => {
  vi.clearAllMocks();
  __resetAntigravityPickerModelsCacheForTests();
});

describe("antigravityDiscoveryToModels", () => {
  it("maps a discovered model with a label", () => {
    const models = antigravityDiscoveryToModels([{ id: "gemini-3-flash", label: "Gemini 3 Flash" }]);
    expect(models).toEqual([
      {
        provider: "antigravity-cli",
        id: "gemini-3-flash",
        name: "Gemini 3 Flash",
        reasoning: false,
        contextWindow: 0,
      },
    ]);
  });

  it("falls back to the id as the name when no label is provided", () => {
    const models = antigravityDiscoveryToModels([{ id: "claude-sonnet-4-5" }]);
    expect(models).toEqual([
      {
        provider: "antigravity-cli",
        id: "claude-sonnet-4-5",
        name: "claude-sonnet-4-5",
        reasoning: false,
        contextWindow: 0,
      },
    ]);
  });

  it("de-duplicates entries that map to the same stable id, keeping the first occurrence", () => {
    const models = antigravityDiscoveryToModels([
      { id: "gemini-3-flash", label: "First" },
      { id: "gemini-3-flash", label: "Second" },
    ]);
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe("First");
  });

  it("returns an empty array for an empty model list", () => {
    expect(antigravityDiscoveryToModels([])).toEqual([]);
  });
});

describe("getAntigravityPickerModels caching", () => {
  it("fetches once and returns mapped models", async () => {
    mockedDiscover.mockResolvedValue({
      models: [{ id: "gemini-3-flash", label: "Gemini 3 Flash" }],
      source: "models-text",
      fallbackUsed: false,
    });

    const models = await getAntigravityPickerModels({ binaryPath: "agy-test-1" });

    expect(models).toEqual([
      {
        provider: "antigravity-cli",
        id: "gemini-3-flash",
        name: "Gemini 3 Flash",
        reasoning: false,
        contextWindow: 0,
      },
    ]);
    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("serves subsequent requests within the TTL window from cache with no additional spawn", async () => {
    mockedDiscover.mockResolvedValue({
      models: [{ id: "gemini-3-flash" }],
      source: "models-text",
      fallbackUsed: false,
    });
    let clock = 1000;
    const now = () => clock;

    await getAntigravityPickerModels({ binaryPath: "agy-test-2", ttlMs: 60_000, now });
    clock += 30_000;
    await getAntigravityPickerModels({ binaryPath: "agy-test-2", ttlMs: 60_000, now });

    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("refreshes after the TTL window expires", async () => {
    mockedDiscover.mockResolvedValue({
      models: [{ id: "gemini-3-flash" }],
      source: "models-text",
      fallbackUsed: false,
    });
    let clock = 1000;
    const now = () => clock;

    await getAntigravityPickerModels({ binaryPath: "agy-test-3", ttlMs: 1_000, now });
    clock += 1_001;
    await getAntigravityPickerModels({ binaryPath: "agy-test-3", ttlMs: 1_000, now });

    expect(mockedDiscover).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent requests for the same binaryPath", async () => {
    let resolveFetch: (v: AntigravityModelDiscoveryResult) => void = () => {};
    mockedDiscover.mockImplementation(
      () =>
        new Promise<AntigravityModelDiscoveryResult>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const p1 = getAntigravityPickerModels({ binaryPath: "agy-test-4" });
    const p2 = getAntigravityPickerModels({ binaryPath: "agy-test-4" });

    resolveFetch({ models: [{ id: "gemini-3-flash" }], source: "models-text", fallbackUsed: false });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual(r2);
    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("degrades to an empty array (never throws) when the CLI fetch rejects, and caches the empty result", async () => {
    mockedDiscover.mockRejectedValue(new Error("agy models failed: binary not found"));
    let clock = 1000;
    const now = () => clock;

    const first = await getAntigravityPickerModels({ binaryPath: "agy-test-5", ttlMs: 60_000, now });
    expect(first).toEqual([]);

    clock += 10;
    const second = await getAntigravityPickerModels({ binaryPath: "agy-test-5", ttlMs: 60_000, now });
    expect(second).toEqual([]);

    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("degrades to an empty array when discovery reports the binary unavailable (fallbackUsed, empty models)", async () => {
    mockedDiscover.mockResolvedValue({
      models: [],
      source: "probe",
      fallbackUsed: true,
      reason: "binary unavailable",
    });

    const models = await getAntigravityPickerModels({ binaryPath: "agy-test-6" });
    expect(models).toEqual([]);
  });

  it("defaults binaryPath to agy when not explicitly provided", async () => {
    mockedDiscover.mockResolvedValue({ models: [], source: "probe", fallbackUsed: true });

    await getAntigravityPickerModels();
    expect(mockedDiscover).toHaveBeenCalledWith({ binaryPath: "agy" });
  });

  it("caches distinct binaryPaths independently", async () => {
    mockedDiscover.mockResolvedValue({
      models: [{ id: "gemini-3-flash" }],
      source: "models-text",
      fallbackUsed: false,
    });

    await getAntigravityPickerModels({ binaryPath: "agy-test-7a" });
    await getAntigravityPickerModels({ binaryPath: "agy-test-7b" });

    expect(mockedDiscover).toHaveBeenCalledTimes(2);
  });

  it("re-fetches an empty/unavailable result well before the full 60s TTL elapses", async () => {
    mockedDiscover.mockResolvedValueOnce({
      models: [],
      source: "probe",
      fallbackUsed: true,
      reason: "binary unavailable",
    });
    let clock = 1000;
    const now = () => clock;

    const first = await getAntigravityPickerModels({ binaryPath: "agy-test-8", ttlMs: 60_000, now });
    expect(first).toEqual([]);

    // Well past a short negative-TTL window, but far short of the full 60s TTL.
    clock += 10_000;
    mockedDiscover.mockResolvedValueOnce({
      models: [{ id: "gemini-3-flash" }],
      source: "models-text",
      fallbackUsed: false,
    });
    const second = await getAntigravityPickerModels({ binaryPath: "agy-test-8", ttlMs: 60_000, now });

    expect(second).toEqual([
      {
        provider: "antigravity-cli",
        id: "gemini-3-flash",
        name: "gemini-3-flash",
        reasoning: false,
        contextWindow: 0,
      },
    ]);
    expect(mockedDiscover).toHaveBeenCalledTimes(2);
  });

  it("keeps a successful non-empty result cached for the full requested TTL (unlike an empty result)", async () => {
    mockedDiscover.mockResolvedValueOnce({
      models: [{ id: "gemini-3-flash" }],
      source: "models-text",
      fallbackUsed: false,
    });
    let clock = 1000;
    const now = () => clock;

    await getAntigravityPickerModels({ binaryPath: "agy-test-9", ttlMs: 60_000, now });
    clock += 10_000; // inside the 60s TTL for a non-empty result
    await getAntigravityPickerModels({ binaryPath: "agy-test-9", ttlMs: 60_000, now });

    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });
});

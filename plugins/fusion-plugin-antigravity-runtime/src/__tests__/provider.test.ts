import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseAgyModelEntries, parseAgyModelLines } from "../process-manager.js";

describe("parseAgyModelLines", () => {
  it("parses a bulleted list, dropping preamble/header and the (default) annotation", () => {
    const raw = [
      "You are logged in with Antigravity",
      "Default model: gemini-antigravity",
      "Available models:",
      "* gemini-antigravity (default)",
      "- gemini-antigravity-fast",
      "- claude-sonnet-via-agy",
    ].join("\n");

    expect(parseAgyModelLines(raw)).toEqual([
      "gemini-antigravity",
      "gemini-antigravity-fast",
      "claude-sonnet-via-agy",
    ]);
  });

  it("keeps real agy labels with spaces and thinking tiers intact", () => {
    const raw = [
      "Gemini 3.5 Flash (Medium)",
      "Claude Opus 4.6 (Thinking)",
      "GPT-OSS 120B (Medium)",
    ].join("\n");
    expect(parseAgyModelLines(raw)).toEqual([
      "Gemini 3.5 Flash (Medium)",
      "Claude Opus 4.6 (Thinking)",
      "GPT-OSS 120B (Medium)",
    ]);
  });

  it("splits agy 1.2.0 id\\tlabel rows and keeps only the machine id", () => {
    const raw = [
      "Fetching available models...",
      "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
      "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
      "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
    ].join("\n");
    expect(parseAgyModelLines(raw)).toEqual([
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "claude-opus-4-6-thinking",
    ]);
  });

  it("dedupes repeated ids", () => {
    const raw = ["- model-a", "- model-a", "- model-b"].join("\n");
    expect(parseAgyModelLines(raw)).toEqual(["model-a", "model-b"]);
  });

  it("returns an empty array for a no-models message", () => {
    expect(parseAgyModelLines("No models available")).toEqual([]);
  });
});

describe("parseAgyModelEntries", () => {
  it("pairs machine ids with human labels for tab-separated agy 1.2.0 rows", () => {
    const raw = [
      "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
      "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
    ].join("\n");
    expect(parseAgyModelEntries(raw)).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
    ]);
  });
});

describe("discoverAntigravityProviderModels", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("uses the override-aware probe binary for model discovery", async () => {
    vi.doMock("../probe.js", () => ({ probeAntigravityBinary: vi.fn() }));
    vi.doMock("../process-manager.js", () => ({ discoverAntigravityModels: vi.fn() }));

    const { probeAntigravityBinary } = await import("../probe.js");
    const { discoverAntigravityModels } = await import("../process-manager.js");
    const { discoverAntigravityProviderModels } = await import("../provider.js");

    vi.mocked(probeAntigravityBinary).mockResolvedValue({
      available: true,
      authenticated: true,
      binaryName: "/usr/local/bin/agy",
      binaryPath: "/usr/local/bin/agy",
      configuredBinaryPath: "/usr/local/bin/agy",
      usingConfiguredBinaryPath: true,
      probeDurationMs: 5,
    });
    vi.mocked(discoverAntigravityModels).mockResolvedValue({
      models: ["gemini-antigravity"],
      labels: ["gemini-antigravity"],
      source: "models-text",
      fallbackUsed: false,
    });

    const result = await discoverAntigravityProviderModels({ binaryPath: "/usr/local/bin/agy" });

    expect(probeAntigravityBinary).toHaveBeenCalledWith({ binaryPath: "/usr/local/bin/agy" });
    expect(discoverAntigravityModels).toHaveBeenCalledWith("/usr/local/bin/agy");
    expect(result.models).toEqual([{ id: "gemini-antigravity", label: "gemini-antigravity" }]);
  });

  it("maps parallel discovery labels onto picker rows for tab-separated models", async () => {
    vi.doMock("../probe.js", () => ({ probeAntigravityBinary: vi.fn() }));
    vi.doMock("../process-manager.js", () => ({ discoverAntigravityModels: vi.fn() }));

    const { probeAntigravityBinary } = await import("../probe.js");
    const { discoverAntigravityModels } = await import("../process-manager.js");
    const { discoverAntigravityProviderModels } = await import("../provider.js");

    vi.mocked(probeAntigravityBinary).mockResolvedValue({
      available: true,
      authenticated: true,
      binaryName: "agy",
      binaryPath: "agy",
      probeDurationMs: 3,
    });
    vi.mocked(discoverAntigravityModels).mockResolvedValue({
      models: ["gemini-3.8-flash-medium", "claude-opus-4-6-thinking"],
      labels: ["Gemini 3.8 Flash (Medium)", "Claude Opus 4.6 (Thinking)"],
      source: "models-text",
      fallbackUsed: false,
    });

    const result = await discoverAntigravityProviderModels();

    expect(result.models).toEqual([
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
      { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
    ]);
  });

  it("returns probe diagnostics when no effective binary is available", async () => {
    vi.doMock("../probe.js", () => ({ probeAntigravityBinary: vi.fn() }));
    vi.doMock("../process-manager.js", () => ({ discoverAntigravityModels: vi.fn() }));

    const { probeAntigravityBinary } = await import("../probe.js");
    const { discoverAntigravityModels } = await import("../process-manager.js");
    const { discoverAntigravityProviderModels } = await import("../provider.js");

    vi.mocked(probeAntigravityBinary).mockResolvedValue({
      available: false,
      authenticated: false,
      configuredBinaryPath: "/missing/agy",
      reason: "Configured Antigravity CLI binary '/missing/agy' failed; PATH fallback agy also failed",
      probeDurationMs: 4,
    });

    const result = await discoverAntigravityProviderModels({ binaryPath: "/missing/agy" });

    expect(discoverAntigravityModels).not.toHaveBeenCalled();
    expect(result).toEqual({
      models: [],
      source: "probe",
      fallbackUsed: true,
      reason: "Configured Antigravity CLI binary '/missing/agy' failed; PATH fallback agy also failed",
    });
  });
});

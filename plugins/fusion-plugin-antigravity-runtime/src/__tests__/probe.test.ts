import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../cli-spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli-spawn.js")>();
  return { ...actual, runAgyCommand: vi.fn() };
});

import { runAgyCommand } from "../cli-spawn.js";
import { probeAntigravityBinary } from "../probe.js";

describe("probeAntigravityBinary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports available + authenticated when `agy --version` succeeds (CLI owns auth)", async () => {
    vi.mocked(runAgyCommand).mockResolvedValueOnce({ code: 0, stdout: "agy 1.2.3", stderr: "" });

    const result = await probeAntigravityBinary({ binaryPath: "/usr/local/bin/agy" });

    expect(runAgyCommand).toHaveBeenCalledWith("/usr/local/bin/agy", ["--version"], 3000);
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.version).toBe("agy 1.2.3");
    expect(result.reason).toBeUndefined();
  });

  it("never invents a status/whoami subcommand — only --version is probed", async () => {
    vi.mocked(runAgyCommand).mockResolvedValueOnce({ code: 0, stdout: "agy 1.0.0", stderr: "" });

    await probeAntigravityBinary({ binaryPath: "agy" });

    expect(runAgyCommand).toHaveBeenCalledTimes(1);
    expect(runAgyCommand).toHaveBeenCalledWith("agy", ["--version"], 3000);
  });

  it("reports unavailable with authenticated:false and diagnostics when the candidate fails", async () => {
    vi.mocked(runAgyCommand).mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: agy" });

    const result = await probeAntigravityBinary();

    expect(result.available).toBe(false);
    expect(result.authenticated).toBe(false);
    expect(result.reason).toContain("not found");
    expect(result.reason).toContain("agy: spawn error: ENOENT");
  });

  it("tries a configured binary path before falling back to PATH", async () => {
    vi.mocked(runAgyCommand)
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: /missing/agy" })
      .mockResolvedValueOnce({ code: 0, stdout: "agy 1.0.0\n", stderr: "" });

    const result = await probeAntigravityBinary({ binaryPath: "/missing/agy" });

    expect(runAgyCommand).toHaveBeenNthCalledWith(1, "/missing/agy", ["--version"], 3000);
    expect(runAgyCommand).toHaveBeenNthCalledWith(2, "agy", ["--version"], 3000);
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.binaryPath).toBe("agy");
    expect(result.usingConfiguredBinaryPath).toBe(false);
    expect(result.diagnostics?.[0]).toContain("/missing/agy: spawn error: ENOENT");
  });

  it("dedupes an override equal to the default PATH candidate name", async () => {
    vi.mocked(runAgyCommand).mockResolvedValueOnce({ code: 0, stdout: "agy 1.0.0\n", stderr: "" });

    const result = await probeAntigravityBinary({ binaryPath: " agy " });

    expect(runAgyCommand).toHaveBeenCalledTimes(1);
    expect(runAgyCommand).toHaveBeenCalledWith("agy", ["--version"], 3000);
    expect(result.binaryPath).toBe("agy");
  });

  it("times out gracefully (code 124) as unavailable", async () => {
    vi.mocked(runAgyCommand).mockResolvedValueOnce({ code: 124, stdout: "", stderr: "" });

    const result = await probeAntigravityBinary();

    expect(result.available).toBe(false);
    expect(result.authenticated).toBe(false);
    expect(result.reason).toContain("agy not found on PATH");
  });
});

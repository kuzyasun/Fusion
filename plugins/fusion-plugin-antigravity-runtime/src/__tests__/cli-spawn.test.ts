import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

import { spawn, spawnSync } from "node:child_process";
import {
  AGY_ARGV_PROMPT_SOFT_LIMIT,
  buildAgyPrintArgs,
  buildAgyPromptFilePointer,
  findCompleteJsonObjectEnd,
  invokeAgyPrint,
  killProcessTree,
  parseAgyPrintOutput,
  prepareAgyPrintPrompt,
  DEFAULT_AGY_CLI_TIMEOUT_MS,
  formatAgyDurationMs,
  normalizeAgyPrintTimeout,
  parseAgyStreamJsonLine,
  AgyStreamJsonReader,
  resolveCliSettings,
  runAgyCommand,
  stripAnsi,
  stripAntigravityModelPrefix,
  type AntigravityCliSettings,
} from "../cli-spawn.js";


function mockPlatform(platform: NodeJS.Platform) {
  return vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  vi.mocked(spawn).mockReturnValue(child as never);
  return child;
}

const BASE_SETTINGS: AntigravityCliSettings = {
  binaryPath: "agy",
  cliTimeoutMs: 1_800_000,
  printTimeout: "30m",
  permissionMode: "skip",
};

describe("buildAgyPrintArgs", () => {
  it("builds the minimal print-mode invocation with the prompt last", () => {
    const args = buildAgyPrintArgs("write a haiku", BASE_SETTINGS);
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "30m",
      "-p",
      "write a haiku",
    ]);
  });

  it("adds --model when a model is configured", () => {
    const args = buildAgyPrintArgs("hi", { ...BASE_SETTINGS, model: "gemini-antigravity" });
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "--model",
      "gemini-antigravity",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "30m",
      "-p",
      "hi",
    ]);
  });

  it("adds --print-timeout when printTimeout is set", () => {
    const args = buildAgyPrintArgs("hi", { ...BASE_SETTINGS, printTimeout: "45000ms" });
    expect(args).toContain("--print-timeout");
    expect(args[args.indexOf("--print-timeout") + 1]).toBe("45000ms");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args.at(-2)).toBe("-p");
    expect(args.at(-1)).toBe("hi");
  });

  it("uses --sandbox instead of skip-permissions when permissionMode is sandbox", () => {
    const args = buildAgyPrintArgs("hi", { ...BASE_SETTINGS, permissionMode: "sandbox" });
    expect(args).toEqual([
      "--sandbox",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "30m",
      "-p",
      "hi",
    ]);
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("omits permission flags when permissionMode is prompt", () => {
    const args = buildAgyPrintArgs("hi", { ...BASE_SETTINGS, permissionMode: "prompt" });
    expect(args).toEqual([
      "--output-format",
      "stream-json",
      "--print-timeout",
      "30m",
      "-p",
      "hi",
    ]);
  });

  it("adds --continue on follow-up turns only", () => {
    const first = buildAgyPrintArgs("hi", BASE_SETTINGS, { continue: false });
    expect(first).not.toContain("--continue");
    const next = buildAgyPrintArgs("more", BASE_SETTINGS, { continue: true });
    expect(next).toContain("--continue");
    expect(next.indexOf("--continue")).toBeLessThan(next.indexOf("-p"));
  });
});

describe("prepareAgyPrintPrompt", () => {
  it("keeps short prompts inline", () => {
    const prepared = prepareAgyPrintPrompt("short");
    expect(prepared.usedPromptFile).toBe(false);
    expect(prepared.argvPrompt).toBe("short");
    prepared.cleanup();
  });

  it("writes oversized prompts to a temp file and returns a short pointer", () => {
    const huge = "x".repeat(AGY_ARGV_PROMPT_SOFT_LIMIT + 50);
    const prepared = prepareAgyPrintPrompt(huge);
    try {
      expect(prepared.usedPromptFile).toBe(true);
      expect(prepared.promptFilePath).toBeTruthy();
      expect(existsSync(prepared.promptFilePath!)).toBe(true);
      expect(readFileSync(prepared.promptFilePath!, "utf8")).toBe(huge);
      expect(prepared.argvPrompt).toBe(buildAgyPromptFilePointer(prepared.promptFilePath!));
      expect(prepared.argvPrompt.length).toBeLessThan(AGY_ARGV_PROMPT_SOFT_LIMIT);
      expect(prepared.argvPrompt).toContain(prepared.promptFilePath!);
    } finally {
      prepared.cleanup();
      expect(existsSync(prepared.promptFilePath!)).toBe(false);
    }
  });

  it("spawns with the pointer argv for oversized prompts (avoids ENAMETOOLONG)", async () => {
    mockPlatform("win32");
    const child = createMockChild();
    const huge = "y".repeat(AGY_ARGV_PROMPT_SOFT_LIMIT + 100);

    const resultPromise = invokeAgyPrint(huge, BASE_SETTINGS, {
      cwd: "/repo",
      spawnFallback: spawn,
      loadPtyModule: async () => {
        throw new Error("Cannot find module 'node-pty'");
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const spawnedArgs = vi.mocked(spawn).mock.calls[0]![1] as string[];
    const argvPrompt = spawnedArgs.at(-1)!;
    expect(argvPrompt.length).toBeLessThan(AGY_ARGV_PROMPT_SOFT_LIMIT);
    expect(argvPrompt).toContain("absolute path");
    expect(argvPrompt).not.toContain(huge);

    child.stdout.write("ok");
    child.emit("close", 0);
    await expect(resultPromise).resolves.toMatchObject({ body: "ok", exitCode: 0, usedFallback: true });
  });
});

describe("stripAntigravityModelPrefix", () => {
  it("strips provider prefixes and trailing tab-separated human labels", () => {
    expect(stripAntigravityModelPrefix("antigravity-cli/gemini-3.8-flash-medium")).toBe(
      "gemini-3.8-flash-medium",
    );
    expect(
      stripAntigravityModelPrefix("antigravity/gemini-3.8-flash-high\tGemini 3.8 Flash (High)"),
    ).toBe("gemini-3.8-flash-high");
    expect(stripAntigravityModelPrefix("gemini-3.8-flash-low\tGemini 3.8 Flash (Low)")).toBe(
      "gemini-3.8-flash-low",
    );
    expect(stripAntigravityModelPrefix(undefined)).toBeUndefined();
    expect(stripAntigravityModelPrefix("")).toBeUndefined();
  });
});

describe("stripAnsi / parseAgyPrintOutput", () => {
  it("removes ANSI escape codes and normalizes newlines", () => {
    const raw = "\u001b[32mHello\u001b[0m\r\nworld\r\n";
    expect(stripAnsi(raw)).toBe("Hello\nworld\n");
  });

  it("trims surrounding whitespace from the print body", () => {
    expect(parseAgyPrintOutput("\u001b[1m  answer  \u001b[0m\n\n")).toBe("answer");
  });

  it("drops a trailing incomplete CSI from the final body", () => {
    expect(parseAgyPrintOutput("Answer text\u001b[3")).toBe("Answer text");
    expect(parseAgyPrintOutput("Hi\u001b[32 ")).toBe("Hi");
  });
});

describe("formatWin32ShellSpawnFile", () => {
  it("quotes absolute Windows paths that contain spaces", async () => {
    const { formatWin32ShellSpawnFile } = await import("../cli-spawn.js");
    const restore = mockPlatform("win32");
    try {
      expect(formatWin32ShellSpawnFile("C:\\Users\\A User\\agy\\agy.exe")).toBe(
        '"C:\\Users\\A User\\agy\\agy.exe"',
      );
      expect(formatWin32ShellSpawnFile("C:\\agy\\agy.exe")).toBe("C:\\agy\\agy.exe");
    } finally {
      restore.mockRestore();
    }
  });
});

describe("resolveWin32SpawnInvocation", () => {
  it("uses shell:false for .exe so spaced --model/-p args stay intact", async () => {
    const { resolveWin32SpawnInvocation } = await import("../cli-spawn.js");
    const restore = mockPlatform("win32");
    try {
      const invocation = resolveWin32SpawnInvocation("C:\\Users\\A User\\agy\\agy.exe", [
        "--model",
        "Gemini 3.5 Flash (Medium)",
        "-p",
        "hello world",
      ]);
      expect(invocation.shell).toBe(false);
      expect(invocation.file).toBe("C:\\Users\\A User\\agy\\agy.exe");
      expect(invocation.args).toEqual([
        "--model",
        "Gemini 3.5 Flash (Medium)",
        "-p",
        "hello world",
      ]);
    } finally {
      restore.mockRestore();
    }
  });

  it("quotes spaced args when a .cmd shim still requires shell:true", async () => {
    const { resolveWin32SpawnInvocation, quoteWin32CmdArg } = await import("../cli-spawn.js");
    const restore = mockPlatform("win32");
    try {
      const invocation = resolveWin32SpawnInvocation("C:\\Users\\A User\\agy\\agy.cmd", [
        "--model",
        "Gemini 3.5 Flash (Medium)",
        "-p",
        "hello world",
      ]);
      expect(invocation.shell).toBe(true);
      expect(invocation.file).toBe('"C:\\Users\\A User\\agy\\agy.cmd"');
      expect(invocation.args).toEqual([
        "--model",
        quoteWin32CmdArg("Gemini 3.5 Flash (Medium)"),
        "-p",
        quoteWin32CmdArg("hello world"),
      ]);
    } finally {
      restore.mockRestore();
    }
  });
});

describe("resolveCliSettings", () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.AGY_BIN;
    delete process.env.AGY_MODEL_ID;
    delete process.env.AGY_PRINT_TIMEOUT_MS;
    delete process.env.AGY_CLI_TIMEOUT_MS;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults binary to agy, permissionMode skip, cliTimeoutMs to 30 minutes, and a matching printTimeout", () => {
    const settings = resolveCliSettings();
    expect(settings.binaryPath).toBe("agy");
    expect(settings.cliTimeoutMs).toBe(1_800_000);
    expect(settings.permissionMode).toBe("skip");
    expect(settings.model).toBeUndefined();
    expect(settings.printTimeout).toBe("30m");
  });

  it("prefers explicit settings over env vars and strips provider prefixes", () => {
    process.env.AGY_BIN = "/env/agy";
    process.env.AGY_MODEL_ID = "env-model";
    const settings = resolveCliSettings({
      binaryPath: "/cfg/agy",
      model: "antigravity-cli/cfg-model",
      printTimeoutMs: 1000,
      permissionMode: "sandbox",
    });
    expect(settings.binaryPath).toBe("/cfg/agy");
    expect(settings.model).toBe("cfg-model");
    expect(settings.printTimeout).toBe("1s");
    expect(settings.permissionMode).toBe("sandbox");
  });

  it("falls back to env vars when settings are absent", () => {
    process.env.AGY_BIN = "/env/agy";
    process.env.AGY_MODEL_ID = "env-model";
    process.env.AGY_CLI_TIMEOUT_MS = "12345";
    const settings = resolveCliSettings();
    expect(settings.binaryPath).toBe("/env/agy");
    expect(settings.model).toBe("env-model");
    expect(settings.cliTimeoutMs).toBe(12345);
  });

  it("accepts global Settings aliases for binary path and permission mode", () => {
    const settings = resolveCliSettings({
      antigravityCliBinaryPath: "/global/agy",
      antigravityCliPermissionMode: "sandbox",
    });
    expect(settings.binaryPath).toBe("/global/agy");
    expect(settings.permissionMode).toBe("sandbox");
  });
});

describe("runAgyCommand", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses the Windows shell so .cmd/.bat agy shims can run", async () => {
    mockPlatform("win32");
    const child = createMockChild();

    const resultPromise = runAgyCommand("agy", ["--version"], 1000);

    expect(spawn).toHaveBeenCalledWith("agy", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });

    child.stdout.write("agy 1.0.0\n");
    child.emit("close", 0);

    await expect(resultPromise).resolves.toEqual({ code: 0, stdout: "agy 1.0.0\n", stderr: "" });
  });

  it("keeps non-Windows invocations on direct spawn", async () => {
    mockPlatform("darwin");
    const child = createMockChild();

    const resultPromise = runAgyCommand("agy", ["models"], 1000);
    expect(spawn).toHaveBeenCalledWith("agy", ["models"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    child.emit("close", 0);
    await expect(resultPromise).resolves.toMatchObject({ code: 0 });
  });

  it("returns spawn errors with diagnostics (code 127)", async () => {
    mockPlatform("linux");
    const child = createMockChild();

    const resultPromise = runAgyCommand("agy", ["--version"], 1000);
    child.emit("error", Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" }));

    const result = await resultPromise;
    expect(result.code).toBe(127);
    expect(result.stderr).toContain("spawn error: ENOENT: spawn agy ENOENT");
  });
});

describe("invokeAgyPrint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatform("linux");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs agy inside a PTY and returns the cleaned body", async () => {
    let dataCb: ((d: string) => void) | undefined;
    let exitCb: ((e: { exitCode: number }) => void) | undefined;
    const ptySpawn = vi.fn(() => ({
      onData: (cb: (d: string) => void) => {
        dataCb = cb;
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        exitCb = cb;
      },
      kill: vi.fn(),
    }));

    const promise = invokeAgyPrint("hello", BASE_SETTINGS, {
      cwd: "/work",
      loadPtyModule: async () => ({ spawn: ptySpawn }) as never,
    });

    // allow the async loader to resolve and wire callbacks
    await vi.waitFor(() => expect(dataCb).toBeTypeOf("function"));
    dataCb?.("\u001b[32mAnswer\u001b[0m\n");
    exitCb?.({ exitCode: 0 });

    const result = await promise;
    expect(result.body).toBe("Answer");
    expect(result.usedFallback).toBe(false);
    expect(ptySpawn).toHaveBeenCalledWith(
      "agy",
      ["--dangerously-skip-permissions", "--output-format", "stream-json", "--print-timeout", "30m", "-p", "hello"],
      expect.objectContaining({ cwd: "/work" }),
    );
  });

  it("streams cleaned deltas across PTY chunks even when an ANSI sequence is split", async () => {
    let dataCb: ((d: string) => void) | undefined;
    let exitCb: ((e: { exitCode: number }) => void) | undefined;
    const ptySpawn = vi.fn(() => ({
      onData: (cb: (d: string) => void) => {
        dataCb = cb;
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        exitCb = cb;
      },
      kill: vi.fn(),
    }));
    const chunks: string[] = [];

    const promise = invokeAgyPrint("hello", BASE_SETTINGS, {
      loadPtyModule: async () => ({ spawn: ptySpawn }) as never,
      onChunk: (text) => chunks.push(text),
    });

    await vi.waitFor(() => expect(dataCb).toBeTypeOf("function"));
    // Split CSI so a per-chunk stripAnsi would leave ESC crumbs in streamed text.
    dataCb?.("\u001b[3");
    dataCb?.("2mPONG\u001b[0m");
    exitCb?.({ exitCode: 0 });

    const result = await promise;
    expect(result.body).toBe("PONG");
    expect(chunks.join("")).toBe("PONG");
    expect(chunks.join("")).not.toMatch(/\u001b/);
  });

  it("holds back CSI intermediate-byte splits (space before final byte)", async () => {
    let dataCb: ((d: string) => void) | undefined;
    let exitCb: ((e: { exitCode: number }) => void) | undefined;
    const ptySpawn = vi.fn(() => ({
      onData: (cb: (d: string) => void) => {
        dataCb = cb;
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        exitCb = cb;
      },
      kill: vi.fn(),
    }));
    const chunks: string[] = [];

    const promise = invokeAgyPrint("hello", BASE_SETTINGS, {
      loadPtyModule: async () => ({ spawn: ptySpawn }) as never,
      onChunk: (text) => chunks.push(text),
    });

    await vi.waitFor(() => expect(dataCb).toBeTypeOf("function"));
    dataCb?.("Hi\u001b[32 ");
    expect(chunks.join("")).toBe("Hi");
    dataCb?.("mOK");
    exitCb?.({ exitCode: 0 });

    const result = await promise;
    expect(result.body).toBe("HiOK");
    expect(chunks.join("")).toBe("HiOK");
    expect(chunks.join("")).not.toMatch(/\u001b/);
  });

  it("falls back to plain spawn when node-pty import fails and marks usedFallback", async () => {
    const child = createMockChild();

    const promise = invokeAgyPrint("hello", BASE_SETTINGS, {
      cwd: "/work",
      loadPtyModule: async () => {
        throw new Error("Cannot find module 'node-pty'");
      },
      spawnFallback: spawn as never,
    });

    // spawn fallback runs after the async PTY loader rejects
    await vi.waitFor(() =>
      expect(spawn).toHaveBeenCalledWith(
        "agy",
        ["--dangerously-skip-permissions", "--output-format", "stream-json", "--print-timeout", "30m", "-p", "hello"],
        expect.objectContaining({ cwd: "/work" }),
      ),
    );

    child.stdout.write("fallback body\n");
    child.emit("close", 0);

    const result = await promise;
    expect(result.body).toBe("fallback body");
    expect(result.usedFallback).toBe(true);
  });

  it("surfaces the node-pty load failure in the error message when the fallback also fails", async () => {
    const child = createMockChild();

    const promise = invokeAgyPrint("hello", BASE_SETTINGS, {
      loadPtyModule: async () => {
        throw new Error("boom");
      },
      spawnFallback: spawn as never,
    });

    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.emit("error", Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" }));

    await expect(promise).rejects.toThrow(/node-pty unavailable \(boom\)/);
  });

  it("wraps .cmd and .bat shims with cmd.exe /c for PTY spawn on Windows", async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const spawnPty = vi.fn(() => ({
        onData: (cb: (d: string) => void) => {
          cb("windows cmd output");
        },
        onExit: (cb: (e: { exitCode: number }) => void) => {
          cb({ exitCode: 0 });
        },
        kill: vi.fn(),
      }));

      const result = await invokeAgyPrint("hello", { ...BASE_SETTINGS, binaryPath: "C:\\tools\\agy.cmd" }, {
        loadPtyModule: async () => ({ spawn: spawnPty as never }),
      });

      expect(result.body).toBe("windows cmd output");
      expect(spawnPty).toHaveBeenCalledWith(
        process.env.ComSpec || "cmd.exe",
        ["/d", "/c", "C:\\tools\\agy.cmd", "--dangerously-skip-permissions", "--output-format", "stream-json", "--print-timeout", "30m", "-p", "hello"],
        expect.any(Object),
      );
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform });
    }
  });

  it("settles on stream-json result without waiting for PTY exit (MCP hang guard)", async () => {
    let dataCb: ((d: string) => void) | undefined;
    const kill = vi.fn();
    const ptySpawn = vi.fn(() => ({
      onData: (cb: (d: string) => void) => {
        dataCb = cb;
      },
      onExit: (_cb: (e: { exitCode: number }) => void) => {
        // Intentionally never exits — simulates MCP child keeping the PTY open.
      },
      kill,
    }));
    const chunks: string[] = [];

    const promise = invokeAgyPrint("hello", BASE_SETTINGS, {
      loadPtyModule: async () => ({ spawn: ptySpawn }) as never,
      onChunk: (text) => chunks.push(text),
    });

    await vi.waitFor(() => expect(dataCb).toBeTypeOf("function"));
    dataCb?.(
      '{"event":"step_update","step_update":{"text_delta":"DONE"}}\n' +
        '{"event":"result","result":{"status":"SUCCESS","response":"DONE\\n"}}\n',
    );

    const result = await promise;
    expect(result.body).toBe("DONE");
    expect(chunks.join("")).toBe("DONE");
    expect(kill).toHaveBeenCalled();
  });

  it("settles when event:result JSON has no trailing newline but buffer is complete", async () => {
    let dataCb: ((d: string) => void) | undefined;
    const kill = vi.fn();
    const ptySpawn = vi.fn(() => ({
      onData: (cb: (d: string) => void) => {
        dataCb = cb;
      },
      onExit: (_cb: (e: { exitCode: number }) => void) => {
        // MCP keeps PTY open; settle must not wait for exit or newline.
      },
      kill,
    }));

    const promise = invokeAgyPrint("hello", BASE_SETTINGS, {
      loadPtyModule: async () => ({ spawn: ptySpawn }) as never,
    });

    await vi.waitFor(() => expect(dataCb).toBeTypeOf("function"));
    // No trailing \n — previously early settle never fired while MCP held the PTY.
    dataCb?.('{"event":"result","result":{"status":"SUCCESS","response":"NO_NL"}}');

    const result = await promise;
    expect(result.body).toBe("NO_NL");
    expect(kill).toHaveBeenCalled();
  });

  it("does not double-append holdback on spawn-fallback close", async () => {
    const child = createMockChild();
    const chunks: string[] = [];

    const promise = invokeAgyPrint("hello", BASE_SETTINGS, {
      loadPtyModule: async () => {
        throw new Error("Cannot find module 'node-pty'");
      },
      spawnFallback: spawn as never,
      onChunk: (text) => chunks.push(text),
    });

    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    // Incomplete CSI held across close; leftover must be processed once, not doubled.
    child.stdout.write("OK\u001b[3");
    child.emit("close", 0);

    const result = await promise;
    expect(result.body).toBe("OK");
    expect(chunks.join("")).toBe("OK");
    expect(chunks.join("")).not.toMatch(/\u001b/);
    // Body must not contain doubled holdback crumbs from re-append.
    expect(result.body).not.toContain("OKOK");
  });

});

describe("killProcessTree", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("on win32 runs taskkill /T /F before child.kill when pid is known", () => {
    mockPlatform("win32");
    const order: string[] = [];
    vi.mocked(spawnSync).mockImplementation((() => {
      order.push("taskkill");
      return { status: 0 } as never;
    }) as never);
    const child = {
      pid: 4242,
      kill: vi.fn(() => {
        order.push("kill");
        return true;
      }),
    };

    killProcessTree(child);

    expect(spawnSync).toHaveBeenCalledWith(
      "taskkill",
      ["/pid", "4242", "/T", "/F"],
      expect.objectContaining({ stdio: "ignore" }),
    );
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(order).toEqual(["taskkill", "kill"]);
  });

  it("on win32 still kills the child when pid is missing (no taskkill)", () => {
    mockPlatform("win32");
    const child = { kill: vi.fn() };
    killProcessTree(child);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("on unix tries process-group kill before child.kill when pid is known", () => {
    mockPlatform("linux");
    const order: string[] = [];
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => {
      order.push("pgid");
      return true;
    }) as never);
    const child = {
      pid: 77,
      kill: vi.fn(() => {
        order.push("kill");
        return true;
      }),
    };

    killProcessTree(child);

    expect(killSpy).toHaveBeenCalledWith(-77, "SIGKILL");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(order).toEqual(["pgid", "kill"]);
  });
});


describe("formatAgyDurationMs / normalizeAgyPrintTimeout", () => {
  it("formats whole minutes and seconds with Go duration units", () => {
    expect(formatAgyDurationMs(1_800_000)).toBe("30m");
    expect(formatAgyDurationMs(1000)).toBe("1s");
    expect(formatAgyDurationMs(DEFAULT_AGY_CLI_TIMEOUT_MS)).toBe("30m");
  });

  it("appends ms to bare numeric print-timeout values", () => {
    expect(normalizeAgyPrintTimeout("45000")).toBe("45000ms");
    expect(normalizeAgyPrintTimeout("30m")).toBe("30m");
  });
});

describe("AgyStreamJsonReader", () => {
  it("parses text_delta and result events across chunk boundaries", () => {
    const reader = new AgyStreamJsonReader();
    const deltas1 = reader.push('{"event":"step_update","step_update":{"text_delta":"Hel');
    expect(deltas1).toEqual([]);
    const deltas2 = reader.push(
      'lo"}}\n{"event":"result","result":{"status":"SUCCESS","response":"Hello\\n"}}\n',
    );
    expect(deltas2.join("")).toBe("Hello");
    expect(reader.result?.status).toBe("SUCCESS");
    expect(reader.bodyFromResultOrText()).toBe("Hello");
  });

  it("parseAgyStreamJsonLine accepts a json envelope without event wrapper", () => {
    const update = parseAgyStreamJsonLine('{"status":"SUCCESS","response":"OK"}');
    expect(update?.result?.response).toBe("OK");
  });

  it("settles event:result from a complete held buffer without a trailing newline", () => {
    const reader = new AgyStreamJsonReader();
    const deltas = reader.push(
      '{"event":"result","result":{"status":"SUCCESS","response":"held"}}',
    );
    expect(deltas).toEqual([]);
    expect(reader.result?.status).toBe("SUCCESS");
    expect(reader.bodyFromResultOrText()).toBe("held");
  });

  it("does not treat an incomplete JSON object as a result", () => {
    const reader = new AgyStreamJsonReader();
    reader.push('{"event":"result","result":{"status":"SUCCESS","response":"partial"');
    expect(reader.result).toBeUndefined();
    expect(findCompleteJsonObjectEnd('{"event":"result"')).toBe(-1);
  });
});

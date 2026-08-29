import { describe, expect, it } from "vitest";
import type { GlobalSettings } from "../types.js";
import {
  DEFAULT_GLOBAL_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  isGlobalSettingsKey,
} from "../config/settings-schema.js";

describe("Antigravity CLI global settings", () => {
  it("includes the enable toggle, binary path, and permission mode in GLOBAL_SETTINGS_KEYS", () => {
    expect(GLOBAL_SETTINGS_KEYS).toContain("useAntigravityCli");
    expect(GLOBAL_SETTINGS_KEYS).toContain("antigravityCliBinaryPath");
    expect(GLOBAL_SETTINGS_KEYS).toContain("antigravityCliPermissionMode");
  });

  it("defaults Antigravity CLI settings to undefined", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.useAntigravityCli).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.antigravityCliBinaryPath).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.antigravityCliPermissionMode).toBeUndefined();
  });

  it("recognizes Antigravity CLI settings keys as global", () => {
    expect(isGlobalSettingsKey("antigravityCliBinaryPath")).toBe(true);
    expect(isGlobalSettingsKey("useAntigravityCli")).toBe(true);
    expect(isGlobalSettingsKey("antigravityCliPermissionMode")).toBe(true);
  });

  it("accepts a string binary override and permission mode distinct from the enable toggle", () => {
    const configured: GlobalSettings = {
      useAntigravityCli: false,
      antigravityCliBinaryPath: "C:\\Users\\A User\\AppData\\Local\\agy\\agy.exe",
      antigravityCliPermissionMode: "sandbox",
    };

    expect(configured.useAntigravityCli).toBe(false);
    expect(configured.antigravityCliBinaryPath).toBe("C:\\Users\\A User\\AppData\\Local\\agy\\agy.exe");
    expect(configured.antigravityCliPermissionMode).toBe("sandbox");
  });
});

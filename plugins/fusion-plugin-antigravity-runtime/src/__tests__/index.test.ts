import { describe, expect, it } from "vitest";
import plugin, {
  AntigravityRuntimeAdapter,
  probeAntigravityBinary,
  discoverAntigravityProviderModels,
} from "../index.js";

describe("antigravity plugin export", () => {
  it("declares the antigravity runtime + antigravity-cli provider contribution", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-antigravity-runtime");
    expect(plugin.runtime?.metadata.runtimeId).toBe("antigravity");
    expect(plugin.cliProviders?.[0]?.providerId).toBe("antigravity-cli");
    expect(plugin.cliProviders?.[0]?.binaryName).toBe("agy");
    expect(plugin.cliProviders?.[0]?.statusRoute).toBe("/providers/antigravity-cli/status");
    expect(plugin.cliProviders?.[0]?.authRoute).toBe("/auth/antigravity-cli");
    expect(plugin.cliProviders?.[0]?.runtime?.runtimeId).toBe("antigravity");
  });

  it("wires probe + discoverModels onto the provider contribution", () => {
    expect(typeof plugin.cliProviders?.[0]?.probe).toBe("function");
    expect(plugin.cliProviders?.[0]?.discoverModels).toBe(discoverAntigravityProviderModels);
  });

  it("re-exports the public API surface", () => {
    expect(typeof AntigravityRuntimeAdapter).toBe("function");
    expect(typeof probeAntigravityBinary).toBe("function");
    expect(typeof discoverAntigravityProviderModels).toBe("function");
  });

  it("constructs a runtime adapter with the antigravity id", () => {
    const adapter = new AntigravityRuntimeAdapter();
    expect(adapter.id).toBe("antigravity");
    expect(adapter.name).toBe("Antigravity Runtime");
  });
});

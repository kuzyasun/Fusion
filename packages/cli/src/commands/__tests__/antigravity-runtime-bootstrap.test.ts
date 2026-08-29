import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsDir = resolve(__dirname, "..");

function readCommand(command: "serve" | "daemon" | "dashboard"): string {
  return readFileSync(resolve(commandsDir, `${command}.ts`), "utf8");
}

/*
FNXC:AntigravityCli 2026-07-18-18:25:
Regression guard mirroring grok-runtime-bootstrap.test.ts (FN-7761). Packaged hosts must
ensure fusion-plugin-antigravity-runtime before loadAllPlugins() so antigravity-cli/* lanes
resolve getRuntimeById("antigravity") instead of throwing the missing-plugin remediation.
*/
describe("Antigravity CLI runtime packaged bootstrap", () => {
  for (const command of ["serve", "daemon", "dashboard"] as const) {
    it(`${command} eagerly ensures the bundled Antigravity runtime before loading enabled plugins`, () => {
      const source = readCommand(command);
      const importIndex = source.indexOf("ensureBundledAntigravityRuntimePluginInstalled");
      const ensureIndex = source.indexOf(
        "ensureBundledAntigravityRuntimePluginInstalled(pluginStore, pluginLoader)",
      );
      const loadIndex = source.indexOf("pluginLoader.loadAllPlugins()");

      expect(importIndex).toBeGreaterThanOrEqual(0);
      expect(ensureIndex).toBeGreaterThanOrEqual(0);
      expect(loadIndex).toBeGreaterThanOrEqual(0);
      expect(ensureIndex).toBeLessThan(loadIndex);
    });
  }
});

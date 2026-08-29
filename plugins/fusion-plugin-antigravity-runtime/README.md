# fusion-plugin-antigravity-runtime

Antigravity CLI (`agy`) backed provider/runtime for Fusion.

See the full contract: [`docs/antigravity-cli-contract.md`](../../docs/antigravity-cli-contract.md).

## External Integration Evidence

- Canonical upstream repo URL: https://github.com/google-antigravity/antigravity-cli
- Docs / homepage URL: https://antigravity.google/docs/gcli-migration
- Release / download URL: https://antigravity.google/cli/install.ps1 (Windows) / https://antigravity.google/cli/install.sh (macOS/Linux)
- Binary / CLI name: `agy`
- Checksum: `upstream-pending-verification`

## Contract summary

- Provider ID: `antigravity-cli`
- Runtime ID: `antigravity`
- Binary probe: `agy --version`
- Auth: CLI owns Antigravity subscription (no Fusion OAuth)
- Models: `agy models` (full labels with spaces/tiers)
- Prompt: PTY print-mode with optional `--model`, `--sandbox` / `--dangerously-skip-permissions`, AbortSignal cancel
- Permission mode: Settings → Authentication → Permission mode (`skip` default / `sandbox` / `prompt`)
- Limitation: no `fn_*` MCP / ACP tool stream — small non-interactive tasks
- Usage/quota: not exposed by `agy` 1.1.4 yet; check Antigravity account UI

## Enable

1. Install and authenticate `agy`.
2. Settings → Authentication → **Antigravity — via Antigravity CLI** → Enable (optional: binary path + permission mode).
3. Pick `antigravity-cli/*` models or Runtime = Antigravity Runtime.

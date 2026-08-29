# Antigravity CLI contract (Fusion)

FNXC:AntigravityCli 2026-07-18-18:10:
This document is the operator/developer contract for `fusion-plugin-antigravity-runtime`.
It deliberately routes through the local `agy` binary (subscription auth) and does **not**
restore the deprecated Pi OAuth providers (`antigravity` / `google-antigravity` /
`google-gemini-cli`) that were removed after account-ban reports.

## External Integration Evidence

- Canonical upstream repo URL: https://github.com/google-antigravity/antigravity-cli
- Docs / homepage URL: https://antigravity.google/docs/gcli-migration
- Release / download URL: https://antigravity.google/cli/install.ps1 (Windows) / https://antigravity.google/cli/install.sh (macOS/Linux)
- Binary / CLI name: `agy`
- Checksum: `upstream-pending-verification`

## IDs

| Surface | Value |
|---|---|
| Plugin id | `fusion-plugin-antigravity-runtime` |
| Provider id | `antigravity-cli` |
| Runtime id | `antigravity` |
| Settings toggle | `useAntigravityCli` |
| Binary override | `antigravityCliBinaryPath` |
| Permission mode | `antigravityCliPermissionMode` (`skip` \| `sandbox` \| `prompt`) |

## Auth / readiness

- Probe: `agy --version` (timeout ~3s).
- Readiness = **binary available**. The CLI owns Antigravity subscription credentials; Fusion never stores Google OAuth for this path.
- Enable requires the binary to be available (same pattern as Cursor/Grok CLI cards).

## Model discovery

- Command: `agy models`
- Observed shape (agy 1.1.4): one human label per line, including spaces and tier suffixes, e.g. `Gemini 3.5 Flash (Medium)`, `Claude Opus 4.6 (Thinking)`.
- Picker rows: `{ provider: "antigravity-cli", id: <full label>, name: <full label> }`.
- When invoking print-mode, Fusion strips only the `antigravity-cli/` / `antigravity/` prefix and passes the remainder to `--model`.

## Prompt transport

```text
agy [--dangerously-skip-permissions | --sandbox]
    [--continue]
    [--model <label>]
    [--print-timeout <duration>]
    -p <prompt>
```

- Default permission mode: `skip` (`--dangerously-skip-permissions`) for non-interactive Fusion tasks.
- Optional `sandbox` (`--sandbox`) or `prompt` (no auto-approve — may hang headless).
- Operators set this via Settings → Authentication → Permission mode (`antigravityCliPermissionMode`); plugin-local `permissionMode` wins when both are set.
- Must run under a **PTY** (`node-pty`). Upstream `agy -p` hangs or drops stdout without a TTY ([issue #76](https://github.com/google-antigravity/antigravity-cli/issues/76), [#318](https://github.com/google-antigravity/antigravity-cli/issues/318)).
- First session turn prepends Fusion system/runtime context; later turns pass `--continue`.
- AbortSignal / `dispose()` kill the live PTY/process.
- Partial PTY chunks may stream via `onText`; final cleaned body is always available at exit.
- **Large prompts (Windows ENAMETOOLONG):** `agy` has no `--prompt-file`. When the fused prompt exceeds ~2KiB, Fusion writes it to a temp file and passes a short pointer as `-p` (same pattern as Cursor CLI print-mode) so CreateProcess argv stays under the OS limit.

## Usage / quota

- `agy` 1.1.4 exposes no `usage` / `quota` subcommand. Subscription remaining quota is not surfaced in Fusion; operators check Antigravity account UI / CLI changelog when upstream adds it.

## Known limitations (print-mode)

- No ACP `session/update` tool-call stream (unlike Grok ACP).
- No Fusion `fn_*` MCP bridge — the Antigravity agent uses only its own tools.
- Best fit: small non-interactive tasks that can complete under the subscription without host coordination tools.

## Enable path

1. Install + authenticate `agy` (`agy` login / Antigravity subscription).
2. Settings → Authentication → **Antigravity — via Antigravity CLI** → Enable.
3. Select `antigravity-cli/<label>` in lane model pickers, or set agent Runtime to **Antigravity Runtime**.

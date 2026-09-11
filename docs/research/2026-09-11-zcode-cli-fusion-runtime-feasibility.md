# ZCode CLI → Fusion runtime-plugin feasibility

**Date:** 2026-09-11  
**Status:** Deferred research note — **revisit later; not implementing now.**

## Verdict

- **Antigravity-parity MVP is possible but fragile** (print/prompt one-shot bridge).
- **Cursor-parity is not realistic now** (no stable stream-json / MCP / resume session bus suitable for Fusion).
- Do **not** ship a bundled Fusion ZCode runtime plugin until an official headless contract exists, or a community spike proves a durable argv + auth + permissions surface.

## Two different “ZCode” products

| | **Z.AI ZCode + `zcode-app-cli`** | **`zcodex` / OpenCode-style agent** |
|---|---|---|
| What it is | ZCode Desktop + unofficial terminal client over an extracted desktop runtime | Separate OpenCode-derived agent CLI |
| Headless | `zcode --prompt` / `zcode --print` | NDJSON session protocol via `app-server --stdio` |
| `app-server` | One-shot request/response (plugin/marketplace methods) | Long-lived `session/create → subscribe → send → events` |
| Likely on an operator machine with ZCode Desktop | **This one** | Different product / binary lineage |

Fusion currently has **no** in-repo ZCode integration. Any plugin would be net-new work, modeled on Antigravity (print) or Cursor (stream)—not a settings toggle.

## Capability matrix vs Cursor / Antigravity

| Fusion runtime need | Cursor | Antigravity (`agy`) | ZCode (`zcode-app-cli`) |
|---|---|---|---|
| Binary probe (`--version`) | yes | yes | yes |
| CLI-owned auth | yes | yes | partial (API key / Coding Plan; OAuth mostly macOS) |
| Stable models catalog | yes | yes (`agy models`) | weakly documented (TUI `/model` / config more than a CLI catalog) |
| Headless one-shot prompt | `--print` + stream-json | PTY `-p` | `--prompt` / `--print` **exist** |
| Model flag for print | yes | yes | needs spike verification |
| Auto-approve / yolo headless | `--force` / `--trust` | `--dangerously-skip-permissions` | TUI `yolo`; dedicated headless flag unclear |
| Worktree / cwd | yes | yes | likely process cwd; verify |
| Cancel / AbortSignal | yes | yes | process kill OK |
| Continue / multi-turn | `--continue` | `agy --continue` | TUI resume; print multi-turn unclear |
| Streaming tool events | stream-json / MCP | mostly PTY text | print = text; rich stream **not** in npm `app-server` |
| Official contract + evidence | strong | strong | unofficial extracted runtime — licensing / breakage risk |
| Windows | OK | OK | Node 22.19+; API-key path OK |

## What `--print` / `--prompt` enables

Documented noninteractive usage:

```bash
zcode --prompt "Explain this repository"
zcode --print "Inspect https://example.com"
```

Enough for an **Antigravity-style** MVP:

1. Probe the binary.
2. Treat auth as CLI-owned (`~/.zcode/cli/config.json`).
3. Spawn print/prompt in the task worktree.
4. Capture stdout as the agent reply.
5. Expose an Authentication card (Enable + optional binary path).

**Not** Cursor-level: no verified `stream-json` tool stream and no Fusion `fn_*` MCP bridge out of the box.

## Why `app-server` in `zcode-app-cli` is not agent-session transport

In `zcode-app-cli`, the client pattern is:

1. Spawn `zcode app-server`.
2. Write **one** NDJSON `{ id, method, params }` request.
3. Read **one** response envelope.
4. Exit.

That surface is oriented at marketplace/plugin methods (`plugins list` / discover / install), **not** multi-turn agent sessions.

The rich NDJSON protocol (`session/create` → `session/subscribe` → `session/send` → `session/event` with `model.streaming` / `tool.updated` / `turn.completed`) appears in **other** integrations (`zcodex` / pi `zcode-provider` / Multica proposals). Targeting that is a separate spike on **that** binary, not on the npm `zcode-app-cli` one-shot helper.

## Recommendations

1. **No bundled Fusion plugin yet** — missing official contract, fragile desktop-runtime extract, unclear model/permission/continue semantics.
2. **If Z.AI models are needed in lanes sooner:** prefer an ordinary **Z.AI / GLM API provider** path (API key), not a CLI runtime plugin.
3. **Before any community `fusion-plugin-zcode-runtime`:** run a short spike checklist:

```text
zcode --version
zcode doctor --json          # if present
zcode --print "reply OK"     # plus model / mode / yolo flags
# How are models listed?
# Does headless hang on permissions?
# Can two prints continue a session?
# Windows large-prompt / ENAMETOOLONG behavior?
```

4. Only after a green spike: optional **community** plugin templated on Antigravity (probe + print transport + auth card). Do **not** aim for Cursor MCP/stream parity first.

## Links / evidence

- npm `zcode-app-cli`: https://www.npmjs.com/package/zcode-app-cli
- GitHub unofficial CLI: https://github.com/kingsword09/zcode-cli
- Z.AI ZCode agents docs: https://zcode.z.ai/en/docs/agents
- pi `zcode-provider` (documents `zcodex app-server` NDJSON session subset): https://pi.dev/packages/zcode-provider · https://www.npmjs.com/package/zcode-provider
- Multica proposal / notes on ZCode `app-server` NDJSON (not ACP): https://github.com/multica-ai/multica/issues/5361

## Explicit deferral

**Revisit later. Not implementing now.** This note exists so a future task can reopen the spike without re-deriving the Cursor vs Antigravity vs `zcode-app-cli` vs `zcodex` distinctions.

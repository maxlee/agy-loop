<div align="center">

<img src="assets/logo.svg" alt="AGY Loop Logo" width="88" height="88" />

# AGY Loop (`agy-loop`)

**Non-blocking `/agy-loop:loop` scheduler for Google Antigravity Desktop & CLI (`agy`), powered by native `schedule` timers, isolated subagents, and live-reloading `loop.md`**

[![CI](https://github.com/maxlee/agy-loop/actions/workflows/ci.yml/badge.svg)](https://github.com/maxlee/agy-loop/actions/workflows/ci.yml)
[![Release](https://github.com/maxlee/agy-loop/actions/workflows/release.yml/badge.svg)](https://github.com/maxlee/agy-loop/releases/latest)
[![Antigravity Plugin v1](https://img.shields.io/badge/Antigravity-Plugin_v1-38BDF8.svg)](plugin.json)
[![Node >=18](https://img.shields.io/badge/Node-%3E%3D18-22C55E.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[**English**](README.md) · [**简体中文**](README.zh-CN.md) · [**Why AGY Loop?**](#-why-agy-loop) · [**Quick Install**](#-installation) · [**Slash Commands**](#-slash-commands-modes--flags) · [**Headless CLI**](#-headless-cli-runner) · [**`loop.md` Guide**](#-agentsloopmd-hot-reload-guide) · [**Exit & Stop**](#-how-to-exit-or-stop-a-loop) · [**Architecture**](ARCHITECTURE.md)

</div>

---

**AGY Loop** brings a non-blocking, context-isolated loop scheduler (`/agy-loop:loop`) to **Antigravity Desktop** (Marketplace-ready) and **Antigravity CLI (`agy`)**, plus a production **Headless CLI Runner** (`agy-loop run | ps | logs | stop | statusline`) for terminals, SSH, and CI/CD pipelines. Instead of locking your prompt with shell `sleep` or dumping repetitive build, test, and CI logs into your main conversation, `agy-loop` delegates each check or fix pass to an isolated `loop-worker` (or `self`) background subagent and parks between iterations on Antigravity's native `schedule` tool at **zero token cost** — or drives headless `agy` JSON / persistent `stream-json` turns directly from the command line.

> Inspired by Claude Code's [`/loop` workflow](https://claude.com/resources/articles/getting-started-with-loops) and engineered around Antigravity's reactive subagent wakeup, sub-minute `DurationSeconds` timers, stateful `Idle` re-awakening, and Git worktree isolation.

---

## 📸 Live Session Preview

```text
> /agy-loop:loop check current PR CI status and fix failures --stateful

⏺ Dispatched Loop [lp_20261121T101500Z_a3f9] #1/20 to loop-worker (dynamic, stateful, workspace=inherit). Main prompt is free.

  [42s later · reactive subagent wake-up]
⏺ [Loop lp_20261121T101500Z_a3f9 #1/20] Fixed snapshot mismatch in src/render.test.ts and pushed 9c41e2b; CI re-running | Next wake-up in 45s (self-paced)

> Meanwhile, explain how token caching works in src/auth.ts
⏺ Token caching in src/auth.ts stores verified JWT claims in an LRU map keyed by SHA-256...
  (Background timer sleeps at 0 tokens/sec; your main chat stays clean and responsive.)

  [45s later · timer wake-up -> Iteration #2]
⏺ [Loop lp_20261121T101500Z_a3f9 #2/20] Unit & lint checks passed; awaiting e2e matrix (4/5 green) | Next wake-up in 90s (self-paced)

  [90s later · timer wake-up -> Iteration #3]
⏺ [Loop lp_20261121T101500Z_a3f9 #3/20] DONE: All 5 CI checks green on PR #42; active schedule cleared.
```

---

## ⚡ Why AGY Loop?

| Capability | Shell `sleep` Loop | Claude Code `/loop` | AGY Loop (`agy-loop`) |
|:---|:---|:---|:---|
| **Wait Mechanism** | Blocking shell `sleep` | Built-in session cron queue | Native non-blocking `schedule` timers & crons |
| **Main Chat Availability** | Locked while waiting | Free between ticks | Free between ticks **and** while subagent runs |
| **Context Isolation** | Pollutes main chat with raw logs | Shares main conversation window | Clean `loop-worker` / `self` subagent window; 1-line main summaries |
| **Minimum Granularity** | `1s` (blocks turn) | `1m` cron floor (`30s` rounds up to `1m`) | Sub-minute `DurationSeconds` (`15s`, `30s`) & compound durations (`1h30m`, `2m30s`) |
| **Dynamic Backoff & Safety** | Fixed delay only | Model-selected `1m–1h` delay | Clamped `NEXT_DELAY_SEC` (`[10s, 86400s]`), 3-error circuit breaker & `loop_id` state |
| **Live-Reloading `loop.md`** | None | `.claude/loop.md` & `~/.claude/loop.md` | Re-read every tick: `.agents/loop.md` -> `loop.md` -> `~/.gemini/config/loop.md` -> built-in fallback |
| **Stateful Debugging** | Full transcript bloat | Shared main history | Opt-in `--stateful` `Idle` subagent re-awakening via `send_message` |
| **Risk-Free Edits** | Mutates active working tree | Mutates active working tree | Opt-in `--worktree` (`branch` worktree + pre-teardown diff/merge safety) or `--share` |

---

## 📦 Installation

### Requirements

- **Antigravity CLI (`agy`)** `v1.5.0+` (verified against `v1.5.14` strict validator, `oneharness` tool registry, and headless `json` / `stream-json` transports) or **Antigravity Desktop**
- **Zero Node.js / npm required** for native `agy plugin install` or the one-line `curl` installer to run interactive **`/agy-loop:loop`**; **`Node.js >= 18`** powers the zero-dependency `npx agy-loop` CLI bridge and the headless **`agy-loop run | ps | logs | stop | statusline`** runner (`Bun` can also run the CLI bridge)

`agy-loop` is packaged as a **pure, Marketplace-compatible dual-habitat plugin**: the repository root is simultaneously a strict v1 Antigravity native plugin (`plugin.json`, `hooks.json`, `skills/loop/SKILL.md`, `agents/loop-worker.md`) and a zero-dependency npm CLI (`bin/agy-loop.mjs` + `lib/*.mjs`). Once installed:

- In Antigravity's native plugin model, bundled skills register cleanly under the plugin namespace as **`/agy-loop:loop`** in both **Antigravity Desktop** and **Antigravity CLI (`agy`)**, keeping the plugin 100% self-contained without writing extra files outside `~/.gemini/config/plugins/`.
- In Antigravity Desktop (**Customizations -> Plugins** / **Marketplace**), the plugin card also exposes 3 one-click starter prompt chips (`suggestedPrompts`) to launch common loops or inspect `/agy-loop:loop status`.
- If `agy` CLI is already open during installation, run **`/skills reload`** once so `/agy-loop:loop` appears in slash autocomplete immediately.

### Method 1: Install via `npx` / `bunx` (npm Bridge)

```bash
npx agy-loop
# or with Bun:
bunx agy-loop
```

Migrating from a manual `~/.gemini/config/skills/loop` or `~/.gemini/config/agents/loop-worker.md` setup? Because Antigravity loads user-level `~/.gemini/config/` files before plugins, pass `--clean-shadow` to install `agy-loop` and archive those loose files into `~/.gemini/config/.agy-loop-backup-<YYYYMMDD-HHMMSSZ>/` automatically:

```bash
npx agy-loop install --clean-shadow
```

### Method 2: Native `agy` CLI from GitHub

```bash
agy plugin install https://github.com/maxlee/agy-loop
```

> **Migrating from loose `~/.gemini/config/` files?** `agy plugin install` stages the plugin without removing pre-existing `~/.gemini/config/skills/loop/SKILL.md` or `~/.gemini/config/agents/loop-worker.md` (which otherwise override `loop-worker` even under `/agy-loop:loop` and intercept `/loop`). `agy-loop` includes a zero-overhead `SessionStart` hook (`hooks.json`) that stays silent (`0` tokens) when clean and automatically alerts you on session start if loose shadow files exist. Archive them non-destructively in one command (zero Node/npm required):
>
> ```bash
> sh ~/.gemini/config/plugins/agy-loop/install.sh --clean-shadow
> ```
>
> Then run `/skills reload` in open sessions, clean directly inside `agy` via `/agy-loop:loop doctor --clean-shadow`, or run `npx agy-loop doctor --clean-shadow`.

### Method 3: One-Line POSIX Installer (macOS & Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/maxlee/agy-loop/main/install.sh | sh
```

With automatic shadow-file backup:

```bash
curl -fsSL https://raw.githubusercontent.com/maxlee/agy-loop/main/install.sh | sh -s -- --clean-shadow
```

### Method 4: Local Clone & Install

```bash
git clone https://github.com/maxlee/agy-loop.git
cd agy-loop
agy plugin install .
```

---

## 🧭 Slash Commands, Modes & Flags

### 5 Invocation Modes

| Mode | Example Commands | Behavior |
|:---|:---|:---|
| **1. Fixed Interval + Prompt** | `/agy-loop:loop 30s curl -fsS http://localhost:8080/health`<br>`/agy-loop:loop every 5m check the deploy`<br>`/agy-loop:loop 1h30m check backup`<br>`/agy-loop:loop check PR #42 comments every 2h` | Runs on a fixed cadence (`s`, `m`, `h`, `d`), supporting leading `every <dur>`, trailing `every`, and compound durations (`1h30m`, `2m30s`; fractional `1.5m` rejected with Exit `2`). Chains non-overlapping `DurationSeconds` timers by default, or uses 5-field `CronExpression` with `--cron`. |
| **2. Dynamic Self-Paced** | `/agy-loop:loop check CI and fix failures`<br>`/agy-loop:loop run pytest and fix failing tests --stateful` | Omits the interval. After each pass, `loop-worker` sets `NEXT_DELAY_SEC` (`120s` default fallback, clamped to `[10s, 86400s]`). |
| **3. Live-Reloading `loop.md` Maintenance** | `/agy-loop:loop`<br>`/agy-loop:loop 15m` | Omits the inline prompt. Re-reads `.agents/loop.md` -> `loop.md` -> `~/.gemini/config/loop.md` -> built-in branch maintenance fallback via `resolve-task` on **every tick** (`25,000`-byte cap with truncation warning). |
| **4. One-Shot Delayed Check-In** | `/agy-loop:loop in 20m verify staging smoke tests`<br>`/agy-loop:loop --once 10m check if docker build finished` | Schedules a single non-blocking `DurationSeconds` timer (`max_iterations = 1`), runs one isolated subagent pass when the timer fires, reports the result, and stops. |
| **5. Lifecycle & Diagnostics** | `/agy-loop:loop status [--all]` (or `list`)<br>`/agy-loop:loop stop [<id1> <id2>\|all] [--after-current]`<br>`/agy-loop:loop doctor [--clean-shadow]`<br>`/agy-loop:loop help` | Correlates `.agents/.agy-loop/` `loop_id` state with `manage_task` & `manage_subagents`, stops specific or all loops (immediately or gracefully `--after-current`), diagnoses shadows / `skills.json` / `active_loops`, or prints concise usage. |

### Flags Reference

Flags can appear anywhere before `--` in `/agy-loop:loop` arguments (leading typos or close aliases like `--statefull` / `--max-iter` fail fast with Exit `2`; mid/trailing command flags like `gh pr checks --required` pass with a warning unless escaped after `--`):

| Flag | Default | Description |
|:---|:---|:---|
| `--max <N>` | `20` (`1` with `--once`) | Upper bound on iterations before the loop automatically stops to protect quota. |
| `--stateful` | `fresh` | Reuse a single `loop-worker` conversation ID across ticks, waking it from `Idle` via `send_message` so multi-turn debugging context persists off the main thread. |
| `--worktree` | `inherit` | Run the worker inside an isolated Git branch/worktree (`Workspace: "branch"`). In `agy v1.5.5+`, dirty parent edits carry over; `agy-loop` tracks `worktree_branch` and surfaces `git diff --stat` + merge commands before teardown. |
| `--share` | `inherit` | Run the worker inside a shared working copy (`Workspace: "share"`). |
| `--model <tier>` | `flash` (`loop-worker`) | Override subagent model tier: `inherit`, `flash_lite`, `flash`, or `pro`. |
| `--self` | `loop-worker` | Delegate iterations to the built-in full-capability `self` subagent (also auto-enabled when the prompt starts with `/` to invoke a nested skill like `/agy-loop:loop 20m /code-review`, or requires MCP tools). |
| `--cron` | `false` | Use native 5-field `CronExpression` (`schedule` tool) when the fixed interval `>= 60s` maps cleanly to cron (`1m`, divisors of `60m` or `24h`, `1d`). Authoritative `state-read` eliminates static prompt drift across ticks. |
| `--exact` | `false` | Set `ExactTiming: true` on `--cron` schedules to fire on exact wall-clock minutes without anti-herd jitter. |
| `--daemon` | `false` | Set `IsDaemon: true` on `--cron` schedules for standing jobs that continue firing after the current task finishes. |
| `--once` | `false` | Execute a single delayed run (`max_iterations = 1`) and exit cleanly after reporting. |
| `--` | — | End-of-options separator: everything after `--` is passed verbatim as prompt text without flag parsing or warnings. |

---

## 🛡️ Reliability, Sandbox State & Cross-Engine Worker

- **6-Tool Cross-Engine `loop-worker` (Desktop Cortex + CLI `oneharness`)**: `agents/loop-worker.md` pins the exact 6 tools verified across both Desktop Cortex and `agy v1.5.14` CLI `oneharness` (`view_file`, `write_to_file`, `replace_file_content`, `run_command`, `manage_task`, `search_web`). The 4 legacy Cortex-only tools (`multi_replace_file_content`, `list_dir`, `find_by_name`, `grep_search`) were removed because `oneharness` aborts agent loading when unmapped tools are absent from its registry; sandboxed `run_command` (`rg`/`grep`/`find`/`ls`) covers search and directory inspection cleanly.
- **Sandbox-Safe Unified State (`.agents/.agy-loop/`)**: Because `agy v1.5.7+` `auto` mode blocks sandboxed `run_command` writes to `~/.gemini/antigravity-cli/plugin_data/`, per-loop `state.json` and `events.jsonl` live under `<workspace>/.agents/.agy-loop/loops/<loop_id>/` (override via `AGY_LOOP_STATE_DIR`) with an auto-created `.gitignore` (`*`). Both interactive `/agy-loop:loop` (`state-read`) and headless `agy-loop run` share this control plane, eliminating `--cron` static-prompt drift and surviving `/compact`.
- **3-Error Circuit Breaker & Delay Clamping**: Missing/unparseable 4-line worker footers (or invalid headless outputs) increment `consecutive_errors`; 3 consecutive failures (`--max-errors 3`) automatically mark the loop `circuit_broken`, clear remaining schedules, and halt with diagnostics. Dynamic `NEXT_DELAY_SEC` values default to `120s` if invalid and clamp to `[10s, 86400s]`.

---

## 🤖 Headless CLI Runner

**(`agy-loop run` · `ps` · `logs` · `stop` · `statusline`)**

Run non-interactive loops from terminals, SSH sessions, cron jobs, or CI/CD pipelines using `Node.js >= 18` with **zero external npm dependencies** (`npx agy-loop run ...` or global `agy-loop run ...`). Headless runs share `.agents/loop.md` hot-reload and `<workspace>/.agents/.agy-loop/` state seamlessly with interactive `/agy-loop:loop`, inherit your local `agy` permission mode by default (`auto` in `v1.5.7+` unless `--mode`, `--sandbox`, or `--dangerously-skip-permissions` is specified), and enforce strict schema validation, model/fallback/verifier routing, hard token/duration budgets, and clean exit codes.

### Quick Examples

```bash
# 1. Single-shot check (immediate or delayed with `in <delay>`)
agy-loop run --once "Inspect git status and summarize any failing tests"
agy-loop run in 20m "Verify staging smoke tests and report status"

# 2. Adaptive CI loop with Gemini 4 model, effort, fallback & independent read-only verifier
agy-loop run "Check PR CI status and fix failing checks" \
  --model gemini-4-hydrogen-xhigh \
  --effort high \
  --fallback-model gemini-4-carbon-high \
  --verifier-model gemini-4-neon-xhigh

# 3. Persistent stream-json session (`--stateful`) with periodic context rotation (`--reset-every 6`)
agy-loop run 2m "Run unit tests and fix failures until green" --stateful --reset-every 6

# 4. Isolated Git branch/worktree execution (auto-cleaned if 0 commits & clean; preserved with merge hints if modified)
agy-loop run "Refactor flaky auth tests and commit verified fixes" --worktree

# 5. Zero-token shell preflight (`--probe` + `--probe-until-pass`)
# Runs `npm test` before each turn; exits DONE (0 LLM tokens) as soon as the probe exits 0
agy-loop run 30s "Fix remaining TypeScript errors" --probe "npm test" --probe-until-pass

# 6. Hard token & wall-clock budgets with machine-readable JSON summary for CI
agy-loop run --max 10 --max-tokens 250000 --max-duration 30m --json "Stabilize build"
```

### Headless Runner Options (`agy-loop run`)

Supports the same interval grammar as `/agy-loop:loop` (`30s`, `1h30m`, `every 5m`, `in 20m`, trailing `every 2h`, or omit prompt to live-reload `.agents/loop.md`), plus:

| Category | Key Options | Behavior & Defaults |
| :--- | :--- | :--- |
| **Transport & Rotation** | `--fresh` (default), `--stateful`, `--reset-every <N>` | `fresh` spawns `agy --output-format json` per pass; `--stateful` reuses a persistent `stream-json` process (rotating every `N` turns when `--reset-every` is set). |
| **Budgets & Retries** | `--max <N>` (`20`), `--once`, `--max-duration <dur>`, `--max-tokens <N>`, `--max-retries <N>` (`3`), `--max-errors <N>` (`3`), `--turn-timeout <dur>` (`10m`) | Enforces hard iteration, wall-clock, and cumulative token budgets; retries `print_timeout` / transient `429` errors with jittered backoff (`30s -> 60s -> 120s`); trips circuit breaker on consecutive schema/runtime errors. |
| **Model & Verifier Routing** | `--model <slug\|label>`, `--effort <low\|medium\|high\|xhigh\|max>`, `--fallback-model <slug\|label>`, `--verifier-model <slug\|label>` | Resolves model slugs or display names via `agy --output-format json models` (automatically omitting `--effort` for `Orchestrator` models), switches to `--fallback-model` on quota/rate-limit/capacity errors, and runs a read-only verifier pass before accepting `DONE`. |
| **Permissions & Isolation** | `--mode <auto\|accept-edits\|plan>`, `--sandbox`, `--dangerously-skip-permissions`, `--allow-slash-commands`, `--settings <json\|path>`, `--add-dir <dir>`, `--worktree`, `--keep-worktree`, `--fail-on-denied` | Inherits local `agy` mode unless overridden; disables slash expansion unless `--allow-slash-commands` is passed; isolates edits in `<state>/worktrees/<loop_id>` (`agy-loop/<loop_id>`); treats soft-denied tool calls (`denied_actions[]`) as `BLOCKED` (exit `3`) under `--fail-on-denied`. |
| **Preflight & Output** | `--probe <cmd>`, `--probe-timeout <dur>` (`60s`), `--probe-until-pass`, `--cwd <dir>`, `--json`, `--quiet`, `--` | Runs bounded shell `--probe` before each pass (injecting failure output tail or completing immediately at `0` tokens); emits final JSON summary under `--json`; `--` passes remaining tokens verbatim as prompt text. |

### Observability & Lifecycle Commands

> **Backward compatibility:** `agy-loop status` remains an alias for `agy-loop doctor` (diagnostics). Use **`agy-loop ps`** (or `list`) to inspect running and historical loops.

```bash
# List active loops in the current workspace (`--all` includes finished loops; `--global` queries cross-workspace index; `[stale]` flags dead PIDs)
agy-loop ps [--all] [--global] [--json]

# Inspect or tail structured iteration events & incremental token telemetry (`id`, prefix/suffix, or `latest`)
agy-loop logs [id|latest] [-f] [-n N] [--json]

# Stop one loop, matching prefix, or all active loops (immediately via control.json + SIGTERM, or gracefully `--after-current`)
agy-loop stop <id|--all> [--after-current]

# Print a compact <5ms status segment (0 subprocesses; silent when 0 live loops)
agy-loop statusline [--global] [--no-color] [--json]
```

**Embed `agy-loop statusline` in Antigravity CLI (`~/.gemini/antigravity-cli/settings.json`):**

```json
{
  "statusLine": {
    "type": "command",
    "command": "agy-loop statusline",
    "stack_with_default": true
  }
}
```

*(If `agy-loop` is installed only as a plugin without global `npm install -g agy-loop`, set `"command": "node ~/.gemini/config/plugins/agy-loop/bin/agy-loop.mjs statusline"` for `<5ms` zero-`npx` latency. `"stack_with_default": true` renders active loop status beneath Antigravity's built-in status bar.)*

### Headless Exit Codes (`agy-loop run`)

| Exit Code | Outcome | Meaning |
| :--- | :--- | :--- |
| **`0`** | `DONE` / `--once` / `--probe-until-pass` | Objective completed with `DONE`, `--probe-until-pass` exited `0` (0 tokens), or a single `--once` pass finished cleanly (`DONE` or `CONTINUE`). |
| **`1`** | `error` / `circuit_broken` | Runtime error (missing `agy`, `agy` Exit `1`, `verifier_error` at `--max`/`--once`) or consecutive contract/runtime errors reached `--max-errors` (`3` default). |
| **`2`** | Usage / Config Error | Invalid CLI flags, conflicting options (`--stateful` + `--fresh`), invalid duration/budget, unrecognized `--model` / `--fallback-model` / `--verifier-model`, or `agy` config error (Exit `2`). |
| **`3`** | `BLOCKED` | Worker reported `BLOCKED`, non-retryable quota/billing/spend-cap error hit, `--verifier-model` rejected at `--max`/`--once`, or soft-denied tool calls triggered `--fail-on-denied`. |
| **`4`** | `max_reached` | Multi-iteration loop exhausted `--max`, `--max-duration`, or `--max-tokens` before reaching `DONE`. |
| **`130`** | `stopped` | Interrupted via `SIGINT`/`SIGTERM` or terminated via `agy-loop stop`. |

---

## 🔄 `.agents/loop.md` Hot-Reload Guide

When you run bare `/agy-loop:loop` or interval-only `/agy-loop:loop 15m` (without an inline prompt), `agy-loop` resolves instructions on **every wake-up** (up to `25,000` bytes) in strict priority order:

1. **`.agents/loop.md`** in the current workspace (project-scoped team or repo loop policy)
2. **`loop.md`** in the workspace root
3. **`~/.gemini/config/loop.md`** (personal global maintenance defaults across repositories)
4. **Built-in branch maintenance fallback**: checks uncommitted/unfinished repo work and incremental tests, inspects open PR review comments and CI status via `gh` when available, and reports a single green status line if clean.

Because resolution runs dynamically on every tick via `skills/loop/scripts/loop-helper.sh resolve-task`, you can edit `.agents/loop.md` while a loop is parked in the background and the updated instructions take effect on the very next wake-up without restarting `/agy-loop:loop`.

### Copy-Paste `.agents/loop.md` Example

```markdown
# Branch Maintenance Policy

1. Run `npm test` (or the fastest incremental test command for touched files).
2. If tests fail, inspect the failure, apply a minimal root-cause fix, and re-run the failing test once in this turn to verify.
3. If `gh` is authenticated and an open PR exists for the current branch:
   - Check `gh pr checks` for failing CI jobs.
   - Check unresolved review comments and address straightforward mechanical fixes.
4. Stop with `LOOP_STATUS: DONE` once local tests pass and all PR checks are green; return `LOOP_STATUS: BLOCKED` if an architectural decision or missing secret is required.
```

---

## 🛑 How to Exit or Stop a Loop

You can stop an active loop at any time through four clean paths, in addition to built-in automatic exit conditions:

1. **Slash Command (`/agy-loop:loop stop`)**
   Run `/agy-loop:loop stop` (or `/agy-loop:loop stop <id1> <id2>`, `/agy-loop:loop stop <id> --after-current`, `/agy-loop:loop cancel`) to update `.agents/.agy-loop/` state (`state-stop`), cancel linked `schedule` timers/crons via `manage_task(Action="kill")`, and terminate loop subagents via `manage_subagents(Action="kill")` (preserving `branch` worktrees with unmerged commits until reviewed).
2. **Conversational Stop**
   Tell the session in plain language: `"stop the current loop"` (or `"stop the loop after this iteration finishes"`).
3. **Interactive CLI TUI Panels (`/tasks` & `/agents`)**
   - Type **`/tasks`**, highlight the scheduled loop timer or cron job, and press **`k`** to kill future wake-ups (`x` clears completed entries).
   - Type **`/agents`**, highlight a `running` or `idle` `loop-worker`, and press **`k`** to kill it immediately (temporary `--worktree` branches are cleaned up automatically). When a worker requests permission approval, press **`Ctrl+K`** to quick-approve or **`Alt+J`** to teleport into its live transcript (`Esc` returns to main chat).
4. **Foreground Turn Interrupt (`Esc`)**
   Press **`Esc`** to interrupt an active foreground dispatch turn immediately without closing `agy` CLI (pressing `Ctrl+C` twice exits the CLI).

**Automatic Stop Conditions**: Every loop stops and clears any remaining schedule automatically when the worker returns `LOOP_STATUS: DONE` (objective satisfied), `LOOP_STATUS: BLOCKED` (human input, sandbox permission, or credentials required), reaches `--max <N>` (default `20` iterations), or hits 3 consecutive contract/runtime errors (`circuit_broken`).

---

## 🧹 Diagnostics, Clean Uninstall & Verification

### Troubleshooting: Pre-Existing Shadow Files (`~/.gemini/config/`)

Antigravity loads user-level customizations in `~/.gemini/config/` ahead of installed plugins (`~/.gemini/config/plugins/agy-loop/`). When you install via `agy plugin install https://github.com/maxlee/agy-loop`, Antigravity stages the plugin without deleting pre-existing loose `~/.gemini/config/skills/loop/SKILL.md` or `~/.gemini/config/agents/loop-worker.md`, which otherwise override the un-namespaced `loop-worker` subagent (even when invoking `/agy-loop:loop`) and intercept `/loop`.

To prevent silent precedence collisions:

- **Zero-Overhead `SessionStart` Auto-Detector (`hooks.json`)**: Runs `skills/loop/scripts/loop-helper.sh session-start` on session start. Strictly `protojson`-compliant for `agy v1.5.13+` (verified on `v1.5.14`, zero leaked stdin keys): returns `{}` in `<5ms` at **`0` token cost** when clean, and surfaces startup alerts when loose shadow files **or** `skills.json` `include_only`/`exclude` filters block `/agy-loop:loop` (matched with POSIX ERE parity).
- **One-Command Non-Destructive Cleanup**: Archive colliding loose files into `~/.gemini/config/.agy-loop-backup-<YYYYMMDD-HHMMSSZ>/` (unified UTC timestamp across `agy-loop.mjs`, `loop-helper.sh`, and `install.sh`; then run `/skills reload` in any open `agy` session):
  - **POSIX shell (zero Node/npm required)**: `sh ~/.gemini/config/plugins/agy-loop/install.sh --clean-shadow`
  - **Inside `agy` (works right away via plugin prefix)**: `/agy-loop:loop doctor --clean-shadow`
  - **Via npm CLI bridge**: `npx agy-loop doctor --clean-shadow`

### CLI Subcommands (`agy-loop` / `npx agy-loop`)

| Command | Description |
|:---|:---|
| `agy-loop run [interval] [prompt...] [options]` | Run headless loop via `fresh` (`json`) or `--stateful` (`stream-json`) transport with Gemini 4 routing, `--probe`, `--verifier-model`, `--worktree`, and budget/exit-code controls |
| `agy-loop ps [--all] [--global] [--json]` | List active (or `--all` / `--global`) loops across interactive and headless engines, flagging `[stale]` dead PIDs (`list` alias supported; `status` remains aliased to `doctor`) |
| `agy-loop logs [id\|latest] [-f] [-n N] [--json]` | Inspect or live-follow `events.jsonl` iteration timelines, incremental token telemetry, and soft-denial records |
| `agy-loop stop <id\|prefix\|all\|--all> [--after-current]` | Stop specific or all active loops immediately (`control.json` + `SIGTERM` for live headless PIDs) or gracefully after the current turn (`--after-current`) |
| `agy-loop statusline [--global] [--no-color] [--json]` | Emit a `<5ms` zero-subprocess status summary for `settings.json` `statusLine` integration (silent when 0 live loops) |
| `npx agy-loop [install \| update]` | Install or update `agy-loop` via `agy plugin install` (warns if user-level shadow files exist) |
| `npx agy-loop install --clean-shadow` | Install `agy-loop` and archive loose shadow files into `~/.gemini/config/.agy-loop-backup-<YYYYMMDD-HHMMSSZ>/` |
| `npx agy-loop doctor [--json]` | Run full diagnostics (`agy v1.5.14` `agy.capabilities` matrix, enterprise `admin_settings.json` / `settings.json` / `hooks.json` audit, `SessionStart` `protojson` `hookSelfTest`, `loop-worker` 6-tool `agentToolsCheck`, shadows, ERE `skills.json` filters, `loop.md`, `activeLoops` with `engine`/`stale`, and `15s`/`30s` `spawnSync` timeout protection; `status` alias preserved) |
| `npx agy-loop doctor --clean-shadow [--json]` | Non-destructively archive loose shadow files into `~/.gemini/config/.agy-loop-backup-<YYYYMMDD-HHMMSSZ>/` and re-run diagnostics (`status --clean-shadow` alias supported; run `/skills reload` in open sessions) |
| `npx agy-loop validate [--json]` | Run `agy plugin validate --strict` against the packaged plugin root |
| `npx agy-loop uninstall` | Cleanly remove the plugin via `agy plugin uninstall agy-loop` (`remove` alias supported) |

```bash
npx agy-loop doctor
# Archive pre-existing loose shadow files non-destructively:
npx agy-loop doctor --clean-shadow
# Machine-readable JSON output:
npx agy-loop doctor --json
```

### Clean Uninstall

Remove `agy-loop` completely with a single command:

```bash
# Via npm bridge:
npx agy-loop uninstall

# Via native Antigravity CLI:
agy plugin uninstall agy-loop

# Via one-line or local POSIX uninstaller:
curl -fsSL https://raw.githubusercontent.com/maxlee/agy-loop/main/uninstall.sh | sh
./uninstall.sh
```

### Local Development & Verification

See [**ARCHITECTURE.md**](ARCHITECTURE.md) for full details on the Three-Turn Reactive Lifecycle, Task & Pacing Resolution flow, 4-line Worker Output Contract, Sandbox/Worktree isolation model, and the v1.2 Headless Dual-Transport Architecture.

```bash
sh -n install.sh uninstall.sh skills/loop/scripts/loop-helper.sh  # Check POSIX shell syntax
node --check bin/agy-loop.mjs lib/*.mjs                           # Check Node >= 18 ESM syntax
npm test                                                          # Run isolated unit & integration tests
agy plugin validate --strict .                                    # Strict Antigravity v1 plugin check (0 findings)
```

---

## 📄 License

Distributed under the [**MIT License**](LICENSE). Copyright © Max.

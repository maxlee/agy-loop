<div align="center">

<img src="assets/logo.svg" alt="AGY Loop Logo" width="88" height="88" />

# AGY Loop (`agy-loop`)

**Non-blocking `/agy-loop:loop` scheduler and dynamic `run_workflow` orchestrator for Google Antigravity Desktop & CLI (`agy`), with independent read-only `loop-verifier`, atomic steering (`nudge`/`wake`), checkpointed `resume`, and live-reloading `loop.md`**

[![CI](https://github.com/maxlee/agy-loop/actions/workflows/ci.yml/badge.svg)](https://github.com/maxlee/agy-loop/actions/workflows/ci.yml)
[![Release](https://github.com/maxlee/agy-loop/releases/latest)](https://github.com/maxlee/agy-loop/releases/latest)
[![Antigravity Plugin v1](https://img.shields.io/badge/Antigravity-Plugin_v1-38BDF8.svg)](plugin.json)
[![Node >=18](https://img.shields.io/badge/Node-%3E%3D18-22C55E.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[**English**](README.md) · [**简体中文**](README.zh-CN.md) · [**Why AGY Loop?**](#-why-agy-loop) · [**Quick Install**](#-installation) · [**Workflow Engine**](#-dynamic-workflow-engine-and-two-stage-verification) · [**Slash Commands**](#-slash-commands-modes--flags) · [**Headless CLI**](#-headless-cli-runner) · [**`loop.md` Guide**](#-agentsloopmd-hot-reload-guide) · [**Exit & Stop**](#-how-to-exit-or-stop-a-loop) · [**Architecture**](ARCHITECTURE.md)

</div>

---

**AGY Loop** (`v1.3.0`) brings a dual-engine, non-blocking loop orchestrator (`/agy-loop:loop`) to **Antigravity Desktop** (Marketplace-ready) and **Antigravity CLI (`agy`)**, alongside a zero-dependency **Headless CLI Runner** (`agy-loop run | resume | nudge | wake | ps | logs | stop | statusline`) for terminals, SSH, and CI/CD pipelines.

- **Interactive `schedule` engine** delegates each check or fix pass to an isolated `loop-worker` (or `self`) subagent and parks between iterations on Antigravity's native `schedule` tool at **zero token cost**, keeping your main prompt completely free.
- **Dynamic Python Workflow engine (`run_workflow`, `agy >= 1.5.9`)** moves multi-turn loops (`--verify`, `--verify-cmd`, `--probe`, `--targets`, `--max-tokens`, `--max-duration`, `--reset-every`) into an async Python orchestrator (`workflows/loop-runner/workflow.py`), cutting a 20-iteration loop from ~41 main-chat turns down to **2 main-session turns (~95% fewer main-chat turns)** with parallel `--targets` fault isolation and a two-stage `turn-stopping` verification gate (`--verify-cmd` -> read-only `loop-verifier`).
- **Unified Control Plane & Recovery (`v1.3.0`)**: Interactive `schedule`, `workflow`, and `headless` runs share `<workspace>/.agents/.agy-loop/` (`state.json`, `events.jsonl`, `control.json`, atomic `inbox/`), supporting live `nudge`/`wake`, frozen per-iteration `IterationSnapshot`s, paired `iteration_start`/`iteration_end` checkpoints, `O_EXCL`-locked global `index.json`, sticky hard-budget guards, `finally` double-insurance error terminal states, and `agy-loop resume`.

> Inspired by Claude Code's [`/loop` workflow](https://claude.com/resources/articles/getting-started-with-loops) and engineered around Antigravity's reactive subagent wakeup, `run_workflow` dynamic orchestration, sub-minute `DurationSeconds` timers, stateful context continuity, and Git worktree isolation.

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

| Capability | Shell `sleep` Loop | Claude Code `/loop` | AGY Loop (`agy-loop v1.3.0`) |
|:---|:---|:---|:---|
| **Wait Mechanism** | Blocking shell `sleep` | Built-in session cron queue | Native non-blocking `schedule` timers/crons & `run_workflow` (`agy >= 1.5.9`) |
| **Main Chat Availability** | Locked while waiting | Free between ticks | Free between ticks **and** while subagents / `run_workflow` run (~95% fewer main turns) |
| **Context Isolation** | Pollutes main chat with raw logs | Shares main conversation window | Isolated `loop-worker` / `self` + read-only `loop-verifier`; 1-line main summaries |
| **Two-Stage Verification** | None | None | Stage 1 0-token `--verify-cmd` -> Stage 2 read-only `loop-verifier` (`pro`) with sticky budget guard |
| **Parallel Fan-Out** | Sequential shell loop | Single prompt thread | Concurrent `--targets <csv>` via `parallel()` with per-target fault isolation |
| **Minimum Granularity** | `1s` (blocks turn) | `1m` cron floor (`30s` rounds up to `1m`) | Sub-minute `DurationSeconds` (`15s`, `30s`) & compound durations (`1h30m`, `2m30s`) |
| **Live Steering & Recovery** | `Ctrl+C` restart from scratch | Cancel & recreate cron | Atomic `inbox/` `nudge`/`wake`, frozen `IterationSnapshot`, `iteration_start`/`end`, `agy-loop resume` |
| **Live-Reloading `loop.md`** | None | `.claude/loop.md` & `~/.claude/loop.md` | Re-read every tick: `.agents/loop.md` -> `loop.md` -> `~/.gemini/config/loop.md` -> built-in fallback |
| **Stateful & Risk-Free Edits** | Mutates active working tree | Shared main history | `--stateful` (+ `--reset-every N`) & `--worktree` (`branch` + diff/merge hints) / `--share` |

---

## 📦 Installation

### Requirements

- **Antigravity CLI (`agy`)** `v1.5.0+` (`v1.5.9+` required for the `run_workflow` dynamic workflow engine; verified against `v1.5.14` strict validator, `oneharness` tool registry, and headless `json` / `stream-json` transports) or **Antigravity Desktop**
- **Zero Node.js / npm required** for native `agy plugin install` or the one-line `curl` installer to run interactive **`/agy-loop:loop`** (note: `run_workflow` executes Python 3.8+ stdlib inside `agy >= 1.5.9` with zero pip dependencies); **`Node.js >= 18`** powers the zero-dependency `npx agy-loop` CLI bridge and the headless **`agy-loop run | resume | nudge | wake | ps | logs | stop | statusline`** runner (`Bun` can also run the CLI bridge)

`agy-loop` is packaged as a **pure, Marketplace-compatible dual-habitat plugin**: the repository root is simultaneously a strict v1 Antigravity native plugin (`plugin.json`, `hooks.json`, `skills/loop/SKILL.md`, `agents/loop-worker.md`, `agents/loop-verifier.md`, `workflows/loop-runner/`) and a zero-dependency npm CLI (`bin/agy-loop.mjs` + `lib/*.mjs`). Once installed:

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

## ⚙️ Dynamic Workflow Engine and Two-Stage Verification

### Engine Auto-Routing (`--engine auto|schedule|workflow`)

`skills/loop/scripts/loop-helper.sh parse` automatically picks the optimal execution engine for `/agy-loop:loop`:

- **`schedule` (default for plain `/agy-loop:loop`)**: Used when `--engine schedule` is passed, or when `--engine auto` (default) is used without workflow-only options. Preserves the 3-Turn Reactive Protocol (`schedule` + `invoke_subagent`), non-`auto` `Ctrl+K` interactive permission prompts, `--cron`/`--exact`/`--daemon`, and compatibility with every `agy` version.
- **`workflow` (`workflows/loop-runner/workflow.py`, `agy >= 1.5.9`)**: Selected automatically when `--engine workflow` OR any workflow-only flag is provided:
  `--verify`, `--verifier-model`, `--verify-cmd`, `--probe`, `--targets`, `--max-tokens`, `--max-duration`, `--reset-every`.
- **Mutual Exclusions (`Exit 2`)**:
  - `--cron`, `--exact`, and `--daemon` require `--engine schedule` (cannot combine with `--engine workflow` or workflow-only flags).
  - Workflow-only flags cannot combine with `--engine schedule`.
  - `--reset-every` requires `--stateful`; `--probe-until-pass` requires `--probe`.

#### Why `run_workflow` Cuts Main-Session Turns by ~95%

Under `schedule`, a 20-iteration loop wakes the main chat on every subagent return and every timer tick (~41 main-chat turns). Under `run_workflow`, `SKILL.md` initializes `<workspace>/.agents/.agy-loop/loops/<loop_id>/`, invokes `run_workflow(ScriptPath=".../workflows/loop-runner/workflow.py", Args=...)`, and yields immediately. All 20 iterations, probes, retries, two-stage verification, and sleeps execute asynchronously inside `workflow.py`, waking the main session **once** upon completion (**2 main-session turns total, ~95% fewer main-chat turns**).

#### `agy < 1.5.9` Graceful Fallback

If `run_workflow` is unavailable (`agy < 1.5.9`), `/agy-loop:loop` cancels the newly initialized state (`state-stop`) and guides the user to:
1. Upgrade Antigravity CLI to `agy >= 1.5.9`, **or**
2. Re-run with `--engine schedule` (for standard intervals/prompts without workflow-only flags), **or**
3. Run `npx agy-loop run ...` in a terminal for headless `--verify-cmd`, `--verifier-model`, `--probe`, `--max-tokens`, `--max-duration`, and `--reset-every` support.

### Parallel `--targets` with Fault Isolation

Pass `--targets "pkgA,pkgB,pkgC"` to execute each target concurrently per iteration via `parallel()` in `workflow.py`. Every target coroutine runs inside a per-target `try / except Exception` guard so one failing target records an isolated error without cancelling sibling targets (while hard `BudgetExceeded` exceptions still propagate to stop the workflow safely). The aggregator marks `DONE` only when **every** target reports `DONE`.

```text
/agy-loop:loop audit and fix lint warnings --targets "packages/core,packages/cli,packages/ui" --max 4
```

*(Prefer `--worktree`, `--share`, or disjoint directories whenever targets modify files concurrently.)*

### Independent Read-Only `loop-verifier` & Two-Stage `turn-stopping` Gate

Available across **both** the `workflow` engine (`--verify` / `--verifier-model` + `--verify-cmd`) and the Headless CLI runner (`--verifier-model` + `--verify-cmd`). Whenever the worker emits `LOOP_STATUS: DONE`:

1. **Stage 1 — Deterministic 0-Token Check (`--verify-cmd <cmd>`)**:
   - Executes your explicit shell verification command locally (bounded by `--verify-timeout`, default `60s`, capturing up to `4096 B` UTF-8-safe tail output and logging a `verify_cmd` event).
   - If the command fails or times out, Stage 2 LLM verification is **skipped** (`0` verifier tokens spent): when `iteration < max_iterations` (and budgets remain), `next_hint` receives the failure tail and the loop continues to fix it; if at `--max` / `--once`, the loop fails closed as `BLOCKED` (`verify_cmd_failed`).
2. **Stage 2 — Independent Read-Only LLM Verification (`loop-verifier` / `--verifier-model`)**:
   - **Sticky Hard-Budget Guard**: Before calling the verifier, both `workflow.py` and `runner.mjs` check whether `max_tokens` or `max_duration` (or `max_agents` in `workflow.py`) is already exhausted. If exhausted, Stage 2 is **never invoked** (never overspends past hard budgets), logs `skipped_due_to_budget: true` (`unverified_due_to_budget: true`), and preserves `status: "max_reached"` (`exit 4` in headless).
   - Otherwise, in `workflow` mode, `workflow.py` invokes `agents/loop-verifier.md` (`model: pro` by default or `--verifier-model`, `commandExecutionPolicy: sandbox`, strictly read-only 3-tool subset `[view_file, run_command, search_web]` with zero write tools). In headless mode, `runner.mjs` runs an isolated read-only `runJsonTurn` (`mode: "auto"`, `sandbox: true`, `dangerouslySkipPermissions: false`) with `--verifier-model`.
   - Anchored to the frozen `IterationSnapshot.taskPrompt`, `git status`, `git diff --stat`, and Stage 1 `verify_cmd` summary, the verifier returns fail-closed JSON (`{ passed, summary, issues }`). Rejection or verifier error sends concrete `issues` back into `next_hint` if iterations remain, or fails closed as `BLOCKED` at `--max` / `--once`.

```text
/agy-loop:loop fix auth regression --verify-cmd "npm test" --verify --verifier-model pro --max 5
/agy-loop:loop hunt flaky race condition --stateful --reset-every 3 --max 9
/agy-loop:loop 30s fix build --probe "npm run build" --probe-until-pass --max 10
```

### Security Boundary (Outside-Sandbox `run_workflow`)

> [!WARNING]
> **Explicit-Only Command Execution**: Because `agy`'s `run_workflow` Python runtime executes outside the OS sandbox, `workflows/loop-runner/workflow.py` **only** executes `--probe` (`probe_cmd`) and `--verify-cmd` (`verify_cmd`) values passed explicitly via CLI/workflow `Args` — it **never** extracts or runs shell commands from `.agents/loop.md` or repository files, and every subprocess enforces explicit timeouts plus `4096 B` UTF-8-safe output tail capping.

---

## 🧭 Slash Commands, Modes & Flags

### 5 Invocation Modes

| Mode | Example Commands | Behavior |
|:---|:---|:---|
| **1. Fixed Interval + Prompt** | `/agy-loop:loop 30s curl -fsS http://localhost:8080/health`<br>`/agy-loop:loop every 5m check the deploy`<br>`/agy-loop:loop 1h30m check backup`<br>`/agy-loop:loop check PR #42 comments every 2h` | Runs on a fixed cadence (`s`, `m`, `h`, `d`), supporting leading `every <dur>`, trailing `every`, and compound durations (`1h30m`, `2m30s`; fractional `1.5m` rejected with Exit `2`). Chains non-overlapping `DurationSeconds` timers by default, or uses 5-field `CronExpression` with `--cron`. |
| **2. Dynamic Self-Paced** | `/agy-loop:loop check CI and fix failures`<br>`/agy-loop:loop run pytest and fix failing tests --stateful` | Omits the interval. After each pass, `loop-worker` sets `NEXT_DELAY_SEC` (`120s` default fallback, clamped to `[10s, 86400s]`). |
| **3. Live-Reloading `loop.md` Maintenance** | `/agy-loop:loop`<br>`/agy-loop:loop 15m` | Omits the inline prompt. Re-reads `.agents/loop.md` -> `loop.md` -> `~/.gemini/config/loop.md` -> built-in branch maintenance fallback via `resolve-task` on **every tick** (`25,000`-byte cap with truncation warning). |
| **4. One-Shot Delayed Check-In** | `/agy-loop:loop in 20m verify staging smoke tests`<br>`/agy-loop:loop --once 10m check if docker build finished` | Schedules a single non-blocking `DurationSeconds` timer (`max_iterations = 1`), runs one isolated pass when the timer fires, reports the result, and stops. |
| **5. Lifecycle, Steering & Diagnostics** | `/agy-loop:loop status [--all] [--json]` (or `list`)<br>`/agy-loop:loop nudge <id\|latest> "<msg>" [--wake]`<br>`/agy-loop:loop wake <id\|latest>`<br>`/agy-loop:loop stop [<id1> <id2>\|all] [--after-current]`<br>`/agy-loop:loop doctor [--clean-shadow]`<br>`/agy-loop:loop help` | Inspects correlated `.agents/.agy-loop/` loops (`schedule`, `workflow`, `headless`), queues live `nudge`/`wake` steering into `inbox/`, stops specific or all loops (immediately or `--after-current`), diagnoses/archives shadows & `skills.json`, or prints concise usage. |

### Flags Reference (`/agy-loop:loop`)

Flags can appear anywhere before `--` in `/agy-loop:loop` arguments (leading typos or close aliases like `--statefull` / `--max-iter` fail fast with Exit `2`; mid/trailing command flags like `gh pr checks --required` pass with a warning unless escaped after `--`):

| Flag | Default | Description |
|:---|:---|:---|
| `--engine <mode>` | `auto` | Execution engine: `auto`, `schedule`, or `workflow`. `auto` selects `schedule` for standard loops and `workflow` whenever any workflow-only flag is passed. |
| `--max <N>` | `20` (`1` with `--once`) | Upper bound on iterations before the loop automatically stops (`max_reached`) to protect quota. |
| `--stateful` | `fresh` | Reuse a single worker conversation across ticks (`send_message` in `schedule`, persistent `agent` object in `workflow`). |
| `--reset-every <N>` | `null` | Rotate `--stateful` worker context every `N` iterations (requires `--stateful`; triggers `workflow` engine). |
| `--worktree` | `inherit` | Run the worker inside an isolated Git branch/worktree (`Workspace: "branch"`). In `agy v1.5.5+`, dirty parent edits carry over; `agy-loop` tracks `worktree_branch` and surfaces `git diff --stat` + merge commands before teardown. |
| `--share` | `inherit` | Run the worker inside a shared working copy (`Workspace: "share"`). |
| `--model <tier>` | `flash` (`loop-worker`) | Override worker model tier: `inherit`, `flash_lite`, `flash`, or `pro`. |
| `--self` | `loop-worker` | Delegate iterations to the built-in full-capability `self` subagent (also auto-enabled when the prompt starts with `/` to invoke a nested skill like `/agy-loop:loop 20m /code-review`, or requires MCP tools). |
| `--verify` | `false` | Enable Stage 2 independent read-only `loop-verifier` (`model: pro`) whenever the worker reports `DONE` (triggers `workflow` engine). |
| `--verifier-model <tier>` | `pro` (with `--verify`) | Override Stage 2 `loop-verifier` model tier (`inherit`, `flash_lite`, `flash`, `pro`; implies `--verify`; triggers `workflow` engine). |
| `--verify-cmd <cmd>` | `null` | Stage 1 deterministic 0-token shell verification command run on `DONE` before Stage 2 LLM verification (triggers `workflow` engine). |
| `--verify-timeout <dur>` | `60s` | Timeout for `--verify-cmd` (e.g., `30s`, `2m`). |
| `--probe <cmd>` | `null` | Explicit shell preflight command executed before each iteration (triggers `workflow` engine). |
| `--probe-timeout <dur>` | `60s` | Timeout for `--probe`. |
| `--probe-until-pass` | `false` | Finish `DONE` at `0` LLM tokens as soon as `--probe` exits `0` (requires `--probe`). |
| `--targets <csv>` | `[]` | Comma-separated targets executed concurrently per iteration via `parallel()` with per-target fault isolation (triggers `workflow` engine). |
| `--max-tokens <N>` | `null` | Hard cumulative token budget across the workflow (triggers `workflow` engine). |
| `--max-duration <dur>` | `null` | Hard wall-clock budget across the workflow (e.g., `30m`, `2h`; triggers `workflow` engine). |
| `--cron` | `false` | Use native 5-field `CronExpression` (`schedule` tool) when the fixed interval `>= 60s` maps cleanly to cron (`1m`, divisors of `60m` or `24h`, `1d`). Cannot combine with `workflow`. |
| `--exact` | `false` | Set `ExactTiming: true` on `--cron` schedules to fire on exact wall-clock minutes without anti-herd jitter (`schedule` only). |
| `--daemon` | `false` | Set `IsDaemon: true` on `--cron` schedules for standing jobs that continue firing after the current task finishes (`schedule` only). |
| `--once` | `false` | Execute a single run (`max_iterations = 1`) and exit cleanly after reporting. |
| `--` | — | End-of-options separator: everything after `--` is passed verbatim as prompt text without flag parsing or warnings. |

---

## 🛡️ Reliability, State Consistency & Cross-Engine Safety

- **Dual-Engine Tool Split (`loop-worker` 6 tools vs `loop-verifier` 3 read-only tools)**:
  - `agents/loop-worker.md` (`model: flash`, `commandExecutionPolicy: sandbox`) pins the 6 tools verified across both Desktop Cortex and `agy v1.5.14` CLI `oneharness` (`view_file`, `write_to_file`, `replace_file_content`, `run_command`, `manage_task`, `search_web`). Legacy Cortex-only tools (`multi_replace_file_content`, `list_dir`, `find_by_name`, `grep_search`) stay excluded so `oneharness` never aborts on unmapped tools.
  - `agents/loop-verifier.md` (`model: pro`, `commandExecutionPolicy: sandbox`) restricts tools strictly to the 3 read-only tools `[view_file, run_command, search_web]`, physically removing write tools (`write_to_file`, `replace_file_content`) and scheduling tools (`manage_task`, `schedule`, `invoke_subagent`).
- **Sandbox-Safe Unified State & `O_EXCL`-Locked Global Index (`.agents/.agy-loop/`)**:
  - Because `agy v1.5.7+` `auto` mode blocks sandboxed `run_command` writes to `~/.gemini/antigravity-cli/plugin_data/`, per-loop `state.json`, `events.jsonl`, `control.json`, and `inbox/` live under `<workspace>/.agents/.agy-loop/loops/<loop_id>/` (override via `AGY_LOOP_STATE_DIR`) with an auto-created `.gitignore` (`*`).
  - Interactive `schedule`, `workflow`, and `headless` runs share this control plane, and cross-workspace upserts into `~/.gemini/antigravity-cli/plugin_data/agy-loop/index.json` (200-entry cap) are serialized by an atomic `O_EXCL` lock file (`${indexPath}.lock`) with dead-PID (`isPidAlive`) and `10s` stale TTL reclamation.
- **Single-Iteration Consistency & Crash Safety (`v1.3.0`)**:
  - **Atomic `inbox/` Queue**: `nudge`, `wake`, and `stop` messages write via temp file + atomic rename into `inbox/`, and `preIteration` claims them synchronously via atomic rename into `inbox/claimed/` (at-most-once delivery, zero write-write races).
  - **Frozen `IterationSnapshot`**: `preIteration` captures `taskPrompt`, `nextHint`, `probeOutput`, `nudges`, and a 12-char SHA-256 `snapshotHash` into an immutable snapshot (`Object.freeze` in Node / `MappingProxyType` in Python), anchoring worker retries and Stage 2 verification even if `loop.md` changes mid-iteration.
  - **Paired `iteration_start` / `iteration_end` Checkpointing**: `state.json` records `in_flight_iteration` + `in_flight_snapshot_hash` before execution, and a per-iteration `finally` unconditionally clears `in_flight_iteration` and emits `iteration_end` (`outcome`, `duration_ms`, `usage_delta`).
  - **`finally` Double-Insurance Error Terminal State**: Both `runner.mjs` and `workflow.py` initialize `finalStatus = "error"` (`exitReason = "unhandled_exception"`), never `"done"`, guaranteeing that an unexpected crash cannot mislabel a failed run as `"done"`.
- **3-Error Circuit Breaker & Delay Clamping**: Missing/unparseable worker contracts increment `consecutive_errors`; 3 consecutive failures (`--max-errors 3`) mark `circuit_broken`, clear schedules, and halt. Dynamic `NEXT_DELAY_SEC` falls back to `120s` and clamps to `[10s, 86400s]`.

---

## 🤖 Headless CLI Runner

**(`agy-loop run` · `resume` · `nudge` · `wake` · `ps` · `logs` · `stop` · `statusline`)**

Run non-interactive loops from terminals, SSH sessions, cron jobs, or CI/CD pipelines using `Node.js >= 18` with **zero external npm dependencies** (`npx agy-loop run ...` or global `agy-loop run ...`). Headless runs share `.agents/loop.md` hot-reload and `<workspace>/.agents/.agy-loop/` state seamlessly with interactive `/agy-loop:loop`, inherit your local `agy` permission mode by default (`auto` in `v1.5.7+` unless `--mode`, `--sandbox`, or `--dangerously-skip-permissions` is specified), and enforce strict schema validation, model/fallback/two-stage verifier routing, hard token/duration budgets, live `nudge`/`wake` steering, checkpointed `resume`, and clean exit codes.

### Quick Examples

```bash
# 1. Single-shot check (immediate or delayed with `in <delay>`)
agy-loop run --once "Inspect git status and summarize any failing tests"
agy-loop run in 20m "Verify staging smoke tests and report status"

# 2. Adaptive CI loop with Gemini 4 model, effort, fallback & two-stage verification
agy-loop run "Check PR CI status and fix failing checks" \
  --model gemini-4-hydrogen-xhigh \
  --effort high \
  --fallback-model gemini-4-carbon-high \
  --verify-cmd "npm test" \
  --verifier-model gemini-4-neon-xhigh

# 3. Persistent stream-json session (`--stateful`) with periodic context rotation (`--reset-every 6`)
agy-loop run 2m "Run unit tests and fix failures until green" --stateful --reset-every 6

# 4. Isolated Git branch/worktree execution (auto-cleaned if 0 commits & clean; preserved with merge hints if modified)
agy-loop run "Refactor flaky auth tests and commit verified fixes" --worktree

# 5. Zero-token shell preflight (`--probe` + `--probe-until-pass`)
agy-loop run 30s "Fix remaining TypeScript errors" --probe "npm test" --probe-until-pass

# 6. Steer or wake a running workflow/headless loop without killing it, or resume an interrupted run
agy-loop nudge latest "Focus on tests/auth.test.mjs first" --wake
agy-loop wake latest
agy-loop resume latest --max 30 --max-tokens 400000
```

### Headless Runner Options (`agy-loop run`)

Supports the same interval grammar as `/agy-loop:loop` (`30s`, `1h30m`, `every 5m`, `in 20m`, trailing `every 2h`, or omit prompt to live-reload `.agents/loop.md`), plus:

| Category | Key Options | Behavior & Defaults |
|:--- |:--- |:--- |
| **Transport & Rotation** | `--fresh` (default), `--stateful`, `--reset-every <N>` | `fresh` spawns `agy --output-format json` per pass; `--stateful` reuses a persistent `stream-json` process (rotating every `N` turns when `--reset-every` is set). |
| **Budgets & Retries** | `--max <N>` (`20`), `--once`, `--max-duration <dur>`, `--max-tokens <N>`, `--max-retries <N>` (`3`), `--max-errors <N>` (`3`), `--turn-timeout <dur>` (`10m`) | Enforces hard iteration, wall-clock, and cumulative token budgets; retries `print_timeout` / transient `429` errors with jittered backoff (`30s -> 60s -> 120s`); trips circuit breaker on consecutive schema/runtime errors. |
| **Model & Two-Stage Gate** | `--model <slug\|label>`, `--effort <low\|medium\|high\|xhigh\|max>`, `--fallback-model <slug\|label>`, `--verify-cmd <cmd>`, `--verify-timeout <dur>` (`60s`), `--verifier-model <slug\|label>` | Resolves model slugs/labels via `agy --output-format json models` (omitting `--effort` for `Orchestrator` models), switches to `--fallback-model` on quota/capacity errors, runs 0-token Stage 1 `--verify-cmd`, and invokes Stage 2 read-only `--verifier-model` (with sticky budget protection) before accepting `DONE`. |
| **Permissions & Isolation** | `--mode <auto\|accept-edits\|plan>`, `--sandbox`, `--dangerously-skip-permissions`, `--allow-slash-commands`, `--settings <json\|path>`, `--add-dir <dir>`, `--worktree`, `--keep-worktree`, `--fail-on-denied` | Inherits local `agy` mode unless overridden; disables slash expansion unless `--allow-slash-commands` is passed; isolates edits in `<state>/worktrees/<loop_id>` (`agy-loop/<loop_id>`); treats soft-denied tool calls (`denied_actions[]`) as `BLOCKED` (exit `3`) under `--fail-on-denied`. |
| **Preflight & Output** | `--probe <cmd>`, `--probe-timeout <dur>` (`60s`), `--probe-until-pass`, `--cwd <dir>`, `--json`, `--quiet`, `--` | Runs bounded shell `--probe` before each pass (injecting failure output tail or completing immediately at `0` tokens); emits final JSON summary under `--json`; `--` passes remaining tokens verbatim as prompt text. |

### Live Steering (`nudge` / `wake`) & Checkpoint `resume`

Because interactive `workflow` loops (`run_workflow`) and `headless` loops share `<workspace>/.agents/.agy-loop/loops/<loop_id>/inbox/` and `state.json`:

- **Inject steering without restarting (`nudge`)**:
  - `agy-loop nudge <id|prefix|latest> "<msg>" [--wake] [--cwd <dir>] [--json]` (or `/agy-loop:loop nudge <id|latest> "<msg>" [--wake]`)
  - Without `--wake`: queues instructions in `inbox/` to be claimed cleanly in the next `preIteration` (preserving fixed intervals).
  - With `--wake`: also immediately interrupts inter-iteration sleep; if an iteration is currently running, sets `wakeRequested` so post-turn sleep is skipped.
- **Wake a sleeping loop early (`wake`)**:
  - `agy-loop wake <id|prefix|latest> [--reason "<msg>"] [--cwd <dir>] [--json]` (or `/agy-loop:loop wake <id|latest>`)
  - Interrupts inter-iteration sleep immediately, or marks `wakeRequested` mid-iteration to skip the upcoming sleep window.
- **Checkpoint Recovery (`resume`)**:
  - `agy-loop resume <id|prefix|latest> [--max <N>] [--max-tokens <N>] [--max-duration <dur>] [--model <slug|label>] [--settings <json|path>] [--cwd <dir>] [--json] [--quiet]`
  - Resumes eligible `headless` loops in `stopped`, `max_reached`, `blocked`, `circuit_broken`, `error`, or `[stale]` dead-PID `running` state (rejects `done` or non-headless loops with Exit `2`, and live running PIDs with Exit `1`).
  - Automatically reconciles any orphan `in_flight_iteration` (`iteration_end` with `outcome: "interrupted"`), verifies and reattaches existing `--worktree` checkouts (failing fast with Exit `2` if deleted), restores `--stateful` `conversation_id`, cumulative `usage_totals`, `next_hint`, and `active_model`, clears prior stop signals, and logs a `resume` event.
  - **Explicit Budget Extension Guard**: When resuming a `max_reached` loop, you must pass a strictly higher `--max <N>`, `--max-tokens <N>`, or `--max-duration <dur>` matching the exhausted limit (otherwise `resume` exits `2` to prevent silent budget overrun). Session-only `--settings` arguments are never persisted into `run_config_snapshot`.

### Observability & Lifecycle Commands

> **Backward compatibility:** `agy-loop status` remains an alias for `agy-loop doctor` (diagnostics). Use **`agy-loop ps`** (or `list`) to inspect running and historical loops.

```bash
# List active loops in the current workspace (`--all` includes finished loops; `--global` queries locked cross-workspace index; `[stale]` flags dead headless/workflow PIDs)
agy-loop ps [--all] [--global] [--json]

# Inspect or tail structured iteration events (`iteration_start`, `iteration_end`, `inbox_claim`, `verify_cmd`, `verifier`, `resume`, token telemetry)
agy-loop logs [id|latest] [-f] [-n N] [--json]

# Stop one loop, matching prefix, or all active loops (writes control.json + inbox/stop, reconciles stale PIDs, sends SIGTERM to live headless PIDs, or drains --after-current)
agy-loop stop <id|prefix|all> [--after-current]

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

### Headless Exit Codes (`agy-loop run` & `agy-loop resume`)

| Exit Code | Outcome | Meaning |
|:--- |:--- |:--- |
| **`0`** | `DONE` / `--once` / `--probe-until-pass` | Objective completed with `DONE`, `--probe-until-pass` exited `0` (0 tokens), or a single `--once` pass finished cleanly (`DONE` or `CONTINUE`). |
| **`1`** | `error` / `circuit_broken` | Unhandled runtime error (never mislabeled `done`), missing `agy`, `agy` Exit `1`, `verifier_error` at `--max`/`--once`, consecutive errors hitting `--max-errors` (`3`), or `resume` targeting a live PID. |
| **`2`** | Usage / Config Error | Invalid CLI flags, conflicting options (`--stateful` + `--fresh`), invalid duration/budget, unrecognized model, `resume` on `done`/missing worktree/unextended `max_reached`, or `agy` config error (Exit `2`). |
| **`3`** | `BLOCKED` | Worker reported `BLOCKED`, non-retryable quota/spend-cap error hit, Stage 1 `--verify-cmd` (`verify_cmd_failed`) or Stage 2 `--verifier-model` (`verifier_rejected`) rejected at `--max`/`--once`, or `--fail-on-denied` triggered. |
| **`4`** | `max_reached` | Multi-iteration loop exhausted `--max`, `--max-duration`, or `--max-tokens` (including sticky budget guard preventing verifier overspend) before reaching `DONE`. |
| **`130`** | `stopped` | Interrupted via `SIGINT`/`SIGTERM` or terminated via `agy-loop stop`. |

---

## 🔄 `.agents/loop.md` Hot-Reload Guide

When you run bare `/agy-loop:loop` or interval-only `/agy-loop:loop 15m` (without an inline prompt), `agy-loop` resolves instructions on **every wake-up** (up to `25,000` bytes) in strict priority order:

1. **`.agents/loop.md`** in the current workspace (project-scoped team or repo loop policy)
2. **`loop.md`** in the workspace root
3. **`~/.gemini/config/loop.md`** (personal global maintenance defaults across repositories)
4. **Built-in branch maintenance fallback**: checks uncommitted/unfinished repo work and incremental tests, inspects open PR review comments and CI status via `gh` when available, and reports a single green status line if clean.

Because resolution runs dynamically on every tick (`resolve-task` / `resolveLoopMdTask` / `resolve_loop_md_task`), you can edit `.agents/loop.md` while a loop is parked in the background and the updated instructions take effect on the very next wake-up without restarting `/agy-loop:loop`.

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
   Run `/agy-loop:loop stop` (or `/agy-loop:loop stop <id1> <id2>`, `/agy-loop:loop stop <id> --after-current`, `/agy-loop:loop cancel`) to dual-write `.agents/.agy-loop/` (`state.json`, `control.json`, and `inbox/` so `schedule`, `workflow`, and `headless` loops react within 1s), cancel linked `schedule` timers/crons via `manage_task(Action="kill")`, and terminate loop subagents via `manage_subagents(Action="kill")` (preserving `branch` worktrees with unmerged commits until reviewed).
2. **Conversational Stop**
   Tell the session in plain language: `"stop the current loop"` (or `"stop the loop after this iteration finishes"`).
3. **Interactive CLI TUI Panels (`/tasks` & `/agents`)**
   - Type **`/tasks`**, highlight the scheduled loop timer or cron job, and press **`k`** to kill future wake-ups (`x` clears completed entries).
   - Type **`/agents`**, highlight a `running` or `idle` `loop-worker`, and press **`k`** to kill it immediately (temporary `--worktree` branches are cleaned up automatically). When a worker requests permission approval, press **`Ctrl+K`** to quick-approve or **`Alt+J`** to teleport into its live transcript (`Esc` returns to main chat).
4. **Foreground Turn Interrupt (`Esc`) & Terminal `agy-loop stop`**
   Press **`Esc`** to interrupt an active foreground dispatch turn immediately without closing `agy` CLI (pressing `Ctrl+C` twice exits the CLI), or run `agy-loop stop <id|all> [--after-current]` from another terminal.

**Automatic Stop Conditions**: Every loop stops and clears any remaining schedule automatically when the worker returns `LOOP_STATUS: DONE` (and passes any configured two-stage verification), returns `LOOP_STATUS: BLOCKED`, hits a hard budget (`--max`, `--max-tokens`, `--max-duration`), or reaches 3 consecutive contract/runtime errors (`circuit_broken`).

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
|:--- |:--- |
| `agy-loop run [interval] [prompt...] [options]` | Run headless loop via `fresh` (`json`) or `--stateful` (`stream-json`) transport with Gemini 4 routing, `--probe`, `--verify-cmd`, `--verifier-model`, `--worktree`, and budget/exit-code controls |
| `agy-loop resume <id\|prefix\|latest> [options]` | Resume an eligible `stopped`, `max_reached`, `blocked`, `circuit_broken`, `error`, or `[stale]` headless loop from checkpoint (`--max`, `--max-tokens`, `--max-duration`, `--model`, `--settings`) |
| `agy-loop nudge <id\|prefix\|latest> "<msg>" [--wake]` | Queue live steering instructions into `inbox/` for active `workflow` or `headless` loops (with optional `--wake` sleep interrupt / `wakeRequested`) |
| `agy-loop wake <id\|prefix\|latest> [--reason <msg>]` | Interrupt inter-iteration sleep immediately (or set `wakeRequested` mid-iteration) for an active `workflow` or `headless` loop |
| `agy-loop ps [--all] [--global] [--json]` | List active (or `--all` / `--global` locked index) loops across interactive, workflow, and headless engines, flagging `[stale]` dead PIDs (`list` alias supported; `status` remains aliased to `doctor`) |
| `agy-loop logs [id\|latest] [-f] [-n N] [--json]` | Inspect or live-follow `events.jsonl` (`iteration_start`, `iteration_end`, `inbox_claim`, `verify_cmd`, `verifier`, `resume`, token telemetry, and soft-denials) |
| `agy-loop stop <id\|prefix\|all\|--all> [--after-current]` | Stop specific or all active loops immediately (`control.json` + `inbox/` + `SIGTERM` for live headless PIDs; reconciles stale `headless`/`workflow` PIDs) or gracefully `--after-current` |
| `agy-loop statusline [--global] [--no-color] [--json]` | Emit a `<5ms` zero-subprocess status summary for `settings.json` `statusLine` integration (silent when 0 live loops) |
| `npx agy-loop [install \| update]` | Install or update `agy-loop` via `agy plugin install` (warns if user-level shadow files exist) |
| `npx agy-loop install --clean-shadow` | Install `agy-loop` and archive loose shadow files into `~/.gemini/config/.agy-loop-backup-<YYYYMMDD-HHMMSSZ>/` |
| `npx agy-loop doctor [--json]` | Run full diagnostics (`agy.capabilities` matrix incl. `dynamicWorkflows`, enterprise `admin_settings.json` / `settings.json` / `hooks.json` audit, `SessionStart` `protojson` `hookSelfTest`, `loop-worker` 6-tool `agentToolsCheck`, `loop-verifier` 3-tool read-only `verifierToolsCheck`, `workflows/loop-runner` `workflowBundleCheck`, shadows, ERE `skills.json` filters, `loop.md`, `activeLoops`, and `15s`/`30s` `spawnSync` timeout protection; `status` alias preserved) |
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

See [**ARCHITECTURE.md**](ARCHITECTURE.md) for full details on the Three-Turn Reactive Lifecycle, the v1.3 Dynamic Workflow Engine (`workflows/loop-runner/`), the Unified Cross-Engine Single-Iteration State Machine (`IterationSnapshot`, `inbox/`, two-stage `turn-stopping` gate, sticky budgets, `finally` double-insurance), the dual-engine tool split (`loop-worker` vs `loop-verifier`), and the Headless Dual-Transport Architecture + `resume`.

```bash
sh -n install.sh uninstall.sh skills/loop/scripts/loop-helper.sh  # Check POSIX shell syntax
node --check bin/agy-loop.mjs lib/*.mjs                           # Check Node >= 18 ESM syntax
python3 -m json.tool workflows/loop-runner/workflow.json >/dev/null # Check workflow.json schema
python3 -c 'import ast,pathlib; compile(ast.parse(pathlib.Path("workflows/loop-runner/workflow.py").read_text()),"workflow.py","exec",flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)' # Check top-level-await Python syntax
npm test                                                          # Run unit, workflow & headless integration tests
agy plugin validate --strict .                                    # Strict Antigravity v1 plugin check (0 findings)
```

---

## 📄 License

Distributed under the [**MIT License**](LICENSE). Copyright © Max.

[← Back to README](../README.md) · [简体中文 README](../README.zh-CN.md) · [Architecture](../ARCHITECTURE.md)

# Headless CLI Runner, Steering, Resume & Exit Codes

Run non-interactive loops from terminals, SSH sessions, cron jobs, OS services, or CI/CD pipelines using `Node.js >= 18` with **zero external npm dependencies** (`npx agy-loop run ...`, global `agy-loop run ...`, or `Bun`). Headless runs share `.agents/loop.md` / `.agents/loops/*.md` resolution, `<workspace>/.agents/.agy-loop/` state, and Four-Gate Lease Locks seamlessly with interactive `/agy-loop:loop`, inherit your local `agy` permission mode by default (`auto` in `v1.5.7+` unless `--mode`, `--sandbox`, or `--dangerously-skip-permissions` is specified), and enforce strict schema validation, `--trust-profile-commands` RCE protection, model/fallback/two-stage verifier routing, hard token/duration budgets, live `nudge`/`wake` steering, checkpointed `resume`, and deterministic exit codes.

---

## CLI Subcommands

| Command | Description |
| :--- | :--- |
| `agy-loop run [interval] [prompt...] [options]` | Run headless loop via `fresh` (`json`) or `--stateful` (`stream-json`) transport with `--profile`/`--file`, `--singleton`/`--on-conflict`/`--relay-on-wake`, `--trust-profile-commands`, Gemini 4 routing, `--probe`, `--verify-cmd`, `--verifier-model`, `--worktree`, and Exit `0/1/2/3/4/5/130` controls |
| `agy-loop resume <id\|prefix\|latest> [options]` | Resume an eligible `stopped`, `max_reached`, `blocked`, `circuit_broken`, `error`, or `[stale]` headless loop from checkpoint, restoring profile metadata & re-acquiring the lease lock (`--max`, `--max-tokens`, `--max-duration`, `--model`, `--settings`) |
| `agy-loop profiles [--cwd <dir>] [--json]` | Discover and validate default `loop.md`, `.agents/loops/*.md`, and `~/.gemini/config/loops/*.md` profiles (schedule, model, singleton, and frontmatter error summary) |
| `agy-loop daemon <install\|list\|status\|remove\|logs>` | Install, inspect, tail logs, or remove cross-reboot persistent daemons (`--mode sidecar` `CRON_TZ` + `agentapi`, or `--mode os` macOS `LaunchAgent` / Linux `systemd --user`) |
| `agy-loop status [--global] [--cwd <dir>] [--clean-shadow] [--json]` | Unified Option A runtime overview: active loops + managed daemons + active lease locks + concise health summary (`--json` keeps top-level `ok`) |
| `agy-loop nudge <id\|prefix\|latest> "<msg>" [--wake]` | Queue live steering instructions into `inbox/` for active `workflow` or `headless` loops (with optional `--wake` sleep interrupt / `wakeRequested` relay) |
| `agy-loop wake <id\|prefix\|latest> [--reason <msg>]` | Interrupt inter-iteration sleep immediately (or set `wakeRequested` mid-iteration / relay at `DONE`) for an active `workflow` or `headless` loop |
| `agy-loop ps [--all] [--global] [--json]` | List active (or `--all` / `--global` locked index) loops across interactive, workflow, and headless engines, flagging `[stale]` dead PIDs (`list` alias supported) |
| `agy-loop logs [id\|latest] [-f] [-n N] [--json]` | Inspect or live-follow `events.jsonl` (`iteration_start`, `iteration_end`, `inbox_claim`, `verify_cmd`, `verifier`, `relay`, `resume`, token telemetry, and soft-denials) |
| `agy-loop stop <id\|prefix\|all\|--all> [--after-current]` | Stop specific or all active loops immediately (`control.json` + `inbox/` + `SIGTERM` for live headless PIDs; reconciles stale `headless`/`workflow` PIDs) or gracefully `--after-current` |
| `agy-loop statusline [--global] [--no-color] [--json]` | Emit a `<5ms` zero-subprocess status summary for `settings.json` `statusLine` integration (silent when 0 live loops) |
| `npx agy-loop [install \| update]` | Install or update `agy-loop` via `agy plugin install` (warns if user-level shadow files exist) |
| `npx agy-loop install --clean-shadow` | Install `agy-loop` and archive loose shadow files into `~/.gemini/config/.agy-loop-backup-<YYYYMMDD-HHMMSSZ>/` |
| `npx agy-loop doctor [--clean-shadow] [--json]` | Run deep diagnostics: `agy.capabilities` matrix, enterprise `admin_settings.json` / `settings.json` / `hooks.json` audit, `SessionStart` `protojson` `hookSelfTest`, `loop-worker` 6-tool `agentToolsCheck`, `loop-verifier` 3-tool read-only `verifierToolsCheck`, `workflows/loop-runner` `workflowBundleCheck`, shadows, ERE `skills.json` filters, `loop.md`, `activeLoops`, plus v2.0 `profiles`, `activeLocks`, and `daemons` summaries |
| `npx agy-loop validate [--remote [ref]] [--json]` | Run `agy plugin validate --strict` locally or against `https://github.com/maxlee/agy-loop/tree/<ref>` (default `v<version>`, no trailing `/.`) |
| `npx agy-loop uninstall` | Cleanly remove the plugin via `agy plugin uninstall agy-loop` (`remove` alias supported) |

---

## Headless Run Examples

```bash
# 1. Discover and run a named profile (with explicit trust if frontmatter defines probe_cmd/verify_cmd)
agy-loop profiles
agy-loop run --profile ci --trust-profile-commands

# 2. Enforce single-instance coalescing (wakes active holder and exits 0 without orphan dirs)
agy-loop run --profile ci --singleton profile --on-conflict wake --relay-on-wake

# 3. Single-shot check (immediate or delayed with `in <delay>`)
agy-loop run --once "Inspect git status and summarize any failing tests"
agy-loop run in 20m "Verify staging smoke tests and report status"

# 4. Adaptive CI loop with Gemini 4 model, effort, fallback & two-stage verification
agy-loop run "Check PR CI status and fix failing checks" \
  --model gemini-4-hydrogen-xhigh \
  --effort high \
  --fallback-model gemini-4-carbon-high \
  --verify-cmd "npm test" \
  --verifier-model gemini-4-neon-xhigh

# 5. Persistent stream-json session (`--stateful`) with periodic context rotation (`--reset-every 6`)
agy-loop run 2m "Run unit tests and fix failures until green" --stateful --reset-every 6

# 6. Isolated Git branch/worktree execution & zero-token shell preflight
agy-loop run "Refactor flaky auth tests and commit verified fixes" --worktree
agy-loop run 30s "Fix remaining TypeScript errors" --probe "npm test" --probe-until-pass

# 7. Steer, wake, or resume an interrupted run
agy-loop nudge latest "Focus on tests/auth.test.mjs first" --wake
agy-loop wake latest
agy-loop resume latest --max 30 --max-tokens 400000
```

---

## Headless Runner Options (agy-loop run)

`agy-loop run` supports the same interval grammar as `/agy-loop:loop` (`30s`, `1h30m`, `every 5m`, `in 20m`, trailing `every 2h`, or omit the prompt to load `.agents/loop.md` or a configured profile; fractional durations like `1.5m` fail fast with Exit `2`), plus:

| Category | Key Options | Behavior & Defaults |
| :--- | :--- | :--- |
| **Profiles & Lease Locks** | `--profile <name>`, `--file <path>`, `--singleton <profile\|workspace\|none>`, `--on-conflict <fail\|wake\|skip>`, `--trust-profile-commands`, `--relay-on-wake` | Resolves named/file profiles (`CLI > Frontmatter > Defaults`), blocks untrusted frontmatter `probe_cmd`/`verify_cmd` (Exit `2`) unless `--trust-profile-commands`, acquires `<stateRoot>/locks/<scope_key>.lock.json` (`profile` default when `--profile`/`--file`, else `none`), and relays on terminal `wake`. |
| **Transport & Rotation** | `--fresh` (default), `--stateful`, `--reset-every <N>` | `fresh` spawns `agy --output-format json` per pass; `--stateful` reuses a persistent `stream-json` process (rotating every `N` turns when `--reset-every` is set). |
| **Budgets & Retries** | `--max <N>` (`20`), `--once`, `--max-duration <dur>`, `--max-tokens <N>`, `--max-retries <N>` (`3`), `--max-errors <N>` (`3`), `--turn-timeout <dur>` (`10m`) | Enforces hard iteration, wall-clock, and cumulative token budgets; retries `print_timeout` / transient `429` errors with jittered backoff (`30s -> 60s -> 120s`); trips circuit breaker on consecutive schema/runtime errors. |
| **Model & Two-Stage Gate** | `--model <slug\|label>`, `--effort <low\|medium\|high\|xhigh\|max>`, `--fallback-model <slug\|label>`, `--verify-cmd <cmd>`, `--verify-timeout <dur>` (`60s`), `--verifier-model <slug\|label>` | Resolves model slugs/labels via `agy --output-format json models` (omitting `--effort` for `Orchestrator` models), switches to `--fallback-model` on quota/capacity errors, runs 0-token Stage 1 `--verify-cmd`, and invokes Stage 2 read-only `--verifier-model` (with sticky budget protection) before accepting `DONE`. |
| **Permissions & Isolation** | `--mode <auto\|accept-edits\|plan>`, `--sandbox`, `--dangerously-skip-permissions`, `--allow-slash-commands`, `--settings <json\|path>`, `--add-dir <dir>`, `--worktree`, `--keep-worktree`, `--fail-on-denied` | Inherits local `agy` mode unless overridden; disables slash expansion unless `--allow-slash-commands` is passed; isolates edits in `<state>/worktrees/<loop_id>` (`agy-loop/<loop_id>`); treats soft-denied tool calls (`denied_actions[]`) as `BLOCKED` (Exit `3`) under `--fail-on-denied`. |
| **Preflight & Output** | `--probe <cmd>`, `--probe-timeout <dur>` (`60s`), `--probe-until-pass`, `--cwd <dir>`, `--json`, `--quiet`, `--` | Runs bounded shell `--probe` before each pass (injecting failure output tail or completing immediately at `0` tokens); emits final JSON summary under `--json`; `--` passes remaining tokens verbatim as prompt text. |

---

## Live Steering (nudge / wake) & Checkpoint Resume

Because interactive `workflow` loops (`run_workflow`) and `headless` loops share `<workspace>/.agents/.agy-loop/loops/<loop_id>/inbox/` and `state.json`, you can steer, wake, or recover loops cleanly without losing progress:

- **Inject steering without restarting (`nudge`)**:
  - `agy-loop nudge <id|prefix|latest> "<msg>" [--wake] [--cwd <dir>] [--json]` (or `/agy-loop:loop nudge <id|latest> "<msg>" [--wake]`)
  - Without `--wake`: queues instructions in `inbox/` to be claimed cleanly in the next `preIteration` (preserving fixed intervals).
  - With `--wake`: also immediately interrupts inter-iteration sleep; if an iteration is currently running, sets `wakeRequested` so post-turn sleep is skipped (and triggers terminal relay on `DONE` if eligible).
- **Wake a sleeping loop early (`wake`)**:
  - `agy-loop wake <id|prefix|latest> [--reason "<msg>"] [--cwd <dir>] [--json]` (or `/agy-loop:loop wake <id|latest>`)
  - Interrupts inter-iteration sleep immediately, or marks `wakeRequested` mid-iteration to skip the upcoming sleep window / relay at completion.
- **Checkpoint Recovery (`resume`)**:
  - `agy-loop resume <id|prefix|latest> [--max <N>] [--max-tokens <N>] [--max-duration <dur>] [--model <slug|label>] [--settings <json|path>] [--cwd <dir>] [--json] [--quiet]`
  - Resumes eligible `headless` loops in `stopped`, `max_reached`, `blocked`, `circuit_broken`, `error`, or `[stale]` dead-PID `running` state (rejects `done` or non-headless loops with Exit `2`, and live running PIDs with Exit `1`).
  - Automatically reconciles any orphan `in_flight_iteration` (`iteration_end` with `outcome: "interrupted"`), verifies and reattaches existing `--worktree` checkouts (failing fast with Exit `2` if deleted), restores `profile_name` / `profile_path`, re-acquires the Four-Gate Lease Lock, restores `--stateful` `conversation_id`, cumulative `usage_totals`, `next_hint`, `relay_count`, and `active_model`, clears prior stop signals, and logs a `resume` event.
  - **Explicit Budget Extension Guard**: When resuming a `max_reached` loop, you must pass a strictly higher `--max <N>`, `--max-tokens <N>`, or `--max-duration <dur>` matching the exhausted limit (otherwise `resume` exits `2` to prevent silent budget overrun).
  - **Session-Only `--settings`**: Arguments passed via `--settings` apply only to the current invocation and are never persisted into `run_config_snapshot`.

---

## Observability & Status Line Integration

> [!NOTE]
> **v2.0.0 Upgrade (`agy-loop status`)**: `agy-loop status` is the **Unified Runtime Overview** (displaying `activeLoops`, managed Sidecar/OS `daemons`, `activeLocks`, and a concise `health` summary; `--json` retains top-level `ok` alongside `activeLoops`, `daemons`, `activeLocks`, and `health`). Use **`agy-loop doctor`** for deep diagnostics and **`agy-loop ps`** (or `list`) for the compact loop table.

```bash
# Unified single-screen runtime overview: active loops + daemons + lease locks + health summary
agy-loop status [--global] [--cwd <dir>] [--clean-shadow] [--json]

# List active loops in the current workspace (`--all` includes finished loops; `--global` queries locked cross-workspace index; `[stale]` flags dead headless/workflow PIDs)
agy-loop ps [--all] [--global] [--json]

# Inspect or tail structured iteration events (`iteration_start`, `iteration_end`, `inbox_claim`, `verify_cmd`, `verifier`, `relay`, `resume`, token telemetry)
agy-loop logs [id|latest] [-f] [-n N] [--json]

# Stop one loop, matching prefix, or all active loops (writes control.json + inbox/stop, reconciles stale PIDs, sends SIGTERM to live headless PIDs, or drains --after-current)
agy-loop stop <id|prefix|all> [--after-current]

# Print a compact <5ms status segment (0 subprocesses; silent when 0 live loops)
agy-loop statusline [--global] [--no-color] [--json]
```

### Embed `agy-loop statusline` in Antigravity CLI (`~/.gemini/antigravity-cli/settings.json`)

```json
{
  "statusLine": {
    "type": "command",
    "command": "agy-loop statusline",
    "stack_with_default": true
  }
}
```

> [!TIP]
> If `agy-loop` is installed only as a plugin without global `npm install -g agy-loop`, set `"command": "node ~/.gemini/config/plugins/agy-loop/bin/agy-loop.mjs statusline"` for `<5ms` zero-`npx` latency. `"stack_with_default": true` renders active loop status beneath Antigravity's built-in status bar.

---

## Exit Codes (agy-loop run & resume)

| Exit Code | Outcome | Meaning |
| :--- | :--- | :--- |
| **`0`** | `DONE` / `--once` / `--probe-until-pass` / `coalesced` / `skipped` | Objective completed with `DONE`, `--probe-until-pass` exited `0` (`0` tokens), `--once` finished cleanly (`DONE` or `CONTINUE`), or singleton `--on-conflict wake\|skip` coalesced/skipped cleanly without spawning a duplicate loop. |
| **`1`** | `error` / `circuit_broken` | Unhandled runtime error (never mislabeled `done`), missing `agy`, `agy` Exit `1`, `verifier_error` at `--max`/`--once`, consecutive errors hitting `--max-errors` (`3`), or `resume` targeting a live PID. |
| **`2`** | Usage / Config / Security Error | Invalid CLI flags, conflicting options (`--stateful` + `--fresh`, `--profile` + `--file`), invalid profile/frontmatter, untrusted frontmatter `probe_cmd`/`verify_cmd` without `--trust-profile-commands`, wildcard `access_grants`, unrecognized model, `resume` on `done`/missing worktree/unextended `max_reached`, or `agy` config error (Exit `2`). |
| **`3`** | `BLOCKED` | Worker reported `BLOCKED`, non-retryable quota/spend-cap error hit, Stage 1 `--verify-cmd` (`verify_cmd_failed`) or Stage 2 `--verifier-model` (`verifier_rejected`) rejected at `--max`/`--once`, or `--fail-on-denied` triggered. |
| **`4`** | `max_reached` | Multi-iteration loop exhausted `--max`, `--max-duration`, or `--max-tokens` (including sticky budget guard preventing verifier overspend) before reaching `DONE`. |
| **`5`** | **`LOCK_CONFLICT`** | Active singleton lease lock is held (`profile` or `workspace` scope) and `--on-conflict fail` (default for manual runs) is in effect. |
| **`130`** | `stopped` | Interrupted via `SIGINT`/`SIGTERM` or terminated via `agy-loop stop`. |

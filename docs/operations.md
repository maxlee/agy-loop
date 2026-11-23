[← Back to README](../README.md) · [简体中文 README](../README.zh-CN.md) · [Architecture](../ARCHITECTURE.md)

# Workflow Engine, Verification Gate, Safety & Operations

Operational reference for the `run_workflow` dynamic orchestrator, parallel `--targets` fault isolation, two-stage `turn-stopping` verification (`--verify-cmd` + read-only `loop-verifier`), cross-engine reliability guarantees, loop termination paths, shadow-file diagnostics, clean uninstall, and local developer verification.

---

## Dynamic Workflow Engine (run_workflow)

### Engine Auto-Routing (`--engine auto|schedule|workflow`)

`skills/loop/scripts/loop-helper.sh parse` automatically picks the optimal execution engine for `/agy-loop:loop`:

- **`schedule` (default for plain `/agy-loop:loop`)**: Used when `--engine schedule` is passed, or when `--engine auto` (default) is used without workflow-only or lease flags. Preserves the 3-Turn Reactive Protocol (`schedule` + `invoke_subagent`), non-`auto` `Ctrl+K` interactive permission prompts, `--cron`/`--exact`/`--daemon`, and compatibility with every `agy` version.
- **`workflow` (`workflows/loop-runner/workflow.py`, `agy >= 1.5.9`)**: Selected automatically when `--engine workflow` OR any workflow-only / lease flag is provided:
  `--verify`, `--verifier-model`, `--verify-cmd`, `--probe`, `--targets`, `--max-tokens`, `--max-duration`, `--reset-every`, `--singleton`, `--on-conflict`.
- **Mutual Exclusions (`Exit 2`)**:
  - `--cron`, `--exact`, and `--daemon` require `--engine schedule` (cannot combine with `--engine workflow`, workflow-only flags, `--singleton`, or `--on-conflict`).
  - Workflow-only flags and lease flags (`--singleton`, `--on-conflict`) cannot combine with `--engine schedule`.
  - `--profile` and `--file` cannot combine with each other or with an inline prompt.
  - `--reset-every` requires `--stateful`; `--probe-until-pass` requires `--probe`.

### Why `run_workflow` Cuts Main-Session Turns by ~95%

Under `schedule`, a 20-iteration loop wakes the main chat on every subagent return and every timer tick (~41 main-chat turns). Under `run_workflow`, `SKILL.md` initializes `<workspace>/.agents/.agy-loop/loops/<loop_id>/`, invokes `run_workflow(ScriptPath=".../workflows/loop-runner/workflow.py", Args=...)`, and yields immediately. All 20 iterations, profile frontmatter defaults, lease-lock checks, probes, retries, two-stage verification, and sleeps execute asynchronously inside `workflow.py`, waking the main session **once** upon completion (**2 main-session turns total, ~95% fewer main-chat turns**).

### `agy < 1.5.9` Graceful Fallback

If `run_workflow` is unavailable (`agy < 1.5.9`), `/agy-loop:loop` cancels the newly initialized state (`state-stop`) and guides the user to:

1. Upgrade Antigravity CLI to `agy >= 1.5.9`, **or**
2. Re-run with `--engine schedule` (for standard intervals/prompts without workflow-only/lease flags), **or**
3. Run `npx agy-loop run ...` in a terminal for headless `--profile`, `--singleton`, `--verify-cmd`, `--verifier-model`, `--probe`, `--max-tokens`, `--max-duration`, and `--reset-every` support.

See [skills/loop/references/workflow-engine.md](../skills/loop/references/workflow-engine.md) for the complete 32-key `workflow.json` `Args` mapping and precedence notes.

---

## Parallel --targets with Fault Isolation

Pass `--targets "pkgA,pkgB,pkgC"` to execute each target concurrently per iteration via `parallel()` in `workflows/loop-runner/workflow.py`:

- Every target coroutine runs inside a per-target `try / except Exception` guard so one failing target records an isolated error without cancelling sibling targets (while hard `BudgetExceeded` exceptions still propagate to stop the workflow safely).
- The aggregator marks `DONE` only when **every** target reports `DONE`.

```text
/agy-loop:loop audit and fix lint warnings --targets "packages/core,packages/cli,packages/ui" --max 4
```

*(Prefer `--worktree`, `--share`, or disjoint directories whenever targets modify files concurrently.)*

---

## Independent Read-Only loop-verifier & Two-Stage Gate

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

> [!WARNING]
> **Security Boundary (Outside-Sandbox `run_workflow`)**: Because `agy`'s `run_workflow` Python runtime executes outside the OS sandbox, `workflows/loop-runner/workflow.py` **only** executes `--probe` (`probe_cmd`) and `--verify-cmd` (`verify_cmd`) values passed explicitly via CLI/workflow `Args` — it **never** executes `probe_cmd` or `verify_cmd` declared inside `.agents/loop.md` or `.agents/loops/*.md` YAML frontmatter, and every subprocess enforces explicit timeouts plus `4096 B` UTF-8-safe output tail capping.

---

## Reliability & Cross-Engine State Consistency

- **Dual-Engine Tool Split (`loop-worker` 6 tools vs `loop-verifier` 3 read-only tools)**:
  - `agents/loop-worker.md` (`model: flash`, `commandExecutionPolicy: sandbox`) pins the 6 tools verified across both Desktop Cortex and `agy v1.5.14` CLI `oneharness` (`view_file`, `write_to_file`, `replace_file_content`, `run_command`, `manage_task`, `search_web`). Legacy Cortex-only tools (`multi_replace_file_content`, `list_dir`, `find_by_name`, `grep_search`) stay excluded so `oneharness` never aborts on unmapped tools.
  - `agents/loop-verifier.md` (`model: pro`, `commandExecutionPolicy: sandbox`) restricts tools strictly to the 3 read-only tools `[view_file, run_command, search_web]`, physically removing write tools (`write_to_file`, `replace_file_content`) and scheduling tools (`manage_task`, `schedule`, `invoke_subagent`).
- **Sandbox-Safe Unified State, Lease Locks & Locked Global Registries (`.agents/.agy-loop/`)**:
  - Because `agy v1.5.7+` `auto` mode blocks sandboxed `run_command` writes to `~/.gemini/antigravity-cli/plugin_data/`, per-loop `state.json`, `events.jsonl`, `control.json`, `inbox/`, and single-instance lease locks (`locks/<scope_key>.lock.json`) live under `<workspace>/.agents/.agy-loop/` (override via `AGY_LOOP_STATE_DIR`) with an auto-created `.gitignore` (`*`).
  - Cross-workspace upserts into `~/.gemini/antigravity-cli/plugin_data/agy-loop/index.json` (200-entry cap) and `daemons.json` are serialized by atomic `O_EXCL` locks (`withFileLock` / `with_file_lock`) with dead-PID (`isPidAlive`) and `10s` stale TTL reclamation.
- **Single-Iteration Consistency, Relay & Crash Safety**:
  - **Atomic `inbox/` + `inbox/claimed/` Queue**: `nudge`, `wake` (including `singleton_coalesced` + `source_pid`), and `stop` write via temp file + atomic rename into `inbox/`, and `preIteration` claims them synchronously via atomic rename into `inbox/claimed/` (at-most-once delivery, zero write-write races).
  - **Frozen `IterationSnapshot`**: `preIteration` captures `taskPrompt` (frontmatter stripped, 25k-byte body-only cap), `nextHint`, `probeOutput`, `nudges`, and a 12-char SHA-256 `snapshotHash` into an immutable snapshot (`Object.freeze` in Node / `MappingProxyType` in Python), anchoring worker retries and Stage 2 verification even if `loop.md` or profile Markdown changes mid-iteration.
  - **Paired `iteration_start` / `iteration_end` Checkpointing**: `state.json` records `in_flight_iteration` + `in_flight_snapshot_hash` before execution, and a per-iteration `finally` unconditionally clears `in_flight_iteration` and emits `iteration_end` (`outcome`, `duration_ms`, `usage_delta`).
  - **Gate 4 Terminal `wakeRequested` Relay**: Loops holding a lease lock or `--relay-on-wake` check `inbox/` on `DONE` (while marking `draining` safely) and relay into another pass instead of dropping concurrent triggers at exit.
  - **`finally` Double-Insurance Error Terminal State**: Both `runner.mjs` and `workflow.py` initialize `finalStatus = "error"` (`exitReason = "unhandled_exception"`), never `"done"`, guaranteeing that an unexpected crash cannot mislabel a failed run as `"done"`.
- **3-Error Circuit Breaker & Delay Clamping**: Missing/unparseable worker contracts increment `consecutive_errors`; 3 consecutive failures (`--max-errors 3`) mark `circuit_broken`, clear schedules, and halt. Dynamic `NEXT_DELAY_SEC` falls back to `120s` and clamps to `[10s, 86400s]`.

---

## How to Exit or Stop a Loop

You can stop an active loop at any time through four clean paths, in addition to built-in automatic exit conditions:

1. **Slash Command (`/agy-loop:loop stop`)**
   Run `/agy-loop:loop stop` (or `/agy-loop:loop stop <id1> <id2>`, `/agy-loop:loop stop <id> --after-current`, `/agy-loop:loop cancel`) to dual-write `.agents/.agy-loop/` (`state.json`, `control.json`, and `inbox/` so `schedule`, `workflow`, and `headless` loops react within 1s), cancel linked `schedule` timers/crons via `manage_task(Action="kill")`, and terminate loop subagents via `manage_subagents(Action="kill")` (preserving `branch` worktrees with unmerged commits until reviewed).
2. **Conversational Stop**
   Tell the session in plain language: `"stop the current loop"` (or `"stop the loop after this iteration finishes"`).
3. **Interactive CLI TUI Panels (`/tasks` & `/agents`)**
   - Type **`/tasks`**, highlight the scheduled loop timer or cron job, and press **`k`** to kill future wake-ups (`x` clears completed entries).
   - Type **`/agents`**, highlight a `running` or `idle` `loop-worker`, and press **`k`** to kill it immediately (temporary `--worktree` branches are cleaned up automatically). When a worker requests permission approval, press **`Ctrl+K`** to quick-approve or **`Alt+J`** to teleport into its live transcript (`Esc` returns to main chat).
4. **Foreground Turn Interrupt (`Esc`), Terminal `agy-loop stop`, & Persistent Daemons**
   Press **`Esc`** to interrupt an active foreground dispatch turn immediately without closing `agy` CLI (pressing `Ctrl+C` twice exits the CLI), or run `agy-loop stop <id|all> [--after-current]` from another terminal. To stop recurring cross-reboot schedules, run `agy-loop daemon remove <slug|--all>` for OS services or disable/delete Sidecar entries in `sidecar://dashboard`.

**Automatic Stop Conditions**: Every loop stops and clears any remaining schedule automatically when the worker returns `LOOP_STATUS: DONE` (and passes any configured two-stage verification), returns `LOOP_STATUS: BLOCKED`, hits a hard budget (`--max`, `--max-tokens`, `--max-duration`), or reaches 3 consecutive contract/runtime errors (`circuit_broken`).

---

## Diagnostics, Shadow-File Troubleshooting & Uninstall

### Troubleshooting: Pre-Existing Shadow Files (`~/.gemini/config/`)

Antigravity loads user-level customizations in `~/.gemini/config/` ahead of installed plugins (`~/.gemini/config/plugins/agy-loop/`). When you install via `agy plugin install https://github.com/maxlee/agy-loop`, Antigravity stages the plugin without deleting pre-existing loose `~/.gemini/config/skills/loop/SKILL.md` or `~/.gemini/config/agents/loop-worker.md`, which otherwise override the un-namespaced `loop-worker` subagent (even when invoking `/agy-loop:loop`) and intercept `/loop`.

To prevent silent precedence collisions:

- **Zero-Overhead `SessionStart` Auto-Detector (`hooks.json`)**: Runs `skills/loop/scripts/loop-helper.sh session-start` on session start. Strictly `protojson`-compliant for `agy v1.5.13+` (verified on `v1.5.14`, zero leaked stdin keys): returns `{}` in `<5ms` at **`0` token cost** when clean, and surfaces startup alerts when loose shadow files **or** `skills.json` `include_only`/`exclude` filters block `/agy-loop:loop` (matched with POSIX ERE parity).
- **One-Command Non-Destructive Cleanup**: Archive colliding loose files into `~/.gemini/config/.agy-loop-backup-<YYYYMMDD-HHMMSSZ>/` (unified UTC timestamp across `agy-loop.mjs`, `loop-helper.sh`, and `install.sh`; then run `/skills reload` in any open `agy` session):
  - **POSIX shell (zero Node/npm required)**: `sh ~/.gemini/config/plugins/agy-loop/install.sh --clean-shadow`
  - **Inside `agy` (works right away via plugin prefix)**: `/agy-loop:loop doctor --clean-shadow`
  - **Via npm CLI bridge**: `npx agy-loop doctor --clean-shadow`

```bash
# Unified status overview (active loops, daemons, lease locks, health):
npx agy-loop status

# Deep diagnostic report & remote GitHub tag validation:
npx agy-loop doctor --json
npx agy-loop validate --remote v2.0.0 --json

# Archive pre-existing loose shadow files non-destructively:
npx agy-loop doctor --clean-shadow
```

### Clean Uninstall

Remove `agy-loop` completely with a single command (first run `agy-loop daemon remove --all --global` if you installed persistent daemons):

```bash
# Via npm bridge:
npx agy-loop uninstall

# Via native Antigravity CLI:
agy plugin uninstall agy-loop

# Via one-line or local POSIX uninstaller:
curl -fsSL https://raw.githubusercontent.com/maxlee/agy-loop/main/uninstall.sh | sh
./uninstall.sh
```

---

## Local Development & Verification

See [**ARCHITECTURE.md**](../ARCHITECTURE.md) for full details on the Three-Turn Reactive Lifecycle, the v2.0 Multi-Profile YAML Frontmatter Pipeline & `--trust-profile-commands` RCE boundary, the Four-Gate Lease Lock (`wakeRequested` relay), the Sidecar & OS Service Daemon Manager, the Dynamic Workflow Engine (`workflows/loop-runner/`), the Unified Cross-Engine Single-Iteration State Machine (`IterationSnapshot`, `inbox/`, two-stage `turn-stopping` gate, sticky budgets, `finally` double-insurance), and the Headless Dual-Transport Architecture + `resume`.

```bash
sh -n install.sh uninstall.sh skills/loop/scripts/loop-helper.sh  # Check POSIX shell syntax
node --check bin/agy-loop.mjs lib/*.mjs                           # Check Node >= 18 ESM syntax
python3 -m json.tool workflows/loop-runner/workflow.json >/dev/null # Check workflow.json schema
python3 -c 'import ast,pathlib; compile(pathlib.Path("workflows/loop-runner/workflow.py").read_text(),"workflow.py","exec",flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)' # Check top-level-await Python syntax
npm test                                                          # Run unit, workflow, headless & v2 integration tests
agy plugin validate --strict .                                    # Strict Antigravity v1 plugin check (0 findings)
```

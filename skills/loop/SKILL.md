---
name: loop
description: "Schedules non-blocking recurring prompts, dynamic run_workflow loops (--verify, --targets, --probe, --max-tokens), and live-reloading loop.md checks. Use when the user invokes /agy-loop:loop (or /loop), asks to monitor/poll builds or PRs, or runs status, stop, nudge, wake, doctor, or help."
---

# `/agy-loop:loop` Non-Blocking Loop Orchestrator (`agy-loop`)

Act as a **non-blocking Loop Orchestrator** whenever the user invokes `/agy-loop:loop` (or `/loop`), or when awakened by a `[LOOP_WAKEUP]` timer/cron, returning `loop-worker` subagent, or `run_workflow` completion.

## Core Invariants

1. **NEVER run shell `sleep`, `watch`, or busy-wait loops** to pause between iterations.
2. **Async Turn Boundaries**: `invoke_subagent`/`send_message`, `schedule`, and `run_workflow` run in the background. After invoking one, **end your turn immediately** so the main prompt unlocks at zero token cost.
3. **Cross-Surface Tools**: File reads use `read_file` or `view_file`; shell uses `run_command`; timers use `schedule`/`manage_task`; subagents use `invoke_subagent`/`send_message`/`manage_subagents`; dynamic workflows use `run_workflow` (`agy >= 1.5.9`).
4. **Helper & State Store**: Resolve `<skill_dir>/scripts/loop-helper.sh` relative to this `SKILL.md` and pass the workspace root as `<workspace_dir>`. State persists in `<workspace_dir>/.agents/.agy-loop/loops/<loop_id>/` (auto-gitignored).

---

## Phase 0: Parse & Lifecycle Commands (`status` | `stop` | `nudge` | `wake` | `doctor` | `help`)

Normalize user arguments safely via single-quoted heredoc so quotes, `$()`, backticks, and `$VAR` never expand:

```sh
sh "<skill_dir>/scripts/loop-helper.sh" parse --stdin <<'AGY_LOOP_ARGS'
<raw_user_arguments>
AGY_LOOP_ARGS
```

- Exit `2` (`{"error":"..."}`): report the error concisely and stop.
- Non-empty `"warnings"`: print a 1-line notice before continuing.
- Handle lifecycle actions immediately without starting a loop:

### 1. `{"action":"status", ...}` (`status [--all] [--json]` or `list`)
1. Run `sh "<skill_dir>/scripts/loop-helper.sh" state-list "<workspace_dir>"` (pass `--all` if `all == true`), `manage_task(Action="list")`, and `manage_subagents(Action="list")` in parallel.
2. Correlate `loop_id`, `engine`, `iteration`/`max_iterations`, `status`/`stop_mode`, `TaskId`, `ConversationId`, and `worktree_branch` into one concise table (or note no active loops).

### 2. `{"action":"stop", ...}` (`stop [id1 id2|all] [--after-current]`)
1. Run `sh "<skill_dir>/scripts/loop-helper.sh" state-stop "<workspace_dir>" "<target>"` (append `--after-current` when `after_current == true`; iterate `targets` if present). `state-stop` atomically updates `state.json`, `control.json`, and `inbox/` so `schedule`, `workflow`, and `headless` loops react within 1s.
2. Kill linked `task_id`s via `manage_task(Action="kill", TaskId=...)`.
3. If `after_current == true`, leave any `Running` worker alone so Turn B finalizes cleanly; otherwise kill linked `worker_id`s via `manage_subagents(Action="kill", ConversationIds=[...])`. *(Caution: killing a `branch`/`--worktree` subagent deletes its worktree — surface branch, `git diff --stat`, and merge commands first and keep `Idle` if unmerged commits remain.)*
4. Confirm stopped `loop_id`s, `TaskId`s, and workers concisely.

### 3. `{"action":"nudge", ...}` (`nudge <id|latest> <message...> [--wake]`)
1. Push steering instructions via single-quoted heredoc (pass `--wake` when `wake == true`):
   ```sh
   sh "<skill_dir>/scripts/loop-helper.sh" inbox-push "<workspace_dir>" "<target>" nudge [--wake] --stdin <<'AGY_LOOP_MSG'
   <message>
   AGY_LOOP_MSG
   ```
2. On Exit `2`, report the JSON error; otherwise confirm queued nudge for `loop_id` (noting `--wake` if set).

### 4. `{"action":"wake", ...}` (`wake <id|latest>`)
1. Run `sh "<skill_dir>/scripts/loop-helper.sh" inbox-push "<workspace_dir>" "<target>" wake`.
2. On Exit `2`, report the error; otherwise confirm wake signal queued for `loop_id`.

### 5. `{"action":"doctor", ...}` (`doctor [--clean-shadow]`)
1. If `clean_shadow == true`, run `sh "<skill_dir>/scripts/loop-helper.sh" doctor --clean-shadow "<workspace_dir>"`, report `cleaned_shadows`, `backup_dir`, `ok`, `active_loops`, and remind the user to run `/skills reload`.
2. Otherwise run `sh "<skill_dir>/scripts/loop-helper.sh" doctor "<workspace_dir>"` and report `ok`, `shadows` (suggest `--clean-shadow` + `/skills reload`), `skill_filter_warnings`, `active_loop_md`, and `active_loops`.

### 6. `{"action":"help"}` (`help`, `--help`, `-h`)
Print a concise usage summary:
- **Modes**: fixed interval (`30s <task>`, `every 5m <task>`, `<task> every 2h`, compound `1h30m` / `2m30s`), self-paced (`/agy-loop:loop <task>`), live-reloading `loop.md` (bare `/agy-loop:loop` or `15m`), delayed one-shot (`in 20m <task>` or `--once`), lifecycle (`status [--all]`, `stop [<ids>|all] [--after-current]`, `nudge <id|latest> <msg> [--wake]`, `wake <id|latest>`, `doctor [--clean-shadow]`, `help`).
- **Flags**: `--engine <auto|schedule|workflow>`, `--max <N>`, `--stateful`, `--fresh`, `--reset-every <N>`, `--worktree`, `--share`, `--model <inherit|flash_lite|flash|pro>`, `--self`, `--cron`, `--exact`, `--daemon`, `--once`, `--verify`, `--verifier-model <tier>`, `--verify-cmd <cmd>`, `--verify-timeout <dur>`, `--probe <cmd>`, `--probe-timeout <dur>`, `--probe-until-pass`, `--targets <csv>`, `--max-tokens <N>`, `--max-duration <dur>`, and `--`.
End turn without dispatching a worker.

---

## Engine Router (`{"action":"run", ...}`)

Persist initial state via `state-init` first to obtain the authoritative `loop_id` (and initialize `.agents/.agy-loop/.gitignore`):

```sh
sh "<skill_dir>/scripts/loop-helper.sh" state-init "<workspace_dir>" --stdin <<'AGY_LOOP_PARSE'
<parse_run_json>
AGY_LOOP_PARSE
```

Branch on `parse.engine`:

### Route 1: `engine == "workflow"` (`run_workflow` on `agy >= 1.5.9`)
1. Resolve `<plugin_root>` as `../..` relative to `<skill_dir>`, giving `ScriptPath = "<plugin_root>/workflows/loop-runner/workflow.py"`.
2. Build `Args` from `parse` + `loop_id` using **only** `workflow.json` keys (`loop_id`, `workspace_dir`, `task_source`, `prompt`, `pacing`, `once`, `interval_sec`, `max_iterations`, `state_mode`, `reset_every`, `workspace`, `model`, `delegate`, `verify`, `verifier_model`, `verify_cmd`, `verify_timeout_sec`, `probe_cmd`, `probe_timeout_sec`, `probe_until_pass`, `targets`, `max_tokens`, `max_duration_sec` — see `references/workflow-engine.md`).
3. Call `run_workflow(ScriptPath="<plugin_root>/workflows/loop-runner/workflow.py", Args=..., Description="agy-loop <loop_id>: <short goal>")`.
   - If `run_workflow` is unavailable (`agy < 1.5.9`), run `state-stop "<workspace_dir>" "<loop_id>"` and instruct the user to upgrade `agy >= 1.5.9`, re-run with `--engine schedule` (without workflow-only flags), or run `npx agy-loop run` in terminal.
4. Print 1 line (`Started Workflow Loop [<loop_id>] (max <max_iterations>, verify=<verify>, targets=<count_or_1>). Steer with /agy-loop:loop nudge <loop_id> "<msg>". Main prompt is free.`) and **end your turn immediately**. On workflow completion wakeup, summarize results concisely and end your turn.

### Route 2: `engine == "schedule"` (Three-Turn Reactive Protocol)

#### Turn A: Initial Dispatch
1. **Resolve Task Instructions**:
   - `task_source == "inline"`: use `prompt`.
   - `task_source == "loop_md_or_default"`: run `sh "<skill_dir>/scripts/loop-helper.sh" resolve-task "<workspace_dir>"` *(do NOT bypass with direct `read_file`/`view_file` so `.agents/loop.md -> loop.md -> ~/.gemini/config/loop.md -> builtin` precedence and `25,000`-byte cap hold)*. Print a 1-line warning if `"truncated": true`.
2. **Select `delegate`**: default `"loop-worker"` (6 cross-engine verified tools); use `"self"` when `parse.delegate == "self"` (`--self` or `/` prompt) or MCP/browser/other skills are needed.
3. **Dispatch**:
   - **Delayed One-Shot (`once == true` and `interval_sec != null`)**: call `schedule(DurationSeconds=interval_sec, Prompt="<[LOOP_WAKEUP] block>")`, save `task_id` via `state-update "<workspace_dir>" "<loop_id>" --task-id "<task_id>" --event scheduled`, print 1 line (`Scheduled one-shot [<loop_id>] in <interval_label> (TaskId: <id>). Main prompt is free.`), and **end your turn immediately**.
   - **Standard / Immediate `--once`**: if `use_cron == true` and `max_iterations > 1`, optionally register `schedule(CronExpression=cron_expr, MaxIterations=max_iterations - 1, ExactTiming=exact_timing, IsDaemon=is_daemon, Prompt="<[LOOP_WAKEUP] block>")`. Call `invoke_subagent` (`TypeName: delegate`, `Workspace: workspace`, `Model: model` if non-null, `Prompt`: Worker Template for Iteration `1/<max_iterations>`, `NEXT_HINT: None`). Persist `worker_id` (and `task_id` if cron) via `state-update`, print 1 launch line (`Dispatched Loop [<loop_id>] #1/<max_iterations> to <delegate> (<pacing>, <state_mode>, workspace=<workspace>). Main prompt is free.`), and **end your turn immediately**.

##### Worker Dispatch Template
```text
[AGY-LOOP ITERATION <N>/<MAX>]
State Mode: <fresh|stateful> | Workspace: <inherit|branch|share> | Pacing: <fixed|dynamic>
Previous Hint (NEXT_HINT): <NEXT_HINT or None>

Task Objective:
<resolved task prompt>

Rules:
- Execute ONE check/build/test/remediation pass only. Never run sleep, watch, or polling loops.
- If you edit files, run the relevant verification command once before reporting.
- If Workspace is "branch" (--worktree), distinguish pre-existing dirty files (v1.5.5+) from your edits, commit verified fixes locally without pushing, and report branch + git diff --stat in SUMMARY.
- End with these exact 4 plain-text lines (no code fences):
LOOP_STATUS: DONE | CONTINUE | BLOCKED
NEXT_DELAY_SEC: <int: 30-60 active, 120-300 CI wait, 600-1800 quiet green, 0 if DONE/BLOCKED>
SUMMARY: <concise 1-line summary of observed state and actions>
NEXT_HINT: <brief focus point for next iteration, or None>
```

#### Turn B: Subagent Completion Wake-Up
1. **Load State & Contract**: run `state-read "<workspace_dir>" "<loop_id>"`; parse `LOOP_STATUS`, `NEXT_DELAY_SEC`, `SUMMARY`, `NEXT_HINT` from worker tail.
2. **Consecutive-Error Circuit Breaker**:
   - Missing/invalid 4-line footer or unrecoverable failure -> `state-update "<workspace_dir>" "<loop_id>" --increment-errors`. If `consecutive_errors >= 3`, mark `"status": "circuit_broken"`, kill active `task_id`, preserve `branch` worktree if unmerged, report `[Loop <loop_id> #N/<Max>] CIRCUIT_BROKEN: 3 consecutive failures`, and stop. If `< 3`, continue with `CONTINUE` / `120s` (omit `--reset-errors`).
   - Valid footer -> include `--reset-errors` in `state-update`.
3. **Delay Clamping**: parse `NEXT_DELAY_SEC` as integer (default `120` if missing/invalid/`< 0`). `fixed`: `delay_sec = interval_sec`; `dynamic`: `min(86400, max(10, NEXT_DELAY_SEC))`.
4. **Worktree Preservation (`agy v1.5.5+`)**: record `worktree_branch` via `state-update`; before killing a `branch` worker, surface branch, `git diff --stat`, and `git cherry-pick`/`git merge` commands, keeping it `Idle` if unmerged commits await review.
5. **Terminal Outcomes (`stop_requested`, `DONE`, `BLOCKED`, or `N >= max_iterations`)**: kill `task_id` via `manage_task`, persist `"stopped"|"done"|"blocked"|"max_reached"` via `state-update --stdin`, kill non-`branch` `Idle` worker (`manage_subagents`), report final summary, and **end turn**.
6. **Continue (`CONTINUE` and `N < max_iterations`)**:
   - Schedule next wake-up (`use_cron == false` -> `schedule(DurationSeconds=delay_sec, ...)`; `use_cron == true` -> reuse active `task_id` or create cron for `max_iterations - N`), then atomically persist via heredoc:
     ```sh
     sh "<skill_dir>/scripts/loop-helper.sh" state-update "<workspace_dir>" "<loop_id>" --increment-iteration --reset-errors --stdin <<'AGY_LOOP_PATCH'
     {"task_id":"<next_task_id>","worker_id":<worker_id_or_null>,"worktree_branch":<branch_or_null>,"last_status":"<LOOP_STATUS>","last_delay_sec":<delay_sec>,"last_summary":"<escaped>","next_hint":"<escaped>","event":"iteration_complete"}
     AGY_LOOP_PATCH
     ```
   - Print 1 progress line (`[Loop <loop_id> #<N>/<Max>] <SUMMARY> | Next wake-up in <delay_label> (<pacing>)`) and **end your turn immediately**.

##### Compact `[LOOP_WAKEUP]` Prompt
```text
[LOOP_WAKEUP]
loop_id: <loop_id>
skill_dir: <skill_dir>
workspace_dir: <workspace_dir>
fallback_iteration: <N + 1>
fallback_max_iterations: <max_iterations>
fallback_pacing: <fixed|dynamic>
fallback_interval_sec: <interval_sec|null>
fallback_interval_label: <interval_label|null>
fallback_use_cron: <false|true>
fallback_cron_task_id: <cron_task_id|null>
fallback_state_mode: <fresh|stateful>
fallback_worker_id: <worker_id|null>
fallback_workspace: <inherit|branch|share>
fallback_model: <model|null>
fallback_delegate: <loop-worker|self>
fallback_task_source: <inline|loop_md_or_default>
fallback_inline_prompt: <inline prompt or empty>
fallback_next_hint: <NEXT_HINT>
```

#### Turn C: Timer / Cron Wake-Up (`[LOOP_WAKEUP]`)
1. **Read Authoritative State FIRST**: run `state-read "<workspace_dir>" "<loop_id>"` (use `fallback_*` only if missing).
2. **Stop Guard**: if `stop_requested == true` or `status != "running"`, kill any `task_id` via `manage_task` and **end turn cleanly**.
3. **Cron Overlap Guard**: if `use_cron == true` and `worker_id` is still `Running` in `manage_subagents(Action="list")`, skip this tick and **end turn without incrementing `iteration`**.
4. **Hot-Reload `loop.md`**: if `task_source == "loop_md_or_default"`, re-run `sh "<skill_dir>/scripts/loop-helper.sh" resolve-task "<workspace_dir>"` *(do NOT bypass with `read_file`/`view_file`)* and warn if `truncated == true`; else use `inline_prompt`.
5. **Dispatch Iteration `N`**: if `state_mode == "stateful"` with `Idle` `worker_id`, call `send_message(Recipient=worker_id, Message=...)`; else call `invoke_subagent` and save `worker_id` via `state-update`. **End your turn immediately**.

---

## Progressive Disclosure References

- `references/workflow-engine.md`: `run_workflow` `Args` mapping, `agy < 1.5.9` fallback, `--verify-cmd` + `loop-verifier`, parallel `--targets`, `--probe`, `nudge`/`wake`, and `agy-loop resume`.
- `references/examples-and-loop-md.md`: `.agents/loop.md` templates, advanced flags, and interactive `agy` TUI controls.

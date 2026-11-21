---
name: loop
description: "Schedules non-blocking recurring prompts, CI/PR babysitting, one-shot delayed check-ins, and live-reloading loop.md maintenance loops using native schedule timers and isolated background subagents. Use when the user invokes /agy-loop:loop (or standalone /loop), clicks a Marketplace starter prompt, asks to poll or monitor builds/PRs/deploys on a fixed interval or adaptive backoff, or runs /agy-loop:loop status, stop, doctor, or help."
---

# `/agy-loop:loop` Non-Blocking Subagent Scheduler (`agy-loop`)

Act as a **non-blocking Loop Orchestrator** whenever the user invokes `/agy-loop:loop` (or standalone `/loop`, or when awakened by a `[LOOP_WAKEUP]` timer/cron notification or a returning loop subagent).

## Core Non-Blocking Invariants

1. **NEVER use shell `sleep`, `watch`, or busy-wait loops** to pause between iterations.
2. **Respect Asynchronous Turn Boundaries**: Both `invoke_subagent` (`send_message`) and `schedule` run asynchronously in the background. After calling either primitive, **end your turn immediately** so the session parks at **zero token cost** and the main chat prompt stays unlocked.
3. **Cross-Surface Tool Compatibility**: Across Antigravity CLI (`agy`) and Desktop/IDE, file reads appear as `read_file` or `view_file`; shell commands use `run_command`; schedules use `schedule` and `manage_task`; subagents use `invoke_subagent`, `send_message`, and `manage_subagents`.
4. **Helper & Externalized State**: Resolve `<skill_dir>/scripts/loop-helper.sh` relative to this `SKILL.md` directory and pass the user's workspace root as `<workspace_dir>`. Runtime state persists in sandbox-writable `<workspace_dir>/.agents/.agy-loop/loops/<loop_id>/` (auto-gitignored).

---

## Phase 0: Lifecycle & Diagnostic Subcommands (`status` | `stop` | `doctor` | `help`)

Normalize user arguments safely via `run_command` using a single-quoted heredoc so quotes, `$()`, backticks, and `$VAR` never undergo shell expansion:

```sh
sh "<skill_dir>/scripts/loop-helper.sh" parse --stdin <<'AGY_LOOP_ARGS'
<raw_user_arguments>
AGY_LOOP_ARGS
```

- If `loop-helper.sh` exits `2` (`{"error":"..."}`), report the validation error concisely and stop.
- If `parse` JSON includes a non-empty `"warnings"` array (e.g., unrecognized mid/trailing `--flag` kept in prompt), surface a brief 1-line notice to the user before continuing.
- Handle lifecycle actions immediately without starting a loop:

### 1. `{"action":"status", ...}` (`/agy-loop:loop status [--all] [--json]` or `list`)
1. Run `sh "<skill_dir>/scripts/loop-helper.sh" state-list "<workspace_dir>"` (pass `--all` if `all == true`), `manage_task(Action="list")`, and `manage_subagents(Action="list")` in parallel.
2. Correlate `loop_id`, `iteration`/`max_iterations`, `status`/`stop_mode`, `TaskId`, `ConversationId`, and `worktree_branch` into one concise status table (or note that no loops are active).

### 2. `{"action":"stop", ...}` (`/agy-loop:loop stop [id1 id2|all] [--after-current]`)
1. Run `sh "<skill_dir>/scripts/loop-helper.sh" state-stop "<workspace_dir>" "<target>"` (append `--after-current` when `after_current == true`; iterate each ID in `targets` if `targets` is present) to get exact linked `task_id` and `worker_id` pairs (`stopped[]`). Also check `manage_task(Action="list")` / `manage_subagents(Action="list")` if needed for untracked loops.
2. Kill each linked `task_id` via `manage_task(Action="kill", TaskId=...)`.
3. If `after_current == true` (or user asked to stop after the current pass finishes): leave any `Running` worker alone so Turn B finalizes cleanly when it returns; otherwise kill linked `worker_id`s via `manage_subagents(Action="kill", ConversationIds=[...])`. *(Caution: killing a `branch` / `--worktree` subagent deletes its worktree — surface branch, `git diff --stat`, and merge commands first and keep `Idle` if unmerged commits await review.)*
4. Confirm all stopped `loop_id`s, `TaskId`s, and subagents concisely.

### 3. `{"action":"doctor", ...}` (`/agy-loop:loop doctor [--clean-shadow]`)
1. If `"clean_shadow": true`, run `sh "<skill_dir>/scripts/loop-helper.sh" doctor --clean-shadow "<workspace_dir>"` to archive shadowing `~/.gemini/...` files into `~/.gemini/config/.agy-loop-backup-<UTC>/`. Report `cleaned_shadows`, `backup_dir`, `ok`, `active_loops`, and **remind the user to run `/skills reload`**.
2. Otherwise, run `sh "<skill_dir>/scripts/loop-helper.sh" doctor "<workspace_dir>"` and report `ok`, `shadows` (suggest `--clean-shadow` + `/skills reload` if non-empty), `skill_filter_warnings`, `active_loop_md`, and `active_loops`.

### 4. `{"action":"help"}` (`/agy-loop:loop help`, `--help`, or `-h`)
Print a concise usage summary covering:
- **5 modes**: fixed interval (`30s <task>`, `every 5m <task>`, `<task> every 2h`, compound durations like `1h30m` / `2m30s`), dynamic self-paced (`/agy-loop:loop <task>`), live-reloading `loop.md` (`/agy-loop:loop` or `/agy-loop:loop 15m`), delayed one-shot (`in 20m <task>` or `--once`), and lifecycle (`status [--all]`, `stop [<id1> <id2>|all] [--after-current]`, `doctor [--clean-shadow]`, `help`).
- **Flags**: `--max <N>`, `--stateful`, `--fresh`, `--worktree`, `--share`, `--model <inherit|flash_lite|flash|pro>`, `--self`, `--cron`, `--exact`, `--daemon`, `--once`, and `--` (end of options).
End your turn without dispatching a worker.

---

## Three-Turn Reactive Loop Protocol (`{"action":"run", ...}`)

Every running loop operates across three short, non-blocking reactive turns:
1. **Turn A** — Initial Dispatch Turn (user runs `/agy-loop:loop ...`)
2. **Turn B** — Subagent Completion Wake-Up Turn (worker returns 4-line footer)
3. **Turn C** — Timer / Cron Wake-Up Turn (`schedule` delivers `[LOOP_WAKEUP]`)

### Turn A: Initial Dispatch Turn

1. **Persist Initial Loop State (`state-init`)**:
   Pipe the `parse` `run` JSON via single-quoted heredoc to obtain the authoritative `loop_id` (and initialize `<workspace_dir>/.agents/.agy-loop/.gitignore`):
   ```sh
   sh "<skill_dir>/scripts/loop-helper.sh" state-init "<workspace_dir>" --stdin <<'AGY_LOOP_PARSE'
   <parse_run_json>
   AGY_LOOP_PARSE
   ```
2. **Resolve Initial Task Instructions**:
   - **`task_source == "inline"`**: Use `prompt` directly.
   - **`task_source == "loop_md_or_default"`**: Run:
     ```sh
     sh "<skill_dir>/scripts/loop-helper.sh" resolve-task "<workspace_dir>"
     ```
     *(Always resolve via `resolve-task` — do NOT bypass with direct `read_file`/`view_file` so `.agents/loop.md -> loop.md -> ~/.gemini/config/loop.md -> builtin` precedence and the `25,000`-byte cap are preserved.)* If `"truncated": true`, explicitly print a 1-line warning to the user.
3. **Confirm Subagent Target (`delegate`)**:
   - Keep `delegate: "loop-worker"` by default (lightweight `flash`, `sandbox`, 6 cross-engine verified tools: `view_file`, `write_to_file`, `replace_file_content`, `run_command`, `manage_task`, `search_web`).
   - Use `delegate: "self"` when `parse` set `"delegate": "self"` (`--self` or `/` prompt) or when MCP/browser/other skills unavailable on `loop-worker` are needed.
4. **Branch: Delayed One-Shot vs Immediate Iteration #1**:
   - **Delayed One-Shot (`once == true` and `interval_sec != null`)**:
     - Call `schedule(DurationSeconds=interval_sec, Prompt="<[LOOP_WAKEUP] block>")`.
     - Persist `task_id`: `sh "<skill_dir>/scripts/loop-helper.sh" state-update "<workspace_dir>" "<loop_id>" --task-id "<task_id>" --event scheduled`.
     - Print 1 line (`Scheduled one-shot [<loop_id>] in <interval_label> (TaskId: <id>). Main prompt is free.`) and **end your turn immediately**.
   - **Standard Loop (or immediate `--once`)**:
     - If `use_cron == true` and `max_iterations > 1`, you may register `schedule(CronExpression=cron_expr, MaxIterations=max_iterations - 1, ExactTiming=exact_timing, IsDaemon=is_daemon, Prompt="<[LOOP_WAKEUP] block>")` and capture `cron_task_id` (or register after Iteration #1).
     - Call `invoke_subagent` (`TypeName`: `delegate`, `Workspace`: `workspace`, `Model`: `model` if non-null, `Prompt`: Worker Dispatch Template below for Iteration `1/<max_iterations>`, `NEXT_HINT: None`).
     - Record `worker_id` (and `task_id` if cron registered) in `state.json`:
       ```sh
       sh "<skill_dir>/scripts/loop-helper.sh" state-update "<workspace_dir>" "<loop_id>" --worker-id "<worker_id>" [--task-id "<cron_task_id>"] --event dispatch
       ```
     - Print 1 launch line (`Dispatched Loop [<loop_id>] #1/<max_iterations> to <delegate> (<pacing>, <state_mode>, workspace=<workspace>). Main prompt is free.`) and **end your turn immediately**.

#### Worker Dispatch Template

```text
[AGY-LOOP ITERATION <N>/<MAX>]
State Mode: <fresh|stateful> | Workspace: <inherit|branch|share> | Pacing: <fixed|dynamic>
Previous Hint (NEXT_HINT): <NEXT_HINT or None>

Task Objective:
<resolved task prompt>

Rules:
- Execute ONE check/build/test/remediation pass only. Never run sleep, watch, or polling loops.
- If you edit files, run the relevant verification command once in this turn before reporting.
- If Workspace is "branch" (--worktree), distinguish pre-existing dirty files (inherited in v1.5.5+) from your edits, commit verified fixes locally without pushing, and report branch + git diff --stat in SUMMARY.
- End your message with these exact 4 plain-text lines (no markdown code fences around them):
LOOP_STATUS: DONE | CONTINUE | BLOCKED
NEXT_DELAY_SEC: <integer seconds: 30-60 active, 120-300 CI wait, 600-1800 quiet green, 0 if DONE/BLOCKED>
SUMMARY: <concise 1-line summary of observed state and actions taken>
NEXT_HINT: <brief focus point for next iteration, or None>
```

---

### Turn B: Subagent Completion Wake-Up Turn

When awakened by the subagent's completion message for Iteration `N`:

1. **Read Authoritative State & Extract 4-Line Contract**:
   - Call `sh "<skill_dir>/scripts/loop-helper.sh" state-read "<workspace_dir>" "<loop_id>"` to check `stop_requested`, `consecutive_errors`, `task_id`, `max_iterations`, and `workspace`.
   - Parse `LOOP_STATUS`, `NEXT_DELAY_SEC`, `SUMMARY`, and `NEXT_HINT` from the tail of the worker's response.
2. **Consecutive-Error Circuit Breaker**:
   - **Missing/Invalid 4-Line Footer or Unrecoverable Worker Failure**: Run `sh "<skill_dir>/scripts/loop-helper.sh" state-update "<workspace_dir>" "<loop_id>" --increment-errors`.
     - If updated `consecutive_errors >= 3`: mark `"status": "circuit_broken"` via `state-update`, cancel any active `task_id` schedule (`manage_task(Action="kill", TaskId=...)`), preserve `branch` worktree if needed, report `[Loop <loop_id> #N/<Max>] CIRCUIT_BROKEN: 3 consecutive worker contract/runtime failures` with diagnostic details, and stop.
     - If `consecutive_errors < 3`: continue with fallback `LOOP_STATUS = CONTINUE` and `NEXT_DELAY_SEC = 120` (do NOT pass `--reset-errors`).
   - **Valid 4-Line Footer**: Reset error count via `--reset-errors` in `state-update`.
3. **Delay Validation & Clamping**:
   - Parse `NEXT_DELAY_SEC` as an integer; if missing, non-integer, or `< 0`, default to `120`.
   - `pacing == "fixed"`: `delay_sec = interval_sec`.
   - `pacing == "dynamic"`: clamp `delay_sec = min(86400, max(10, NEXT_DELAY_SEC))`.
4. **Worktree Preservation (`agy v1.5.5+`)**:
   - If `workspace == "branch"`, record the branch name (`worktree_branch`) via `state-update`.
   - Before killing a `branch` subagent, surface `worktree_branch`, `git diff --stat`, and ready-to-run `git cherry-pick` / `git merge` commands. Keep the `branch` subagent `Idle` if unmerged commits await user review (killing deletes its worktree).
5. **Terminal Outcomes (`stop_requested == true`, `LOOP_STATUS == DONE`, `LOOP_STATUS == BLOCKED`, or `N >= max_iterations`)**:
   - Cancel remaining schedules (`manage_task(Action="kill", TaskId=...)` using `task_id`/`cron_task_id`).
   - Persist terminal state (`"stopped"`, `"done"`, `"blocked"`, or `"max_reached"`) via `state-update --stdin <<'AGY_LOOP_PATCH'`.
   - Clean up non-`branch` `Idle` subagent (`manage_subagents(Action="kill", ConversationIds=[worker_id])`); for `branch`, follow Step 4 above.
   - Report final summary (`DONE`, `BLOCKED` with needed decision/credential, `Stopped`, or `Reached max iterations`) and **end your turn**.
6. **Continue Outcome (`LOOP_STATUS == CONTINUE` and `N < max_iterations`)**:
   - Schedule next wake-up:
     - **`use_cron == false` (default)**: Call `schedule(DurationSeconds=delay_sec, Prompt="<[LOOP_WAKEUP] block>")` and capture `next_task_id`.
     - **`use_cron == true`**: If `task_id` (`cron_task_id`) is not active yet, call `schedule(CronExpression=cron_expr, MaxIterations=max_iterations - N, ExactTiming=exact_timing, IsDaemon=is_daemon, Prompt="<[LOOP_WAKEUP] block>")` and capture `next_task_id`; otherwise reuse existing `task_id`.
   - Persist state atomically via single-quoted heredoc so quotes, backticks, and `$()` in `SUMMARY`/`NEXT_HINT` are 100% shell-safe:
     ```sh
     sh "<skill_dir>/scripts/loop-helper.sh" state-update "<workspace_dir>" "<loop_id>" --increment-iteration --reset-errors --stdin <<'AGY_LOOP_PATCH'
     {"task_id":"<next_task_id>","worker_id":<worker_id_or_null>,"worktree_branch":<branch_or_null>,"last_status":"<LOOP_STATUS>","last_delay_sec":<delay_sec>,"last_summary":"<json_escaped_summary>","next_hint":"<json_escaped_next_hint>","event":"iteration_complete"}
     AGY_LOOP_PATCH
     ```
     *(Omit `--reset-errors` if Step 2 already incremented `consecutive_errors` for a recoverable missing-footer turn.)*
   - Print **exactly one compact progress line**:
     ```text
     [Loop <loop_id> #<N>/<Max>] <SUMMARY> | Next wake-up in <delay_label> (<self-paced | fixed <interval_label> | cron <cron_expr>>)
     ```
   - **End your turn immediately**.

#### Compact `[LOOP_WAKEUP]` Schedule Prompt

Put `loop_id`, `skill_dir`, and `workspace_dir` at top, keeping concise fallback metadata below in case `state.json` is absent:
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

---

### Turn C: Timer / Cron Wake-Up Turn (`[LOOP_WAKEUP]`)

When awakened by a `[LOOP_WAKEUP]` notification from `schedule`:

1. **Read Authoritative State FIRST**:
   Call `sh "<skill_dir>/scripts/loop-helper.sh" state-read "<workspace_dir>" "<loop_id>"` to load authoritative `iteration`, `max_iterations`, `worker_id`, `task_id`, `next_hint`, `consecutive_errors`, `stop_requested`, `status`, `task_source`, `inline_prompt`, `state_mode`, `workspace`, `model`, `delegate`, and `use_cron` (eliminating `--cron` static-prompt drift and surviving context compaction). *(Use `fallback_*` fields only if the state file is missing.)*
2. **Stop / Status Guard**:
   If `stop_requested == true` or `status != "running"`, cancel any remaining `task_id` via `manage_task(Action="kill", TaskId=...)` and **end your turn cleanly** without dispatching.
3. **Overlap Guard (`use_cron == true`)**:
   Check `manage_subagents(Action="list")`. If `worker_id` is still `Running`, skip this tick and **end your turn immediately without incrementing `iteration`** in `state.json`.
4. **Hot-Reload `loop.md` Strictly via Helper**:
   - If `task_source == "loop_md_or_default"`, re-run `sh "<skill_dir>/scripts/loop-helper.sh" resolve-task "<workspace_dir>"` on every wake-up (do NOT bypass with `read_file`/`view_file`). If `"truncated": true`, print a 1-line truncation warning.
   - If `task_source == "inline"`, use `inline_prompt`.
5. **Dispatch Iteration `N` Asynchronously**:
   - **`state_mode == "stateful"` with an `Idle` `worker_id`**: Call `send_message(Recipient=worker_id, Message="<Worker Dispatch Template for Iteration N/Max>")` using authoritative `next_hint`. *(If `worker_id` is missing or `Killed`, spawn via `invoke_subagent` and update `worker_id` via `state-update`.)*
   - **`state_mode == "fresh"` (or delayed one-shot Iteration #1)**: Call `invoke_subagent` (`TypeName: delegate`, `Workspace: workspace`, `Model: model`) and record `worker_id` via `state-update`.
6. **End your turn immediately** while the worker runs in the background.

---

## Progressive Disclosure References

For copy-paste `.agents/loop.md` templates, advanced flag recipes (`every`, `1h30m`, `--worktree`, `--stateful`, `--self`, `--cron`), or CLI TUI controls (`/tasks`, `/agents`, `Ctrl+K`, `Alt+J`, `Esc`), read `references/examples-and-loop-md.md` via `read_file` or `view_file`.

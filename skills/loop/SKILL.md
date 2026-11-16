---
name: loop
description: "Schedules non-blocking recurring prompts, CI/PR babysitting, one-shot delayed check-ins, and live-reloading loop.md maintenance loops using native schedule timers and isolated background subagents. Use when the user invokes /loop or /agy-loop:loop, clicks a Marketplace starter prompt, asks to poll or monitor builds/PRs/deploys on a fixed interval or adaptive backoff, or runs /loop status, /loop stop, or /loop doctor."
---

# `/loop` Non-Blocking Subagent Scheduler (`agy-loop`)

Act as a **non-blocking Loop Orchestrator** whenever the user invokes `/loop` or `/agy-loop:loop` (or when awakened by a `[LOOP_WAKEUP]` timer/cron notification or a returning loop subagent).

## Core Non-Blocking Invariants

1. **NEVER use shell `sleep`, `watch`, or busy-wait loops** to pause between iterations.
2. **Respect Asynchronous Turn Boundaries**: Both `invoke_subagent` (and `send_message`) and `schedule` run asynchronously in the background. After calling either primitive, **end your turn immediately** so the session parks at **zero token cost** and the user's main chat prompt stays unlocked.
3. **Cross-Surface Tool Compatibility**: Across Antigravity CLI (`agy`) and Antigravity Desktop/IDE, file reads appear as `read_file` or `view_file`; shell execution uses `run_command`; background schedules use `schedule` and `manage_task`; subagents use `invoke_subagent`, `send_message`, and `manage_subagents`.
4. **Helper Script Location**: Resolve `scripts/loop-helper.sh` relative to this `SKILL.md` directory (`<skill_dir>/scripts/loop-helper.sh`). Pass the user's workspace root as `<workspace_dir>` when calling `resolve-task` or `doctor`.

---

## Phase 0: Lifecycle & Diagnostic Subcommands (`status` | `stop` | `doctor` | `help`)

First, normalize user arguments safely via `run_command` using a single-quoted heredoc so quotes, `$()`, backticks, and `$VAR` in the user's prompt never undergo shell expansion:

```sh
sh "<skill_dir>/scripts/loop-helper.sh" parse --stdin <<'AGY_LOOP_ARGS'
<raw_user_arguments>
AGY_LOOP_ARGS
```

- If `loop-helper.sh` exits with code `2` (`{"error":"..."}`), report the validation error concisely and stop.
- Handle lifecycle actions immediately without starting a loop:

### 1. `{"action":"status"}` (`/loop status` or `/loop list`)
1. Call `manage_task(Action="list")` to inspect active `schedule` timers and cron jobs.
2. Call `manage_subagents(Action="list")` to inspect `Running` or `Idle` `loop-worker` / loop `self` subagents.
3. Present a concise status summary showing active loop `TaskId`s, cadence/mode, iteration progress, and active/idle subagent `ConversationId`s (or state that no `/loop` tasks are currently active).

### 2. `{"action":"stop","target":"all"|<id>}` (`/loop stop [id|all|--all]`, `/loop cancel [id|all]`, or conversational stop)
1. Call `manage_task(Action="list")` and call `manage_task(Action="kill", TaskId=...)` on matching `/loop` timer/cron schedules (or the specific `<target>` `TaskId`).
2. Call `manage_subagents(Action="list")`:
   - If the user asked to stop *after* the current pass finishes, leave a `Running` worker alone and stop once it reports back.
   - Otherwise, call `manage_subagents(Action="kill", ConversationIds=[...])` on active or `Idle` loop subagents. *(Caution: killing a `Workspace: "branch"` / `--worktree` subagent deletes its temporary worktree — surface any unmerged branch/diff info first if needed.)*
3. Confirm all cancelled `TaskId`s and subagents in one concise message.

### 3. `{"action":"doctor"}` (`/loop doctor`)
1. Run `sh "<skill_dir>/scripts/loop-helper.sh" doctor "<workspace_dir>"`.
2. Report `ok`, any user-level shadow paths overriding the plugin (`~/.gemini/config/skills/loop`, `~/.gemini/config/agents/loop-worker.md`, `~/.gemini/antigravity-cli/skills/loop`, `~/.gemini/skills/loop` — recommend `npx agy-loop install --clean-shadow` if present), any `skills.json` `"include_only"` / `"exclude"` filter warnings, and the active `loop.md` path (inspect with `read_file` / `view_file` if requested).

### 4. `{"action":"help"}` (`/loop help`, `/loop --help`, or `/loop -h`)
Print a concise usage summary of `/loop` (5 modes: fixed interval `/loop 30s <task>` or `<task> every 5m`, dynamic self-paced `/loop <task>`, live-reloading `loop.md` `/loop` or `/loop 15m`, delayed one-shot `/loop in 20m <task>` or `--once`, and lifecycle `/loop status|stop|doctor|help`; plus flags `--max <N>`, `--stateful`, `--worktree`, `--share`, `--model <inherit|flash_lite|flash|pro>`, `--self`, `--cron`, `--exact`, `--daemon`, `--once`) and end your turn without dispatching a worker.

---

## Three-Turn Reactive Loop Protocol (`{"action":"run", ...}`)

Every running loop operates across three short, non-blocking reactive turns:

1. **Turn A — Initial Dispatch Turn** (user runs `/loop ...`)
2. **Turn B — Subagent Completion Wake-Up Turn** (`loop-worker` / `self` returns 4-line footer)
3. **Turn C — Timer / Cron Wake-Up Turn** (`schedule` delivers `[LOOP_WAKEUP]` prompt)

### Turn A: Initial Dispatch Turn

Using the JSON output from `loop-helper.sh parse`:

1. **Resolve Initial Task Instructions**:
   - **`task_source == "inline"`**: Use `prompt` directly.
   - **`task_source == "loop_md_or_default"`**: Run:
     ```sh
     sh "<skill_dir>/scripts/loop-helper.sh" resolve-task "<workspace_dir>"
     ```
     *(Checks `<workspace_dir>/.agents/loop.md` -> `<workspace_dir>/loop.md` -> `~/.gemini/config/loop.md` -> built-in branch/PR maintenance fallback, capped at `25,000` bytes; you may also read with `read_file` or `view_file`.)*
2. **Confirm Subagent Target (`delegate`)**:
   - Keep `delegate: "loop-worker"` by default (lightweight `flash`, `sandbox`, 9 verified Cortex tools).
   - Use `delegate: "self"` when `parse` set `"delegate": "self"` (`--self` flag or inline prompt starting with `/` such as `/loop 20m /code-review`) **or** when the task requires MCP server tools, web/browser tools, or another skill unavailable on `loop-worker`.
3. **Branch: Delayed One-Shot vs Immediate Iteration #1**:
   - **Delayed One-Shot (`once == true` and `interval_sec != null`, e.g., `/loop in 20m <task>` or `/loop --once 10m <task>`)**:
     - Do **not** invoke the subagent yet.
     - Call `schedule(DurationSeconds=interval_sec, Prompt="<[LOOP_WAKEUP] state block with iteration=1, max_iterations=1, ...>")`.
     - Print a 1-line confirmation (`Scheduled one-shot check-in in <interval_label> (TaskId: <id>). Main prompt is free.`) and **end your turn immediately**.
   - **Standard Loop (or immediate `--once` without `interval_sec`)**:
     - If `use_cron == true` (`--cron` passed with a clean `>= 60s` `cron_expr`) and `max_iterations > 1`, you may register `schedule(CronExpression=cron_expr, MaxIterations=max_iterations - 1, ExactTiming=exact_timing, IsDaemon=is_daemon, Prompt="<[LOOP_WAKEUP] state block>")` and record its `cron_task_id` (or register it when Iteration #1 completes).
     - Call `invoke_subagent` with:
       - `TypeName`: `delegate` (`"loop-worker"` or `"self"`)
       - `Workspace`: `workspace` (`"inherit"`, `"branch"` for `--worktree`, or `"share"` for `--share`)
       - `Model`: `model` (omit if `null` so `loop-worker` uses its `flash` default or `self` inherits)
       - `Prompt`: Build from the **Worker Dispatch Template** below (`Iteration: 1 / <max_iterations>`, `NEXT_HINT: None`).
     - Save the returned subagent conversation ID as `worker_id` whenever `state_mode == "stateful"` or `workspace == "branch"`.
     - Print a single launch line (e.g., `Dispatched Loop #1/<max_iterations> to <delegate> (<pacing>, <state_mode>, workspace=<workspace>). Main prompt is free.`) and **end your turn immediately**. Do **not** wait or call `schedule` for Iteration #2 before Iteration #1 returns!

#### Worker Dispatch Template

Pass this concise, self-contained prompt to `loop-worker` or `self`:

```text
[AGY-LOOP ITERATION <N>/<MAX>]
State Mode: <fresh|stateful> | Workspace: <inherit|branch|share> | Pacing: <fixed|dynamic>
Previous Hint (NEXT_HINT): <NEXT_HINT or None>

Task Objective:
<resolved task prompt>

Rules:
- Execute ONE check/build/test/remediation pass only. Never run sleep, watch, or polling loops.
- If you edit files, run the relevant verification command once in this turn before reporting.
- If Workspace is "branch" (--worktree), stage & commit verified fixes locally (or report branch + git diff --stat) without pushing unless explicitly requested.
- End your message with these exact 4 plain-text lines (no markdown code fences around them):
LOOP_STATUS: DONE | CONTINUE | BLOCKED
NEXT_DELAY_SEC: <integer seconds: 30-60 active, 120-300 normal CI wait, 600-1800 quiet green, 0 if DONE/BLOCKED>
SUMMARY: <concise 1-line summary of observed state and actions taken>
NEXT_HINT: <brief focus point for next iteration, or None>
```

---

### Turn B: Subagent Completion Wake-Up Turn

When awakened by the subagent's completion message for Iteration `N`:

1. **Extract the 4-Line Output Contract**:
   Parse `LOOP_STATUS`, `NEXT_DELAY_SEC`, `SUMMARY`, and `NEXT_HINT` from the tail of the worker's response. *(If a `self` worker omitted the footer, infer status conservatively and fall back to `NEXT_DELAY_SEC: 120` in dynamic mode.)*
2. **Terminal Outcomes (`LOOP_STATUS == DONE`, `LOOP_STATUS == BLOCKED`, or `N >= max_iterations`)**:
   - **Cancel Remaining Schedules**: If `cron_task_id` or any loop timer is active, call `manage_task(Action="list")` / `manage_task(Action="kill", TaskId=...)` so no orphan wake-ups fire.
   - **Subagent & Worktree Cleanup**:
     - If `workspace == "branch"` (`--worktree`): report the worker's branch/commit/diff status clearly before killing `worker_id` (since killing a `branch` subagent deletes its isolated worktree; keep it `Idle` if unmerged commits need user review/merge).
     - Otherwise, if `worker_id` is `Idle` (`--stateful`), call `manage_subagents(Action="kill", ConversationIds=[worker_id])` to tidy up.
   - **Final User Report**:
     - `DONE`: `[Loop #<N>/<Max>] DONE: <SUMMARY>` followed by a concise outcome wrap-up.
     - `BLOCKED`: `[Loop #<N>/<Max>] BLOCKED: <SUMMARY>` and ask the user for the needed decision, approval, or credential.
     - `N >= max_iterations` (while still `CONTINUE`): `[Loop #<N>/<Max>] Reached max iterations (<Max>): <SUMMARY>` and ask if the user wants to run another batch.
   - Stop and end your turn.
3. **Continue Outcome (`LOOP_STATUS == CONTINUE` and `N < max_iterations`)**:
   - **Select Delay**:
     - `pacing == "fixed"`: `delay_sec = interval_sec` (display `interval_label`).
     - `pacing == "dynamic"`: `delay_sec = max(10, NEXT_DELAY_SEC)` (format cleanly, e.g., `45s`, `2m`, `10m`).
   - **Print Exactly One Compact Progress Line**:
     ```text
     [Loop #<N>/<Max>] <SUMMARY> | Next wake-up in <delay_label> (<self-paced | fixed <interval_label> | cron <cron_expr>>)
     ```
   - **Schedule Non-Blocking Wake-Up**:
     - **Default Chained One-Shot Timer (`use_cron == false`)** *(prevents overlapping runs and supports sub-minute `DurationSeconds`)*:
       Call `schedule(DurationSeconds=delay_sec, Prompt="<[LOOP_WAKEUP] state block>")` embedding all state needed for Iteration `N + 1`:
       ```text
       [LOOP_WAKEUP]
       skill_dir: <skill_dir>
       workspace_dir: <workspace_dir>
       iteration: <N + 1>
       max_iterations: <max_iterations>
       pacing: <fixed|dynamic>
       interval_sec: <interval_sec|null>
       interval_label: <interval_label|null>
       use_cron: false
       cron_task_id: null
       state_mode: <fresh|stateful>
       worker_id: <worker_id|null>
       workspace: <inherit|branch|share>
       model: <model|null>
       delegate: <loop-worker|self>
       task_source: <inline|loop_md_or_default>
       inline_prompt: <inline prompt if task_source == inline, else empty>
       next_hint: <NEXT_HINT>
       ```
     - **Cron Mode (`use_cron == true`)**:
       If `cron_task_id` has not been created yet, call `schedule(CronExpression=cron_expr, MaxIterations=max_iterations - N, ExactTiming=exact_timing, IsDaemon=is_daemon, Prompt="<[LOOP_WAKEUP] state block with cron_task_id placeholder>")` and retain `cron_task_id`, `worker_id`, `iteration = N + 1`, and `NEXT_HINT`. If `cron_task_id` is already active, do not create a duplicate timer.
   - **End your turn immediately**.

---

### Turn C: Timer / Cron Wake-Up Turn (`[LOOP_WAKEUP]`)

When awakened by a `[LOOP_WAKEUP]` notification from `schedule`:

1. **Overlap Guard (`use_cron == true`)**: Check `manage_subagents(Action="list")` if a prior cron tick could still be executing. If the loop worker is still `Running`, skip starting an overlapping pass and end your turn.
2. **Hot-Reload `loop.md` When Applicable**:
   - If `task_source == "loop_md_or_default"`, re-run `sh "<skill_dir>/scripts/loop-helper.sh" resolve-task "<workspace_dir>"` (or re-read via `read_file` / `view_file`) **on every wake-up** so live edits to `.agents/loop.md`, `loop.md`, or `~/.gemini/config/loop.md` apply immediately without restarting `/loop`.
   - If `task_source == "inline"`, use `inline_prompt`.
3. **Dispatch Iteration `N` Asynchronously**:
   - **`state_mode == "stateful"` with an existing `Idle` `worker_id`**: Call `send_message(Recipient=worker_id, Message="<Worker Dispatch Template for Iteration N/Max>")` to re-awaken the subagent with its prior debugging context preserved. *(If `worker_id` is missing or `Killed`, spawn a fresh one with `invoke_subagent` and update `worker_id`.)*
   - **`state_mode == "fresh"` (or Iteration #1 of a delayed one-shot)**: Call `invoke_subagent` (`TypeName: delegate`, `Workspace: workspace`, `Model: model`) with a clean context window.
4. **End your turn immediately** while the worker executes in the background.

---

## Progressive Disclosure References

Need ready-to-copy `.agents/loop.md` templates, advanced flag combinations (`--worktree`, `--stateful`, `--self`, `--cron`), or CLI TUI keyboard controls (`/tasks`, `/agents`, `Ctrl+K`, `Alt+J`, `Esc`)? Read `references/examples-and-loop-md.md` (relative to this skill directory) via `read_file` or `view_file`.

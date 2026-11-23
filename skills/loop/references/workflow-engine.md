# `/agy-loop:loop` Workflow Engine (`run_workflow` & `loop-verifier`)

Progressive-disclosure reference for `skills/loop/SKILL.md`. Load via `read_file` or `view_file` when dispatching `--engine workflow`, configuring two-stage verification (`--verify-cmd` + `--verify`), parallel `--targets`, `--probe`, `--stateful --reset-every`, or live steering (`nudge` / `wake` / `resume`).

---

## 1. Engine Routing (`auto` vs `schedule` vs `workflow`)

`skills/loop/scripts/loop-helper.sh parse` computes effective `"engine"`:

- **`"schedule"` (default for plain `/agy-loop:loop`)**: Used when `--engine schedule` is passed or when `--engine auto` (default) is used without workflow-only flags. Preserves the 3-Turn Reactive Protocol (`schedule` + `invoke_subagent`) so non-`auto` permission prompts (`Ctrl+K`) and native timers work on every `agy` version.
- **`"workflow"`**: Selected automatically when `--engine workflow` OR any workflow-only/lease flag (`--verify`, `--verifier-model`, `--verify-cmd`, `--probe`, `--targets`, `--max-tokens`, `--max-duration`, `--reset-every`, `--singleton`, `--on-conflict`) is passed.
- **Mutual exclusions (Exit `2`)**:
  - `--cron`, `--exact`, and `--daemon` require `--engine schedule` (cannot combine with `--engine workflow`, workflow-only flags, `--singleton`, or `--on-conflict`).
  - Workflow-only flags and lease flags (`--singleton`, `--on-conflict`) cannot combine with `--engine schedule`.
  - `--profile` and `--file` cannot combine with each other or with an inline prompt.
  - `--reset-every` requires `--stateful`; `--probe-until-pass` requires `--probe`.

---

## 2. Invoking `run_workflow` from `SKILL.md` (`agy >= 1.5.9`)

When `parse.engine == "workflow"`:

1. Initialize persisted state first via `loop-helper.sh state-init "<workspace_dir>" --stdin <<'AGY_LOOP_PARSE'` to receive an authoritative `loop_id` (and initialize `<workspace_dir>/.agents/.agy-loop/.gitignore`).
2. Resolve `<plugin_root>` as `../..` relative to `<skill_dir>` and set:
   `ScriptPath = "<plugin_root>/workflows/loop-runner/workflow.py"`
3. Pass **only** keys allowed by `workflows/loop-runner/workflow.json` (`additionalProperties: false` — never forward `action`, `engine`, `interval_label`, `cron_expr`, `use_cron`, `exact_timing`, `is_daemon`, `explicit_flags`, or `warnings`):
   - **Profile / `loop.md` Frontmatter Precedence**: When `parse.profile != null`, `parse.profile_file != null`, or `parse.task_source == "loop_md_or_default"`, pass `loop_id`, `workspace_dir`, `task_source`, `prompt`, `profile`, `profile_file` (plus `delegate` if `"self"`), and **only** the optional keys present in `parse.explicit_flags`. Omitting unpassed default keys (`pacing`, `once`, `max_iterations`, `state_mode`, `workspace`, `verify`, `targets`, etc.) lets `workflow.py` apply profile YAML frontmatter defaults instead of overwriting them with parser defaults.

| `workflow.json` `Args` key | Source from `parse` / `state-init` | Type / Default |
| :--- | :--- | :--- |
| `loop_id` | `state_init.loop_id` | `string` |
| `workspace_dir` | `<workspace_dir>` (absolute path) | `string` (required) |
| `task_source` | `parse.task_source` | `"inline" \| "loop_md_or_default"` |
| `prompt` | `parse.prompt` | `string` |
| `profile` | `parse.profile` | `string \| null` (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`) |
| `profile_file` | `parse.profile_file` | `string \| null` |
| `pacing` | `parse.pacing` | `"fixed" \| "dynamic"` |
| `once` | `parse.once` | `boolean` |
| `interval_sec` | `parse.interval_sec` | `integer \| null` |
| `max_iterations` | `parse.max_iterations` | `integer` (default `20`, `1` if `once`) |
| `state_mode` | `parse.state_mode` | `"fresh" \| "stateful"` |
| `reset_every` | `parse.reset_every` | `integer \| null` |
| `workspace` | `parse.workspace` | `"inherit" \| "branch" \| "share"` |
| `model` | `parse.model` | `"inherit" \| "flash_lite" \| "flash" \| "pro" \| null` |
| `delegate` | `parse.delegate` | `"loop-worker" \| "self"` |
| `verify` | `parse.verify` | `boolean` |
| `verifier_model` | `parse.verifier_model` | `"inherit" \| "flash_lite" \| "flash" \| "pro" \| null` |
| `verify_cmd` | `parse.verify_cmd` | `string \| null` |
| `verify_timeout_sec` | `parse.verify_timeout_sec` | `integer` (default `60`) |
| `probe_cmd` | `parse.probe_cmd` | `string \| null` |
| `probe_timeout_sec` | `parse.probe_timeout_sec` | `integer` (default `60`) |
| `probe_until_pass` | `parse.probe_until_pass` | `boolean` |
| `targets` | `parse.targets` | `string[]` (default `[]`) |
| `max_tokens` | `parse.max_tokens` | `integer \| null` |
| `max_duration_sec` | `parse.max_duration_sec` | `integer \| null` |
| `singleton` | `parse.singleton` | `"profile" \| "workspace" \| "none" \| null` |
| `on_conflict` | `parse.on_conflict` | `"wake" \| "skip" \| "fail" \| null` |
| `relay_on_wake` | `false` (or `true` when daemon/relaying) | `boolean` |

4. Call `run_workflow(ScriptPath=..., Args=..., Description="agy-loop <loop_id>: <concise task>")`, print one launch line naming `<loop_id>`, and **end your turn immediately**. `workflow.py` executes the entire multi-turn loop in the background and notifies the main session once upon completion.

> **Frontmatter & Lease Lock Notes**:
> - When `profile` or `profile_file` is set (or `task_source == "loop_md_or_default"`), `workflow.py` resolves the profile Markdown, strips optional YAML frontmatter, and applies safe non-command frontmatter defaults (`interval`, `max_iterations`, `state_mode`, `reset_every`, `worker_model`/`model`, `verify`, `verifier_model`, `worktree`, `budget_tokens`/`max_tokens`, `max_duration`, `max_errors`, `targets`, `singleton`) only when the corresponding `Args` key was omitted.
> - **Sandbox Security Boundary**: `workflow.py` runs outside the OS sandbox, so frontmatter `probe_cmd` and `verify_cmd` are **always blocked** in workflow mode (logged and ignored). Pass `--probe` / `--verify-cmd` explicitly on the command line when needed.
> - When `singleton` resolves to `"profile"` or `"workspace"` (defaults to `"profile"` when `profile`/`profile_file` is set, else `"none"`), `workflow.py` enforces the Four-Gate Lease Lock (`<state_root>/locks/<scope_key>.lock.json`). See [profiles-and-daemons.md](profiles-and-daemons.md).

### Fallback on `agy < 1.5.9` (when `run_workflow` is unavailable)

If `run_workflow` is missing or rejected by the runtime:
- Clean up the newly initialized state with `sh "<skill_dir>/scripts/loop-helper.sh" state-stop "<workspace_dir>" "<loop_id>"`.
- Tell the user clearly: `run_workflow` requires Antigravity CLI `>= 1.5.9`. Offer two alternatives:
  1. Re-run with `--engine schedule` (for standard intervals/prompts without workflow-only flags).
  2. Run `npx agy-loop run ...` in a terminal for headless `--verify-cmd` / `--verifier-model` / `--probe` / `--max-tokens` / `--max-duration` / `--reset-every` support.

---

## 3. Workflow Engine Capabilities & Recipes

### Two-Stage `turn-stopping` Verification (`--verify-cmd` + `--verify`)

When a worker reports `LOOP_STATUS: DONE`:
1. **Stage 1 (`--verify-cmd <cmd>`, 0 LLM tokens)**: Runs the explicit shell command locally (bounded by `--verify-timeout`, default `60s`, with `4096 B` UTF-8-safe tail capture). On non-zero exit, injects the failure tail into `next_hint` and continues (or fails closed `BLOCKED` if at `max_iterations`).
2. **Stage 2 (`--verify` / `--verifier-model <tier>`)**: Checks sticky `max_tokens` / `max_duration` budget first (never overspends on verification once a hard budget is exhausted), then invokes the read-only `loop-verifier` agent (default `pro`; tools `[view_file, run_command, search_web]` only) against the frozen `IterationSnapshot`. Fails closed on rejection or verifier error.

> **Security boundary**: `workflow.py` runs outside the OS sandbox. `probe_cmd` and `verify_cmd` execute **only** explicit user-provided flags — never commands extracted from `.agents/loop.md`.

```text
/agy-loop:loop fix auth regression --verify-cmd "npm test" --verify --verifier-model pro --max 5
```

### Parallel Multi-Target Fan-Out (`--targets <csv>`)

Runs each target concurrently via `parallel()`, isolating per-target exceptions so one failure does not cancel sibling targets. Marks `DONE` only when every target reports `DONE`.

```text
/agy-loop:loop audit and fix lint warnings --targets "packages/core,packages/cli,packages/ui" --max 4
```

*(Prefer `--worktree` or `--share` or disjoint target directories when targets edit files concurrently.)*

### Stateful Context Rotation (`--stateful --reset-every <N>`) & Zero-Token Probes (`--probe`)

```text
/agy-loop:loop hunt flaky race condition --stateful --reset-every 3 --max 9
/agy-loop:loop 30s fix build --probe "npm run build" --probe-until-pass --max 10
```

---

## 4. Live Steering (`nudge`, `wake`) & Terminal `resume`

Both `workflow` and `headless` loops share `<workspace>/.agents/.agy-loop/loops/<loop_id>/inbox/` and `state.json`:

- **Inject steering instructions without killing the loop**:
  - `/agy-loop:loop nudge latest "focus on tests/auth.test.mjs"` (takes effect on next iteration)
  - `/agy-loop:loop nudge lp_... "check flaky port binding" --wake` (also interrupts inter-iteration sleep immediately, or skips end-of-turn sleep if mid-iteration)
- **Skip remaining inter-iteration sleep**:
  - `/agy-loop:loop wake latest`
- **Terminal CLI companions (`npx agy-loop ...`)**:
  - `agy-loop ps [--all] [--global]` — inspect running/past `workflow`, `headless`, and `schedule` loops
  - `agy-loop logs <id|latest> -f` — stream live `iteration_start`, `inbox_claim`, `verify_cmd`, and `iteration_end` events
  - `agy-loop nudge <id|latest> "<msg>" [--wake]` / `agy-loop wake <id|latest>` / `agy-loop stop <id|all> [--after-current]`
  - `agy-loop resume <id|latest> [--max <N>] [--max-tokens <N>] [--max-duration <dur>] [--model <slug>]` — resume an interrupted or budget-stopped headless loop cleanly (reconciles orphan `in_flight_iteration`, reattaches worktree, and preserves `usage_totals`)

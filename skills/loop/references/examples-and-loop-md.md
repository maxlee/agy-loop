# `/agy-loop:loop` Recipes, `.agents/loop.md` Templates & CLI TUI Controls

Progressive-disclosure reference for `skills/loop/SKILL.md` (`agy-loop`). Load this file via `read_file` or `view_file` only when the user asks for `.agents/loop.md` starter templates, advanced `/agy-loop:loop` recipes, or interactive CLI controls.

> **Why `/agy-loop:loop`?** Antigravity native plugins namespace bundled skills as `/<plugin>:<skill>` across Desktop Marketplace and CLI (`agy`), avoiding writes outside the plugin bundle (`~/.gemini/config/skills/`).

---

## 1. Ready-to-Use `.agents/loop.md` Templates

When `/agy-loop:loop` or `/agy-loop:loop <interval>` is invoked without an inline prompt, `skills/loop/scripts/loop-helper.sh resolve-task` evaluates files on **every wake-up** (up to `25,000` bytes) in strict priority order:

1. `<workspace>/.agents/loop.md` — Team or repository-specific loop policy (commit to git or gitignore per preference)
2. `<workspace>/loop.md` — Workspace root loop policy
3. `~/.gemini/config/loop.md` — Personal global fallback across repositories
4. Built-in branch, incremental test, and PR maintenance fallback

Live edits to any `loop.md` file take effect automatically on the next scheduled tick without restarting `/agy-loop:loop`.

### Template A: PR Babysitter & CI Healer (`.agents/loop.md`)

```markdown
# PR Babysitter & CI Healer

1. Inspect `git status -sb` and run fast incremental verification (`npm test` or targeted tests for modified files).
2. Check the current branch's open PR with `gh pr view --json state,mergeStateStatus,reviewDecision` and `gh pr checks`:
   - If a CI check failed due to a reproducible compile, lint, snapshot, or unit-test error in this repo, inspect the failing log (`gh run view --log-failed`), apply a minimal root-cause fix, and verify locally once in this turn.
   - Inspect unresolved review comments; address clear, mechanical fixes and leave architectural trade-offs for the human author.
3. Exit rules:
   - Return `LOOP_STATUS: DONE` once local checks pass, all required PR checks are green, and no actionable mechanical failures remain.
   - Return `LOOP_STATUS: BLOCKED` if credentials/permissions are missing, merge conflicts require product judgment, or the same failure persists after 2 fix attempts.
   - Otherwise return `LOOP_STATUS: CONTINUE` with `NEXT_DELAY_SEC` set to `45` while builds just started, `180` while queued in CI, or `900` when green and monitoring.
```

### Template B: Local TDD / Refactoring Watchdog (`.agents/loop.md`)

```markdown
# Incremental Test & Typecheck Watchdog

1. Run typechecking and fast unit tests (`pnpm typecheck && pnpm test --run`).
2. If errors are present:
   - Fix the highest-leverage root cause first (avoid broad unrelated edits).
   - Re-run the failing test command once in this turn to confirm the fix.
3. Return `LOOP_STATUS: DONE` as soon as both typecheck and unit tests exit `0` cleanly.
4. Return `LOOP_STATUS: BLOCKED` if a test failure contradicts an explicit spec or requires schema/API migration approval.
```

### Template C: Personal Global Maintenance Policy (`~/.gemini/config/loop.md`)

```markdown
# Global Quiet Branch Tending

1. Check `git status -sb`. Do not commit or push automatically.
2. Detect the project runner (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`) and run its fast check/lint/unit-test command if changes exist.
3. If `gh` is authenticated and the current branch has an open PR, summarize check status in one line.
4. Stay in `LOOP_STATUS: CONTINUE` with `NEXT_DELAY_SEC: 900` when clean and green, or `LOOP_STATUS: BLOCKED` if human input is needed.
```

---

## 2. Advanced `/agy-loop:loop` Recipes

### Sub-Minute Local Service / Health Readiness (`DurationSeconds`)
Beats 1-minute cron floors using non-overlapping one-shot timers:
```text
/agy-loop:loop 20s "curl -fsS http://localhost:8080/healthz && curl -fsS http://localhost:8080/readyz" --max 15
```

### Multi-Turn Stateful Bug Hunting (`--stateful`)
Re-awakens the same `Idle` `loop-worker` via `send_message` so hypotheses ruled out in Iteration #1 are remembered in Iteration #2 without bloating main chat:
```text
/agy-loop:loop check cargo test and fix intermittent race condition in worker_pool --stateful --max 10
```

### Risk-Free Experimental Fix in an Isolated Git Worktree (`--worktree`)
Runs inside `Workspace: "branch"` so uncommitted edits in your active terminal remain untouched while you keep coding or chatting:
```text
/agy-loop:loop 5m refactor flaky integration test in tests/sync.spec.ts until green --worktree --stateful --max 8
```

### Delegating to Nested Slash Skills or MCP Tools (`--self` or `/skill`)
Prompts starting with `/` (or passing `--self`) automatically route to the built-in `self` subagent instead of `loop-worker`:
```text
/agy-loop:loop 30m /check
/agy-loop:loop check Sentry MCP errors for release v2.4.0 and summarize regressions --self --max 12
```

### Exact Wall-Clock Recurring Cron (`--cron --exact`)
Opts into 5-field `CronExpression` when wall-clock alignment (`*/15 * * * *`, `0 * * * *`) is preferred over completion-chained timers:
```text
/agy-loop:loop 15m check staging deployment metrics --cron --exact --max 16
```

### Delayed One-Shot Check-In (`in <delay>` or `--once`)
Sleeps non-blockingly first, runs a single isolated pass when the timer triggers, reports, and exits:
```text
/agy-loop:loop in 25m verify canary rollout metrics and error budget
/agy-loop:loop --once 10m check if docker multi-arch build finished
```

---

## 3. Interactive Antigravity CLI (`agy`) TUI Controls

While `/agy-loop:loop` runs asynchronously in the background, users have full interactive control from the `agy` TUI in addition to `/agy-loop:loop status` and `/agy-loop:loop stop`:

| Control | Where to Use | Effect |
| :--- | :--- | :--- |
| `/agy-loop:loop status` | Main chat prompt | Lists active `schedule` timers/crons (`manage_task`) and `Running`/`Idle` loop subagents (`manage_subagents`). |
| `/agy-loop:loop stop [id\|all]` | Main chat prompt | Programmatically cancels active loop schedules and terminates loop subagents. |
| `/agy-loop:loop doctor [--clean-shadow]` | Main chat prompt | Checks shadow files in `~/.gemini/...` (and optionally backs them up), `skills.json` filters, and active `loop.md`. |
| `/agy-loop:loop help` | Main chat prompt | Prints concise `/agy-loop:loop` modes, flags, and lifecycle reference without starting a loop. |
| `/tasks` -> `k` | `agy` TUI panel | Opens background task manager; highlight a scheduled timer or cron job and press `k` to kill future wake-ups (`x` removes finished entries). |
| `/agents` -> `k` | `agy` TUI panel | Opens subagent manager; highlight a `Running` or `Idle` `loop-worker` and press `k` to terminate it immediately (cleans up temporary `--worktree` branches). |
| `/agents` -> `Enter` | `agy` TUI panel | Inspect the isolated subagent's private reasoning and command transcript (`Esc` returns to main chat). |
| `Ctrl+K` | Main chat prompt | Fast-path approve a pending sandbox/command permission request from a background subagent. |
| `Alt+J` | Main chat prompt | Teleport directly into the subagent view requesting permission approval (`Esc` returns to main chat). |
| `Esc` | Main chat prompt | Interrupts the current foreground turn immediately without exiting `agy` CLI (`Ctrl+C` twice exits CLI). |
| `/skills reload` | Main chat prompt | Hot-reloads newly installed or updated skills (`agy-loop`) in an already-open CLI session. |

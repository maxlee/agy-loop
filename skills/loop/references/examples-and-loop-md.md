# `/agy-loop:loop` Recipes, `.agents/loop.md` Templates & CLI TUI Controls

Progressive-disclosure reference for `skills/loop/SKILL.md` (`agy-loop` v2.0.0). Load this file via `read_file` or `view_file` when the user asks for `.agents/loop.md` / `.agents/loops/<name>.md` starter templates, advanced `/agy-loop:loop` recipes, or interactive CLI controls. For the full YAML v2 frontmatter schema, `--trust-profile-commands` security rules, Four-Gate Lease Locks, and persistent `agy-loop daemon` setup, see [profiles-and-daemons.md](profiles-and-daemons.md).

> **Why `/agy-loop:loop`?** Antigravity native plugins namespace bundled skills as `/<plugin>:<skill>` across Desktop Marketplace and CLI (`agy`), avoiding writes outside the plugin bundle (`~/.gemini/config/skills/`).

---

## 1. Ready-to-Use `.agents/loop.md` & Named Profile Templates

When `/agy-loop:loop`, `/agy-loop:loop <interval>`, or `--profile <name>` / `--file <path>` is invoked without an inline prompt, `skills/loop/scripts/loop-helper.sh resolve-task` (and `workflow.py` / `runner.mjs`) resolves instructions on **every wake-up** in strict order:

- **Named profile (`--profile <name>`)**:
  1. `<workspace>/.agents/loops/<name>.md` (repository/team profile)
  2. `~/.gemini/config/loops/<name>.md` (personal global profile)
- **Explicit file (`--file <path>`)**: `<path>` resolved relative to `<workspace>` (mutually exclusive with `--profile` and inline prompts)
- **Default lookup (no `--profile` / `--file`)**:
  1. `<workspace>/.agents/loop.md` — Team or repository-specific loop policy
  2. `<workspace>/loop.md` — Workspace root loop policy
  3. `~/.gemini/config/loop.md` — Personal global fallback across repositories
  4. Built-in branch, incremental test, and PR maintenance fallback

Optional YAML v2 frontmatter (`--- ... ---`) is stripped before measuring the `25,000`-byte UTF-8-safe cap on the Markdown body (`has_frontmatter: false` for plain `v1.x` Markdown). Live edits to the Markdown body take effect automatically on the next scheduled tick without restarting `/agy-loop:loop`. See [profiles-and-daemons.md](profiles-and-daemons.md) for the complete 33-key frontmatter reference.

### Template A: Named PR Babysitter & CI Healer Profile (`.agents/loops/ci.md` with YAML v2 Frontmatter)

```markdown
---
name: ci
description: "PR babysitter and CI failure healer"
interval: 3m
max_iterations: 15
state_mode: stateful
reset_every: 5
worktree: true
verify: true
verifier_model: pro
singleton: profile
max_duration: 90m
---

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

> **Security note**: Never rely on frontmatter `probe_cmd` / `verify_cmd` executing automatically in untrusted repos—interactive `run_workflow` blocks frontmatter commands completely (pass `--probe` / `--verify-cmd` explicitly), and Headless `agy-loop run` requires explicit `--trust-profile-commands`. See [profiles-and-daemons.md](profiles-and-daemons.md#4-security-boundary---trust-profile-commands--sidecar-grants).

### Template B: Local TDD / Refactoring Watchdog (`.agents/loop.md` or `.agents/loops/tdd.md`, Plain Markdown)

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

### Discover & Run Named Profiles (`profiles`, `--profile`, `--file`)
List workspace and global profiles (`default`, `.agents/loops/*.md`, `~/.gemini/config/loops/*.md`) or launch a named profile directly (CLI flags always override frontmatter defaults):
```text
/agy-loop:loop profiles
/agy-loop:loop profiles --json
/agy-loop:loop --profile ci
/agy-loop:loop --profile ci --max 8 --verify-cmd "npm test"
/agy-loop:loop --file .agents/loops/custom.md
```

### Single-Instance Lease Locks (`--singleton`, `--on-conflict`)
Prevent overlapping loop runs across sessions and terminals using the Four-Gate Lease Lock (`<stateRoot>/locks/<scope_key>.lock.json`). Passing `--singleton` or `--on-conflict` routes `/agy-loop:loop` through `run_workflow` (`workflow.py`), and defaults to `profile` scope whenever `--profile` or `--file` is set:
```text
/agy-loop:loop --profile ci --singleton profile --on-conflict wake
/agy-loop:loop run tests and fix failures --singleton workspace --on-conflict fail
```
*(In terminal Headless mode, use `agy-loop run --profile ci --singleton profile --on-conflict wake --relay-on-wake`, or install cross-reboot automation with `agy-loop daemon install` — see [profiles-and-daemons.md](profiles-and-daemons.md).)*

### Sub-Minute & Compound Duration Local Readiness (`DurationSeconds`)
Beats 1-minute cron floors using non-overlapping one-shot timers, and supports prefix `every` plus compound durations (`1h30m`, `2m30s`, `1d12h`):
```text
/agy-loop:loop 20s "curl -fsS http://localhost:8080/healthz && curl -fsS http://localhost:8080/readyz" --max 15
/agy-loop:loop every 2m30s check staging canary health
/agy-loop:loop 1h30m audit nightly backup status
```

### Multi-Turn Stateful Bug Hunting (`--stateful`)
Re-awakens the same `Idle` `loop-worker` via `send_message` so hypotheses ruled out in Iteration #1 are remembered in Iteration #2 without bloating main chat:
```text
/agy-loop:loop check cargo test and fix intermittent race condition in worker_pool --stateful --max 10
```

### Risk-Free Experimental Fix in an Isolated Git Worktree (`--worktree`)
Runs inside `Workspace: "branch"` so uncommitted edits in your active terminal remain untouched while you keep coding or chatting. In `agy v1.5.5+`, worktrees carry over pre-existing dirty files from the parent checkout; `agy-loop` tracks `worktree_branch` in `.agents/.agy-loop/` and surfaces `git diff --stat` plus `git cherry-pick` / `git merge` commands before teardown:
```text
/agy-loop:loop 5m refactor flaky integration test in tests/sync.spec.ts until green --worktree --stateful --max 8
```

### Escaping Command Flags (`--` & Two-Tier Validation)
Unrecognized flags in leading option slots or close typos (`--statefull`, `--max-iter`, `--profiles`) fail fast with Exit `2`, while command flags embedded mid/trailing prompt (`gh pr checks --required`) pass through with a non-blocking warning (or pass `--` to treat everything after as literal prompt text):
```text
/agy-loop:loop 3m -- gh pr checks --required
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

### Live Steering (`nudge` & `wake`) Without Restarting
Queue steering instructions or cut an inter-iteration sleep short for an active `workflow` or `headless` loop via `<workspace>/.agents/.agy-loop/loops/<loop_id>/inbox/`:
```text
/agy-loop:loop nudge latest "focus on tests/auth.test.mjs first"
/agy-loop:loop nudge lp_20261122T160000Z_ab12 "check flaky port binding" --wake
/agy-loop:loop wake latest
```

### Dynamic Workflow Engine (`--engine workflow`, `--verify`, `--verify-cmd`, `--targets`)
Passing `--engine workflow` or any workflow-only / lease option (`--verify`, `--verifier-model`, `--verify-cmd`, `--probe`, `--targets`, `--max-tokens`, `--max-duration`, `--reset-every`, `--singleton`, `--on-conflict`) routes `/agy-loop:loop` through `run_workflow` (`agy >= 1.5.9`), reducing main-session turns by ~95% and enabling two-stage verification plus parallel target fan-out. See [workflow-engine.md](workflow-engine.md) for the complete `Args` mapping, fallback rules, and recipes:
```text
/agy-loop:loop fix auth regression --verify-cmd "npm test" --verify --verifier-model pro --max 5
/agy-loop:loop audit lint warnings --targets "packages/core,packages/cli" --engine workflow --max 4
```

---

## 3. Interactive Antigravity CLI (`agy`) TUI Controls

While `/agy-loop:loop` runs asynchronously in the background, users have full interactive control from the `agy` TUI in addition to `/agy-loop:loop status` and `/agy-loop:loop stop`:

| Control | Where to Use | Effect |
| :--- | :--- | :--- |
| `/agy-loop:loop status [--all]` | Main chat prompt | Lists active (or all) persisted `.agents/.agy-loop/` loops correlated with `manage_task` timers/crons and `manage_subagents` workers. |
| `/agy-loop:loop profiles [--json]` | Main chat prompt | Discovers default `loop.md`, `.agents/loops/*.md`, and `~/.gemini/config/loops/*.md` profiles, reporting frontmatter status and blocked command notices. |
| `/agy-loop:loop nudge <id\|latest> "<msg>" [--wake]` | Main chat prompt | Atomically queues steering instructions into `inbox/` for the next iteration (pass `--wake` to also interrupt sleep or skip post-turn sleep). |
| `/agy-loop:loop wake <id\|latest>` | Main chat prompt | Atomically queues a `wake` signal in `inbox/` to interrupt inter-iteration sleep (or skip post-turn sleep / trigger terminal relay on `DONE`). |
| `/agy-loop:loop stop [<id1> <id2>\|all] [--after-current]` | Main chat prompt | Cancels linked `schedule` timers, writes `control.json` + `inbox/` `stop`, and terminates loop subagents (or drains gracefully after the current pass with `--after-current`). |
| `/agy-loop:loop doctor [--clean-shadow]` | Main chat prompt | Checks shadow files in `~/.gemini/...` (optionally archiving to UTC backup), `skills.json` filters, active `loop.md`, and `active_loops`. |
| `/agy-loop:loop help` | Main chat prompt | Prints concise `/agy-loop:loop` modes, flags, and lifecycle reference without starting a loop. |
| `/tasks` -> `k` | `agy` TUI panel | Opens background task manager; highlight a scheduled timer or cron job and press `k` to kill future wake-ups (`x` removes finished entries). |
| `/agents` -> `k` | `agy` TUI panel | Opens subagent manager; highlight a `Running` or `Idle` `loop-worker` and press `k` to terminate it immediately (cleans up temporary `--worktree` branches). |
| `/agents` -> `Enter` | `agy` TUI panel | Inspect the isolated subagent's private reasoning and command transcript (`Esc` returns to main chat). |
| `Ctrl+K` | Main chat prompt | Fast-path approve a pending sandbox/command permission request from a background subagent. |
| `Alt+J` | Main chat prompt | Teleport directly into the subagent view requesting permission approval (`Esc` returns to main chat). |
| `Esc` | Main chat prompt | Interrupts the current foreground turn immediately without exiting `agy` CLI (`Ctrl+C` twice exits CLI). |
| `/skills reload` | Main chat prompt | Hot-reloads newly installed or updated skills (`agy-loop`) in an already-open CLI session. |

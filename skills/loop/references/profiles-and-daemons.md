# `/agy-loop:loop` Multi-Profile YAML v2, Single-Instance Lease Locks & Persistent Daemons

Progressive-disclosure reference for `skills/loop/SKILL.md` (`agy-loop` v2.0.0). Load this file via `read_file` or `view_file` when authoring declarative `.agents/loops/<name>.md` profiles, reviewing the `--trust-profile-commands` security boundary, configuring `--singleton` / `--on-conflict` lease locks, or installing cross-reboot daemons with `agy-loop daemon`.

---

## 1. Multi-Profile Resolution & Discovery

`agy-loop` supports named loop profiles per workspace and globally while remaining 100% backward-compatible with v1.x pure Markdown `loop.md` files:

- **Named profile (`--profile <name>`)**: `<name>` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (rejects `/`, `\`, leading `.`, and path traversal). Lookup precedence:
  1. `<workspace>/.agents/loops/<name>.md` (repository/team scope)
  2. `~/.gemini/config/loops/<name>.md` (personal global scope)
- **Explicit file (`--file <path>`)**: Resolved relative to `<workspace>` (fails Exit `2` if missing or empty). Mutually exclusive with `--profile` and with inline prompt text.
- **Default resolution (no `--profile` / `--file` / inline prompt)**:
  1. `<workspace>/.agents/loop.md`
  2. `<workspace>/loop.md`
  3. `~/.gemini/config/loop.md`
  4. Built-in branch/PR/test maintenance prompt
- **Discover profiles**:
  - In chat: `/agy-loop:loop profiles [--json]`
  - In terminal: `agy-loop profiles [--cwd <dir>] [--json]`
  - POSIX helper: `sh "<skill_dir>/scripts/loop-helper.sh" list-profiles "<workspace_dir>"`

Precedence order for configuration keys: **Explicit CLI flags > YAML Frontmatter > Built-in defaults**.
The `25,000`-byte UTF-8-safe truncation limit applies **only to the Markdown body** after stripping frontmatter, so frontmatter settings are never truncated.

---

## 2. `.agents/loop.md` v2 YAML Frontmatter Schema

Files that do not start with `---\n` (or `---\r\n`) are treated as pure v1 Markdown (`hasFrontmatter: false`). When YAML frontmatter is present, it must close with `\n---` and accepts comments (`#`), single/double-quoted or bare scalars, booleans (`true`/`false`), integers, inline arrays (`["a", "b"]`), and block lists (`- item`). Unknown keys fail fast with typo suggestions.

| Key | Type / Allowed Values | Notes & Constraints |
| :--- | :--- | :--- |
| `name` | `string` | Human-readable profile name (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`) |
| `description` | `string` | Short summary shown in `profiles` and Sidecar `display_name` / `description` |
| `engine` | `"auto" \| "schedule" \| "workflow"` | Interactive skill engine selection |
| `interval` | duration (`30s`, `5m`, `1h30m`, `1d`) | Fixed pacing interval (cannot be fractional or zero) |
| `cron` | 5-field cron string | Wall-clock schedule for `agy-loop daemon install` |
| `timezone` | valid IANA zone (`Asia/Shanghai`, `UTC`) | Used for `CRON_TZ=` in Sidecar schedules (rejects `PST` or `+08:00`) |
| `once` | `boolean` | Single-iteration mode (conflicts with `max_iterations > 1`) |
| `max_iterations` | `integer >= 1` | Iteration cap (default `20`, or `1` when `once: true`) |
| `state_mode` | `"fresh" \| "stateful"` | Worker conversation reuse across turns |
| `reset_every` | `integer >= 1` | Rotate stateful session every `N` turns (requires `state_mode: stateful`) |
| `worker_model` / `model` | `string` (slug or tier) | Mutually exclusive; setting both fails validation |
| `effort` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | Reasoning effort for headless `agy` turns |
| `fallback_model` | `string` | Headless fallback model on quota/rate-limit/capacity errors |
| `verify` | `boolean` | Enables Stage 2 read-only `loop-verifier` gate on `DONE` |
| `verifier_model` | `string` (slug or tier) | Verifier model (default `pro`) |
| `verify_cmd` | `string` | Stage 1 shell check on `DONE` (**blocked unless trusted / CLI-passed**) |
| `verify_timeout` | duration (`60s`, `2m`) | Timeout for `verify_cmd` |
| `probe_cmd` | `string` | Pre-iteration shell probe (**blocked unless trusted / CLI-passed**) |
| `probe_timeout` | duration (`30s`, `1m`) | Timeout for `probe_cmd` |
| `probe_until_pass` | `boolean` | Exit `DONE` with 0 LLM tokens when `probe_cmd` exits `0` (requires `probe_cmd`) |
| `mode` | `"auto" \| "accept-edits" \| "plan"` | Headless `agy` execution mode |
| `sandbox` | `boolean` | Enables `agy` sandbox mode in headless runs |
| `worktree` | `boolean` | Isolate edits in Git worktree (`workspace: "branch"`) |
| `keep_worktree` | `boolean` | Keep clean 0-commit worktree after exit |
| `fail_on_denied` | `boolean` | Treat soft-denied headless tool calls as `BLOCKED` (Exit `3`) |
| `budget_tokens` / `max_tokens` | `integer >= 1` | Hard token cap; mutually exclusive aliases |
| `max_duration` | duration (`30m`, `2h`) | Hard wall-clock budget |
| `max_retries` | `integer >= 0` | Retryable turn error retries (default `3`) |
| `max_errors` | `integer >= 1` | Consecutive error circuit breaker threshold (default `3`) |
| `turn_timeout` | duration (`10m`, `15m`) | Per-turn timeout passed to `agy --print-timeout` |
| `targets` | non-empty `string[]` | Concurrent targets for workflow `parallel()` fan-out |
| `singleton` | `"profile" \| "workspace" \| "none"` | Single-instance lease lock scope |
| `access_grants` | `string[]` | Scoped Sidecar grants (`command(...)`, `read_file(...)`, `write_file(...)`, `mcp(...)`, `read_url(...)`, `execute_url(...)`); **wildcards forbidden** |

---

## 3. Copy-Paste Profile Templates

### A. `.agents/loops/ci.md` (PR Babysitter & CI Healer)

```markdown
---
name: ci
description: "Monitor open PR checks, diagnose CI failures, and apply minimal verified fixes"
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

# CI & PR Healer

1. Inspect `git status -sb` and run the fastest targeted tests for modified files.
2. Check `gh pr view --json state,mergeStateStatus,reviewDecision` and `gh pr checks`.
3. If a check failed on a reproducible compile, lint, or unit-test issue, inspect `gh run view --log-failed`, apply a minimal root-cause fix, and re-verify locally.
4. Emit `LOOP_STATUS: DONE` once PR checks and local verification are green; `BLOCKED` if credentials/permissions or product decisions are required; otherwise `CONTINUE` with `NEXT_DELAY_SEC` (60 while building, 180 while queued).
```

### B. `.agents/loops/tdd.md` (Local TDD & Typecheck Watchdog)

```markdown
---
name: tdd
description: "Fix failing unit tests and typecheck errors iteratively"
interval: 30s
max_iterations: 12
state_mode: stateful
reset_every: 4
singleton: profile
max_errors: 3
# Note: probe_cmd/verify_cmd in frontmatter require --trust-profile-commands in headless CLI
# or explicit --probe / --verify-cmd flags in interactive /agy-loop:loop.
---

# Local TDD Watchdog

1. Run the project typecheck and unit test suite (`npm test` or `pnpm typecheck && pnpm test --run`).
2. Fix the highest-leverage root failure cleanly without broad unrelated edits.
3. Re-run the affected test command once before reporting.
4. Emit `LOOP_STATUS: DONE` as soon as all typechecks and tests exit `0`.
```

### C. `~/.gemini/config/loops/nightly-audit.md` (Global Nightly Repo Audit)

```markdown
---
name: nightly-audit
description: "Quiet overnight security, dependency, and dead-code audit"
cron: "0 2 * * *"
timezone: UTC
max_iterations: 4
state_mode: fresh
worker_model: pro
budget_tokens: 120000
max_duration: 45m
singleton: workspace
access_grants:
  - "command(git status *)"
  - "command(git diff *)"
  - "read_file(./)"
---

# Nightly Audit

1. Audit `git status -sb`, recent commits, TODO/FIXME regressions, and obvious security or dependency hazards.
2. Do not modify files or push; summarize actionable findings concisely with file paths and line numbers.
3. Emit `LOOP_STATUS: DONE` once the audit report is complete.
```

---

## 4. Security Boundary: `--trust-profile-commands` & Sidecar Grants

To prevent Remote Code Execution (RCE) when running `agy-loop` inside a freshly cloned or untrusted repository that ships `.agents/loop.md` or `.agents/loops/*.md`:

1. **Interactive `/agy-loop:loop` (`run_workflow` & `loop-helper.sh`)**:
   - `workflow.py` runs outside the OS sandbox, so frontmatter `probe_cmd` and `verify_cmd` are **strictly blocked** (logged as warnings and ignored; `loop-helper.sh resolve-task` flags `"blocked_frontmatter_commands": true`).
   - Pass `--probe "<cmd>"` or `--verify-cmd "<cmd>"` explicitly on the command line when running interactive workflows.
2. **Headless CLI (`agy-loop run`) & OS Daemons (`agy-loop daemon install --mode os`)**:
   - Fail closed with Exit `2` whenever active profile frontmatter defines `probe_cmd` or `verify_cmd` without an explicit CLI `--probe` / `--verify-cmd` override, **unless** the user explicitly passes **`--trust-profile-commands`**.
3. **Sidecar `access_grants` Sanitization**:
   - Wildcard grants—including `command(*)`, `read_file(*)`, `read_file(/)`, `write_file(*)`, `mcp(*)`, `read_url(*)`, `execute_url(*)`, `allow(*)`, or any `(*)` / `/*` pattern—are rejected with Exit `2`.
   - `agy-loop daemon install --mode sidecar` **never** writes or modifies `user_config.json` or `config.json`.

---

## 5. Four-Gate Single-Instance Lease Lock (`--singleton`, `--on-conflict`, `wakeRequested`)

Both Node (`lib/lease-lock.mjs`) and Python (`workflows/loop-runner/workflow.py`) implement the exact same lock protocol under `<stateRoot>/locks/<scope_key>.lock.json`:

- **Scope Keys (`--singleton <profile|workspace|none>`)**:
  - `none`: No lock acquired (default for ad-hoc `agy-loop run` without `--profile` or `--file`).
  - `profile`: `pf_<sha256(realpath(workspaceDir) + "\0" + (profileName || "default"))[0:16]>` (default when `--profile`, `--file`, or `daemon --mode os` is used; isolates e.g. `ci` and `tdd` in the same repo while preventing duplicate `ci` runs).
  - `workspace`: `ws_<sha256(realpath(workspaceDir))[0:16]>` (at most one loop across the entire workspace).
- **Four-Gate Protocol**:
  1. **Gate 1 (Exclusive Lease + Heartbeat)**: Atomic `O_EXCL` creation (`{ scope, scope_key, loop_id, pid, engine, profile, workspace_dir, acquired_at, heartbeat_at, lease_ttl_ms: 60000, draining: false }`), refreshed every `min(lease_ttl_ms / 3, 15s)` after verifying `loop_id` + `pid` ownership.
  2. **Gate 2 (Stale Self-Healing)**: Reclaims orphaned locks via atomic rename-aside + `unlink` if the holder PID is dead, `heartbeat_at` expired past `lease_ttl_ms`, or the lock file remains corrupt for `> 2s`.
  3. **Gate 3 (Live Conflict Policy — `--on-conflict <wake|skip|fail>`)**:
     - `wake`: Enqueues `{"type":"wake","reason":"singleton_coalesced","source_pid":...}` into the active holder's `inbox/` and exits `0` without spawning duplicate loops or worktrees (default for `daemon --mode os`).
     - `skip`: Exits `0` quietly (`skipped: true`).
     - `fail`: Reports the active holder (`loop_id`, `pid`, `profile`) and exits `5` (`LOCK_CONFLICT`, default for manual `run`).
  4. **Gate 4 (`draining` Handoff & `wakeRequested` Relay)**: While exiting, the holder sets `draining: true`; incoming contenders wait up to `3000ms` (`drainWaitMs`) for clean handoff. With `--relay-on-wake` (or active lease lock), if an unclaimed `wake` arrives during the final turn before exit, the loop relays into one additional pass (`relay_count++`) within budget/iteration limits instead of dropping the trigger at the `turn -> idle` boundary.

---

## 6. Persistent Cross-Reboot Daemons (`agy-loop daemon`)

Manage scheduled background loops that survive terminal close and system reboots:

```sh
agy-loop daemon install --profile <name> --mode <sidecar|os> [options]
agy-loop daemon list [--cwd <dir>] [--global] [--json]
agy-loop daemon status [--cwd <dir>] [--json]
agy-loop daemon logs <slug> [--tail <N>] [--cwd <dir>]
agy-loop daemon remove <slug|--all> [--cwd <dir>] [--no-unload]
```

### Mode A: Native Antigravity Sidecar (`--mode sidecar`)

Generates `~/.gemini/config/sidecars/<slug>/sidecar.json` following the official Antigravity `schedule` builtin contract:

- Uses `"builtin": "schedule"`, `"restart_policy": "always"`, `"display_name"`, `"description"`, and scoped `"agent_permissions"`.
- Sets `"args": ["CRON_TZ=<IANA> <5-field-cron>", "agentapi", "new-conversation", ..., "--", "<self-contained prompt>"]`.
- Supports `--dry-run` (prints generated `sidecar.json` without writing), `--test-run` (executes `agy-loop run --once` first to surface `denied_actions[]` and suggest least-privilege `access_grants`), `--tz <IANA>`, and `--cron "<expr>"`.
- Never modifies `user_config.json` or `config.json`. After installation, open `[Open Automations Dashboard](sidecar://dashboard)` to enable/manage the sidecar and check `agy remote-control status`.

### Mode B: OS Native Service (`--mode os`)

Generates and loads OS-scheduled headless runners invoking `<nodeBin> bin/agy-loop.mjs run ... --singleton profile --on-conflict wake --relay-on-wake`:

- **macOS (`LaunchAgent`)**: `~/Library/LaunchAgents/com.maxlee.<slug>.plist` (`StartInterval` or expanded `StartCalendarInterval`), loaded via `launchctl bootstrap gui/<uid> <plist>` (unloaded via `launchctl bootout`). Logs to `<stateRoot>/daemons/<slug>.log`.
- **Linux (`systemd --user`)**: `~/.config/systemd/user/<slug>.service` (`Type=oneshot`) + `<slug>.timer` (`OnCalendar=` or `OnUnitActiveSec=`, `Persistent=true`), enabled via `systemctl --user daemon-reload && systemctl --user enable --now <slug>.timer`.
- Pass `--no-load` to generate unit/plist files without loading them into `launchctl` / `systemd`, and `--allow-temp-workspace` only for ephemeral test workspaces (persistent daemons reject `/tmp`, `/var/folders`, and CitC paths by default).
- Cross-workspace daemon registrations are tracked under lock in `~/.gemini/antigravity-cli/plugin_data/agy-loop/daemons.json`.

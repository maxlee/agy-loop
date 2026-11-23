[← Back to README](../README.md) · [简体中文 README](../README.zh-CN.md) · [Architecture](../ARCHITECTURE.md)

# Multi-Profile Configuration, Lease Locks & Persistent Daemons

`agy-loop` (`v2.0.0`) supports declarative multi-profile configuration with optional YAML v2 frontmatter, a clone-safe Remote Code Execution (RCE) command boundary, a byte-compatible Four-Gate Single-Instance Lease Lock across Node and Python, and persistent cross-reboot daemons (`agy-loop daemon`) — while maintaining 100% backward compatibility with `v1.x` pure-Markdown `loop.md` files.

---

## Multi-Profile Discovery & Precedence

Both interactive `/agy-loop:loop` and Headless `agy-loop run` resolve task definitions using the same deterministic lookup rules:

- **Named profiles (`--profile <name>`)**: `<name>` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (rejects `/`, `\`, `..`, and whitespace). Lookup order:
  1. `<workspace>/.agents/loops/<name>.md` (repository/team profile)
  2. `~/.gemini/config/loops/<name>.md` (personal global profile)
- **Explicit file (`--file <path>`)**: Resolves relative to `<workspace>` (fails with Exit `2` if missing, non-regular, or empty). Mutually exclusive with `--profile` and with inline prompt text.
- **Default lookup (no `--profile`, `--file`, or inline prompt)**: Preserves the exact `v1.x` resolution order:
  1. `.agents/loop.md` in the current workspace (project-scoped team or repo loop policy)
  2. `loop.md` in the workspace root
  3. `~/.gemini/config/loop.md` (personal global maintenance defaults across repositories)
  4. **Built-in branch maintenance fallback**: checks uncommitted/unfinished repo work and incremental tests, inspects open PR review comments and CI status via `gh` when available, and reports a single green status line if clean.
- **Profile Discovery Commands**:
  - Terminal: `agy-loop profiles [--cwd <dir>] [--json]`
  - Interactive chat: `/agy-loop:loop profiles [--json]`
- **Configuration Precedence & Body Truncation**:
  - Configuration merges strictly as **`Explicit CLI Flags > YAML Frontmatter > Built-in Defaults`**.
  - The **`25,000`-byte** UTF-8-safe truncation cap applies **only to the Markdown body** after stripping frontmatter, guaranteeing that frontmatter settings are never cut off.

---

## Optional YAML Frontmatter v2 Reference

Files that do not begin with `---\n` (or `---\r\n`) parse as plain `v1.x` Markdown (`hasFrontmatter: false`). When present, frontmatter closes with `\n---` and accepts:

- `#` comments
- Single-quoted, double-quoted, or bare scalar strings (single-line fields reject embedded newlines and NUL bytes)
- Booleans (`true` / `false`) and integers
- Inline arrays (`["a", "b"]`) and block lists (`- item`)
- Nested mappings and block scalars (`|`, `>`) are rejected

Unknown keys fail fast with Exit `2` and Damerau-Levenshtein / synonym typo suggestions (such as suggesting `timezone` for `tz`, or `max_iterations` for `max_iter`). Cross-field conflicts also fail fast (for example: `once: true` with `max_iterations > 1`, `reset_every` without `state_mode: stateful`, `probe_until_pass: true` without `probe_cmd`, setting both `worker_model` and `model`, or setting both `budget_tokens` and `max_tokens`).

### Allowed Frontmatter Keys (`33` Primary Keys + `2` Aliases)

| Category | Key | Type / Allowed Values | Constraints & Notes |
| :--- | :--- | :--- | :--- |
| **Identity & Engine** | `name` | `string` | Human-readable profile name matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` |
| **Identity & Engine** | `description` | `string` | Short summary shown in `profiles` and Sidecar `display_name` / `description` |
| **Identity & Engine** | `engine` | `auto \| schedule \| workflow` | Interactive `/agy-loop:loop` engine selection |
| **Schedule & Caps** | `interval` | duration (`30s`, `5m`, `1h30m`, `1d`) | Fixed pacing interval (fractional or zero durations rejected) |
| **Schedule & Caps** | `cron` | 5-field cron string | Wall-clock schedule for `agy-loop daemon install` |
| **Schedule & Caps** | `timezone` | strict IANA zone (`Asia/Shanghai`, `UTC`) | Used for `CRON_TZ=` in Sidecar schedules (rejects `PST` or `+08:00`) |
| **Schedule & Caps** | `once` | `boolean` | Single-iteration mode (`once: true` cannot combine with `max_iterations > 1`) |
| **Schedule & Caps** | `max_iterations` | `integer >= 1` | Iteration cap (default `20`, or `1` when `once: true`) |
| **Context & Models** | `state_mode` | `fresh \| stateful` | Worker conversation reuse across turns |
| **Context & Models** | `reset_every` | `integer >= 1` | Rotate stateful session every `N` turns (requires `state_mode: stateful`) |
| **Context & Models** | `worker_model` *(alias: `model`)* | `string` (slug or tier) | `worker_model` and `model` are mutually exclusive |
| **Context & Models** | `effort` | `low \| medium \| high \| xhigh \| max` | Reasoning effort for headless `agy` turns |
| **Context & Models** | `fallback_model` | `string` | Headless fallback model on quota, rate-limit, or capacity errors |
| **Verification & Probe** | `verify` | `boolean` | Enables Stage 2 read-only `loop-verifier` gate on `DONE` |
| **Verification & Probe** | `verifier_model` | `string` (slug or tier) | Verifier model (default `pro`) |
| **Verification & Probe** | `verify_cmd` | `string` | Stage 1 shell check on `DONE` (subject to RCE security boundary) |
| **Verification & Probe** | `verify_timeout` | duration (`60s`, `2m`) | Timeout for `verify_cmd` |
| **Verification & Probe** | `probe_cmd` | `string` | Pre-iteration shell probe (subject to RCE security boundary) |
| **Verification & Probe** | `probe_timeout` | duration (`30s`, `1m`) | Timeout for `probe_cmd` |
| **Verification & Probe** | `probe_until_pass` | `boolean` | Exit `DONE` at `0` LLM tokens when `probe_cmd` exits `0` (requires `probe_cmd`) |
| **Permissions & Isolation** | `mode` | `auto \| accept-edits \| plan` | Headless `agy` execution mode |
| **Permissions & Isolation** | `sandbox` | `boolean` | Enables `agy` sandbox mode in headless runs |
| **Permissions & Isolation** | `worktree` | `boolean` | Isolate edits in a Git worktree (`worktree: true` maps to `workspace: "branch"`) |
| **Permissions & Isolation** | `keep_worktree` | `boolean` | Keep clean 0-commit worktree after exit |
| **Permissions & Isolation** | `fail_on_denied` | `boolean` | Treat soft-denied headless tool calls (`denied_actions[]`) as `BLOCKED` (Exit `3`) |
| **Budgets & Targets** | `budget_tokens` *(alias: `max_tokens`)* | `integer >= 1` | Hard cumulative token cap (`budget_tokens` and `max_tokens` are mutually exclusive) |
| **Budgets & Targets** | `max_duration` | duration (`30m`, `2h`) | Hard wall-clock budget |
| **Budgets & Targets** | `max_retries` | `integer >= 0` | Retryable turn error retries (default `3`) |
| **Budgets & Targets** | `max_errors` | `integer >= 1` | Consecutive error circuit-breaker threshold (default `3`) |
| **Budgets & Targets** | `turn_timeout` | duration (`10m`, `15m`) | Per-turn timeout passed to `agy --print-timeout` |
| **Budgets & Targets** | `targets` | non-empty `string[]` | Concurrent targets for workflow `parallel()` fan-out |
| **Lock & Sidecar** | `singleton` | `profile \| workspace \| none` | Single-instance Four-Gate Lease Lock scope |
| **Lock & Sidecar** | `access_grants` | `string[]` | Scoped Sidecar grants: `command(...)`, `read_file(...)`, `write_file(...)`, `mcp(...)`, `read_url(...)`, `execute_url(...)` (**wildcards forbidden**) |

### Copy-Paste Profile Example (`.agents/loops/ci.md`)

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
2. Check `gh pr checks` and fix reproducible lint, build, or unit-test failures minimally.
3. Emit `LOOP_STATUS: DONE` once PR checks and local verification pass.
```

See [skills/loop/references/profiles-and-daemons.md](../skills/loop/references/profiles-and-daemons.md) for the full per-key schema reference and additional copy-paste templates (`.agents/loops/tdd.md` and `~/.gemini/config/loops/nightly-audit.md`).

---

## Hot-Reloading loop.md & Profile Bodies

When you run bare `/agy-loop:loop`, interval-only `/agy-loop:loop 15m`, or a named profile via `--profile <name>` or `--file <path>` (without an inline prompt), `agy-loop` resolves instructions dynamically on **every wake-up** via `resolve-task` (`skills/loop/scripts/loop-helper.sh`), `resolveProfileTask` (`lib/state-store.mjs` / `lib/runner.mjs`), or `resolve_profile_task` (`workflows/loop-runner/workflow.py`).

- On each iteration, the optional YAML frontmatter is stripped and the Markdown body is re-read and capped at `25,000` bytes (UTF-8-safe).
- Structural startup settings (models, budgets, worktree isolation, lock scope) remain anchored for the duration of the run while edits to the Markdown body take effect automatically on the very next wake-up without restarting the loop.

### Copy-Paste `.agents/loop.md` Branch Maintenance Example

```markdown
---
interval: 3m
max_iterations: 15
state_mode: stateful
reset_every: 5
singleton: profile
---

# Branch Maintenance Policy

1. Run `npm test` (or the fastest incremental test command for touched files).
2. If tests fail, inspect the failure, apply a minimal root-cause fix, and re-run the failing test once in this turn to verify.
3. If `gh` is authenticated and an open PR exists for the current branch:
   - Check `gh pr checks` for failing CI jobs.
   - Check unresolved review comments and address straightforward mechanical fixes.
4. Stop with `LOOP_STATUS: DONE` once local tests pass and all PR checks are green; return `LOOP_STATUS: BLOCKED` if an architectural decision or missing secret is required.
```

Frontmatter is completely optional — plain `v1.x` Markdown without `---` works identically. See [skills/loop/references/examples-and-loop-md.md](../skills/loop/references/examples-and-loop-md.md) for more templates and recipes.

---

## Security Boundary (--trust-profile-commands)

> [!CAUTION]
> **Untrusted Repository Frontmatter Commands Are Blocked by Default (Clone-Safe RCE Prevention)**:
> Cloning an untrusted repository that ships `.agents/loop.md` or `.agents/loops/*.md` containing malicious `probe_cmd` or `verify_cmd` will **never** auto-execute shell commands:
> 1. **Headless CLI (`agy-loop run`) & OS Daemons (`agy-loop daemon install --mode os`)**: Fail closed with **Exit `2`** whenever frontmatter defines `probe_cmd` or `verify_cmd` without an explicit CLI `--probe` / `--verify-cmd` override, **unless** you explicitly pass **`--trust-profile-commands`**.
> 2. **Interactive `run_workflow` (`workflows/loop-runner/workflow.py`)**: Because Antigravity's `run_workflow` Python runtime executes outside the OS sandbox, frontmatter `probe_cmd` and `verify_cmd` are **never executed** in workflow mode (logged as warnings and ignored; `loop-helper.sh resolve-task` flags `"blocked_frontmatter_commands": true`). Pass `--probe "<cmd>"` or `--verify-cmd "<cmd>"` explicitly on the command line when needed.

---

## Four-Gate Single-Instance Lease Lock

Both Node ([`lib/lease-lock.mjs`](../lib/lease-lock.mjs)) and Python ([`workflows/loop-runner/workflow.py`](../workflows/loop-runner/workflow.py)) enforce the exact same byte-compatible lock protocol under `<stateRoot>/locks/<scope_key>.lock.json` so Headless runs, OS Daemons, and interactive `run_workflow` runs coordinate cleanly without duplicate loops or orphan worktrees.

### Lock Scopes (`--singleton`)

- **`none`**: No lock acquired (default for ad-hoc `agy-loop run` without `--profile` or `--file`, keeping `v1.x` parallel runs 100% compatible).
- **`profile`**: `pf_<sha256(realpath(workspaceDir) + "\0" + (profileName || "default"))[0:16]>` (default whenever `--profile`, `--file`, or `daemon --mode os` is used; isolates e.g. `ci` vs `tdd` in the same repo while preventing duplicate `ci` runs).
- **`workspace`**: `ws_<sha256(realpath(workspaceDir))[0:16]>` (at most one active loop across the entire workspace).

### Conflict Policies (`--on-conflict`)

- **`fail`** (default for manual `run` / `/agy-loop:loop`): Reports the active holder (`loop_id`, `pid`, `profile`) and exits **`5` (`LOCK_CONFLICT`)** in Headless (or returns `status: "lock_conflict"` in `workflow.py`).
- **`wake`** (default for `daemon --mode os`): Atomically enqueues `{"type":"wake","reason":"singleton_coalesced","source_pid":...}` into the active holder's `inbox/` and exits **`0`** without creating orphan loop directories or worktrees.
- **`skip`**: Exits **`0`** quietly (`skipped: true`, `active_loop_id`) without creating orphan directories or worktrees.

### Four-Gate Protocol & `--relay-on-wake`

1. **Gate 1 — Atomic `O_EXCL` Lease + Heartbeat**: Creates the lock file atomically (`0o600`) with `{ scope, scope_key, loop_id, pid, engine, profile, workspace_dir, acquired_at, heartbeat_at, lease_ttl_ms: 60000, draining: false }`. Heartbeat refreshes `heartbeat_at` every `min(lease_ttl_ms / 3, 15s)` after verifying `loop_id` + `pid` ownership.
2. **Gate 2 — Stale & Corrupt Self-Healing**: Reclaims orphaned locks via an `O_EXCL`-guarded `reclaim.lock` + atomic rename-aside + `unlink` if the holder PID is dead, `heartbeat_at` exceeded `lease_ttl_ms`, or the lock file remains corrupt for `> 2s`.
3. **Gate 3 — Live Holder Conflict**: Applies `--on-conflict wake | skip | fail` (coalesced `inbox/wake` returns Exit `0`; `fail` returns Exit `5`).
4. **Gate 4 — `draining` Handoff & Terminal `wakeRequested` Relay**: While tearing down, the active holder sets `draining: true`; incoming contenders poll up to `3000ms` to hand off cleanly. With `--relay-on-wake` (or while holding a lease lock), if a new `wake` (or `nudge --wake`) arrives right as a non-`once` loop finishes an iteration with `DONE` (including `probe_until_pass`), it claims the wake within budget/iteration limits, clears `draining` (`unmarkLeaseDraining` / `unmark_lease_draining`), increments `relay_count`, logs a `relay` event, and continues into another pass instead of dropping the trigger at exit.

---

## Persistent Cross-Reboot Daemons (agy-loop daemon)

Schedule recurring loops that survive terminal close and system reboots, tracked across workspaces in a file-locked registry (`~/.gemini/antigravity-cli/plugin_data/agy-loop/daemons.json`):

```bash
agy-loop daemon install [--profile <name> | --file <path>] --mode <sidecar|os> [options]
agy-loop daemon list [--cwd <dir>] [--global] [--json]
agy-loop daemon status [--cwd <dir>] [--json]
agy-loop daemon logs <slug> [-n|--tail <N>] [--cwd <dir>] [--json]
agy-loop daemon remove [<slug> | --all] [--global] [--mode <sidecar|os>] [--no-unload] [--cwd <dir>] [--json]
```

Every installed daemon receives a deterministic slug (`agy-loop-<repo>-<profile>-<4hex>`). Persistent registration rejects ephemeral workspaces (`/tmp`, `/var/folders`, `/google/src/cloud`) unless `--allow-temp-workspace` is explicitly passed for testing, and `list`/`remove` strictly operate only on `agy-loop-*` managed artifacts.

### Mode A: Native Antigravity Sidecar (`--mode sidecar`)

Default mode whenever `--cron` or frontmatter `cron:` is present (cron-mappable `--interval >= 60s` values like `5m`, `1h` auto-convert via `intervalToCron`):

- Writes `~/.gemini/config/sidecars/<slug>/sidecar.json` following Antigravity's official `schedule` builtin contract:
  - `"builtin": "schedule"`, `"restart_policy": "always"`, `"display_name"`, `"description"`
  - `"args": ["CRON_TZ=<IANA> <5-field-cron>", "agentapi", "new-conversation", ...("--model=..."), "--title=...", "--", "<prompt>"]`
  - `"agent_permissions"`: `{ "workspace_uris": ["file://..."], "access_grants": [...] }` (omit `workspace_uris` with `--no-workspace-uri`)
- **Strict Non-Wildcard `access_grants`**: Only scoped `command(...)`, `read_file(...)`, `write_file(...)`, `mcp(...)`, `read_url(...)`, and `execute_url(...)` grants are accepted. Any wildcard (`command(*)`, `read_file(*)`, `read_file(/)`, `write_file(*)`, `mcp(*)`, `read_url(*)`, `execute_url(*)`, `allow(*)`, `(*)`, `/*`) fails fast with Exit `2`.
- **Never modifies `user_config.json` or `config.json`**.
- **Preview & Permission Discovery**:
  - `--dry-run`: Prints the generated `sidecar.json` without writing disk files.
  - `--test-run`: Runs a sandboxed 1-turn `agy-loop run --once` check first, reports any `denied_actions[]`, and recommends minimal non-wildcard `--grant` flags.
- After installation, enable and manage the sidecar in Antigravity via **`sidecar://dashboard`** ([Open Automations Dashboard](sidecar://dashboard)) and observe execution via `agy remote-control status` or `agy-loop status`.

### Mode B: OS Native Services (`--mode os`)

Generates and loads OS-native scheduled services invoking Headless `<nodeBin> bin/agy-loop.mjs run --cwd <workspace> [--profile <name> | --file <path>] --singleton profile --on-conflict wake --relay-on-wake`:

- **macOS (`LaunchAgent`)**: Writes `~/Library/LaunchAgents/com.maxlee.<slug>.plist` (`StartInterval` or expanded `StartCalendarInterval`), logs to `<stateRoot>/daemons/<slug>.log`, and loads via `launchctl bootstrap gui/<uid> <plist>` (unloaded via `launchctl bootout`).
- **Linux (`systemd --user`)**: Writes `~/.config/systemd/user/<slug>.service` (`Type=oneshot`) + `<slug>.timer` (`OnCalendar=` or `OnBootSec=30s` + `OnUnitActiveSec=`, `Persistent=true`), and enables via `systemctl --user daemon-reload && systemctl --user enable --now <slug>.timer`.
- Pass `--no-load` to generate `.plist` / `.service` + `.timer` files without loading them into `launchctl` or `systemd`.
- Inspect OS daemon stdout/stderr logs via `agy-loop daemon logs <slug> [-n <N>]`.
- OS daemons refuse untrusted frontmatter `probe_cmd` / `verify_cmd` unless `--trust-profile-commands` is passed.

### Daemon Examples

```bash
# 1. Preview a native Antigravity Sidecar schedule with IANA timezone & scoped grants
agy-loop daemon install --profile ci --mode sidecar --cron "*/30 * * * *" --tz Asia/Shanghai \
  --grant "command(npm test)" --dry-run

# 2. Discover least-privilege grants via 1-turn sandbox probe before installing Sidecar
agy-loop daemon install --profile ci --mode sidecar --cron "0 * * * *" --test-run

# 3. Install a macOS LaunchAgent / Linux systemd --user timer driving Headless singleton + wake relay
agy-loop daemon install --profile tdd --mode os --interval 5m --trust-profile-commands

# 4. Inspect, check live load status, tail logs, or cleanly remove managed daemons
agy-loop daemon status --global
agy-loop daemon logs <slug> -n 100
agy-loop daemon remove <slug>
```

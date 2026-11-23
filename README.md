<div align="center">

<img src="assets/logo.svg" alt="AGY Loop Logo" width="88" height="88" />

# AGY Loop

**Non-blocking `/agy-loop:loop` scheduler, dynamic workflow runner, and persistent daemon manager for Google Antigravity Desktop & CLI (`agy`).**

[![CI](https://github.com/maxlee/agy-loop/actions/workflows/ci.yml/badge.svg)](https://github.com/maxlee/agy-loop/actions/workflows/ci.yml)
[![Release](https://github.com/maxlee/agy-loop/releases/latest)](https://github.com/maxlee/agy-loop/releases/latest)
[![Antigravity Plugin v1](https://img.shields.io/badge/Antigravity-Plugin_v1-38BDF8.svg)](plugin.json)
[![Node >=18](https://img.shields.io/badge/Node-%3E%3D18-22C55E.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[**English**](README.md) · [**简体中文**](README.zh-CN.md) · [**Install**](#-installation) · [**Commands & Flags**](#-commands--parameters) · [**Docs**](#-documentation) · [**Architecture**](ARCHITECTURE.md)

</div>

---

**AGY Loop (`v2.0.0`)** brings declarative, multi-profile, singleton-safe loop automation to **Antigravity Desktop** and **Antigravity CLI (`agy`)** with **zero external npm/pip dependencies** and **100% backward compatibility** with `v1.x` pure-Markdown `loop.md` files.

- **Non-blocking dual-engine scheduling**: native `schedule` timers (`0` tokens while parked) + `run_workflow` Python engine (`agy >= 1.5.9`, ~95% fewer main-chat turns) + parallel `--targets`.
- **Isolated workers & two-stage verification**: isolated `loop-worker` / `--worktree` + Stage 1 `0`-token `--verify-cmd` -> Stage 2 read-only `loop-verifier`.
- **Multi-profile YAML v2 & single-instance locks**: `.agents/loops/<name>.md` & `~/.gemini/config/loops/<name>.md` with hot-reload, RCE-safe `--trust-profile-commands`, and Four-Gate Lease Locks.
- **Headless CLI & cross-reboot daemons**: `agy-loop run | resume | nudge | wake | status` + persistent Antigravity Sidecar (`CRON_TZ`), macOS `LaunchAgent`, and Linux `systemd --user` daemons.

### Live Session Preview

```text
> /agy-loop:loop check current PR CI status and fix failures --stateful
⏺ Dispatched Loop [lp_20261121T101500Z_a3f9] #1/20 to loop-worker (dynamic, stateful). Main prompt is free.
  [42s later · reactive subagent wake-up]
⏺ [Loop lp_20261121T101500Z_a3f9 #1/20] Fixed src/render.test.ts and pushed 9c41e2b | Next wake-up in 45s
> Meanwhile, explain how token caching works in src/auth.ts
⏺ Token caching in src/auth.ts stores verified JWT claims in an LRU map keyed by SHA-256...
  [45s later · timer wake-up -> Iteration #2]
⏺ [Loop lp_20261121T101500Z_a3f9 #2/20] Unit & lint checks passed; awaiting e2e matrix (4/5 green) | Next wake-up in 90s
  [90s later · timer wake-up -> Iteration #3]
⏺ [Loop lp_20261121T101500Z_a3f9 #3/20] DONE: All 5 CI checks green on PR #42; active schedule cleared.
```

### At a Glance

| Capability | Shell `sleep` | Claude Code `/loop` | AGY Loop (`v2.0.0`) |
| :--- | :--- | :--- | :--- |
| **Main Chat Availability** | Blocked while sleeping | Free between ticks | Free between ticks **and** during workers / `run_workflow` (~95% fewer turns) |
| **Context & Verification** | Pollutes main chat | Shared main window | Isolated `loop-worker` / `self` + Stage 1 `--verify-cmd` -> Stage 2 read-only `loop-verifier` |
| **Multi-Profile & Locks** | Ad-hoc scripts / `flock` | Single `.claude/loop.md` | Named `.agents/loops/*.md` + YAML v2 + Four-Gate Lease Lock (`wake`, `skip`, Exit `5`) |
| **Cross-Reboot Daemons** | Manual `crontab` | Session-scoped only | `agy-loop daemon` manages Antigravity Sidecar (`CRON_TZ`), `LaunchAgent` & `systemd --user` |
| **Cadence & Steering** | `1s` blocking | `1m` cron floor | Sub-minute `DurationSeconds`, compound `1h30m`, parallel `--targets`, atomic `inbox/` `nudge`/`wake` |
| **Isolation & Recovery** | Mutates working tree | `Ctrl+C` restarts | `--stateful` (`--reset-every`), `--worktree`/`--share`, frozen snapshots & checkpoint `resume` |

---

## 📦 Installation

- **Antigravity**: CLI `v1.5.0+` (`v1.5.9+` required for `run_workflow`) or **Antigravity Desktop**.
- **Runtime**: **Zero Node.js required** for native interactive `/agy-loop:loop`; **`Node >= 18`** (or Bun) powers the zero-dependency Headless CLI (`agy-loop run`, `daemon`, `status`, `doctor`).

**1. npm / Bun Bridge**
```bash
npx agy-loop            # or: bunx agy-loop
```
**2. Native `agy` CLI (GitHub)**
```bash
agy plugin install https://github.com/maxlee/agy-loop
```
**3. One-Line POSIX Installer (macOS & Linux)**
```bash
curl -fsSL https://raw.githubusercontent.com/maxlee/agy-loop/main/install.sh | sh
```
**4. Local Clone**
```bash
git clone https://github.com/maxlee/agy-loop.git && cd agy-loop && agy plugin install .
```

> [!TIP]
> Run `/skills reload` in any open `agy` session after installing. If migrating from loose `~/.gemini/config/` files (which take precedence over plugins), pass `--clean-shadow` (e.g., `npx agy-loop install --clean-shadow`) to archive them non-destructively; see [Shadow-File Troubleshooting & Clean Uninstall](docs/operations.md#diagnostics-shadow-file-troubleshooting--uninstall).

---

## 🧭 Commands & Parameters

### Interactive `/agy-loop:loop`

| Mode | Example | Behavior |
| :--- | :--- | :--- |
| **Fixed Interval** | `/agy-loop:loop 30s curl -fsS http://localhost:8080/health` | Chains non-overlapping `DurationSeconds` timers (`every 5m`, `1h30m`, trailing `every 2h`, or `--cron`). |
| **Dynamic Self-Paced** | `/agy-loop:loop check CI and fix failures --stateful` | Omits interval; `loop-worker` sets `NEXT_DELAY_SEC` (`120s` default fallback, clamped `[10s, 86400s]`). |
| **Profile / `loop.md`** | `/agy-loop:loop --profile ci` (or bare `/agy-loop:loop`) | Loads `.agents/loops/<name>.md`, `--file <path>`, or `.agents/loop.md` -> `loop.md` -> `~/.gemini/config/loop.md` -> built-in fallback; hot-reloads body each tick. |
| **One-Shot Delayed** | `/agy-loop:loop in 20m verify staging smoke tests` | Schedules a single non-blocking pass (`max_iterations = 1`), reports status, and exits (`--once` runs immediately). |
| **Lifecycle & Steering** | `/agy-loop:loop status`, `profiles`, `nudge`, `wake`, `stop`, `doctor`, `help` | Inspects `.agents/.agy-loop/` runs, lists profiles, queues `inbox/` nudges/wakes, stops loops (`--after-current`), or checks shadows. |

<details open>
<summary><strong>Flags Reference (<code>/agy-loop:loop</code>)</strong> — 27 flags accepted anywhere before <code>--</code></summary>

| Flag | Default | Description |
| :--- | :--- | :--- |
| `--engine <mode>` | `auto` | Engine mode: `auto`, `schedule`, or `workflow` (`auto` routes to `workflow` on workflow/lease flags). |
| `--profile <name>` | `null` | Load named profile from `.agents/loops/<name>.md` or `~/.gemini/config/loops/<name>.md`. |
| `--file <path>` | `null` | Load workspace-relative Markdown profile/task file (mutually exclusive with `--profile` & inline text). |
| `--singleton <scope>` | `profile` / `none` | Four-Gate Lease Lock scope (`profile` with `--profile`/`--file`, else `none`; `profile`, `workspace`, `none`). |
| `--on-conflict <action>` | `fail` | Live lease conflict policy: `fail`, `wake` (coalesce into `inbox/`), or `skip` (triggers `workflow`). |
| `--max <N>` | `20` (`1` w/ `--once`) | Maximum iterations before stopping cleanly with `max_reached`. |
| `--once` | `false` | Execute a single iteration (`max_iterations = 1`) and exit. |
| `--stateful` | `fresh` | Reuse the same worker conversation across ticks (`--fresh` enforces isolated fresh turns). |
| `--reset-every <N>` | `null` | Rotate `--stateful` context every `N` iterations (requires `--stateful`; triggers `workflow`). |
| `--worktree` | `inherit` | Run worker in an isolated Git branch worktree (`Workspace: "branch"`). |
| `--share` | `inherit` | Run worker in a shared working copy (`Workspace: "share"`). |
| `--model <tier>` | `flash` | Worker model tier (`inherit`, `flash_lite`, `flash`, `pro`). |
| `--self` | `loop-worker` | Delegate to built-in `self` subagent (auto-enabled for `/` prompts or MCP tools). |
| `--verify` | `false` | Enable Stage 2 read-only `loop-verifier` (`pro`) on `DONE` (triggers `workflow`). |
| `--verifier-model <tier>` | `pro` (w/ `--verify`) | Stage 2 verifier model tier (`inherit`, `flash_lite`, `flash`, `pro`; implies `--verify`). |
| `--verify-cmd <cmd>` | `null` | Stage 1 `0`-token shell verification command run on `DONE` before Stage 2 LLM verification. |
| `--verify-timeout <dur>` | `60s` | Timeout for `--verify-cmd` (e.g. `30s`, `2m`). |
| `--probe <cmd>` | `null` | Explicit shell preflight command run before each iteration (triggers `workflow`). |
| `--probe-timeout <dur>` | `60s` | Timeout for `--probe`. |
| `--probe-until-pass` | `false` | Finish `DONE` at `0` LLM tokens as soon as `--probe` exits `0` (requires `--probe`). |
| `--targets <csv>` | `[]` | Comma-separated targets executed concurrently via `parallel()` with per-target fault isolation. |
| `--max-tokens <N>` | `null` | Hard cumulative token cap across the workflow (triggers `workflow`). |
| `--max-duration <dur>` | `null` | Hard wall-clock budget (e.g. `30m`, `2h`; triggers `workflow`). |
| `--cron` | `false` | Use 5-field `CronExpression` when fixed interval `>= 60s` maps cleanly (`schedule` only). |
| `--exact` | `false` | Set `ExactTiming: true` with `--cron` to disable anti-herd jitter (`schedule` only). |
| `--daemon` | `false` | Set `IsDaemon: true` on `--cron` schedules to persist after task finish (`schedule` only). |
| `--` | `—` | End-of-options separator; passes all trailing tokens verbatim as prompt text. |

</details>

> See [docs/operations.md](docs/operations.md) for [engine auto-routing](docs/operations.md#dynamic-workflow-engine-run_workflow), [two-stage verification gates](docs/operations.md#independent-read-only-loop-verifier--two-stage-gate), and [all ways to stop a loop](docs/operations.md#how-to-exit-or-stop-a-loop).

### Headless CLI (`agy-loop`)

| Subcommand | Purpose |
| :--- | :--- |
| `run [interval] [prompt...]` | Run headless loop via `fresh` (`json`) or `--stateful` (`stream-json`) with profiles, locks & budgets |
| `resume <id\|prefix\|latest>` | Resume `stopped`, `max_reached`, `blocked`, `circuit_broken`, `error`, or `[stale]` loops from checkpoint |
| `profiles [--cwd <dir>]` | Discover and validate default `loop.md`, `.agents/loops/*.md` & `~/.gemini/config/loops/*.md` |
| `daemon <subcommand>` | Manage persistent Sidecar (`CRON_TZ`) or OS (`LaunchAgent` / `systemd --user`) daemons (`install\|list\|status\|remove\|logs`) |
| `status [--global] [--json]` | Unified runtime overview: active loops, managed daemons, lease locks & health summary |
| `nudge <target> "<msg>"` | Queue live `inbox/` steering instructions for active `workflow` or `headless` loops (`--wake`) |
| `wake <target> [--reason]` | Interrupt inter-iteration sleep early or request terminal relay at `DONE` |
| `ps [--all] [--global]` | List active or historical (`--all` / `--global`) loops across all engines (`list` alias) |
| `logs [id\|latest] [-f]` | Inspect or live-follow structured `events.jsonl` telemetry (`-n N`, `--json`) |
| `stop <target\|all>` | Stop loops immediately or gracefully (`--after-current`) across engines |
| `statusline [--global]` | Print `<5ms` zero-subprocess status segment for `settings.json` `statusLine` |
| `doctor [--clean-shadow]` | Audit capabilities, hooks, worker/verifier tools, shadows, profiles, locks & daemons |
| `validate [--remote [ref]]` | Run `agy plugin validate --strict` locally or against a remote GitHub ref |
| `install` / `uninstall` | Install/update (`npx agy-loop`) or cleanly remove the plugin (`remove` alias) |

```bash
# 1. Discover and run a named profile (explicitly trust frontmatter probe_cmd/verify_cmd)
agy-loop profiles && agy-loop run --profile ci --trust-profile-commands
# 2. Enforce singleton coalescing (wakes active holder and exits 0 without orphan dirs)
agy-loop run --profile ci --singleton profile --on-conflict wake --relay-on-wake
# 3. Gemini 4 routing, fallback & two-stage verification (0-token command + read-only verifier)
agy-loop run "Fix PR CI" --model gemini-4-hydrogen-xhigh --effort high --fallback-model gemini-4-carbon-high --verify-cmd "npm test" --verifier-model gemini-4-neon-xhigh
# 4. Persistent --stateful session with rotation & isolated Git worktree
agy-loop run 2m "Fix failing tests until green" --stateful --reset-every 6 --worktree
# 5. Live-steer, wake early, or resume from checkpoint
agy-loop nudge latest "Focus on auth tests first" --wake && agy-loop resume latest --max 30
```

| `agy-loop run` Option Group | Key Flags & Defaults |
| :--- | :--- |
| **Profiles & Lease Locks** | `--profile <name>`, `--file <path>`, `--singleton <profile\|workspace\|none>`, `--on-conflict <fail\|wake\|skip>`, `--trust-profile-commands`, `--relay-on-wake` |
| **Transport & Rotation** | `--fresh` (default, `json` per turn), `--stateful` (`stream-json`), `--reset-every <N>` |
| **Budgets & Retries** | `--max <N>` (`20`), `--once`, `--max-duration <dur>`, `--max-tokens <N>`, `--max-retries <N>` (`3`), `--max-errors <N>` (`3`), `--turn-timeout <dur>` (`10m`) |
| **Model & Two-Stage Gate** | `--model <slug\|label>`, `--effort <low\|medium\|high\|xhigh\|max>`, `--fallback-model <slug\|label>`, `--verify-cmd <cmd>`, `--verify-timeout <dur>` (`60s`), `--verifier-model <slug\|label>` |
| **Permissions & Isolation** | `--mode <auto\|accept-edits\|plan>`, `--sandbox`, `--dangerously-skip-permissions`, `--allow-slash-commands`, `--settings <json\|path>`, `--add-dir <dir>`, `--worktree`, `--keep-worktree`, `--fail-on-denied` |
| **Preflight & Output** | `--probe <cmd>`, `--probe-timeout <dur>` (`60s`), `--probe-until-pass`, `--cwd <dir>`, `--json`, `--quiet`, `--` |

> See [docs/headless-cli.md](docs/headless-cli.md) for complete examples, [`statusLine` integration](docs/headless-cli.md#observability--status-line-integration), and [Exit Codes (`0` / `1` / `2` / `3` / `4` / `5` / `130`)](docs/headless-cli.md#exit-codes-agy-loop-run--resume).

### Multi-Profile & Persistent Daemons

**`.agents/loops/ci.md`**

```markdown
---
name: ci
interval: 3m
max_iterations: 15
state_mode: stateful
reset_every: 5
worktree: true
verify: true
singleton: profile
---
1. Check `git status -sb` and run targeted tests for modified files.
2. Fix reproducible lint/CI failures minimally and emit `LOOP_STATUS: DONE`.
```

```bash
agy-loop profiles
agy-loop run --profile ci
agy-loop daemon install --profile ci --mode sidecar --cron "*/30 * * * *" --tz Asia/Shanghai --dry-run
```

> [!NOTE]
> **RCE Security Boundary**: Untrusted repository frontmatter `probe_cmd` / `verify_cmd` values are blocked by default (`--trust-profile-commands` required in Headless/OS daemons; always blocked in `run_workflow`). See [docs/profiles-and-daemons.md](docs/profiles-and-daemons.md) for the full 33-key YAML v2 schema, Four-Gate Lease Locks, Sidecar grants & OS Daemons.

---

## 📚 Documentation

| Guide | Coverage |
| :--- | :--- |
| [**Profiles, Locks & Daemons**](docs/profiles-and-daemons.md) | Multi-Profile YAML v2 schema (33 keys), `loop.md` hot-reload, `--trust-profile-commands`, Four-Gate Lease Locks, Sidecar & OS Daemons |
| [**Headless CLI Runner**](docs/headless-cli.md) | Headless options, Gemini 4 routing, live `nudge`/`wake`/`resume`, `statusLine` setup, and Exit Codes (`0`–`130`) |
| [**Operations & Reliability**](docs/operations.md) | `run_workflow` engine, parallel `--targets`, two-stage `loop-verifier`, state/crash safety, stopping loops, shadow troubleshooting, uninstall & dev checks |
| [**Technical Architecture**](ARCHITECTURE.md) | Internal architecture, Mermaid control-plane diagrams, Node/Python protocol parity & repo layout |
| [**Skill References**](skills/loop/references/) | Progressive-disclosure references ([`workflow-engine.md`](skills/loop/references/workflow-engine.md), [`profiles-and-daemons.md`](skills/loop/references/profiles-and-daemons.md), [`examples-and-loop-md.md`](skills/loop/references/examples-and-loop-md.md)) |

---

## 📄 License

Distributed under the [**MIT License**](LICENSE). Copyright © Max.

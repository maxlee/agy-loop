<div align="center">

<img src="assets/logo.svg" alt="AGY Loop Logo" width="88" height="88" />

# AGY Loop

**面向 Google Antigravity Desktop 与 CLI（`agy`）的非阻塞 `/agy-loop:loop` 调度器、动态工作流引擎与持久化后台守护工具。**

[![CI](https://github.com/maxlee/agy-loop/actions/workflows/ci.yml/badge.svg)](https://github.com/maxlee/agy-loop/actions/workflows/ci.yml)
[![Release](https://github.com/maxlee/agy-loop/releases/latest)](https://github.com/maxlee/agy-loop/releases/latest)
[![Antigravity Plugin v1](https://img.shields.io/badge/Antigravity-Plugin_v1-38BDF8.svg)](plugin.json)
[![Node >=18](https://img.shields.io/badge/Node-%3E%3D18-22C55E.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[**English**](README.md) · [**简体中文**](README.zh-CN.md) · [**安装**](#-安装) · [**命令与参数**](#-命令与参数) · [**技术文档**](#-技术文档) · [**架构说明**](ARCHITECTURE.md)

</div>

---

**AGY Loop（`v2.0.0`）** 为 **Antigravity Desktop** 与 **Antigravity CLI（`agy`）** 提供声明式、多 Profile、防重入的自动化循环能力，严守**零外部 npm/pip 依赖**，并对 `v1.x` 纯 Markdown `loop.md` **100% 向后兼容**。

- **非阻塞双引擎调度**：原生 `schedule` 定时器（挂起零 Token 消耗）+ `run_workflow` Python 工作流引擎（`agy >= 1.5.9`，主聊天回合减少 ~95%）+ 并发 `--targets`。
- **独立隔离执行与两段式验收**：独立 `loop-worker` / `--worktree` + Stage 1 零 Token `--verify-cmd` -> Stage 2 只读 `loop-verifier`。
- **YAML v2 多 Profile 与单实例租约锁**：支持 `.agents/loops/<name>.md` 与 `~/.gemini/config/loops/<name>.md` 热重载、防 RCE `--trust-profile-commands` 与四道关卡 Lease 锁。
- **Headless CLI 与跨重启守护进程**：`agy-loop run | resume | nudge | wake | status` + 持久化 Antigravity Sidecar（`CRON_TZ`）、macOS `LaunchAgent` 与 Linux `systemd --user`。

### 实时会话预览

```text
> /agy-loop:loop check current PR CI status and fix failures --stateful
⏺ 已派发 Loop [lp_20261121T101500Z_a3f9] #1/20 至 loop-worker（dynamic，stateful）。主输入框已释放。
  [42s 后 · 子代理响应式唤醒]
⏺ [Loop lp_20261121T101500Z_a3f9 #1/20] 修复 src/render.test.ts 并推送 9c41e2b | Next wake-up in 45s
> 顺便解释一下 src/auth.ts 里的 token 缓存逻辑
⏺ src/auth.ts 使用以 SHA-256 为键的 LRU Map 缓存已验签的 JWT Claims……
  [45s 后 · 定时器唤醒 -> 第 2 轮]
⏺ [Loop lp_20261121T101500Z_a3f9 #2/20] 单元测试与 Lint 已绿灯，等待 e2e 矩阵完成（4/5 通过） | Next wake-up in 90s
  [90s 后 · 定时器唤醒 -> 第 3 轮]
⏺ [Loop lp_20261121T101500Z_a3f9 #3/20] DONE: PR #42 全部 5 项 CI 检查已绿灯通过，定时任务已自动清理。
```

### 核心能力对比

| 对比维度 | Shell `sleep` | Claude Code `/loop` | AGY Loop (`v2.0.0`) |
| :--- | :--- | :--- | :--- |
| **主会话可用性** | 休眠期间锁死 | 轮次间隙可对话 | 轮次间隙**及子代理/`run_workflow` 运行期**均自由对话（主回合减少 ~95%） |
| **上下文与验收** | 污染主对话窗口 | 共享主会话历史 | 独立 `loop-worker` / `self` + Stage 1 `--verify-cmd` -> Stage 2 只读 `loop-verifier` |
| **多 Profile 与并发锁** | 零散脚本 / `flock` | 单一 `.claude/loop.md` | 命名 `.agents/loops/*.md` + YAML v2 + 四道关卡 Lease 锁（`wake`、`skip`、Exit `5`） |
| **跨重启持久守护** | 手写 `crontab` | 仅限当前会话存活 | `agy-loop daemon` 托管 Antigravity Sidecar（`CRON_TZ`）、`LaunchAgent` 与 `systemd --user` |
| **节奏粒度与纠偏** | `1s` 阻塞执行 | `1m` Cron 下限 | 秒级 `DurationSeconds`、复合时长 `1h30m`、并发 `--targets`、原子 `inbox/` `nudge`/`wake` |
| **隔离与断点恢复** | 直接改写工作区 | `Ctrl+C` 重头再来 | `--stateful`（`--reset-every`）、`--worktree`/`--share`、冻结快照与断点 `resume` |

---

## 📦 安装

- **Antigravity**：CLI `v1.5.0+`（使用 `run_workflow` 需 `v1.5.9+`）或 **Antigravity Desktop**。
- **运行环境**：原生使用交互式 `/agy-loop:loop` **无需 Node.js**；**`Node >= 18`**（或 Bun）用于运行零依赖的 Headless CLI（`agy-loop run`、`daemon`、`status`、`doctor`）。

**1. npm / Bun 桥接安装**
```bash
npx agy-loop            # 或使用 Bun：bunx agy-loop
```
**2. 原生 `agy` CLI 从 GitHub 安装**
```bash
agy plugin install https://github.com/maxlee/agy-loop
```
**3. 一行 POSIX 脚本安装（macOS & Linux）**
```bash
curl -fsSL https://raw.githubusercontent.com/maxlee/agy-loop/main/install.sh | sh
```
**4. 本地克隆源码安装**
```bash
git clone https://github.com/maxlee/agy-loop.git && cd agy-loop && agy plugin install .
```

> [!TIP]
> 安装后请在已打开的 `agy` 会话中执行一次 `/skills reload`。若本机此前散落过 `~/.gemini/config/` 同名旧文件（加载优先级高于插件），请追加 `--clean-shadow`（如 `npx agy-loop install --clean-shadow`）无损归档旧文件；完整排障与卸载命令请参阅 [同名遮蔽文件排查与干净卸载](docs/operations.md#diagnostics-shadow-file-troubleshooting--uninstall)。

---

## 🧭 命令与参数

### 交互式命令 `/agy-loop:loop`

| 模式 | 示例 | 行为说明 |
| :--- | :--- | :--- |
| **固定间隔** | `/agy-loop:loop 30s curl -fsS http://localhost:8080/health` | 链式调度防重叠 `DurationSeconds` 定时器（支持 `every 5m`、`1h30m`、后缀 `every 2h` 或 `--cron`）。 |
| **动态自适应** | `/agy-loop:loop check CI and fix failures --stateful` | 省略间隔；每轮结束后由 `loop-worker` 返回 `NEXT_DELAY_SEC`（默认 `120s`，限幅 `[10s, 86400s]`）。 |
| **Profile / `loop.md`** | `/agy-loop:loop --profile ci`（或直接 `/agy-loop:loop`） | 按 `.agents/loops/<name>.md`、`--file <path>` 或 `.agents/loop.md` -> `loop.md` -> `~/.gemini/config/loop.md` -> 内置策略解析，每轮热重载正文。 |
| **单次延时** | `/agy-loop:loop in 20m verify staging smoke tests` | 定时触发单次非阻塞检查（`max_iterations = 1`），汇报后自动停止（`--once` 则立即单轮执行）。 |
| **生命周期与纠偏** | `/agy-loop:loop status`, `profiles`, `nudge`, `wake`, `stop`, `doctor`, `help` | 查看 `.agents/.agy-loop/` 循环状态、列出 Profile、向 `inbox/` 投递纠偏/唤醒、停止循环（`--after-current`）或诊断遮蔽文件。 |

<details open>
<summary><strong>参数完整参考（<code>/agy-loop:loop</code>）</strong> — 共 27 个参数，可置于 <code>--</code> 前任意位置</summary>

| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `--engine <mode>` | `auto` | 执行引擎：`auto`、`schedule` 或 `workflow`（`auto` 遇 workflow/Lease 参数自动切入 `workflow`）。 |
| `--profile <name>` | `null` | 加载 `.agents/loops/<name>.md` 或 `~/.gemini/config/loops/<name>.md` 命名 Profile。 |
| `--file <path>` | `null` | 加载相对于工作区的显式 Markdown 任务/Profile 文件（与 `--profile` 和内联提示词互斥）。 |
| `--singleton <scope>` | `profile` / `none` | 四道关卡 Lease 锁作用域（带 `--profile`/`--file` 默认 `profile`，否则 `none`；可选 `profile`、`workspace`、`none`）。 |
| `--on-conflict <action>` | `fail` | 活实例持锁冲突策略：`fail`、`wake`（合并唤醒写入 `inbox/`）或 `skip`（触发 `workflow`）。 |
| `--max <N>` | `20`（`--once` 为 `1`） | 最大循环轮数上限，达上限自动以 `max_reached` 停止。 |
| `--once` | `false` | 仅执行单轮检查（`max_iterations = 1`）并退出。 |
| `--stateful` | `fresh` | 跨轮次复用同一 Worker 会话（传入 `--fresh` 强制每轮全新会话）。 |
| `--reset-every <N>` | `null` | 每 `N` 轮自动轮换一次 `--stateful` 上下文（须配合 `--stateful`；触发 `workflow`）。 |
| `--worktree` | `inherit` | 在独立 Git 分支工作树（`Workspace: "branch"`）中执行修改。 |
| `--share` | `inherit` | 在共享工作副本（`Workspace: "share"`）中运行子代理。 |
| `--model <tier>` | `flash` | 覆盖 Worker 模型档位（`inherit`、`flash_lite`、`flash`、`pro`）。 |
| `--self` | `loop-worker` | 改用内置全功能 `self` 子代理（`/` 开头调用斜杠技能或需 MCP 工具时自动启用）。 |
| `--verify` | `false` | Worker 报 `DONE` 时启用 Stage 2 只读 `loop-verifier`（`pro`）复验（触发 `workflow`）。 |
| `--verifier-model <tier>` | `pro`（含 `--verify`） | 指定 Stage 2 验收模型档位（`inherit`、`flash_lite`、`flash`、`pro`；隐含 `--verify`）。 |
| `--verify-cmd <cmd>` | `null` | `DONE` 时先执行的 Stage 1 零 Token 本地验证命令（早于 Stage 2 LLM 验收）。 |
| `--verify-timeout <dur>` | `60s` | `--verify-cmd` 子进程超时时长（如 `30s`、`2m`）。 |
| `--probe <cmd>` | `null` | 每轮模型执行前运行的显式 Shell 预检命令（触发 `workflow`）。 |
| `--probe-timeout <dur>` | `60s` | `--probe` 子进程超时时长。 |
| `--probe-until-pass` | `false` | 当 `--probe` 返回 `0` 时直接以 `0` Token 结束并返回 `DONE`（需配合 `--probe`）。 |
| `--targets <csv>` | `[]` | 逗号分隔的并发目标，每轮通过 `parallel()` 并发执行且单目标故障隔离。 |
| `--max-tokens <N>` | `null` | 跨轮次累计 Token 硬预算上限（触发 `workflow`）。 |
| `--max-duration <dur>` | `null` | 跨轮次墙钟总时长硬预算（如 `30m`、`2h`；触发 `workflow`）。 |
| `--cron` | `false` | 固定间隔 `>= 60s` 且可映射 5 段 Cron 时使用原生 `CronExpression`（仅限 `schedule`）。 |
| `--exact` | `false` | 配合 `--cron` 开启 `ExactTiming: true`，关闭随机抖动（仅限 `schedule`）。 |
| `--daemon` | `false` | 配合 `--cron` 开启 `IsDaemon: true`，任务完成后常驻后台继续触发（仅限 `schedule`）。 |
| `--` | `—` | 选项截止分隔符；其后所有内容原样作为任务提示词。 |

</details>

> 有关[引擎自动路由](docs/operations.md#dynamic-workflow-engine-run_workflow)、[两段式验收门禁](docs/operations.md#independent-read-only-loop-verifier--two-stage-gate)与[停止循环的全部途径](docs/operations.md#how-to-exit-or-stop-a-loop)，请参阅 [docs/operations.md](docs/operations.md)。

### 无头 CLI（`agy-loop`）

| 子命令 | 用途 |
| :--- | :--- |
| `run [interval] [prompt...]` | 运行 Headless 循环（`fresh` `json` 或 `--stateful` `stream-json`），支持 Profile、锁与预算控制 |
| `resume <id\|prefix\|latest>` | 从检查点断点续跑 `stopped`、`max_reached`、`blocked`、`circuit_broken`、`error` 或 `[stale]` 循环 |
| `profiles [--cwd <dir>]` | 发现并校验默认 `loop.md`、`.agents/loops/*.md` 与 `~/.gemini/config/loops/*.md` |
| `daemon <subcommand>` | 托管跨重启 Sidecar（`CRON_TZ`）或 OS 服务（`LaunchAgent` / `systemd --user`）（`install\|list\|status\|remove\|logs`） |
| `status [--global] [--json]` | 统一运行时总览：汇总活跃循环、托管守护进程、Lease 锁与健康摘要 |
| `nudge <target> "<msg>"` | 向活跃的 `workflow` 或 `headless` 循环原子投递 `inbox/` 纠偏指令（可选 `--wake`） |
| `wake <target> [--reason]` | 立即中断轮间休眠，或在 `DONE` 退场前触发终态接力 |
| `ps [--all] [--global]` | 列出当前或跨工作区（`--all` / `--global`）各引擎循环（支持 `list` 别名） |
| `logs [id\|latest] [-f]` | 查看或实时追踪结构化 `events.jsonl` 遥测日志（`-n N`、`--json`） |
| `stop <target\|all>` | 跨引擎立即停止循环，或传入 `--after-current` 等待当前轮收尾后停止 |
| `statusline [--global]` | 输出 `<5ms` 零子进程紧凑状态栏片段（可接入 `settings.json` `statusLine`） |
| `doctor [--clean-shadow]` | 深度诊断能力矩阵、钩子、Worker/Verifier 工具、遮蔽文件、Profile、锁与守护进程 |
| `validate [--remote [ref]]` | 在本地或针对远端 GitHub Ref 执行 `agy plugin validate --strict` 校验 |
| `install` / `uninstall` | 安装更新（`npx agy-loop`）或干净卸载插件（支持 `remove` 别名） |

```bash
# 1. 发现并运行命名 Profile（若 frontmatter 含 probe_cmd/verify_cmd 需显式授权）
agy-loop profiles && agy-loop run --profile ci --trust-profile-commands
# 2. 启用单实例冲突合并（向活跃持有者写入 wake 并以 0 退出，不生成多余目录）
agy-loop run --profile ci --singleton profile --on-conflict wake --relay-on-wake
# 3. Gemini 4 模型路由 + 降级 + 两段式验收（0 Token 命令 + 只读 Verifier）
agy-loop run "Fix PR CI" --model gemini-4-hydrogen-xhigh --effort high --fallback-model gemini-4-carbon-high --verify-cmd "npm test" --verifier-model gemini-4-neon-xhigh
# 4. 持久 --stateful 会话（定期轮换）与独立 Git Worktree 隔离
agy-loop run 2m "Fix failing tests until green" --stateful --reset-every 6 --worktree
# 5. 实时纠偏、提前唤醒与断点续跑
agy-loop nudge latest "Focus on auth tests first" --wake && agy-loop resume latest --max 30
```

| `agy-loop run` 参数分组 | 核心选项与默认值 |
| :--- | :--- |
| **Profile 与 Lease 锁** | `--profile <name>`、`--file <path>`、`--singleton <profile\|workspace\|none>`、`--on-conflict <fail\|wake\|skip>`、`--trust-profile-commands`、`--relay-on-wake` |
| **传输与上下文轮换** | `--fresh`（默认，每轮 `json`）、`--stateful`（`stream-json`）、`--reset-every <N>` |
| **预算与容错重试** | `--max <N>`（`20`）、`--once`、`--max-duration <dur>`、`--max-tokens <N>`、`--max-retries <N>`（`3`）、`--max-errors <N>`（`3`）、`--turn-timeout <dur>`（`10m`） |
| **模型与两段式验收** | `--model <slug\|label>`、`--effort <low\|medium\|high\|xhigh\|max>`、`--fallback-model <slug\|label>`、`--verify-cmd <cmd>`、`--verify-timeout <dur>`（`60s`）、`--verifier-model <slug\|label>` |
| **权限与工作区隔离** | `--mode <auto\|accept-edits\|plan>`、`--sandbox`、`--dangerously-skip-permissions`、`--allow-slash-commands`、`--settings <json\|path>`、`--add-dir <dir>`、`--worktree`、`--keep-worktree`、`--fail-on-denied` |
| **预检与输出控制** | `--probe <cmd>`、`--probe-timeout <dur>`（`60s`）、`--probe-until-pass`、`--cwd <dir>`、`--json`、`--quiet`、`--` |

> 完整示例、[`statusLine` 状态栏接入](docs/headless-cli.md#observability--status-line-integration)与[退出码契约（`0` / `1` / `2` / `3` / `4` / `5` / `130`）](docs/headless-cli.md#exit-codes-agy-loop-run--resume)请参阅 [docs/headless-cli.md](docs/headless-cli.md)。

### 多 Profile 与持久化守护进程

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
1. 检查 `git status -sb` 并运行改动文件的相关增量测试。
2. 最小化修复可复现的 Lint/CI 失败并在通过后返回 `LOOP_STATUS: DONE`。
```

```bash
agy-loop profiles
agy-loop run --profile ci
agy-loop daemon install --profile ci --mode sidecar --cron "*/30 * * * *" --tz Asia/Shanghai --dry-run
```

> [!NOTE]
> **RCE 安全红线**：仓库 frontmatter 中的 `probe_cmd` 与 `verify_cmd` 默认严格拦截（Headless / OS 守护需显式 `--trust-profile-commands`；`run_workflow` 沙箱外永久禁止执行）。完整的 33 个 YAML v2 键名规范、四道关卡 Lease 锁、Sidecar 权限白名单与 OS 守护请参阅 [docs/profiles-and-daemons.md](docs/profiles-and-daemons.md)。

---

## 📚 技术文档

| 文档 | 内容范围 |
| :--- | :--- |
| [**多 Profile、Lease 锁与持久守护**](docs/profiles-and-daemons.md) | YAML v2 规范（33 个主键）、`loop.md` 热重载、`--trust-profile-commands`、四道关卡 Lease 锁、Sidecar 与 OS 守护 |
| [**Headless CLI 运行器**](docs/headless-cli.md) | Headless 参数详解、Gemini 4 路由、实时 `nudge`/`wake`/`resume`、`statusLine` 接入与退出码（`0`–`130`） |
| [**工作流引擎与运维排障**](docs/operations.md) | `run_workflow` 引擎、并发 `--targets`、两段式 `loop-verifier`、状态/崩溃安全、停止循环、遮蔽文件排查、卸载与本地校验 |
| [**架构设计说明**](ARCHITECTURE.md) | 内部架构、Mermaid 控制面流程图、Node/Python 字节级协议对齐与仓库目录结构 |
| [**Skill 渐进式参考文档**](skills/loop/references/) | 按需加载参考指南（[`workflow-engine.md`](skills/loop/references/workflow-engine.md)、[`profiles-and-daemons.md`](skills/loop/references/profiles-and-daemons.md)、[`examples-and-loop-md.md`](skills/loop/references/examples-and-loop-md.md)） |

---

## 📄 许可证

基于 [**MIT License**](LICENSE) 协议开源发布，Copyright © Max.

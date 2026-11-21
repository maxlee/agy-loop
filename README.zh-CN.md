<div align="center">

<img src="assets/logo.svg" alt="AGY Loop Logo" width="88" height="88" />

# AGY Loop (`agy-loop`)

**专为 Google Antigravity 桌面端与 CLI (`agy`) 打造的纯原生非阻塞循环调度插件（`/agy-loop:loop`），基于内置 `schedule` 定时器、隔离子代理与 `loop.md` 热重载构建**

[![CI](https://github.com/maxlee/agy-loop/actions/workflows/ci.yml/badge.svg)](https://github.com/maxlee/agy-loop/actions/workflows/ci.yml)
[![Release](https://github.com/maxlee/agy-loop/actions/workflows/release.yml/badge.svg)](https://github.com/maxlee/agy-loop/releases/latest)
[![Antigravity Plugin v1](https://img.shields.io/badge/Antigravity-Plugin_v1-38BDF8.svg)](plugin.json)
[![Node >=18](https://img.shields.io/badge/Node-%3E%3D18-22C55E.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[**English**](README.md) · [**简体中文**](README.zh-CN.md) · [**核心优势**](#-为什么选择-agy-loop) · [**快速安装**](#-安装指南) · [**斜杠命令**](#-斜杠命令运行模式与参数参考) · [**Headless 运行器**](#-headless-cli-运行器) · [**`loop.md` 热重载**](#-agentsloopmd-热重载指南) · [**退出与停止**](#-如何退出或停止循环) · [**架构设计**](ARCHITECTURE.md)

</div>

---

**AGY Loop** 为 **Antigravity 桌面端**（原生兼容 Marketplace）与 **Antigravity CLI (`agy`)** 带来真正非阻塞、上下文完全隔离的 `/agy-loop:loop` 循环调度命令，并提供面向终端、SSH 与 CI/CD 流水线的生产级 **Headless CLI 运行器**（`agy-loop run | ps | logs | stop | statusline`）。告别使用 Shell `sleep` 锁死主对话回合或将几十轮构建、测试与 CI 日志塞满主窗口的做法：交互模式下，`agy-loop` 将每一轮检查与修复派发给独立上下文的后台 `loop-worker`（或 `self`）子代理执行，并在轮次间隙通过原生 `schedule` 工具以**零 Token 消耗**挂起休眠；无头模式下，则直接通过 CLI 驱动 `agy` 单轮 `json` 或持久 `stream-json` 会话。

> 设计灵感源自 Claude Code 的 [`/loop` 工作流](https://claude.com/resources/articles/getting-started-with-loops)，深度结合 Antigravity 的响应式子代理唤醒、秒级 `DurationSeconds` 定时器、`Idle` 有状态重唤醒与 Git Worktree 分支隔离机制原生实现。

---

## 📸 实时会话预览

```text
> /agy-loop:loop check current PR CI status and fix failures --stateful

⏺ 已派发 Loop [lp_20261121T101500Z_a3f9] #1/20 至后台 loop-worker（dynamic，stateful，workspace=inherit）。主输入框已释放，可随时继续对话。

  [42s 后 · 子代理完成响应式唤醒]
⏺ [Loop lp_20261121T101500Z_a3f9 #1/20] 修复 src/render.test.ts 快照断言并推送提交 9c41e2b，CI 重新运行中 | Next wake-up in 45s (self-paced)

> 顺便帮我解释一下 src/auth.ts 里的 token 缓存逻辑
⏺ src/auth.ts 使用以 SHA-256 为键的 LRU Map 缓存已验签的 JWT Claims……
  （后台定时器以 0 token/s 静默等待，主对话上下文始终保持清爽。）

  [45s 后 · 定时器唤醒 -> 第 2 轮检查]
⏺ [Loop lp_20261121T101500Z_a3f9 #2/20] 单元测试与 Lint 已绿灯，等待 e2e 矩阵完成（4/5 通过） | Next wake-up in 90s (self-paced)

  [90s 后 · 定时器唤醒 -> 第 3 轮检查]
⏺ [Loop lp_20261121T101500Z_a3f9 #3/20] DONE: PR #42 全部 5 项 CI 检查已绿灯通过，定时任务已自动清理。
```

---

## ⚡ 为什么选择 AGY Loop？

| 对比维度 | Shell `sleep` 循环 | Claude Code `/loop` | AGY Loop (`agy-loop`) |
| :--- | :--- | :--- | :--- |
| **等待机制** | Shell `sleep` 阻塞回合 | 内置会话 Cron 队列 | 原生非阻塞 `schedule` 定时器与 Cron |
| **主会话可用性** | 等待期锁死，无法输入 | 轮次间隙可正常对话 | 轮次间隙**及子代理执行期间**均可自由对话 |
| **上下文隔离** | 构建/测试日志塞满主窗口 | 共享主会话历史记录 | 独立 `loop-worker` / `self` 干净窗口，主窗口仅留单行摘要 |
| **最小时间粒度** | `1s`（阻塞前台） | `1m` Cron 下限（`30s` 会向上取整为 `1m`） | 秒级 `DurationSeconds`（`15s`、`30s`）与复合时长（`1h30m`、`2m30s`） |
| **动态退避与熔断** | 仅固定间隔 | 模型估算 `1m–1h` 延迟 | `NEXT_DELAY_SEC` 限幅 `[10s, 86400s]`、3 次异常熔断与 `loop_id` 状态层 |
| **`loop.md` 热重载** | 不支持 | `.claude/loop.md` 与 `~/.claude/loop.md` | 每轮实时重读：`.agents/loop.md` -> `loop.md` -> `~/.gemini/config/loop.md` -> 内置维护兜底 |
| **多轮修 Bug 记忆** | 全量日志堆积膨胀 | 混杂在主对话历史中 | 可选 `--stateful` 通过 `send_message` 唤醒 `Idle` 子代理，隔离保留排查上下文 |
| **高风险代码修改隔离** | 直接修改当前工作区 | 直接修改当前工作区 | 可选 `--worktree`（`branch` 工作树 + 清理前汇报 diff/merge）或 `--share` 副本 |

---

## 📦 安装指南

### 环境要求

- **Antigravity CLI (`agy`)** `v1.5.0+`（已通过 `v1.5.14` 严格插件校验、`oneharness` 工具注册表与 Headless `json` / `stream-json` 双传输协议验证）或 **Antigravity 桌面端**
- **原生安装零 Node.js / npm 依赖**：通过 `agy plugin install` 或一行 `curl` 脚本安装并使用交互式 **`/agy-loop:loop`** 无需任何 Node 运行时；**`Node.js >= 18`** 用于驱动零外部依赖的 `npx agy-loop` CLI 桥接器及 Headless **`agy-loop run | ps | logs | stop | statusline`** 运行器（也可通过 `Bun` 运行 CLI 桥接器）

`agy-loop` 采用**纯原生、兼容 Marketplace 的双栖包架构**：仓库根目录既是符合严格 v1 规范的 Antigravity 原生插件（`plugin.json`、`hooks.json`、`skills/loop/SKILL.md`、`agents/loop-worker.md`），也是零外部依赖的 npm CLI（`bin/agy-loop.mjs` + `lib/*.mjs`）。安装完成后：

- 遵循 Antigravity 原生插件的命名空间规范，插件内技能在 **Antigravity 桌面端** 与 **Antigravity CLI (`agy`)** 中统一注册为 **`/agy-loop:loop`**，无需向 `~/.gemini/config/skills/` 额外写入散落文件，完整兼容官方 Marketplace 分发。
- 在 Antigravity 桌面端（**Customizations -> Plugins** 或 **Marketplace** 插件卡片）中，可直接点击内置的 3 个快捷引导胶囊（`suggestedPrompts`）一键启动常用巡检或查看 `/agy-loop:loop status`。
- 若安装时 `agy` 会话已处于打开状态，先执行一次 **`/skills reload`** 即可在 `/` 自动补全菜单中立即看到 `/agy-loop:loop`。

### 方式一：通过 `npx` / `bunx` 安装（npm 零依赖桥接）

```bash
npx agy-loop
# 或使用 Bun：
bunx agy-loop
```

如果你此前手动创建过 `~/.gemini/config/skills/loop` 或 `~/.gemini/config/agents/loop-worker.md`，由于 Antigravity 加载个人全局目录的优先级高于插件目录，旧文件会遮蔽（Shadow）插件版本。追加 `--clean-shadow` 即可安装 `agy-loop` 并将旧文件自动安全归档至 `~/.gemini/config/.agy-loop-backup-<YYYYMMDD-HHMMSSZ>/`：

```bash
npx agy-loop install --clean-shadow
```

### 方式二：通过 `agy` CLI 从 GitHub 直接安装

```bash
agy plugin install https://github.com/maxlee/agy-loop
```

> **若本机已有手动创建的同名文件：** `agy plugin install` 仅将插件安装至插件目录，不会自动移除此前散落在 `~/.gemini/config/skills/loop/SKILL.md` 或 `~/.gemini/config/agents/loop-worker.md` 的旧文件（它们会优先覆盖 `loop-worker` 子代理并抢占 `/loop`，即便显式运行 `/agy-loop:loop` 也会受到旧版 `loop-worker` 遮蔽影响）。`agy-loop` 内置零开销 `SessionStart` 钩子（`hooks.json`），无冲突时完全静默（`0` Token），检测到同名遮蔽文件时会在启动会话时自动提醒。无需安装 Node/npm，只需一行命令即可无损归档旧文件：
>
> ```bash
> sh ~/.gemini/config/plugins/agy-loop/install.sh --clean-shadow
> ```
>
> 随后在已打开的会话中执行 `/skills reload` 即可生效；也可直接在 `agy` 内运行 `/agy-loop:loop doctor --clean-shadow`，或执行 `npx agy-loop doctor --clean-shadow`。

### 方式三：一行 POSIX 脚本安装（macOS & Linux）

```bash
curl -fsSL https://raw.githubusercontent.com/maxlee/agy-loop/main/install.sh | sh
```

安装同时自动备份并清理同名全局遮蔽文件：

```bash
curl -fsSL https://raw.githubusercontent.com/maxlee/agy-loop/main/install.sh | sh -s -- --clean-shadow
```

### 方式四：克隆源码本地安装

```bash
git clone https://github.com/maxlee/agy-loop.git
cd agy-loop
agy plugin install .
```

---

## 🧭 斜杠命令、运行模式与参数参考

### 5 大调用模式

| 运行模式 | 命令示例 | 行为说明 |
| :--- | :--- | :--- |
| **1. 固定间隔 + 任务提示词** | `/agy-loop:loop 30s curl -fsS http://localhost:8080/health`<br>`/agy-loop:loop every 5m check the deploy`<br>`/agy-loop:loop 1h30m check backup`<br>`/agy-loop:loop check PR #42 comments every 2h` | 按固定周期（`s`、`m`、`h`、`d`）执行，支持前置 `every <dur>`、后缀 `every` 与复合时长（`1h30m`、`2m30s`；小数 `1.5m` 将退出码 `2` 报错）。默认使用防重叠 `DurationSeconds` 链式定时器，传入 `--cron` 时切换 5 段式 `CronExpression`。 |
| **2. 动态自适应节奏（Self-Paced）** | `/agy-loop:loop check CI and fix failures`<br>`/agy-loop:loop run pytest and fix failing tests --stateful` | 省略时间间隔。每轮结束后由 `loop-worker` 返回 `NEXT_DELAY_SEC`（缺失或非正整数回退 `120s`，并严格限幅至 `[10s, 86400s]`）。 |
| **3. `loop.md` 热重载维护巡检** | `/agy-loop:loop`<br>`/agy-loop:loop 15m` | 省略内联提示词。每轮唤醒强制通过 `resolve-task` 按 `.agents/loop.md` -> `loop.md` -> `~/.gemini/config/loop.md` -> 内置策略读取（上限 `25,000` 字节，超长截断时主动提醒）。 |
| **4. 单次延时检查（One-Shot）** | `/agy-loop:loop in 20m verify staging smoke tests`<br>`/agy-loop:loop --once 10m check if docker build finished` | 创建单次非阻塞 `DurationSeconds` 定时器（`max_iterations = 1`），到点唤醒子代理执行一轮检查并汇报结果后自动结束。 |
| **5. 生命周期管理与诊断** | `/agy-loop:loop status [--all]`（或 `list`）<br>`/agy-loop:loop stop [<id1> <id2>\|all] [--after-current]`<br>`/agy-loop:loop doctor [--clean-shadow]`<br>`/agy-loop:loop help` | 关联 `.agents/.agy-loop/` `loop_id` 状态与定时器/子代理列表、按多目标或 `--after-current` 优雅停止循环、诊断（或归档）遮蔽文件/`skills.json`/`active_loops`，或输出速查帮助。 |

### 参数（Flags）完整参考

所有参数均可放置在 `--` 之前的任意位置（前置位未知参数或近拼写错字如 `--statefull`、`--max-iter` 会直接 Exit `2` 拦截；提示词中段/尾部的真实命令参数如 `gh pr checks --required` 会透传并输出一条提示，也可使用 `--` 显式截止参数解析）：

| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `--max <N>` | `20`（`--once` 时为 `1`） | 最大循环轮数安全上限，达标前若触顶将自动停止并汇总，防止无人值守时消耗过多配额。 |
| `--stateful` | `fresh` | 跨轮次复用同一个 `loop-worker` 会话 ID，通过 `send_message` 唤醒处于 `Idle` 状态的子代理，在不污染主窗口的前提下保留多轮排障记忆。 |
| `--worktree` | `inherit` | 在独立 Git 分支工作树（`Workspace: "branch"`）中运行。`agy v1.5.5+` 会继承父工作区脏改动，编排器会记录 `worktree_branch` 并在清理前汇报 `git diff --stat` 与合并命令。 |
| `--share` | `inherit` | 在共享工作副本（`Workspace: "share"`）中运行子代理。 |
| `--model <tier>` | `flash`（`loop-worker`） | 覆盖子代理模型档位：支持 `inherit`、`flash_lite`、`flash`、`pro`。 |
| `--self` | `loop-worker` | 改用内置全功能 `self` 子代理执行每轮任务（当提示词以 `/` 开头调用其他斜杠技能如 `/agy-loop:loop 20m /code-review` 或需使用 MCP 工具时也会自动启用）。 |
| `--cron` | `false` | 当固定间隔 `>= 60s` 且可精确映射为标准 5 段 Cron（`1m`、`60m` 约数、`24h` 约数、`1d`）时，启用原生 `CronExpression` 周期调度，并结合 `state-read` 彻底消除静态 Prompt 漂移。 |
| `--exact` | `false` | 配合 `--cron` 开启 `ExactTiming: true`，在整分时刻精确触发，关闭防惊群随机抖动（Jitter）。 |
| `--daemon` | `false` | 配合 `--cron` 开启 `IsDaemon: true`，作为常驻后台任务在当前前台目标完成后继续按周期触发。 |
| `--once` | `false` | 仅延时执行单轮检查（`max_iterations = 1`），汇报后立即退出。 |
| `--` | — | 选项截止分隔符：其后所有参数原样作为任务提示词，不再触发 flag 解析或未知参数告警。 |

---

## 🛡️ 可靠性、沙箱安全状态层与双引擎 Worker

- **6 工具双引擎交集 `loop-worker`（桌面端 Cortex + CLI `oneharness`）**：`agents/loop-worker.md` 精确声明了在桌面端与 `agy v1.5.14` CLI `oneharness` 均受支持的 6 个工具（`view_file`、`write_to_file`、`replace_file_content`、`run_command`、`manage_task`、`search_web`）。已移除 4 个仅存在于旧 Cortex、在 `oneharness` 注册表中缺失并导致加载中断的工具（`multi_replace_file_content`、`list_dir`、`find_by_name`、`grep_search`）；目录枚举与代码检索统一由沙箱内 `run_command`（`rg`/`grep`/`find`/`ls`）完成。
- **沙箱安全统一状态控制面（`.agents/.agy-loop/`）**：由于 `agy v1.5.7+` 默认 `auto` 沙箱禁止 `run_command` 写入 `~/.gemini/antigravity-cli/plugin_data/`，循环状态统一落盘于 `<workspace>/.agents/.agy-loop/loops/<loop_id>/{state.json,events.jsonl}`（支持 `AGY_LOOP_STATE_DIR` 覆盖，并自动创建内容为 `*` 的 `.gitignore` 避免污染仓库或 `v1.5.5+` worktree）。交互式 `/agy-loop:loop`（`state-read`）与 Headless `agy-loop run` 共用同一状态目录，彻底根除 `--cron` 静态 Prompt 漂移并抵御上下文压缩丢失。
- **连续 3 次异常熔断与延迟限幅**：若子代理未输出合法 4 行契约（或 Headless 轮次返回非法结构/脏数据），累计 `consecutive_errors` 达 3 次（`--max-errors 3`）自动置为 `circuit_broken`、清理定时器并告警停止；动态 `NEXT_DELAY_SEC` 缺失/非法时默认 `120s`，并强制限幅至 `[10s, 86400s]`。

---

## 🤖 Headless CLI 运行器

**（`agy-loop run` · `ps` · `logs` · `stop` · `statusline`）**

基于 `Node.js >= 18` 且**零外部 npm 依赖**，专为本地终端、SSH、Cron 与 CI/CD 流水线打造（`npx agy-loop run ...` 或全局安装 `agy-loop run ...`）。Headless 运行器与交互式 `/agy-loop:loop` 完全共用 `.agents/loop.md` 热重载与 `<workspace>/.agents/.agy-loop/` 状态存储，默认遵循本机 `agy` 权限配置（除非显式传入 `--mode`、`--sandbox` 或 `--dangerously-skip-permissions`），并提供严格 JSON Schema 校验、模型/降级/独立验收路由、硬预算熔断及规范 CI 退出码。

### 快速上手示例

```bash
# 1. 单次执行检查（立即执行或使用 `in <delay>` 延时执行）
agy-loop run --once "Inspect git status and summarize any failing tests"
agy-loop run in 20m "Verify staging smoke tests and report status"

# 2. 自适应 CI 循环：指定 Gemini 4 模型、推理档位、降级模型与独立只读验收模型
agy-loop run "Check PR CI status and fix failing checks" \
  --model gemini-4-hydrogen-xhigh \
  --effort high \
  --fallback-model gemini-4-carbon-high \
  --verifier-model gemini-4-neon-xhigh

# 3. 持久双向 `stream-json` 会话（`--stateful`），每 6 轮自动轮换上下文（`--reset-every 6`）
agy-loop run 2m "Run unit tests and fix failures until green" --stateful --reset-every 6

# 4. 独立 Git Worktree 分支隔离运行（无修改无提交自动清理；有改动保留并输出合并命令）
agy-loop run "Refactor flaky auth tests and commit verified fixes" --worktree

# 5. 零 Token Shell 预检（`--probe` + `--probe-until-pass`）
# 每轮调用模型前先执行 `npm test`；一旦退出码为 0 则零 Token 直接结束并返回 DONE
agy-loop run 30s "Fix remaining TypeScript errors" --probe "npm test" --probe-until-pass

# 6. Token 与墙钟硬预算控制 + CI 结构化 JSON 输出
agy-loop run --max 10 --max-tokens 250000 --max-duration 30m --json "Stabilize build"
```

### Headless 核心参数一览（`agy-loop run`）

完整复用 `/agy-loop:loop` 间隔语法（`30s`、`1h30m`、`every 5m`、`in 20m`、后缀 `every 2h`，省略提示词自动热重载 `.agents/loop.md`），并支持以下专项能力：

| 类别 | 核心参数 | 行为与默认值说明 |
| :--- | :--- | :--- |
| **传输与上下文轮换** | `--fresh`（默认）、`--stateful`、`--reset-every <N>` | `fresh` 每轮独立调用 `agy --output-format json`；`--stateful` 复用持久 `stream-json` 进程（配合 `--reset-every N` 定期重置上下文）。 |
| **预算与容错熔断** | `--max <N>`（`20`）、`--once`、`--max-duration <dur>`、`--max-tokens <N>`、`--max-retries <N>`（`3`）、`--max-errors <N>`（`3`）、`--turn-timeout <dur>`（`10m`） | 严格限制轮次、总时长与累计 Token；对 `print_timeout` / 瞬态 `429` 自动指数退避重试（`30s -> 60s -> 120s`，含抖动）；连续契约/运行错误触顶即熔断。 |
| **模型与独立验收路由** | `--model <slug\|label>`、`--effort <low\|medium\|high\|xhigh\|max>`、`--fallback-model <slug\|label>`、`--verifier-model <slug\|label>` | 通过 `agy --output-format json models` 校验模型 slug 或显示名（命中 `Orchestrator` 自动省略 `--effort`）；配额/限流时自动切至 `--fallback-model`；worker 报 `DONE` 时触发只读 `--verifier-model` 独立复核。 |
| **权限与工作区隔离** | `--mode <auto\|accept-edits\|plan>`、`--sandbox`、`--dangerously-skip-permissions`、`--allow-slash-commands`、`--settings <json\|path>`、`--add-dir <dir>`、`--worktree`、`--keep-worktree`、`--fail-on-denied` | 默认透传本机 `agy` 模式不覆写；默认禁用意外斜杠命令展开（除非指定 `--allow-slash-commands`）；`--worktree` 在 `<state>/worktrees/<loop_id>` 创建 `agy-loop/<loop_id>` 分支；开启 `--fail-on-denied` 时软拒绝工具调用（`denied_actions[]`）直接按 `BLOCKED`（Exit `3`）处理。 |
| **预检与输出控制** | `--probe <cmd>`、`--probe-timeout <dur>`（`60s`）、`--probe-until-pass`、`--cwd <dir>`、`--json`、`--quiet`、`--` | 每轮先运行有界 `--probe` 命令（失败时注入输出尾段，或配合 `--probe-until-pass` 零 Token 通过）；`--json` 输出最终结构化 JSON 摘要；`--` 后所有参数原样作为提示词。 |

### 观测与生命周期管理命令

> **向后兼容说明：** `agy-loop status` 继续保留为 `agy-loop doctor`（健康诊断）的别名；查看运行中或历史循环请使用 **`agy-loop ps`**（或 `list`）。

```bash
# 查看当前工作区活跃循环（`--all` 含已结束记录；`--global` 查询跨工作区索引；自动标记 `[stale]` 僵尸进程）
agy-loop ps [--all] [--global] [--json]

# 回放或实时追踪结构化迭代日志与每轮增量 Token 遥测（支持完整 ID、唯一前后缀或 `latest`）
agy-loop logs [id|latest] [-f] [-n N] [--json]

# 停止指定循环、前缀匹配循环或全部活跃循环（默认写 control.json 并向 Headless PID 发送 SIGTERM；`--after-current` 等当前轮结束）
agy-loop stop <id|--all> [--after-current]

# 输出 <5ms 零子进程紧凑状态栏片段（无活跃循环时静默空输出，自动过滤 stale 进程）
agy-loop statusline [--global] [--no-color] [--json]
```

**将 `agy-loop statusline` 接入 Antigravity CLI 状态栏（`~/.gemini/antigravity-cli/settings.json`）：**

```json
{
  "statusLine": {
    "type": "command",
    "command": "agy-loop statusline",
    "stack_with_default": true
  }
}
```

*（若仅通过 `agy plugin install` 安装而未全局执行 `npm install -g agy-loop`，可将 `"command"` 设为 `"node ~/.gemini/config/plugins/agy-loop/bin/agy-loop.mjs statusline"`，实现 `<5ms` 无 `npx` 启动开销响应；`"stack_with_default": true` 会在 `agy` 官方默认状态栏下方叠加显示活跃循环。）*

### Headless 退出码契约（`agy-loop run`）

| 退出码 | 终态 | 含义说明 |
| :--- | :--- | :--- |
| **`0`** | `DONE` / `--once` / `--probe-until-pass` | 目标达成返回 `DONE`、`--probe-until-pass` 预检通过（零 Token），或 `--once` 单次检查正常执行结束（`DONE` 或 `CONTINUE`）。 |
| **`1`** | `error` / `circuit_broken` | 运行时错误（如缺少 `agy`、`agy` Exit `1`、末轮/`--once` 触发 `verifier_error`），或连续错误达到 `--max-errors`（默认 `3`）触发熔断。 |
| **`2`** | 参数或配置错误 | 未知参数、冲突参数（如 `--stateful` 与 `--fresh` 混用）、非法时长/预算、无法识别的模型名称，或 `agy` 配置报错（Exit `2`）。 |
| **`3`** | `BLOCKED` | Worker 返回 `BLOCKED`、命中不可重试的硬配额/计费上限、`--verifier-model` 在末轮/`--once` 验收驳回，或软拒绝工具调用命中 `--fail-on-denied`。 |
| **`4`** | `max_reached` | 多轮循环在达成 `DONE` 前耗尽 `--max` 轮次、`--max-duration` 或 `--max-tokens` 预算。 |
| **`130`** | `stopped` | 收到 `SIGINT`/`SIGTERM` 中断，或被 `agy-loop stop` 手动终止。 |

---

## 🔄 `.agents/loop.md` 热重载指南

当直接运行 `/agy-loop:loop` 或仅指定间隔的 `/agy-loop:loop 15m`（未附带内联提示词）时，`agy-loop` 会在**每一轮唤醒时**按以下优先级动态解析巡检指令（单文件读取上限 `25,000` 字节）：

1. 当前工作区下的 **`.agents/loop.md`**（项目级团队或仓库巡检规范）
2. 当前工作区根目录下的 **`loop.md`**
3. 全局配置目录下的 **`~/.gemini/config/loop.md`**（跨仓库个人默认巡检策略）
4. **内置分支维护兜底协议**：依次检查仓库未完成改动与增量测试、通过 `gh`（若已安装登录）检查当前分支 PR 评审意见与最新 CI 状态；若全部正常则单行汇报绿灯。

由于每一轮唤醒都会重新调用 `skills/loop/scripts/loop-helper.sh resolve-task` 读取文件，你可以在后台循环运行期间随时保存修改 `.agents/loop.md`，下一轮唤醒将自动加载最新策略，无需取消或重启 `/agy-loop:loop`。

### `.agents/loop.md` 实用模板示例

```markdown
# 分支值守与自动修复策略

1. 优先运行当前改动关联的增量测试或 `npm test`。
2. 若测试失败，定位根因并做最小化代码修复，在同一轮内重新执行失败用例确认修复结果。
3. 若本机 `gh` 已登录且当前分支存在打开状态的 PR：
   - 执行 `gh pr checks` 检查是否有红灯 CI 任务；
   - 查看未解决的 Review 评论并处理明确的机械性修改建议。
4. 当本地测试通过且 PR 全部检查绿灯时返回 `LOOP_STATUS: DONE` 自动结束循环；若遇到需要人工拍板的架构分歧或缺少密钥凭证，返回 `LOOP_STATUS: BLOCKED`。
```

---

## 🛑 如何退出或停止循环

除满足条件自动退出外，你可以随时通过以下 4 种方式干净终止循环：

1. **斜杠命令一键停止（`/agy-loop:loop stop`）**
   输入 `/agy-loop:loop stop`（或 `/agy-loop:loop stop <id1> <id2>`、`/agy-loop:loop stop <id> --after-current`、`/agy-loop:loop cancel`），编排器会先调用 `state-stop` 更新 `.agents/.agy-loop/` 状态，再通过 `manage_task(Action="kill")` 与 `manage_subagents(Action="kill")` 精确清理关联定时器和子代理（有未合并提交的 `branch` 工作树会优先保留以便人工合入）。
2. **自然语言对话停止**
   直接在输入框发送：`取消当前的 loop 定时任务`（或 `等当前这一轮子代理返回后停止 loop`）。
3. **CLI 交互式管理面板（`/tasks` 与 `/agents`）**
   - 输入 **`/tasks`** 打开后台任务面板，选中对应的 `schedule` 定时器或 Cron 按 **`k`** 键取消后续触发（按 `x` 清理已完成记录）。
   - 输入 **`/agents`** 打开子代理面板，选中状态为 `running` 或 `idle` 的 `loop-worker` 按 **`k`** 键立即终止（`--worktree` 创建的临时分支工作区会自动回收）。子代理等待命令审批时，可按 **`Ctrl+K`** 快速放行，或按 **`Alt+J`** 瞬移进入子代理实时视图（按 `Esc` 返回主会话）。
4. **键盘中断当前回合（`Esc`）**
   在 `agy` CLI 中直接按 **`Esc`** 键可立即中断主代理当前正在执行的派发动作，控制权回到输入框且不会退出 CLI（连按两次 `Ctrl+C` 会退出整个 CLI）。

**内置自动退出保护**：当子代理返回 `LOOP_STATUS: DONE`（目标达成）、`LOOP_STATUS: BLOCKED`（缺少权限、沙箱拦截或需人工决策）、循环次数达到 `--max <N>`（默认 `20` 轮），或连续 3 次未按契约返回/运行时报错触发熔断（`circuit_broken`）时，调度器会自动清理残留定时任务并结束循环。

---

## 🧹 诊断、卸载与本地校验

### 故障排查：同名遮蔽文件处理（Shadowing）

Antigravity 加载个人全局配置目录 `~/.gemini/config/` 的优先级高于已安装插件目录（`~/.gemini/config/plugins/agy-loop/`）。当你直接通过 `agy plugin install https://github.com/maxlee/agy-loop` 安装插件时，Antigravity 仅部署插件文件，不会删除本机原有的 `~/.gemini/config/skills/loop/SKILL.md` 或 `~/.gemini/config/agents/loop-worker.md`，从而导致这些旧文件优先接管未命名空间化的 `loop-worker` 子代理（即便显式运行 `/agy-loop:loop` 也会受到旧版 `loop-worker` 遮蔽影响）并抢占 `/loop`。

为彻底避免静默遮蔽：

- **零开销 `SessionStart` 自动检测钩子（`hooks.json`）**：会话启动时自动运行纯 POSIX 脚本 `skills/loop/scripts/loop-helper.sh session-start`。严格遵守 `agy v1.5.13+`（已在 `v1.5.14` 验证）`protojson` 规范（零 stdin 字段回显），环境干净时 `<5ms` 直接返回 `{}`（**`0` Token 开销**、零界面打扰）；检测到同名散落文件**或** `skills.json` 的 `include_only`/`exclude` 过滤拦截（POSIX ERE 正则对齐）时会在启动会话时自动弹出告警与修复命令。
- **一行命令无损归档清理**：将冲突的旧文件安全移入统一 UTC 时间戳目录 `~/.gemini/config/.agy-loop-backup-<YYYYMMDD-HHMMSSZ>/`（清理后在已打开的 `agy` 会话中执行一次 `/skills reload`）：
  - **纯 POSIX Shell（零 Node/npm 依赖）**：`sh ~/.gemini/config/plugins/agy-loop/install.sh --clean-shadow`
  - **在 `agy` 会话内直接执行（通过插件前缀即可立即调起）**：`/agy-loop:loop doctor --clean-shadow`
  - **通过 npm CLI 桥接器**：`npx agy-loop doctor --clean-shadow`

### CLI 子命令一览（`agy-loop` / `npx agy-loop`）

| 命令 | 用途说明 |
| :--- | :--- |
| `agy-loop run [interval] [prompt...] [options]` | 启动 Headless 循环（`fresh` `json` 或 `--stateful` `stream-json` 双传输），支持 Gemini 4 模型/档位/降级/独立验收路由、`--probe`、`--worktree` 与预算/退出码控制 |
| `agy-loop ps [--all] [--global] [--json]` | 查看当前工作区（或 `--all` / `--global` 跨工作区）交互式与 Headless 循环列表，自动标注 `[stale]` 僵尸进程（支持 `list` 别名；`status` 保留为 `doctor` 别名） |
| `agy-loop logs [id\|latest] [-f] [-n N] [--json]` | 回放或实时追踪 `events.jsonl` 迭代时间线、增量 Token 遥测与软拒绝记录 |
| `agy-loop stop <id\|prefix\|all\|--all> [--after-current]` | 立即停止（写 `control.json` 并向活跃 Headless PID 发送 `SIGTERM`）或等待当前轮完成后停止（`--after-current`）指定或全部循环 |
| `agy-loop statusline [--global] [--no-color] [--json]` | 输出 `<5ms` 零子进程紧凑状态段，可直接配置到 `settings.json` `statusLine`（无活跃循环时输出空） |
| `npx agy-loop [install \| update]` | 调用 `agy plugin install` 安装或更新插件（自动检测同名全局遮蔽文件并告警） |
| `npx agy-loop install --clean-shadow` | 安装 `agy-loop` 并将遮蔽插件的用户级散落文件自动归档至 `~/.gemini/config/.agy-loop-backup-<YYYYMMDD-HHMMSSZ>/` |
| `npx agy-loop doctor [--json]` | 完整健康巡检：含 `agy v1.5.14` 特性矩阵（`agy.capabilities`）、企业策略 `admin_settings.json`/`settings.json`/`hooks.json` 审计、`SessionStart` `protojson` 自检（`hookSelfTest`）、`loop-worker` 6 工具校验（`agentToolsCheck`）、遮蔽文件、ERE `skills.json` 过滤、`loop.md`、`activeLoops`（含 `engine`/`stale`）与 `15s`/`30s` `spawnSync` 超时保护（保留 `status` 别名） |
| `npx agy-loop doctor --clean-shadow [--json]` | 无损归档同名遮蔽文件至 `~/.gemini/config/.agy-loop-backup-<YYYYMMDD-HHMMSSZ>/` 并重新执行健康检查（支持 `status --clean-shadow` 别名；活跃会话请执行 `/skills reload`） |
| `npx agy-loop validate [--json]` | 对插件目录执行 `agy plugin validate --strict` 官方严格校验 |
| `npx agy-loop uninstall` | 调用 `agy plugin uninstall agy-loop` 干净卸载插件（支持 `remove` 别名） |

```bash
npx agy-loop doctor
# 无损归档已有同名遮蔽文件并复检：
npx agy-loop doctor --clean-shadow
# 输出结构化 JSON 诊断报告：
npx agy-loop doctor --json
```

### 零残留干净卸载

随时可通过任一方式完整卸载 `agy-loop`：

```bash
# 通过 npm 桥接器卸载：
npx agy-loop uninstall

# 通过 Antigravity 原生 CLI 卸载：
agy plugin uninstall agy-loop

# 通过一行远程脚本或本地脚本卸载：
curl -fsSL https://raw.githubusercontent.com/maxlee/agy-loop/main/uninstall.sh | sh
./uninstall.sh
```

### 本地开发与严格校验

有关三回合响应式非阻塞状态机、任务与节奏解析流程、4 行无围栏输出契约、沙箱/Worktree 隔离模型以及 v1.2 Headless 双传输架构的完整技术细节，请参阅 [**ARCHITECTURE.md**](ARCHITECTURE.md)。

```bash
sh -n install.sh uninstall.sh skills/loop/scripts/loop-helper.sh  # 检查纯 POSIX sh 语法合规性
node --check bin/agy-loop.mjs lib/*.mjs                           # 检查 Node >= 18 ESM 模块语法
npm test                                                          # 运行隔离 HOME 的单元与端到端集成测试
agy plugin validate --strict .                                    # 执行 Antigravity v1 插件严格规范校验（0 告警）
```

---

## 📄 开源协议

基于 [**MIT License**](LICENSE) 协议开源发布，Copyright © Max。

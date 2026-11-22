<div align="center">

<img src="assets/logo.svg" alt="AGY Loop Logo" width="88" height="88" />

# AGY Loop (`agy-loop`)

**专为 Google Antigravity 桌面端与 CLI (`agy`) 打造的纯原生非阻塞循环调度与 `run_workflow` 动态工作流编排插件（`/agy-loop:loop`），内置独立只读验收 `loop-verifier`、原子实时纠偏（`nudge`/`wake`）、断点续跑（`resume`）与 `loop.md` 热重载**

[![CI](https://github.com/maxlee/agy-loop/actions/workflows/ci.yml/badge.svg)](https://github.com/maxlee/agy-loop/actions/workflows/ci.yml)
[![Release](https://github.com/maxlee/agy-loop/releases/latest)](https://github.com/maxlee/agy-loop/releases/latest)
[![Antigravity Plugin v1](https://img.shields.io/badge/Antigravity-Plugin_v1-38BDF8.svg)](plugin.json)
[![Node >=18](https://img.shields.io/badge/Node-%3E%3D18-22C55E.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[**English**](README.md) · [**简体中文**](README.zh-CN.md) · [**核心优势**](#-为什么选择-agy-loop) · [**快速安装**](#-安装指南) · [**工作流引擎**](#-动态工作流引擎与两段式验收) · [**斜杠命令**](#-斜杠命令运行模式与参数参考) · [**Headless 运行器**](#-headless-cli-运行器) · [**`loop.md` 热重载**](#-agentsloopmd-热重载指南) · [**退出与停止**](#-如何退出或停止循环) · [**架构设计**](ARCHITECTURE.md)

</div>

---

**AGY Loop** (`v1.3.0`) 为 **Antigravity 桌面端**（原生兼容 Marketplace）与 **Antigravity CLI (`agy`)** 带来双引擎、真正非阻塞且上下文隔离的 `/agy-loop:loop` 循环调度器，并提供零外部依赖的生产级 **Headless CLI 运行器**（`agy-loop run | resume | nudge | wake | ps | logs | stop | statusline`）。

- **交互式 `schedule` 引擎**：将每一轮检查或修复派发给独立上下文的后台 `loop-worker`（或 `self`）子代理执行，并在轮次间隙通过原生 `schedule` 工具以**零 Token 消耗**挂起休眠，主对话输入框始终保持自由。
- **动态 Python 工作流引擎（`run_workflow`，`agy >= 1.5.9`）**：使用 `--verify`、`--verify-cmd`、`--probe`、`--targets`、`--max-tokens`、`--max-duration`、`--reset-every` 或 `--engine workflow` 时自动切入异步工作流 `workflows/loop-runner/workflow.py`，将 20 轮交互式循环的主会话交互从 ~41 次降至 **2 次（减少约 95% 主聊天回合与主上下文消耗）**，原生支持并发多目标 `--targets` 故障隔离与两段式 `turn-stopping` 验收门禁（`--verify-cmd` -> 只读 `loop-verifier`）。
- **跨引擎统一状态一致性与实时控制（`v1.3.0`）**：`schedule`、`workflow` 与 `headless` 三端共用 `<workspace>/.agents/.agy-loop/`（`state.json`、`events.jsonl`、`control.json`、原子 `inbox/` 队列），支持不停机实时 `nudge`/`wake`、每轮冻结不可变 `IterationSnapshot`、成对 `iteration_start`/`iteration_end` 事务检查点、`O_EXCL` 加锁的全局 `index.json`、sticky 硬预算防透支、`finally` 双保险错误终态，以及 `agy-loop resume` 断点续跑。

> 设计灵感源自 Claude Code 的 [`/loop` 工作流](https://claude.com/resources/articles/getting-started-with-loops)，深度结合 Antigravity 的响应式子代理唤醒、`run_workflow` 动态工作流、秒级 `DurationSeconds` 定时器、有状态上下文延续与 Git Worktree 分支隔离机制原生实现。

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

| 对比维度 | Shell `sleep` 循环 | Claude Code `/loop` | AGY Loop (`agy-loop v1.3.0`) |
|:--- |:--- |:--- |:--- |
| **等待机制** | Shell `sleep` 阻塞回合 | 内置会话 Cron 队列 | 原生非阻塞 `schedule` 定时器/Cron 与 `run_workflow`（`agy >= 1.5.9`） |
| **主会话可用性** | 等待期锁死，无法输入 | 轮次间隙可正常对话 | 轮次间隙**及子代理/`run_workflow` 运行期间**均可自由对话（主回合减少 ~95%） |
| **上下文隔离** | 构建/测试日志塞满主窗口 | 共享主会话历史记录 | 独立 `loop-worker` / `self` + 只读 `loop-verifier`；主窗口仅留单行摘要 |
| **两段式独立验收** | 不支持 | 不支持 | Stage 1 零 Token `--verify-cmd` -> Stage 2 只读 `loop-verifier`（`pro`）+ sticky 预算防透支 |
| **并发多目标编排** | 串行 Shell 循环 | 单一会话串行 | 并发 `--targets <csv>`（`parallel()`），单目标异常隔离不连带取消兄弟任务 |
| **最小时间粒度** | `1s`（阻塞前台） | `1m` Cron 下限（`30s` 向上取整为 `1m`） | 秒级 `DurationSeconds`（`15s`、`30s`）与复合时长（`1h30m`、`2m30s`） |
| **实时纠偏与断点续跑** | `Ctrl+C` 重头再来 | 取消后重新创建 Cron | 原子 `inbox/` `nudge`/`wake`、冻结 `IterationSnapshot`、`iteration_start`/`end`、`agy-loop resume` |
| **`loop.md` 热重载** | 不支持 | `.claude/loop.md` 与 `~/.claude/loop.md` | 每轮实时重读：`.agents/loop.md` -> `loop.md` -> `~/.gemini/config/loop.md` -> 内置维护兜底 |
| **记忆与隔离修改** | 直接修改当前工作区 | 混杂在主对话历史中 | `--stateful`（支持 `--reset-every N` 轮换）与 `--worktree`（`branch` + diff/merge 指引）/ `--share` |

---

## 📦 安装指南

### 环境要求

- **Antigravity CLI (`agy`)** `v1.5.0+`（其中 `run_workflow` 动态工作流引擎要求 `v1.5.9+`；已通过 `v1.5.14` 严格插件校验、`oneharness` 工具注册表与 Headless `json` / `stream-json` 双传输协议验证）或 **Antigravity 桌面端**
- **原生安装零 Node.js / npm 依赖**：通过 `agy plugin install` 或一行 `curl` 脚本安装并使用交互式 **`/agy-loop:loop`** 无需 Node 运行时（`run_workflow` 在 `agy >= 1.5.9` 内使用 Python 3.8+ 标准库运行，零第三方依赖）；**`Node.js >= 18`** 用于驱动零外部依赖的 `npx agy-loop` CLI 桥接器及 Headless **`agy-loop run | resume | nudge | wake | ps | logs | stop | statusline`** 运行器（也可通过 `Bun` 运行 CLI 桥接器）

`agy-loop` 采用**纯原生、兼容 Marketplace 的双栖包架构**：仓库根目录既是符合严格 v1 规范的 Antigravity 原生插件（`plugin.json`、`hooks.json`、`skills/loop/SKILL.md`、`agents/loop-worker.md`、`agents/loop-verifier.md`、`workflows/loop-runner/`），也是零外部依赖的 npm CLI（`bin/agy-loop.mjs` + `lib/*.mjs`）。安装完成后：

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

## ⚙️ 动态工作流引擎与两段式验收

### 引擎自动路由策略（`--engine auto|schedule|workflow`）

`skills/loop/scripts/loop-helper.sh parse` 会根据参数自动计算有效执行引擎 `"engine"`：

- **`schedule`（普通 `/agy-loop:loop` 默认）**：当显式传入 `--engine schedule`，或 `--engine auto`（默认）且未使用任何 workflow 专属参数时走该引擎。完整保留三回合响应式协议（`schedule` + `invoke_subagent`）、非 `auto` 权限模式下的人工 `Ctrl+K` 审批体验、`--cron`/`--exact`/`--daemon` 支持，并兼容全部 `agy` 版本。
- **`workflow`（`workflows/loop-runner/workflow.py`，要求 `agy >= 1.5.9`）**：当显式传入 `--engine workflow`，或使用任意 workflow 专属参数时自动切入：
  `--verify`、`--verifier-model`、`--verify-cmd`、`--probe`、`--targets`、`--max-tokens`、`--max-duration`、`--reset-every`。
- **参数互斥校验（Exit `2`）**：
  - `--cron`、`--exact`、`--daemon` 仅限 `--engine schedule`（不可与 `--engine workflow` 或 workflow 专属参数混用）。
  - workflow 专属参数不可与 `--engine schedule` 混用。
  - `--reset-every` 必须配合 `--stateful`；`--probe-until-pass` 必须配合 `--probe`。

#### 为什么 `run_workflow` 可减少 ~95% 主会话交互？

在 `schedule` 引擎下，20 轮循环每轮都会两次唤醒主会话，主对话约产生 ~41 个回合。而在 `run_workflow` 引擎下，`SKILL.md` 仅先通过 `state-init` 落盘 `loop_id`，再调用 `run_workflow(ScriptPath=".../workflows/loop-runner/workflow.py", Args=...)` 并立即结束当前回合。全部轮次的预检、重连、两段式验收与轮间休眠均在后台 `workflow.py` 中异步闭环，结束后仅唤醒主会话**一次**（主会话共 **2 个回合，减少约 95% 主对话回合与主上下文消耗**）。

#### `agy < 1.5.9` 自动降级指引

若运行时不支持 `run_workflow`（`agy < 1.5.9`），`/agy-loop:loop` 会先调用 `state-stop` 清理刚创建的初始状态，并引导用户选择：
1. 升级 Antigravity CLI 至 `agy >= 1.5.9`；**或**
2. 改用 `--engine schedule`（移除 workflow 专属参数运行标准定时循环）；**或**
3. 在终端运行 `npx agy-loop run ...`，使用 Headless 运行器获得 `--verify-cmd`、`--verifier-model`、`--probe`、`--max-tokens`、`--max-duration` 与 `--reset-every` 支持。

### 并发多目标 `--targets` 与故障隔离

传入 `--targets "pkgA,pkgB,pkgC"` 后，`workflow.py` 每轮通过 `parallel()` 并发派发所有目标。每个目标在独立的 `try / except Exception` 隔离块中执行，单个目标出错不会连带取消其他兄弟目标的协程（仅硬预算 `BudgetExceeded` 异常继续上抛熔断）。聚合器仅在**全部**目标均返回 `DONE` 时才判定整轮为 `DONE`。

```text
/agy-loop:loop audit and fix lint warnings --targets "packages/core,packages/cli,packages/ui" --max 4
```

*（并发修改文件时建议配合 `--worktree`、`--share` 或保持目标目录彼此互斥。）*

### 独立只读 `loop-verifier` 与两段式 `turn-stopping` 门禁

交互式 `workflow` 引擎（`--verify` / `--verifier-model` + `--verify-cmd`）与 Headless CLI 运行器（`--verifier-model` + `--verify-cmd`）统一内置两段式验收门禁。每当 Worker 声称 `LOOP_STATUS: DONE` 时触发：

1. **Stage 1 — 零 Token 确定性命令复验（`--verify-cmd <cmd>`）**：
   - 本地执行用户显式传入的验证命令（受 `--verify-timeout` 限制，默认 `60s`，安全截取尾部 `4096 B` UTF-8 输出，并记录 `verify_cmd` 事件）。
   - 若命令失败或超时，直接跳过 Stage 2 LLM 验收（省下无效 Verifier Token）：若仍有轮次与预算，将失败尾行注入 `next_hint` 并转为 `CONTINUE` 续跑修复；若已达 `--max` 或 `--once`，严格 Fail-Closed 落盘 `BLOCKED`（`verify_cmd_failed`）。
2. **Stage 2 — 独立只读 LLM 语义验收（`loop-verifier` / `--verifier-model`）**：
   - **Sticky 硬预算防透支保护**：调用 Stage 2 LLM 之前，先检测 `max_tokens` 或 `max_duration`（工作流模式还包括 `max_agents`）是否已耗尽。若已耗尽，**绝不透支**调用 Verifier，记录 `skipped_due_to_budget: true`（`unverified_due_to_budget: true`）并锁定 `status: "max_reached"` 终态（Headless 退出码 `4`）。
   - 预算充足时：`workflow` 模式调用插件内置只读代理 `agents/loop-verifier.md`（默认 `model: pro`，`commandExecutionPolicy: sandbox`，物理限制仅 3 个只读工具 `[view_file, run_command, search_web]`）；Headless 模式调用只读 `runJsonTurn`（`mode: "auto"`、`sandbox: true`、`dangerouslySkipPermissions: false`）与 `--verifier-model`。
   - 对照冻结的 `IterationSnapshot.taskPrompt`、`git status`、`git diff --stat` 与 Stage 1 `verify_cmd` 结果，严格 Fail-Closed 返回 `{ passed, summary, issues }`。验收驳回或 Verifier 异常时，未触顶则将 `issues` 注入 `next_hint` 继续修复；已达 `--max`/`--once` 则 Fail-Closed 终止为 `BLOCKED`。

```text
/agy-loop:loop fix auth regression --verify-cmd "npm test" --verify --verifier-model pro --max 5
/agy-loop:loop hunt flaky race condition --stateful --reset-every 3 --max 9
/agy-loop:loop 30s fix build --probe "npm run build" --probe-until-pass --max 10
```

### 安全边界（`run_workflow` 沙箱外命令红线）

> [!WARNING]
> **仅执行显式命令行指令**：由于 `agy` 的 `run_workflow` Python 进程运行在 OS 沙箱之外，`workflows/loop-runner/workflow.py` 中的 `probe_cmd` 与 `verify_cmd` **严格只接受用户显式传入的命令行参数 / `Args`**，**绝不**解析或执行 `.agents/loop.md` 或仓库文本中的命令；所有子进程强制受超时与 `4096 B` UTF-8 安全尾部截断约束。

---

## 🧭 斜杠命令、运行模式与参数参考

### 5 大调用模式

| 运行模式 | 命令示例 | 行为说明 |
|:--- |:--- |:--- |
| **1. 固定间隔 + 任务提示词** | `/agy-loop:loop 30s curl -fsS http://localhost:8080/health`<br>`/agy-loop:loop every 5m check the deploy`<br>`/agy-loop:loop 1h30m check backup`<br>`/agy-loop:loop check PR #42 comments every 2h` | 按固定周期（`s`、`m`、`h`、`d`）执行，支持前置 `every <dur>`、后缀 `every` 与复合时长（`1h30m`、`2m30s`；小数 `1.5m` 将退出码 `2` 报错）。默认使用防重叠 `DurationSeconds` 链式定时器，传入 `--cron` 时切换 5 段式 `CronExpression`。 |
| **2. 动态自适应节奏（Self-Paced）** | `/agy-loop:loop check CI and fix failures`<br>`/agy-loop:loop run pytest and fix failing tests --stateful` | 省略时间间隔。每轮结束后由 `loop-worker` 返回 `NEXT_DELAY_SEC`（缺失或非正整数回退 `120s`，并严格限幅至 `[10s, 86400s]`）。 |
| **3. `loop.md` 热重载维护巡检** | `/agy-loop:loop`<br>`/agy-loop:loop 15m` | 省略内联提示词。每轮唤醒按 `.agents/loop.md` -> `loop.md` -> `~/.gemini/config/loop.md` -> 内置策略动态读取（上限 `25,000` 字节，超长截断时主动提醒）。 |
| **4. 单次延时检查（One-Shot）** | `/agy-loop:loop in 20m verify staging smoke tests`<br>`/agy-loop:loop --once 10m check if docker build finished` | 创建单次非阻塞 `DurationSeconds` 定时器（`max_iterations = 1`），到点唤醒子代理执行一轮检查并汇报结果后自动结束。 |
| **5. 生命周期管理、实时纠偏与诊断** | `/agy-loop:loop status [--all] [--json]`（或 `list`）<br>`/agy-loop:loop nudge <id\|latest> "<msg>" [--wake]`<br>`/agy-loop:loop wake <id\|latest>`<br>`/agy-loop:loop stop [<id1> <id2>\|all] [--after-current]`<br>`/agy-loop:loop doctor [--clean-shadow]`<br>`/agy-loop:loop help` | 查看 `.agents/.agy-loop/` 各引擎循环状态、向运行中循环原子投递 `nudge`/`wake` 控制信号、按多目标或 `--after-current` 优雅停止、诊断/归档遮蔽文件与 `skills.json`，或输出帮助信息。 |

### 参数（Flags）完整参考（`/agy-loop:loop`）

所有参数均可放置在 `--` 之前的任意位置（前置位未知参数或近拼写错字如 `--statefull`、`--max-iter` 会直接 Exit `2` 拦截；提示词中段/尾部的真实命令参数如 `gh pr checks --required` 会透传并输出一条提示，也可使用 `--` 显式截止参数解析）：

| 参数 | 默认值 | 说明 |
|:--- |:--- |:--- |
| `--engine <mode>` | `auto` | 指定执行引擎：`auto`、`schedule` 或 `workflow`。`auto` 对普通循环走 `schedule`，命中任一 workflow 专属参数时自动路由至 `workflow`。 |
| `--max <N>` | `20`（`--once` 时为 `1`） | 最大循环轮数安全上限，达标前若触顶将自动停止（`max_reached`）并汇总，防止消耗过多配额。 |
| `--stateful` | `fresh` | 跨轮次复用同一个 Worker 会话（`schedule` 通过 `send_message` 唤醒 `Idle` 子代理；`workflow` 复用持久 `agent` 实例）。 |
| `--reset-every <N>` | `null` | 每 `N` 轮自动轮换一次 `--stateful` 上下文（需配合 `--stateful`；自动触发 `workflow` 引擎）。 |
| `--worktree` | `inherit` | 在独立 Git 分支工作树（`Workspace: "branch"`）中运行。`agy v1.5.5+` 会继承父工作区脏改动，编排器会记录 `worktree_branch` 并在清理前汇报 `git diff --stat` 与合并命令。 |
| `--share` | `inherit` | 在共享工作副本（`Workspace: "share"`）中运行子代理。 |
| `--model <tier>` | `flash`（`loop-worker`） | 覆盖子代理模型档位：支持 `inherit`、`flash_lite`、`flash`、`pro`。 |
| `--self` | `loop-worker` | 改用内置全功能 `self` 子代理执行每轮任务（当提示词以 `/` 开头调用其他斜杠技能如 `/agy-loop:loop 20m /code-review` 或需使用 MCP 工具时也会自动启用）。 |
| `--verify` | `false` | Worker 报 `DONE` 时开启 Stage 2 独立只读 `loop-verifier`（`model: pro`）语义验收（自动触发 `workflow` 引擎）。 |
| `--verifier-model <tier>` | `pro`（配合 `--verify`） | 指定 Stage 2 `loop-verifier` 模型档位（`inherit`、`flash_lite`、`flash`、`pro`；隐含 `--verify`；自动触发 `workflow` 引擎）。 |
| `--verify-cmd <cmd>` | `null` | Worker 报 `DONE` 时优先执行 Stage 1 零 Token 本地验证命令（自动触发 `workflow` 引擎）。 |
| `--verify-timeout <dur>` | `60s` | `--verify-cmd` 子进程超时时长（如 `30s`、`2m`）。 |
| `--probe <cmd>` | `null` | 每轮模型执行前先运行显式 Shell 预检命令（自动触发 `workflow` 引擎）。 |
| `--probe-timeout <dur>` | `60s` | `--probe` 子进程超时时长。 |
| `--probe-until-pass` | `false` | 当 `--probe` 退出码为 `0` 时直接以 `0` Token 结束并返回 `DONE`（需配合 `--probe`）。 |
| `--targets <csv>` | `[]` | 逗号分隔的并发目标列表，每轮通过 `parallel()` 并发执行且单目标异常隔离（自动触发 `workflow` 引擎）。 |
| `--max-tokens <N>` | `null` | 跨轮次累计 Token 硬预算上限（自动触发 `workflow` 引擎）。 |
| `--max-duration <dur>` | `null` | 跨轮次墙钟总时长硬预算上限（如 `30m`、`2h`；自动触发 `workflow` 引擎）。 |
| `--cron` | `false` | 当固定间隔 `>= 60s` 且可精确映射为标准 5 段 Cron（`1m`、`60m` 约数、`24h` 约数、`1d`）时，启用原生 `CronExpression` 周期调度，仅限 `schedule` 引擎。 |
| `--exact` | `false` | 配合 `--cron` 开启 `ExactTiming: true`，在整分时刻精确触发，关闭防惊群随机抖动（仅限 `schedule` 引擎）。 |
| `--daemon` | `false` | 配合 `--cron` 开启 `IsDaemon: true`，作为常驻后台任务在当前任务完成后继续触发（仅限 `schedule` 引擎）。 |
| `--once` | `false` | 仅执行单轮检查（`max_iterations = 1`），汇报后立即退出。 |
| `--` | — | 选项截止分隔符：其后所有参数原样作为任务提示词，不再触发 flag 解析或未知参数告警。 |

---

## 🛡️ 可靠性、状态一致性与双引擎安全

- **双引擎工具严格分离（`loop-worker` 6 工具 vs `loop-verifier` 3 只读工具）**：
  - `agents/loop-worker.md`（`model: flash`、`commandExecutionPolicy: sandbox`）精确声明桌面端 Cortex 与 `agy v1.5.14` CLI `oneharness` 均受支持的 6 个工具（`view_file`、`write_to_file`、`replace_file_content`、`run_command`、`manage_task`、`search_web`），剔除 4 个不兼容旧 Cortex 工具，搜索由沙箱内 `run_command`（`rg`/`grep`/`find`/`ls`）完成。
  - `agents/loop-verifier.md`（`model: pro`、`commandExecutionPolicy: sandbox`）仅保留 3 个只读工具 `[view_file, run_command, search_web]`，物理移除写入工具（`write_to_file`、`replace_file_content`）及调度/派生工具（`manage_task`、`schedule`、`invoke_subagent`）。
- **沙箱安全统一控制面与 `O_EXCL` 跨进程加锁的 `index.json`（`.agents/.agy-loop/`）**：
  - 由于 `agy v1.5.7+` 默认 `auto` 沙箱禁止 `run_command` 写入 `~/.gemini/antigravity-cli/plugin_data/`，循环状态统一落盘于 `<workspace>/.agents/.agy-loop/loops/<loop_id>/`（含 `state.json`、`events.jsonl`、`control.json`、`inbox/`，支持 `AGY_LOOP_STATE_DIR` 覆盖，并自动创建 `*` `.gitignore`）。
  - 交互式 `schedule`、`workflow` 与 Headless 运行器完全共用此状态目录；跨工作区 `~/.gemini/antigravity-cli/plugin_data/agy-loop/index.json`（上限 200 条）的读写全面采用 `O_EXCL` 排他锁（`${indexPath}.lock`），并支持死 PID（`isPidAlive`）与 `10s` 超时僵尸锁回收。
- **单轮状态一致性与异常双保险（`v1.3.0`）**：
  - **原子 `inbox/` 控制队列**：`nudge`、`wake` 与 `stop` 均通过临时文件 + 原子重命名写入 `inbox/`，轮首 `preIteration` 通过原子 `rename`/`os.replace` 同步认领移入 `inbox/claimed/`，确保单条指令至多消费一次且无写写竞争。
  - **冻结不可变 `IterationSnapshot`**：`preIteration` 完成认领、预算检查、`loop.md` 热重载与 `--probe` 后，将 `taskPrompt`、`nextHint`、`probeOutput`、`nudges` 与 12 位 SHA-256 `snapshotHash` 冻结（JS `Object.freeze` / Python `MappingProxyType`），保证同轮重试与 Stage 2 验收锚定同一目标，不受轮内修改 `loop.md` 干扰。
  - **成对 `iteration_start` / `iteration_end` 事务检查点**：开始执行前落盘 `in_flight_iteration` 与 `in_flight_snapshot_hash` 并写 `iteration_start`，单轮 `try / finally` 退出时无条件清理 `in_flight_iteration` 并补写 `iteration_end`（含 `outcome`、`duration_ms`、`usage_delta`）。
  - **`finally` 双保险错误终态**：`runner.mjs` 与 `workflow.py` 默认将终态初始化为 `finalStatus = "error"`（`exitReason = "unhandled_exception"`），绝不默认 `"done"`，彻底杜绝未捕获异常误标成功的隐患。
- **连续 3 次异常熔断与延迟限幅**：无效输出或运行异常累计达 `--max-errors`（默认 `3`）触发 `circuit_broken`；动态 `NEXT_DELAY_SEC` 缺失/非法时回退 `120s`，并限幅至 `[10s, 86400s]`。

---

## 🤖 Headless CLI 运行器

**（`agy-loop run` · `resume` · `nudge` · `wake` · `ps` · `logs` · `stop` · `statusline`）**

基于 `Node.js >= 18` 且**零外部 npm 依赖**，专为本地终端、SSH、Cron 与 CI/CD 流水线打造（`npx agy-loop run ...` 或全局安装 `agy-loop run ...`）。Headless 运行器与交互式 `/agy-loop:loop` 共用 `.agents/loop.md` 热重载与 `<workspace>/.agents/.agy-loop/` 状态存储，默认遵循本机 `agy` 权限配置（除非显式传入 `--mode`、`--sandbox` 或 `--dangerously-skip-permissions`），并提供严格 Schema 校验、模型/降级/两段式验收路由、硬预算熔断、实时 `nudge`/`wake`、断点 `resume` 及规范 CI 退出码。

### 快速上手示例

```bash
# 1. 单次执行检查（立即执行或使用 `in <delay>` 延时执行）
agy-loop run --once "Inspect git status and summarize any failing tests"
agy-loop run in 20m "Verify staging smoke tests and report status"

# 2. 自适应 CI 循环：Gemini 4 模型路由 + 降级 + 两段式验收（0 Token 命令 + 只读 Verifier）
agy-loop run "Check PR CI status and fix failing checks" \
  --model gemini-4-hydrogen-xhigh \
  --effort high \
  --fallback-model gemini-4-carbon-high \
  --verify-cmd "npm test" \
  --verifier-model gemini-4-neon-xhigh

# 3. 持久双向 `stream-json` 会话（`--stateful`），每 6 轮自动轮换上下文（`--reset-every 6`）
agy-loop run 2m "Run unit tests and fix failures until green" --stateful --reset-every 6

# 4. 独立 Git Worktree 分支隔离运行（无修改无提交自动清理；有改动保留并输出合并命令）
agy-loop run "Refactor flaky auth tests and commit verified fixes" --worktree

# 5. 零 Token Shell 预检（`--probe` + `--probe-until-pass`）
agy-loop run 30s "Fix remaining TypeScript errors" --probe "npm test" --probe-until-pass

# 6. 不停机实时纠偏、提前唤醒与断点续跑
agy-loop nudge latest "Focus on tests/auth.test.mjs first" --wake
agy-loop wake latest
agy-loop resume latest --max 30 --max-tokens 400000
```

### Headless 核心参数一览（`agy-loop run`）

完整复用 `/agy-loop:loop` 间隔语法（`30s`、`1h30m`、`every 5m`、`in 20m`、后缀 `every 2h`，省略提示词自动热重载 `.agents/loop.md`），并支持以下专项能力：

| 类别 | 核心参数 | 行为与默认值说明 |
|:--- |:--- |:--- |
| **传输与上下文轮换** | `--fresh`（默认）、`--stateful`、`--reset-every <N>` | `fresh` 每轮独立调用 `agy --output-format json`；`--stateful` 复用持久 `stream-json` 进程（配合 `--reset-every N` 定期重置上下文）。 |
| **预算与容错熔断** | `--max <N>`（`20`）、`--once`、`--max-duration <dur>`、`--max-tokens <N>`、`--max-retries <N>`（`3`）、`--max-errors <N>`（`3`）、`--turn-timeout <dur>`（`10m`） | 严格限制轮次、总时长与累计 Token；对 `print_timeout` / 瞬态 `429` 自动指数退避重试（`30s -> 60s -> 120s`，含抖动）；连续契约/运行错误触顶即熔断。 |
| **模型与两段式验收** | `--model <slug\|label>`、`--effort <low\|medium\|high\|xhigh\|max>`、`--fallback-model <slug\|label>`、`--verify-cmd <cmd>`、`--verify-timeout <dur>`（`60s`）、`--verifier-model <slug\|label>` | 通过 `agy --output-format json models` 校验模型 slug 或显示名（命中 `Orchestrator` 自动省略 `--effort`）；配额/限流时自动切至 `--fallback-model`；`DONE` 时依次执行 Stage 1 `--verify-cmd` 与 Stage 2 只读 `--verifier-model`（受 sticky 预算保护）。 |
| **权限与工作区隔离** | `--mode <auto\|accept-edits\|plan>`、`--sandbox`、`--dangerously-skip-permissions`、`--allow-slash-commands`、`--settings <json\|path>`、`--add-dir <dir>`、`--worktree`、`--keep-worktree`、`--fail-on-denied` | 默认透传本机 `agy` 模式不覆写；默认禁用斜杠命令展开（除非指定 `--allow-slash-commands`）；`--worktree` 在 `<state>/worktrees/<loop_id>` 创建 `agy-loop/<loop_id>` 分支；开启 `--fail-on-denied` 时软拒绝（`denied_actions[]`）按 `BLOCKED`（Exit `3`）处理。 |
| **预检与输出控制** | `--probe <cmd>`、`--probe-timeout <dur>`（`60s`）、`--probe-until-pass`、`--cwd <dir>`、`--json`、`--quiet`、`--` | 每轮先运行有界 `--probe` 命令（失败时注入输出尾段，或配合 `--probe-until-pass` 零 Token 通过）；`--json` 输出最终结构化 JSON 摘要；`--` 后所有参数原样作为提示词。 |

### 实时纠偏（`nudge` / `wake`）与断点续跑（`resume`）

由于交互式 `workflow`（`run_workflow`）与 `headless` 循环共用 `<workspace>/.agents/.agy-loop/loops/<loop_id>/inbox/` 与 `state.json`：

- **不停机注入纠偏指令（`nudge`）**：
  - `agy-loop nudge <id|prefix|latest> "<msg>" [--wake] [--cwd <dir>] [--json]`（或会话内 `/agy-loop:loop nudge <id|latest> "<msg>" [--wake]`）
  - 默认仅写入 `inbox/` 等待下一轮自然唤醒认领（不打乱固定节拍）；追加 `--wake` 会立即打断轮间休眠，若正在执行当前轮则置位 `wakeRequested` 跳过本轮结束后的休眠。
- **提前唤醒休眠中的循环（`wake`）**：
  - `agy-loop wake <id|prefix|latest> [--reason "<msg>"] [--cwd <dir>] [--json]`（或会话内 `/agy-loop:loop wake <id|latest>`）
  - 立即结束当前轮间休眠；若循环正在执行本轮，轮尾检测到 `wake` 后跳过休眠直接进入下一轮。
- **检查点断点续跑（`resume`）**：
  - `agy-loop resume <id|prefix|latest> [--max <N>] [--max-tokens <N>] [--max-duration <dur>] [--model <slug|label>] [--settings <json|path>] [--cwd <dir>] [--json] [--quiet]`
  - 支持恢复 `stopped`、`max_reached`、`blocked`、`circuit_broken`、`error` 或 `[stale]` 死 PID 状态的 `headless` 循环（拒绝已 `done` 或非 headless 循环并 Exit `2`，拒绝存活 PID 并 Exit `1`）。
  - 自动检测并补写异常中断的 `in_flight_iteration`（追加 `outcome: "interrupted"` 的 `iteration_end` 事件），校验并复用原 `--worktree` 与 `--stateful` `conversation_id`，继承累计 `usage_totals`、`denied_actions_count`、`next_hint` 与 `active_model`，清理旧停止信号并记录 `resume` 事件。
  - **显式扩预算保护**：当恢复 `max_reached` 循环时，必须显式传入严格大于原耗尽上限的 `--max`、`--max-tokens` 或 `--max-duration`（否则直接 Exit `2` 报错，防止无意透支）。会话级 `--settings` 参数不会持久化写入 `run_config_snapshot`。

### 观测与生命周期管理命令

> **向后兼容说明：** `agy-loop status` 继续保留为 `agy-loop doctor`（健康诊断）的别名；查看运行中或历史循环请使用 **`agy-loop ps`**（或 `list`）。

```bash
# 查看当前工作区活跃循环（`--all` 含已结束记录；`--global` 查询加锁跨工作区索引；自动标记 `[stale]` 死 PID）
agy-loop ps [--all] [--global] [--json]

# 回放或实时追踪结构化事件流（含 `iteration_start`、`iteration_end`、`inbox_claim`、`verify_cmd`、`verifier`、`resume` 与 Token 遥测）
agy-loop logs [id|latest] [-f] [-n N] [--json]

# 停止指定循环、前缀匹配循环或全部活跃循环（双写 control.json 与 inbox/stop，清理 stale PID，向存活 Headless PID 发送 SIGTERM，或 `--after-current` 优雅停止）
agy-loop stop <id|prefix|all> [--after-current]

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

### Headless 退出码契约（`agy-loop run` 与 `agy-loop resume`）

| 退出码 | 终态 | 含义说明 |
|:--- |:--- |:--- |
| **`0`** | `DONE` / `--once` / `--probe-until-pass` | 目标达成返回 `DONE`、`--probe-until-pass` 预检通过（零 Token），或 `--once` 单次检查正常执行结束（`DONE` 或 `CONTINUE`）。 |
| **`1`** | `error` / `circuit_broken` | 未捕获运行异常（绝不误标 `done`）、缺少 `agy`、`agy` Exit `1`、末轮/`--once` 触发 `verifier_error`、连续错误达 `--max-errors`（默认 `3`）熔断，或 `resume` 目标 PID 仍存活。 |
| **`2`** | 参数或配置错误 | 未知参数、冲突参数（如 `--stateful` 与 `--fresh` 混用）、非法时长/预算、无法识别的模型名称、`resume` 目标已 `done`/Worktree 缺失/未显式扩预算，或 `agy` 配置报错（Exit `2`）。 |
| **`3`** | `BLOCKED` | Worker 返回 `BLOCKED`、命中不可重试的硬配额上限、末轮/`--once` 被 Stage 1 `--verify-cmd`（`verify_cmd_failed`）或 Stage 2 `--verifier-model`（`verifier_rejected`）驳回，或命中 `--fail-on-denied`。 |
| **`4`** | `max_reached` | 多轮循环在达成 `DONE` 前耗尽 `--max` 轮次、`--max-duration` 或 `--max-tokens`（含 sticky 硬预算跳过 Verifier 的情况）。 |
| **`130`** | `stopped` | 收到 `SIGINT`/`SIGTERM` 中断，或被 `agy-loop stop` 手动终止。 |

---

## 🔄 `.agents/loop.md` 热重载指南

当直接运行 `/agy-loop:loop` 或仅指定间隔的 `/agy-loop:loop 15m`（未附带内联提示词）时，`agy-loop` 会在**每一轮唤醒时**按以下优先级动态解析巡检指令（单文件读取上限 `25,000` 字节）：

1. 当前工作区下的 **`.agents/loop.md`**（项目级团队或仓库巡检规范）
2. 当前工作区根目录下的 **`loop.md`**
3. 全局配置目录下的 **`~/.gemini/config/loop.md`**（跨仓库个人默认巡检策略）
4. **内置分支维护兜底协议**：依次检查仓库未完成改动与增量测试、通过 `gh`（若已安装登录）检查当前分支 PR 评审意见与最新 CI 状态；若全部正常则单行汇报绿灯。

由于每一轮唤醒都会重新调用 `resolve-task` / `resolveLoopMdTask` / `resolve_loop_md_task` 读取文件，你可以在后台循环运行期间随时保存修改 `.agents/loop.md`，下一轮唤醒将自动加载最新策略，无需取消或重启 `/agy-loop:loop`。

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
   输入 `/agy-loop:loop stop`（或 `/agy-loop:loop stop <id1> <id2>`、`/agy-loop:loop stop <id> --after-current`、`/agy-loop:loop cancel`），编排器会先调用 `state-stop` 同步更新 `state.json`、`control.json` 与 `inbox/`（使 `schedule`、`workflow` 与 `headless` 均可秒级响应），再通过 `manage_task(Action="kill")` 与 `manage_subagents(Action="kill")` 清理关联定时器和子代理（有未合并提交的 `branch` 工作树会优先保留以便人工合入）。
2. **自然语言对话停止**
   直接在输入框发送：`取消当前的 loop 定时任务`（或 `等当前这一轮子代理返回后停止 loop`）。
3. **CLI 交互式管理面板（`/tasks` 与 `/agents`）**
   - 输入 **`/tasks`** 打开后台任务面板，选中对应的 `schedule` 定时器或 Cron 按 **`k`** 键取消后续触发（按 `x` 清理已完成记录）。
   - 输入 **`/agents`** 打开子代理面板，选中状态为 `running` 或 `idle` 的 `loop-worker` 按 **`k`** 键立即终止（`--worktree` 创建的临时分支工作区会自动回收）。子代理等待命令审批时，可按 **`Ctrl+K`** 快速放行，或按 **`Alt+J`** 瞬移进入子代理实时视图（按 `Esc` 返回主会话）。
4. **键盘中断当前回合（`Esc`）与终端 `agy-loop stop`**
   在 `agy` CLI 中直接按 **`Esc`** 键可立即中断主代理当前正在执行的派发动作，控制权回到输入框且不会退出 CLI（连按两次 `Ctrl+C` 会退出整个 CLI）；也可在另一终端运行 `agy-loop stop <id|all> [--after-current]`。

**内置自动退出保护**：当子代理返回 `LOOP_STATUS: DONE`（且通过配置的两段式验收门禁）、`LOOP_STATUS: BLOCKED`、耗尽硬预算（`--max`、`--max-tokens`、`--max-duration`），或连续 3 次未按契约返回/运行时报错触发熔断（`circuit_broken`）时，调度器会自动清理残留定时任务并结束循环。

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
|:--- |:--- |
| `agy-loop run [interval] [prompt...] [options]` | 启动 Headless 循环（`fresh` `json` 或 `--stateful` `stream-json` 双传输），支持 Gemini 4 模型/档位/降级、`--probe`、`--verify-cmd`、`--verifier-model`、`--worktree` 与预算/退出码控制 |
| `agy-loop resume <id\|prefix\|latest> [options]` | 从检查点断点续跑已停止、耗尽预算、受阻、熔断或 `[stale]` 的 Headless 循环（`--max`、`--max-tokens`、`--max-duration`、`--model`、`--settings`） |
| `agy-loop nudge <id\|prefix\|latest> "<msg>" [--wake]` | 向活跃中的 `workflow` 或 `headless` 循环原子投递纠偏指令（可选 `--wake` 立即中断休眠或设置 `wakeRequested`） |
| `agy-loop wake <id\|prefix\|latest> [--reason <msg>]` | 立即提前唤醒休眠中的 `workflow` / `headless` 循环（或在轮内标记 `wakeRequested` 跳过本轮结束后休眠） |
| `agy-loop ps [--all] [--global] [--json]` | 查看当前工作区（或 `--all` / `--global` 加锁索引）交互式、工作流与 Headless 循环列表，自动标注 `[stale]` 死 PID（支持 `list` 别名；`status` 保留为 `doctor` 别名） |
| `agy-loop logs [id\|latest] [-f] [-n N] [--json]` | 回放或实时追踪 `events.jsonl`（含 `iteration_start`、`iteration_end`、`inbox_claim`、`verify_cmd`、`verifier`、`resume`、增量 Token 遥测与软拒绝记录） |
| `agy-loop stop <id\|prefix\|all\|--all> [--after-current]` | 立即停止（双写 `control.json` 与 `inbox/`、清理 stale PID 并向存活 Headless PID 发送 `SIGTERM`）或等待当前轮完成后停止（`--after-current`） |
| `agy-loop statusline [--global] [--no-color] [--json]` | 输出 `<5ms` 零子进程紧凑状态段，可直接配置到 `settings.json` `statusLine`（无活跃循环时输出空） |
| `npx agy-loop [install \| update]` | 调用 `agy plugin install` 安装或更新插件（自动检测同名全局遮蔽文件并告警） |
| `npx agy-loop install --clean-shadow` | 安装 `agy-loop` 并将遮蔽插件的用户级散落文件自动归档至 `~/.gemini/config/.agy-loop-backup-<YYYYMMDD-HHMMSSZ>/` |
| `npx agy-loop doctor [--json]` | 完整健康巡检：含 `agy.capabilities` 特性矩阵（含 `dynamicWorkflows`）、企业策略 `admin_settings.json`/`settings.json`/`hooks.json` 审计、`SessionStart` `protojson` 自检（`hookSelfTest`）、`loop-worker` 6 工具校验（`agentToolsCheck`）、`loop-verifier` 3 工具只读校验（`verifierToolsCheck`）、`workflows/loop-runner` bundle 校验（`workflowBundleCheck`）、遮蔽文件、ERE `skills.json` 过滤、`loop.md`、`activeLoops` 与 `15s`/`30s` `spawnSync` 超时保护（保留 `status` 别名） |
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

有关三回合响应式非阻塞状态机、`v1.3` 动态工作流引擎（`workflows/loop-runner/`）、跨引擎统一单轮状态机（`IterationSnapshot`、`inbox/`、两段式 `turn-stopping`、sticky 硬预算、`finally` 双保险）、双引擎工具分权（`loop-worker` vs `loop-verifier`）以及 Headless 双传输架构与 `resume` 的完整技术细节，请参阅 [**ARCHITECTURE.md**](ARCHITECTURE.md)。

```bash
sh -n install.sh uninstall.sh skills/loop/scripts/loop-helper.sh  # 检查纯 POSIX sh 语法合规性
node --check bin/agy-loop.mjs lib/*.mjs                           # 检查 Node >= 18 ESM 模块语法
python3 -m json.tool workflows/loop-runner/workflow.json >/dev/null # 校验 workflow.json Schema 合法性
python3 -c 'import ast,pathlib; compile(ast.parse(pathlib.Path("workflows/loop-runner/workflow.py").read_text()),"workflow.py","exec",flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)' # 校验支持顶层 await 的 Python 语法
npm test                                                          # 运行隔离 HOME 的单元、工作流与端到端集成测试
agy plugin validate --strict .                                    # 执行 Antigravity v1 插件严格规范校验（0 告警）
```

---

## 📄 开源协议

基于 [**MIT License**](LICENSE) 协议开源发布，Copyright © Max.
